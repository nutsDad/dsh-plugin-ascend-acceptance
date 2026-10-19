/**
 * 指标值解析与比较。
 *
 * 负责把“不低于 8.0.RC1”“18℃～27℃”“正常”“≤4Ω”这类人话翻译成
 * 可计算的 operator / target / unit，并在比较时处理单位换算与版本排序。
 *
 * @module dsh-plugin-ascend-acceptance/domain/value
 */

import { normalizeForMatch } from './catalog.js';

const UNIT_ALIASES = new Map([
  ['℃', '℃'], ['°c', '℃'], ['摄氏度', '℃'], ['c', '℃'],
  ['%rh', '%'], ['%', '%'], ['rh', '%'],
  ['gb', 'GB'], ['g', 'GB'], ['gib', 'GB'], ['tb', 'TB'], ['tib', 'TB'],
  ['kw', 'kW'], ['千瓦', 'kW'], ['w', 'W'], ['瓦', 'W'], ['kva', 'kVA'],
  ['u', 'U'], ['个', '个'], ['台', '台'], ['架', '架'], ['张', '张'], ['卡', '张'], ['颗', '张'],
  ['分钟', 'min'], ['min', 'min'], ['小时', 'h'], ['h', 'h'], ['年', '年'], ['个月', '月'], ['月', '月'],
  ['gbps', 'Gbps'], ['gb/s', 'Gbps'], ['ge', 'Gbps'], ['mbps', 'Mbps'],
  ['ω', 'Ω'], ['欧姆', 'Ω'], ['ohm', 'Ω'],
  ['kg/m²', 'kg/m²'], ['kg/m2', 'kg/m²'], ['kn/m²', 'kN/m²'], ['kn/m2', 'kN/m²'],
  ['pflops', 'PFLOPS'], ['tflops', 'TFLOPS'],
  ['p', 'P'], ['匹', 'P'],
]);

const POSITIVE_WORDS = [
  '正常', '通过', '合格', '已配置', '已部署', '已提供', '已验收', '已完成', '已接入', '已设置', '已封闭',
  '支持', '具备', '是', '有', '启用', '在线', '健康', '全部正常', '无异常', '满足', '符合',
  '双上联', '双路', '冗余', 'M-LAG', 'MLAG', '已在', '设置了', '设置备件',
];
const NEGATIVE_WORDS = [
  '异常', '故障', '不通过', '不合格', '未配置', '未部署', '未提供', '未提交', '不支持', '不具备',
  '否', '无', '未启用', '离线', '不健康', '缺失', '缺少', '不满足', '不符合', '未安装', '未覆盖',
  '待补', '待提供', '待原厂', '未随交付件', '仍在确认', '未见',
];

const OPERATOR_LABELS = {
  gte: '不低于',
  lte: '不高于',
  gt: '大于',
  lt: '小于',
  eq: '等于',
  range: '处于区间',
  contains: '包含',
  boolean: '应为',
  presence: '应提供',
  negative: '不得出现',
  unknown: '满足',
};

/**
 * 解析要求表达式。
 *
 * @param {string} text - 要求原文（可含指标名）。
 * @param {object} [metric] - 指标定义，用于确认目标类型。
 * @returns {{operator: string, target: any, unit: string, rawTarget: string, range?: {min: number, max: number}, negative: boolean, text: string}}
 */
export function parseRequirementExpression(text, metric) {
  const raw = String(text ?? '').trim();
  const normalized = raw
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[≥≧]/g, '>=')
    .replace(/[≤≦]/g, '<=')
    .replace(/[～~—–]/g, '~')
    .replace(/[：]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/[；]/g, ';')
    .replace(/[。]/g, '.')
    .replace(/[ \t]+/g, ' ')
    .trim();

  const negative = /(?:不得|禁止|不允许|严禁|不能)/.test(normalized);
  const type = metric?.type ?? 'string';

  // 先识别区间：18~27℃、30%~70%、1~2 小时。
  const range = parseRange(normalized);
  if (range !== null) {
    return {
      operator: 'range',
      target: [range.min, range.max],
      range: { min: range.min, max: range.max },
      unit: range.unit,
      rawTarget: range.raw,
      negative,
      text: raw,
    };
  }

  const opPatterns = [
    { operator: 'gte', regex: /(?:不低于|不小于|不少于|至少|大于等于|最低|最小|>=|多于)\s*[;；,，:：]?\s*([^,;。]{1,120})/ },
    { operator: 'lte', regex: /(?:不高于|不大于|不超过|不多于|至多|小于等于|最高|最大|<=|少于)\s*[;；,，:：]?\s*([^,;。]{1,120})/ },
    { operator: 'gt', regex: /(?:大于|超过)\s*[;；,，:：]?\s*([^,;。]{1,120})/ },
    { operator: 'lt', regex: /(?:小于|低于)\s*[;；,，:：]?\s*([^,;。]{1,120})/ },
    { operator: 'eq', regex: /(?:等于|为|应达到|达到|保持|设定为)\s*[;；,，:：]?\s*([^,;。]{1,120})/ },
  ];

  for (const entry of opPatterns) {
    const match = entry.regex.exec(normalized);
    if (match !== null) {
      const parsed = parseTarget(match[1].trim(), type, metric);
      return {
        operator: entry.operator,
        target: parsed.value,
        unit: parsed.unit,
        rawTarget: match[1].trim(),
        negative,
        text: raw,
      };
    }
  }

  // “支持 / 具备 / 配置 / 提供 / 采用” 等存在性要求。
  const presence = /(?:支持|具备|配置|提供|采用|包含|覆盖|实现|开启|启用|部署)\s*([^,;。]{1,120})/.exec(normalized);
  if (presence !== null) {
    if (type === 'boolean') {
      return { operator: 'boolean', target: true, unit: '', rawTarget: presence[1], negative, text: raw };
    }
    if (type === 'presence') {
      return { operator: 'presence', target: presence[1].trim(), unit: '', rawTarget: presence[1], negative, text: raw };
    }
    const parsed = parseTarget(presence[1], type, metric);
    if (parsed.value !== null && parsed.value !== '') {
      return { operator: type === 'number' ? 'eq' : 'contains', target: parsed.value, unit: parsed.unit, rawTarget: presence[1], negative, text: raw };
    }
    return { operator: 'contains', target: presence[1].trim(), unit: '', rawTarget: presence[1], negative, text: raw };
  }

  // 没有操作符但有明确值：按“等于/包含”处理。
  const fallback = parseTarget(normalized, type, metric);
  if (fallback.value !== null && fallback.value !== '') {
    return {
      operator: type === 'number' ? 'eq' : type === 'boolean' ? 'boolean' : 'contains',
      target: fallback.value,
      unit: fallback.unit,
      rawTarget: fallback.raw,
      negative,
      text: raw,
    };
  }

  return { operator: 'unknown', target: null, unit: '', rawTarget: '', negative, text: raw };
}

function parseRange(text) {
  // 仅当两个数字之间用区间符号连接时才算区间；不能把“签到表”“到场时间”里的
  // “到”当成区间连接符。
  const rangeRegex = /(-?\d+(?:\.\d+)?)\s*([^\s\d~]{0,6})?\s*(?:~|至|到)\s*(-?\d+(?:\.\d+)?)\s*([^\s\d,;，；。]{0,6})?/;
  const match = rangeRegex.exec(text);
  if (match === null) return null;
  const min = Number(match[1]);
  const max = Number(match[3]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  const unit = normalizeUnit(match[4] ?? match[2] ?? '');
  return { min, max, unit, raw: match[0] };
}

function parseTarget(value, type, metric) {
  const text = String(value ?? '').trim().replace(/^[：:=]+/, '').trim();
  if (text === '') return { value: null, unit: '', raw: '' };
  const unitMatch = /(-?\d+(?:\.\d+)?)\s*([A-Za-z%℃Ω²/]+|分钟|小时|个月|年|天|张|卡|颗|个|台|架|路|U|P|匹|千瓦|欧姆)?/.exec(text);
  const unit = type === 'number' ? normalizeUnit(unitMatch?.[2] ?? '', metric) : '';
  if (type === 'number') {
    const number = unitMatch === null ? Number.NaN : Number(unitMatch[1]);
    return { value: Number.isFinite(number) ? number : null, unit, raw: text };
  }
  if (type === 'version') {
    const version = extractVersion(text);
    return { value: version ?? text, unit: '', raw: text };
  }
  if (type === 'boolean') {
    return { value: parseBoolean(text) ?? true, unit: '', raw: text };
  }
  if (type === 'presence') {
    return { value: text.replace(/^(?:提供|提交|出具|包含|附)/, '').trim(), unit: '', raw: text };
  }
  return { value: text.replace(/^[“"']|[”"']$/g, '').trim(), unit, raw: text };
}

/**
 * 解析交付件中的实测值。
 *
 * @param {string} text - 交付证据原文。
 * @param {object} metric - 指标定义。
 * @returns {{value: any, unit: string, raw: string, confidence: number} | null}
 */
export function parseActualValue(text, metric) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const type = metric?.type ?? 'string';
  if (type === 'presence') {
    const negative = /(?:未提供|未提交|未随|缺失|缺少|待补|待提供|待原厂|无此|没有|不适用|未见|仍在确认)/.test(raw);
    return { value: !negative, unit: '', raw, confidence: negative ? 0.88 : 0.9 };
  }
  if (type === 'boolean') {
    const value = parseBoolean(raw);
    if (value !== null) return { value, unit: '', raw, confidence: 0.88 };
    // “正常/异常”未命中明确的否定词时，只要出现正向词也算通过。
    if (POSITIVE_WORDS.some((word) => raw.includes(word))) return { value: true, unit: '', raw, confidence: 0.72 };
    return null;
  }
  if (type === 'version') {
    const version = extractVersion(raw);
    if (version === null) return null;
    return { value: version, unit: '', raw, confidence: 0.9 };
  }
  if (type === 'number') {
    if (/^\s*[-+]?\d+(?:\.\d+)?\s*$/.test(raw)) {
      const unit = metric?.unit ?? '';
      const value = convertUnit(Number(raw), '', unit, metric);
      return { value, unit, raw, confidence: 0.72 };
    }
    const range = /(-?\d+(?:\.\d+)?)\s*([A-Za-z%℃Ω²/]+|分钟|小时|个月|年|张|卡|颗|个|台|架|路|U|P|匹|千瓦|欧姆)?\s*[~～-]\s*(-?\d+(?:\.\d+)?)/.exec(raw);
    if (range !== null) {
      const unit = normalizeUnit(range[2] ?? '', metric);
      const min = convertUnit(Number(range[1]), unit, metric?.unit ?? unit, metric);
      const max = convertUnit(Number(range[3]), unit, metric?.unit ?? unit, metric);
      return { value: [min, max], unit: metric?.unit ?? unit, raw, confidence: 0.82 };
    }
    const regex = /(-?\d+(?:\.\d+)?)\s*([A-Za-z%℃Ω²/]+|分钟|小时|个月|年|张|卡|颗|个|台|架|路|U|P|匹|千瓦|欧姆)?/g;
    let match;
    let best = null;
    while ((match = regex.exec(raw)) !== null) {
      const unit = normalizeUnit(match[2] ?? '', metric);
      // 忽略明显属于日期/编号的数字，除非没有其他候选。
      if (match.index > 0 && /\d{4}[-/年]\d{1,2}/.test(raw.slice(Math.max(0, match.index - 2), match.index + match[0].length + 2))) continue;
      const value = convertUnit(Number(match[1]), unit, metric?.unit ?? unit, metric);
      if (!Number.isFinite(value)) continue;
      // 设备型号、附件号里的裸数字不是指标值：有单位的数字优先，其次才是
      // 纯数字；同一行有多个值时取第一个实测值。
      const candidate = { value, unit: metric?.unit ?? unit, raw, confidence: match[2] === undefined ? 0.55 : 0.85 };
      if (best === null) best = candidate;
      if (match[2] !== undefined && best.unit === metric?.unit && match.index > 0) {
        best = candidate;
        break;
      }
      if (match[2] !== undefined) break;
    }
    return best;
  }

  const cleaned = raw
    .replace(/^(?:实测|实际|配置|当前|检测结果|验证结果|结论)\s*[:：=]?\s*/, '')
    .replace(/^[：:=]+/, '')
    .trim();
  if (cleaned === '') return null;
  return { value: cleaned, unit: '', raw, confidence: 0.65 };
}

/** 规范化单位，并做常见同义单位合并。 */
export function normalizeUnit(unit, metric) {
  const raw = String(unit ?? '').trim();
  if (raw === '') return metric?.unit ?? '';
  const normalized = UNIT_ALIASES.get(raw.toLowerCase()) ?? UNIT_ALIASES.get(raw) ?? raw;
  if (metric?.unit === '%' && normalized === '%RH') return '%';
  return normalized;
}

function convertUnit(value, fromUnit, toUnit, metric) {
  if (!Number.isFinite(value)) return Number.NaN;
  const from = normalizeUnit(fromUnit, metric);
  const to = normalizeUnit(toUnit, metric);
  if (from === to || from === '') return value;
  if (from === 'W' && to === 'kW') return value / 1000;
  if (from === 'kW' && to === 'W') return value * 1000;
  if (from === 'TB' && to === 'GB') return value * 1024;
  if (from === 'GB' && to === 'TB') return value / 1024;
  if (from === 'Mbps' && to === 'Gbps') return value / 1000;
  if (from === 'Gbps' && to === 'Mbps') return value * 1000;
  if (from === 'h' && to === 'min') return value * 60;
  if (from === 'min' && to === 'h') return value / 60;
  if (from === '个月' && to === '年') return value / 12;
  if (from === '年' && to === '个月') return value * 12;
  if (from === 'kN/m²' && to === 'kg/m²') return value * 102;
  if (from === 'kg/m²' && to === 'kN/m²') return value / 102;
  if ((from === '℃' && to === '°C') || (from === '°C' && to === '℃')) return value;
  return value;
}

/** 从文本中抽取版本号。 */
export function extractVersion(text) {
  const candidate = String(text ?? '');
  const patterns = [
    /(?:版本|Version|Ver\.?)?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+){0,3}(?:[._-]?(?:RC|rc|T|alpha|beta|sp|SP)[0-9]{0,3})?)/,
    /(?:^|[\s:：=(（])([0-9]+\.[0-9]+(?:\.[0-9]+){1,3})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(candidate);
    if (match !== null) return match[1].replace(/^v/i, '');
  }
  return null;
}

/** 解析布尔/状态词。 */
export function parseBoolean(text) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return null;
  const negative = NEGATIVE_WORDS.find((word) => raw.includes(word));
  const positive = POSITIVE_WORDS.find((word) => raw.includes(word));
  if (negative !== undefined && (positive === undefined || raw.indexOf(negative) <= raw.indexOf(positive))) return false;
  if (positive !== undefined) return true;
  return null;
}

/**
 * 比较要求与实测值。
 *
 * @param {object} metric - 指标定义。
 * @param {object} requirement - 解析后的要求表达式。
 * @param {{value: any, unit: string, raw: string}} actual - 实测值。
 * @returns {{status: 'pass'|'fail'|'unknown', reason: string, confidence: number, diff?: number}}
 */
export function compareValues(metric, requirement, actual) {
  const op = requirement.operator;
  const target = requirement.target;
  const actualValue = actual?.value;

  if (target === null || target === undefined || op === 'unknown') {
    return { status: 'unknown', reason: '标准条款未解析出可计算的阈值', confidence: 0.3 };
  }
  if (actualValue === null || actualValue === undefined) {
    return { status: 'unknown', reason: '交付件中没有可用的实测值', confidence: 0.3 };
  }

  if (op === 'presence') {
    return { status: actualValue === true ? 'pass' : 'unknown', reason: actualValue === true ? '交付件中存在对应文档/证据' : '未在交付件中找到对应证据', confidence: 0.7 };
  }

  if (metric?.type === 'boolean' || op === 'boolean') {
    const expected = requirement.negative ? false : (target === false ? false : true);
    if (typeof actualValue !== 'boolean') return { status: 'unknown', reason: '实测状态无法判定为通过/不通过', confidence: 0.4 };
    if (requirement.negative) {
      return actualValue === false
        ? { status: 'pass', reason: '未发现标准禁止的状态', confidence: 0.82 }
        : { status: 'fail', reason: '发现标准禁止的状态', confidence: 0.82 };
    }
    return actualValue === expected
      ? { status: 'pass', reason: `实测状态为“${formatBoolean(actualValue)}”，符合要求`, confidence: 0.9 }
      : { status: 'fail', reason: `实测状态为“${formatBoolean(actualValue)}”，不满足要求`, confidence: 0.9 };
  }

  if (metric?.type === 'version') {
    const comparison = compareVersions(String(actualValue), String(target));
    if (comparison === null) {
      // 目标里可能带产品名（openEuler 22.03 LTS）；退回产品名 + 版本号的
      // 包含判断，避免把“名字匹配但版本无法排序”误判为不通过。
      const actualText = normalizeForMatch(actualValue);
      const targetText = normalizeForMatch(target);
      if (targetText !== '' && (actualText.includes(targetText) || targetText.includes(actualText))) {
        return { status: 'pass', reason: `交付版本“${actualValue}”包含要求“${target}”`, confidence: 0.72 };
      }
      return { status: 'unknown', reason: `无法比较版本“${actualValue}”与“${target}”`, confidence: 0.4 };
    }
    const status = applyOperator(op, comparison, requirement.negative);
    return {
      status,
      reason: `实测 ${actualValue} ${operatorLabel(op)} 要求 ${target}`,
      confidence: 0.9,
    };
  }

  if (metric?.type === 'number') {
    if (op === 'range' && requirement.range !== undefined) {
      const { min, max } = requirement.range;
      if (Array.isArray(actualValue)) {
        const [actualMin, actualMax] = actualValue;
        const pass = actualMin >= min && actualMax <= max;
        return {
          status: pass ? 'pass' : 'fail',
          reason: `实测区间 ${actualMin}~${actualMax}${actual.unit ?? ''}，要求处于 ${min}~${max}${requirement.unit ?? ''}`,
          confidence: 0.86,
        };
      }
      const value = Number(actualValue);
      if (!Number.isFinite(value)) return { status: 'unknown', reason: '实测值不是有效数字', confidence: 0.3 };
      const pass = value >= min && value <= max;
      return {
        status: pass ? 'pass' : 'fail',
        reason: `实测 ${value}${actual.unit ?? ''}，要求处于 ${min}~${max}${requirement.unit ?? ''}`,
        confidence: 0.92,
      };
    }
    const targetNumber = Number(target);
    if (!Number.isFinite(targetNumber)) return { status: 'unknown', reason: '要求阈值不是有效数字', confidence: 0.3 };
    if (Array.isArray(actualValue)) {
      const [min, max] = actualValue;
      const pass = min >= targetNumber * (1 - toleranceFor(requirement)) && max <= targetNumber * (1 + toleranceFor(requirement));
      return {
        status: pass ? 'pass' : 'fail',
        reason: `实测区间 ${min}~${max}${actual.unit ?? ''}，要求 ${operatorLabel(op)} ${targetNumber}${requirement.unit ?? ''}`,
        confidence: 0.86,
      };
    }
    const value = Number(actualValue);
    if (!Number.isFinite(value)) return { status: 'unknown', reason: '实测值不是有效数字', confidence: 0.3 };
    const tolerance = toleranceFor(requirement);
    let comparison = 0;
    if (value > targetNumber + Math.abs(targetNumber) * tolerance) comparison = 1;
    else if (value < targetNumber - Math.abs(targetNumber) * tolerance) comparison = -1;
    const status = applyOperator(op, comparison, requirement.negative);
    return {
      status,
      reason: `实测 ${formatNumber(value)}${actual.unit ?? ''}，要求 ${operatorLabel(op)} ${formatNumber(targetNumber)}${requirement.unit ?? ''}`,
      confidence: 0.94,
      diff: value - targetNumber,
    };
  }

  // 文本/型号要求：完全相等或包含即通过；支持“/、或”分隔的多个可接受值。
  const actualText = normalizeForMatch(actualValue);
  const targetText = normalizeForMatch(target);
  if (targetText === '') return { status: 'unknown', reason: '要求中没有可比对的文本值', confidence: 0.3 };
  const alternatives = String(target).split(/[\/、,，]|\s或\s/).map((item) => normalizeForMatch(item)).filter(Boolean);
  const matched = alternatives.some((alternative) => actualText === alternative || actualText.includes(alternative) || alternative.includes(actualText));
  return {
    status: matched ? 'pass' : 'fail',
    reason: matched
      ? `交付值“${actualValue}”与要求“${target}”匹配`
      : `交付值“${actualValue}”与要求“${target}”不一致`,
    confidence: 0.78,
  };
}

function toleranceFor(requirement) {
  return /约|左右|大约|近似/.test(requirement.text ?? '') ? 0.05 : 0.0005;
}

function applyOperator(operator, comparison, negative) {
  if (negative) {
    // “不得大于 X”等价于“不大于 X”；反转普通比较。
    if (operator === 'gte') return comparison > 0 ? 'fail' : 'pass';
    if (operator === 'lte') return comparison < 0 ? 'fail' : 'pass';
    if (operator === 'eq') return comparison === 0 ? 'fail' : 'pass';
    return 'unknown';
  }
  switch (operator) {
    case 'gte':
      return comparison >= 0 ? 'pass' : 'fail';
    case 'lte':
      return comparison <= 0 ? 'pass' : 'fail';
    case 'gt':
      return comparison > 0 ? 'pass' : 'fail';
    case 'lt':
      return comparison < 0 ? 'pass' : 'fail';
    case 'eq':
      return comparison === 0 ? 'pass' : 'fail';
    default:
      return 'unknown';
  }
}

/**
 * 比较版本号。返回 1 / 0 / -1，无法比较时返回 null。
 *
 * 规则：按数字段比较；数字段相同再看 RC/beta 后缀，正式版高于 RC。
 * `8.0.RC2` 的数字段是 [8,0,0,2]，`8.0.0` 是 [8,0,0]，前者大于后者。
 */
export function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (leftParts === null || rightParts === null) return null;
  const length = Math.max(leftParts.numbers.length, rightParts.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts.numbers[index] ?? 0;
    const b = rightParts.numbers[index] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  if (leftParts.rank === rightParts.rank) {
    if (leftParts.suffixNumber === rightParts.suffixNumber) return 0;
    return leftParts.suffixNumber > rightParts.suffixNumber ? 1 : -1;
  }
  return leftParts.rank > rightParts.rank ? 1 : -1;
}

function versionParts(value) {
  const text = String(value ?? '').trim();
  // 基础数字段与后缀分开：8.0.RC2 的基础段是 [8,0]，8.0.0 是 [8,0,0]，
  // 先比较基础段，再比较 RC/正式版等级，最后比较 RC 序号。
  const match = /(\d+(?:\.\d+)*)(?:[._-]?(RC|rc|T|SP|sp|alpha|beta|a|b)?(\d{0,3}))?/.exec(text);
  if (match === null) return null;
  const numbers = match[1].split('.').map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  const suffixNumber = Number(match[3] ?? 0) || 0;
  let rank = 9;
  if (suffix === 'alpha' || suffix === 'a') rank = 1;
  else if (suffix === 'beta' || suffix === 'b') rank = 2;
  else if (suffix === 'rc') rank = 3;
  else if (suffix === 't') rank = 4;
  else if (suffix === 'sp') rank = 10;
  return { numbers, rank, suffixNumber };
}

export function operatorLabel(operator) {
  return OPERATOR_LABELS[operator] ?? operator ?? '满足';
}

export function formatBoolean(value) {
  return value ? '正常/支持' : '异常/不支持';
}

export function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

/** 把比较结果和单位整理成“实测 78℃，不高于 85℃”这样的短句。 */
export function describeComparison(requirement, actual) {
  const target = Array.isArray(requirement.target)
    ? requirement.target.join('~')
    : requirement.target;
  return `${operatorLabel(requirement.operator)} ${target}${requirement.unit ?? ''}`.trim();
}
