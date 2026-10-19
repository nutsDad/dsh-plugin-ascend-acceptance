/**
 * 标准要求与交付证据的结构化提取。
 *
 * 两条路径并行：
 *   1. 表格：识别表头中的“指标列 / 要求列 / 实测值列”，逐行抽取；
 *   2. 段落：按句拆分，识别“应/不低于/不少于/支持/提供”等规范措辞，
 *      再映射到领域指标目录。
 *
 * 提取结果保留文件名、章节、页码、行号和证据原文，报告里的每一条结论都能
 * 回溯到具体位置。
 *
 * @module dsh-plugin-ascend-acceptance/domain/extract
 */

import {
  CATEGORY_MAP,
  METRICS,
  METRIC_MAP,
  detectCategory,
  matchMetric,
  normalizeForMatch,
} from './catalog.js';
import { extractVersion, parseActualValue, parseRequirementExpression } from './value.js';

const REQUIREMENT_CUES = /(?:应|须|必须|需|要求|不得|禁止|严禁|不低于|不小于|不少于|至少|不高于|不大于|不超过|至多|支持|具备|配置|提供|采用|覆盖|达到|满足|确保|保证|保持|实现|开启|启用|部署|通过)/;
const NEGATIVE_REQUIREMENT = /(?:不得|禁止|严禁|不允许|不能)/;
const TOC_LINE = /(?:\.{3,}|…{2,})\s*\d+\s*$/;
const DOC_HINTS = /(?:提供|提交|出具|附上|随附|交付).{0,80}(?:单|报告|证书|合格证|手册|图纸|清单|记录|方案|函|材料)/;

/**
 * 提取标准要求。
 *
 * @param {Array<object>} files - 已解析的标准文件。
 * @param {{maxRequirements?: number}} [options] - 上限。
 * @returns {{requirements: object[], stats: object, warnings: string[]}}
 */
export function extractRequirements(files, options = {}) {
  const maxRequirements = options.maxRequirements ?? 800;
  const requirements = [];
  const warnings = [];
  const seen = new Set();

  for (const file of files) {
    let section = '';
    const before = requirements.length;
    for (const block of file.blocks ?? []) {
      if (block.type === 'heading') {
        section = block.section || block.text;
        continue;
      }
      if (block.type === 'table') {
        const extracted = extractTableRequirements(block, file, section);
        for (const item of extracted) pushRequirement(item);
      } else if (block.type === 'para') {
        const extracted = extractParagraphRequirements(block, file, section);
        for (const item of extracted) pushRequirement(item);
      }
    }
    const count = requirements.length - before;
    if (count === 0 && (file.blocks ?? []).some((block) => block.type === 'para' || block.type === 'table')) {
      warnings.push(`${file.name}: 未识别到明确的标准条款，建议确认文档中包含“应/不低于/不少于”等要求措辞`);
    }
  }

  function pushRequirement(item) {
    if (requirements.length >= maxRequirements) return;
    if (!item || !item.raw || item.raw.trim().length < 4) return;
    const key = `${item.metricKey ?? 'generic'}|${item.operator}|${stringifyTarget(item.target)}|${normalizeForMatch(item.raw)}`;
    if (seen.has(key)) return;
    seen.add(key);
    item.id = `REQ-${String(requirements.length + 1).padStart(3, '0')}`;
    requirements.push(item);
  }

  if (requirements.length === 0) {
    warnings.push('标准文件中没有提取到条款。请确认上传的是验收标准/技术规范，而不是空白模板。');
  }

  return {
    requirements,
    stats: summarizeRequirements(requirements, files),
    warnings,
  };
}

function extractTableRequirements(block, file, section) {
  const rows = block.rows ?? [];
  if (rows.length === 0) return [];
  const header = findTableHeader(rows, 'standard');
  const output = [];
  const startRow = header.index + 1;
  const tableSection = block.section || section || header.title || `表格 ${block.page ?? 1}`;

  for (let rowIndex = startRow; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined || row.every((cell) => String(cell).trim() === '')) continue;
    let metricText = header.metricCol >= 0 ? row[header.metricCol] ?? '' : '';
    let requirementText = header.requirementCols.length > 0
      ? header.requirementCols.map((column) => row[column] ?? '').filter(Boolean).join('；')
      : '';

    // 没有表头（PDF 表格、无表头的验收清单）时，逐列找真正的指标单元格，
    // 不能拿整行去匹配：方法列里的 “npu-smi info” 会把 NPU 数量误判成
    // npu-smi 可用性。
    let metricCellIndex = header.metricCol;
    if (metricCellIndex < 0) {
      const found = findMetricCell(row, detectCategory(`${tableSection}`).key);
      if (found !== null) {
        metricCellIndex = found.index;
        metricText = row[found.index] ?? '';
        requirementText = row
          .filter((_, cellIndex) => cellIndex !== found.index && !isIdCell(row[cellIndex]) && !looksLikeMethodCell(row[cellIndex]))
          .join('；');
      }
    }

    if (requirementText.trim() === '' && metricText.trim() === '') continue;
    if (isHeaderLikeRow(row)) continue;
    if (/^(?:序号|编号|no\.?|id)$/i.test(metricText.trim())) continue;

    // 没有要求列时，用整行除序号/指标外的内容作为要求。
    if (requirementText.trim() === '') {
      requirementText = row
        .filter((_, index) => index !== metricCellIndex && index !== header.idCol && !looksLikeMethodCell(row[index]))
        .join('；');
    }
    // 指标列为空时，从要求文本中反推指标。
    if (metricText.trim() === '') metricText = requirementText;

    const categoryHint = header.categoryCol >= 0
      ? detectCategory(row[header.categoryCol] ?? '').key
      : detectCategory(`${tableSection} ${metricText}`).key;
    const category = normalizeCategory(categoryHint);
    const metric = matchMetric(metricText, category) ?? matchMetric(requirementText, category);
    const method = header.methodCols.length > 0
      ? header.methodCols.map((column) => row[column] ?? '').filter(Boolean).join('；')
      : header.method;
    const parsed = parseRequirementExpression(requirementText, metric?.metric);
    const raw = buildRequirementRaw(metricText, requirementText, row);

    if (!metric && !DOC_HINTS.test(requirementText) && !REQUIREMENT_CUES.test(requirementText)) continue;

    // 文档类条款可能在同一行列出多份文档，拆成独立条目。
    const docMetrics = metric === null || metric.metric.type === 'presence'
      ? findDocumentMetrics(`${metricText} ${requirementText}`)
      : [];
    if (docMetrics.length > 1) {
      for (const docMetric of docMetrics) {
        output.push(makeRequirement({
          metric: docMetric,
          requirementText,
          raw,
          parsed: { ...parsed, operator: 'presence', target: docMetric.aliases[0], unit: '' },
          category: 'docs',
          file,
          block,
          section: tableSection,
          location: `表格第 ${rowIndex + 1} 行`,
          method,
          confidence: 0.88,
          keywords: [docMetric.aliases[0]],
        }));
      }
      continue;
    }

    if (!REQUIREMENT_CUES.test(requirementText) && parsed.operator === 'unknown' && metric === null) continue;

    output.push(makeRequirement({
      metric: metric?.metric ?? docMetrics[0],
      requirementText,
      raw,
      parsed,
      category,
      file,
      block,
      section: tableSection,
      location: `表格第 ${rowIndex + 1} 行`,
      method,
      confidence: metric === null ? 0.55 : 0.9,
      keywords: extractKeywords(`${metricText} ${requirementText}`),
    }));
  }
  return output;
}

function extractParagraphRequirements(block, file, section) {
  const output = [];
  const text = String(block.text ?? '');
  if (text.trim() === '' || TOC_LINE.test(text) || /^(?:目录|目\s*录|table of contents)/i.test(text.trim())) return [];
  if (/^(?:\$|#|>|npu-smi|hccn_tool|docker |pip |python )/.test(text.trim())) return [];

  // 具备列结构的行（PDF 表格/Word 制表位）先按“指标 | 要求”处理。
  if (Array.isArray(block.columns) && block.columns.length >= 2) {
    const metricCell = block.columns[0];
    const requirementText = block.columns.slice(1).join('；');
    const category = normalizeCategory(detectCategory(`${section} ${metricCell}`).key);
    const metric = matchMetric(metricCell, category) ?? matchMetric(requirementText, category);
    if (metric !== null && REQUIREMENT_CUES.test(requirementText)) {
      const parsed = parseRequirementExpression(requirementText, metric.metric);
      output.push(makeRequirement({
        metric: metric.metric,
        requirementText,
        raw: block.text,
        parsed,
        category,
        file,
        block,
        section,
        location: `第 ${block.page ?? 1} 页`,
        confidence: 0.86,
        keywords: extractKeywords(`${metricCell} ${requirementText}`),
      }));
    }
  }

  const clauses = splitClauses(text);
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (trimmed.length < 4 || trimmed.length > 500) continue;
    if (TOC_LINE.test(trimmed) || /^注[:：]/.test(trimmed) || /^说明[:：]/.test(trimmed)) continue;
    if (!REQUIREMENT_CUES.test(trimmed) && !looksLikeBareThreshold(trimmed)) continue;

    const hint = normalizeCategory(detectCategory(`${section} ${trimmed}`).key);
    let metric = matchMetric(trimmed, hint)?.metric ?? null;
    const docMetrics = findDocumentMetrics(trimmed);

    // “应提供 A、B、C”拆成多个文档要求，避免“全部提供才算通过”。
    if (docMetrics.length > 1 && /(?:提供|提交|出具|附|随附|包含)/.test(trimmed)) {
      for (const docMetric of docMetrics) {
        output.push(makeRequirement({
          metric: docMetric,
          requirementText: trimmed,
          raw: trimmed,
          parsed: { operator: 'presence', target: docMetric.aliases[0], unit: '', negative: false, text: trimmed },
          category: 'docs',
          file,
          block,
          section,
          location: `第 ${block.page ?? 1} 页`,
          confidence: 0.88,
          keywords: [docMetric.aliases[0]],
        }));
      }
      continue;
    }

    if (docMetrics.length === 1 && (metric === null || metric.type !== 'presence')) metric = docMetrics[0];
    const parsed = parseRequirementExpression(trimmed, metric ?? undefined);
    if (parsed.operator === 'unknown' && metric === null) {
      // 完全没有指标也没有可解析阈值：保留为“其他要求”，走关键词证据。
      if (!/(?:应|须|必须|不得|要求)/.test(trimmed)) continue;
    }

    output.push(makeRequirement({
      metric,
      requirementText: trimmed,
      raw: trimmed,
      parsed,
      category: metric?.category ?? hint,
      file,
      block,
      section,
      location: `第 ${block.page ?? 1} 页`,
      confidence: metric === null ? 0.5 : 0.84,
      keywords: extractKeywords(trimmed),
    }));
  }
  return output;
}

function makeRequirement(input) {
  const metric = input.metric ?? null;
  const category = normalizeCategory(metric?.category ?? input.category);
  const parsed = input.parsed ?? {};
  let target = parsed.target;
  let unit = parsed.unit ?? '';
  let operator = parsed.operator ?? 'unknown';

  if (metric?.type === 'presence') {
    operator = 'presence';
    target = metric.aliases[0] ?? metric.label;
    unit = '';
  } else if (metric?.type === 'boolean') {
    // 布尔类条款里可能同时出现“不少于 90 天”“不大于 1 秒”等修饰语；
    // 这些不是布尔指标的阈值，不能把指标判成数值比较。
    operator = 'boolean';
    target = parsed.negative === true ? false : true;
    unit = '';
  } else if (metric?.type === 'version' && target === null) {
    target = extractVersion(input.requirementText);
  }

  return {
    role: 'standard',
    metricKey: metric?.key ?? null,
    metricLabel: metric?.label ?? input.metricLabel ?? truncate(input.requirementText, 32),
    metricType: metric?.type ?? 'text',
    category,
    categoryLabel: CATEGORY_MAP.get(category)?.label ?? '其他要求',
    title: metric?.label ?? truncate(input.requirementText, 30),
    raw: input.raw ?? input.requirementText,
    requirementText: input.requirementText,
    operator,
    target,
    unit,
    range: parsed.range,
    negative: parsed.negative === true || NEGATIVE_REQUIREMENT.test(input.requirementText),
    section: input.section ?? '',
    page: input.block?.page ?? 1,
    sourceFile: input.file?.name ?? '',
    sourceFileId: input.file?.id ?? '',
    location: input.location ?? `第 ${input.block?.page ?? 1} 页`,
    method: input.method ?? '',
    confidence: input.confidence ?? 0.6,
    keywords: input.keywords ?? [],
    evidence: input.raw ?? input.requirementText,
  };
}

// --------------------------------------------------------------------------
// 交付件证据
// --------------------------------------------------------------------------

/**
 * 提取交付件证据。
 *
 * @param {Array<object>} files - 已解析的交付文件。
 * @param {{maxFacts?: number}} [options] - 上限。
 * @returns {{facts: object[], stats: object, warnings: string[]}}
 */
export function extractFacts(files, options = {}) {
  const maxFacts = options.maxFacts ?? 2400;
  const facts = [];
  const warnings = [];
  const seen = new Set();

  for (const file of files) {
    let section = '';
    for (const block of file.blocks ?? []) {
      if (block.type === 'heading') {
        section = block.section || block.text;
        continue;
      }
      if (block.type === 'table') {
        for (const fact of extractTableFacts(block, file, section)) pushFact(fact);
      } else if (block.type === 'para') {
        for (const fact of extractParagraphFacts(block, file, section)) pushFact(fact);
      }
    }
  }

  // 文件清单本身也是“交付文档”类要求的证据。
  const fileNames = files.map((file) => file.name).join('\n');
  for (const metric of METRICS.filter((item) => item.type === 'presence')) {
    const aliases = metric.aliases.filter((alias) => fileNames.includes(alias) || normalizeForMatch(fileNames).includes(normalizeForMatch(alias)));
    if (aliases.length > 0) {
      pushFact({
        metric,
        value: true,
        unit: '',
        raw: `交付文件名包含“${aliases[0]}”`,
        sourceFile: '交付文件清单',
        sourceFileId: '',
        section: '文件清单',
        page: 1,
        location: '文件名',
        evidence: `交付文件：${fileNames.split('\n').join('、')}`,
        confidence: 0.82,
        parsedFrom: 'filename',
      });
    }
  }

  function pushFact(fact) {
    if (!fact || facts.length >= maxFacts) return;
    if (fact.metric === undefined && fact.metricKey === undefined) return;
    const metric = fact.metric ?? METRIC_MAP.get(fact.metricKey);
    if (metric === undefined) return;
    const valueKey = Array.isArray(fact.value) ? fact.value.join('~') : String(fact.value ?? '');
    const key = `${metric.key}|${normalizeForMatch(valueKey)}|${fact.sourceFileId ?? ''}|${normalizeForMatch(fact.raw ?? '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({
      id: `EVD-${String(facts.length + 1).padStart(3, '0')}`,
      role: 'delivery',
      metricKey: metric.key,
      metricLabel: metric.label,
      metricType: metric.type,
      category: metric.category,
      categoryLabel: CATEGORY_MAP.get(metric.category)?.label ?? '其他要求',
      value: fact.value,
      unit: fact.unit ?? metric.unit ?? '',
      raw: fact.raw ?? '',
      sourceFile: fact.sourceFile ?? '',
      sourceFileId: fact.sourceFileId ?? '',
      section: fact.section ?? '',
      page: fact.page ?? 1,
      location: fact.location ?? `第 ${fact.page ?? 1} 页`,
      evidence: fact.evidence ?? fact.raw ?? '',
      confidence: fact.confidence ?? 0.7,
      parsedFrom: fact.parsedFrom ?? 'text',
    });
  }

  if (facts.length === 0 && files.length > 0) {
    warnings.push('交付件中没有提取到可比对的指标证据。请确认文件包含实测值、版本号或状态结论。');
  }

  return {
    facts,
    stats: summarizeFacts(facts, files),
    warnings,
  };
}

function extractTableFacts(block, file, section) {
  const rows = block.rows ?? [];
  if (rows.length === 0) return [];
  const header = findTableHeader(rows, 'delivery');
  const output = [];
  const startRow = header.index + 1;

  for (let rowIndex = startRow; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined || row.every((cell) => String(cell).trim() === '')) continue;
    if (isHeaderLikeRow(row)) continue;

    let metricText = header.metricCol >= 0 ? row[header.metricCol] ?? '' : '';
    let valueText = header.actualCol >= 0 ? row[header.actualCol] ?? '' : '';
    let metricCellIndex = header.metricCol;

    if (metricCellIndex < 0) {
      const found = findMetricCell(row, detectCategory(section).key);
      if (found === null) continue;
      metricCellIndex = found.index;
      metricText = row[found.index] ?? '';
      const after = row[found.index + 1] ?? '';
      valueText = after !== '' && !looksLikeMethodCell(after) ? after : (row[row.length - 1] ?? '');
    }
    if (valueText.trim() === '') {
      const candidates = row.filter((_, index) => index !== metricCellIndex && index !== header.idCol && index !== header.categoryCol && !looksLikeMethodCell(row[index]));
      valueText = candidates[candidates.length - 1] ?? '';
    }
    if (valueText.trim() === '') continue;

    let metric = matchMetric(metricText, normalizeCategory(detectCategory(`${section} ${metricText}`).key))?.metric ?? null;
    if (metric === null) {
      // 有些表把指标写在第二列；逐列找一次。
      for (const cell of row) {
        metric = matchMetric(cell, normalizeCategory(detectCategory(section).key))?.metric ?? null;
        if (metric !== null) break;
      }
    }
    if (metric === null) continue;
    const parsed = parseActualValue(valueText, metric);
    if (parsed === null) continue;
    output.push({
      metric,
      value: parsed.value,
      unit: parsed.unit,
      raw: valueText,
      sourceFile: file.name,
      sourceFileId: file.id,
      section: block.section || section,
      page: block.page ?? 1,
      location: `表格第 ${rowIndex + 1} 行`,
      evidence: `${metricText ? `${metricText} | ` : ''}${valueText}`,
      confidence: parsed.confidence * 0.95,
      parsedFrom: 'table',
    });
  }
  return output;
}

function extractParagraphFacts(block, file, section) {
  const output = [];
  const text = String(block.text ?? '');
  if (text.trim() === '') return output;
  const hint = normalizeCategory(detectCategory(`${section} ${text}`).key);

  // 列结构行：指标 | 实测值 | 证据。
  if (Array.isArray(block.columns) && block.columns.length >= 2) {
    for (let index = 0; index < block.columns.length; index += 1) {
      const match = matchMetric(block.columns[index], hint);
      if (match === null) continue;
      const valueText = block.columns[index + 1] ?? '';
      const parsed = parseActualValue(valueText, match.metric);
      if (parsed !== null && acceptableActual(match.metric, parsed, valueText)) {
        output.push({
          metric: match.metric,
          value: parsed.value,
          unit: parsed.unit,
          raw: valueText,
          sourceFile: file.name,
          sourceFileId: file.id,
          section,
          page: block.page ?? 1,
          location: `第 ${block.page ?? 1} 页`,
          evidence: block.text,
          confidence: parsed.confidence * 0.9,
          parsedFrom: 'columns',
        });
      }
      break;
    }
  }

  // key: value / key = value（一行里可能有多个键值对，例如
  // “驱动版本：23.0.3，firmware 版本：7.1.0.5.220”）。
  const lines = text.split('\n');
  for (const line of lines) {
    for (const piece of splitKeyValues(line)) {
      const match = matchMetric(piece.key, hint);
      if (match === null) continue;
      const parsed = parseActualValue(piece.value, match.metric);
      if (parsed === null || !acceptableActual(match.metric, parsed, piece.value)) continue;
      output.push({
        metric: match.metric,
        value: parsed.value,
        unit: parsed.unit,
        raw: piece.value,
        sourceFile: file.name,
        sourceFileId: file.id,
        section,
        page: block.page ?? 1,
        location: `第 ${block.page ?? 1} 页`,
        evidence: line.trim(),
        confidence: parsed.confidence,
        parsedFrom: 'key-value',
      });
    }
  }

  // 文档/状态类证据经常写成“已提供：A、B、C”“消防：气体灭火系统已验收”，
  // 这类行没有明确数值，按键值对匹配不到，需要按“存在性”单独扫一遍。
  for (const line of lines) {
    for (const metric of METRICS.filter((item) => item.type === 'presence' || item.type === 'boolean')) {
      const aliases = metric.aliases.filter((alias) => lineContainsAlias(line, alias));
      if (aliases.length === 0) continue;
      if (!/(?:已|未|待|提供|提交|随附|见附件|缺失|缺少|不适用|正常|异常|支持|不支持|关闭|开启|启用|完成|验收)/.test(line)) continue;
      const parsed = parseActualValue(line, metric);
      if (parsed === null) continue;
      output.push({
        metric,
        value: parsed.value,
        unit: parsed.unit,
        raw: line.trim(),
        sourceFile: file.name,
        sourceFileId: file.id,
        section,
        page: block.page ?? 1,
        location: `第 ${block.page ?? 1} 页`,
        evidence: line.trim(),
        confidence: Math.min(0.82, parsed.confidence * 0.9),
        parsedFrom: 'status-line',
      });
    }
  }

  // 没有冒号的交付行：指标名 + 值（PDF/Word 常见）。
  if (output.length === 0) {
    const matches = findAllMetricMatches(text, hint);
    for (const match of matches) {
      const tail = text.slice(match.end).trim().replace(/^[:：=,，;；\s]+/, '');
      if (tail === '') continue;
      const parsed = parseActualValue(tail, match.metric);
      if (parsed === null || !acceptableActual(match.metric, parsed, tail)) continue;
      output.push({
        metric: match.metric,
        value: parsed.value,
        unit: parsed.unit,
        raw: tail,
        sourceFile: file.name,
        sourceFileId: file.id,
        section,
        page: block.page ?? 1,
        location: `第 ${block.page ?? 1} 页`,
        evidence: text.trim(),
        confidence: parsed.confidence * 0.85,
        parsedFrom: 'line',
      });
    }
  }

  return output;
}

/**
 * 数值指标必须真的带有指标单位，或原文本身就是一个纯数字字段。
 * 否则“附件 9”“2026-10-18”会被误读成温度、功率等实测值。
 */
function acceptableActual(metric, parsed, raw) {
  if (metric.type !== 'number') return true;
  if (parsed.value === null || parsed.value === undefined) return false;
  if (Array.isArray(parsed.value)) return true;
  if (/^\s*[-+]?\d+(?:\.\d+)?\s*[。.;；]?\s*$/.test(String(raw ?? ''))) return true;
  // 指标带单位时，原文必须真的出现单位（或原文本身就是纯数字字段），
  // 否则“附件 9”“2026-10-18”会被误读成温度/功率。
  return /(?:℃|°C|%RH|%|GB|G|GiB|TB|kW|KW|W|瓦|U|Ω|欧姆|min|分钟|小时|h|年|月|个月|Gbps|Mbps|kg\/m²|kg\/m2|kN\/m²|kN\/m2|TFLOPS|PFLOPS|张|卡|颗|个|台|架|路|P|匹)/i.test(String(raw ?? ''));
}

function lineContainsAlias(text, alias) {
  return normalizeForMatch(text).includes(normalizeForMatch(alias));
}

// --------------------------------------------------------------------------
// 表格表头与文本工具
// --------------------------------------------------------------------------

function findTableHeader(rows, role) {
  const scanLimit = Math.min(rows.length, 6);
  for (let index = 0; index < scanLimit; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) continue;
    const roles = row.map((cell) => headerRole(cell));
    const metricCol = roles.findIndex((item) => item === 'metric');
    const requirementCols = roles.map((item, cellIndex) => (item === 'requirement' ? cellIndex : -1)).filter((cellIndex) => cellIndex >= 0);
    const actualCol = roles.findIndex((item) => item === 'actual');
    const categoryCol = roles.findIndex((item) => item === 'category');
    const idCol = roles.findIndex((item) => item === 'id');
    const methodCols = roles.map((item, cellIndex) => (item === 'method' ? cellIndex : -1)).filter((cellIndex) => cellIndex >= 0);
    const useful = (role === 'standard'
      ? (metricCol >= 0 && requirementCols.length > 0) || requirementCols.length > 0
      : (metricCol >= 0 && actualCol >= 0) || actualCol >= 0 || metricCol >= 0);
    if (useful) {
      return {
        index,
        metricCol,
        requirementCols,
        actualCol,
        categoryCol,
        idCol,
        methodCols,
        method: '',
        title: row.join(' / '),
      };
    }
    // 表头只有一列“项目/指标”时，仍可能是纵向表格；不在这里强行识别。
  }
  return {
    index: -1,
    metricCol: -1,
    requirementCols: [],
    actualCol: -1,
    categoryCol: -1,
    idCol: -1,
    methodCols: [],
    method: '',
    title: '',
  };
}

function headerRole(cell) {
  const text = String(cell ?? '').trim();
  if (text === '') return 'empty';
  if (/^(?:序号|编号|no\.?|id|#)$/i.test(text)) return 'id';
  if (/要求|标准|规范|合格|期望|基线|技术指标|验收标准|交付标准|指标值/.test(text)) return 'requirement';
  if (/实测|实际|交付值|配置值|检查结果|验证结果|检测结果|结果|现状|结论|是否|状态|参数值|^值$/.test(text)) return 'actual';
  if (/类别|分类|领域|专业/.test(text)) return 'category';
  if (/验证|测试方法|检验方法|检查方法|证据|证明材料|备注/.test(text)) return 'method';
  if (/指标|项目|检查项|验收项|测试项|参数|配置项|名称|条目|item/i.test(text)) return 'metric';
  return 'other';
}

/** 在一行里找最可能的指标单元格；优先前半行。 */
function findMetricCell(row, hint) {
  for (let index = 0; index < row.length; index += 1) {
    const cell = String(row[index] ?? '').trim();
    if (cell === '' || isIdCell(cell)) continue;
    const match = matchMetric(cell, hint);
    if (match !== null) return { index, metric: match.metric, score: match.score };
  }
  return null;
}

function isIdCell(value) {
  return /^(?:\d{1,4}|序号|编号|no\.?|id|#)$/i.test(String(value ?? '').trim());
}

function looksLikeMethodCell(value) {
  const text = String(value ?? '').trim();
  return /^(?:npu-smi|hccn_tool|free |cat |docker |pip |python |ls |dmidecode|iperf|perftest|\/etc\/|报告|截图|附件|见附件|证据|备注)/i.test(text)
    || /(?:npu-smi|hccn_tool|iperf3|perftest|dmidecode|free -h)/i.test(text);
}

function isHeaderLikeRow(row) {
  const joined = row.join(' ');
  return /^(?:序号|编号|no\.?|id)\s*[|,，\s]*(?:指标|项目|检查项)/i.test(joined)
    || (/指标|项目/.test(joined) && /要求|实测|标准/.test(joined) && joined.length < 80);
}

function splitClauses(text) {
  const clauses = [];
  let current = '';
  let depth = 0;
  for (const char of String(text)) {
    if ('（(【['.includes(char)) depth += 1;
    else if ('）)】]'.includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && /[。；;\n]/.test(char)) {
      if (current.trim() !== '') clauses.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') clauses.push(current);
  return clauses;
}

function splitKeyValues(line) {
  const output = [];
  const text = String(line ?? '').trim();
  if (text === '') return output;

  // 先按逗号/分号切成小段，避免一行里多个“键：值”只取到第一个。
  const segments = text.split(/[，,；;]/).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    const match = /^(.{2,48}?)\s*[:：=]\s*(.{1,240})$/.exec(segment);
    if (match !== null) {
      output.push({ key: match[1].replace(/^[-*\d.、\s]+/, '').trim(), value: match[2].trim().replace(/[。.;；]+$/, '') });
      continue;
    }
    // “CANN版本 8.0.RC2”之间只有一个空格。
    const loose = /^(.{2,32}?)\s{1,}([A-Za-z0-9Ω℃%+./_-].{0,120})$/.exec(segment);
    if (loose !== null) output.push({ key: loose[1].trim(), value: loose[2].trim() });
  }

  // 如果整行只有一个冒号，但值里还有冒号（URL、时间），上面按段处理已经覆盖。
  if (output.length === 0) {
    const match = /^(.{2,48}?)\s*[:：=]\s*(.{1,240})$/.exec(text);
    if (match !== null) output.push({ key: match[1].trim(), value: match[2].trim() });
  }
  return output;
}

function findAllMetricMatches(text, hint) {
  const matches = [];
  for (const metric of METRICS) {
    for (const alias of metric.aliases) {
      if (normalizeForMatch(alias).length < 2) continue;
      const pattern = aliasPattern(alias);
      let match;
      while ((match = pattern.exec(text)) !== null) {
        matches.push({ metric, start: match.index, end: match.index + match[0].length });
        if (matches.length > 60) break;
      }
      if (matches.length > 60) break;
    }
    if (matches.length > 60) break;
  }
  matches.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
  // 去掉重叠的短匹配，保留更长的指标名。
  const filtered = [];
  for (const match of matches) {
    if (filtered.some((item) => match.start < item.end && match.end > item.start)) continue;
    filtered.push(match);
  }
  return filtered;
}

/** 允许别名内部出现空格/下划线差异的正则。 */
function aliasPattern(alias) {
  const chars = String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/[\s_]+/);
  return new RegExp(chars.join('[\\s_]*'), 'gi');
}

function findDocumentMetrics(text) {
  const normalized = normalizeForMatch(text);
  return METRICS.filter((metric) => metric.type === 'presence')
    .filter((metric) => metric.aliases.some((alias) => normalized.includes(normalizeForMatch(alias))));
}

function buildRequirementRaw(metricText, requirementText, row) {
  if (metricText && requirementText && metricText !== requirementText) return `${metricText}：${requirementText}`;
  return requirementText || row.join(' | ');
}

function looksLikeBareThreshold(text) {
  return /^(?:≥|≤|>|<|不小于|不大于|不低于|不高于|至少|至多)\s*\d/.test(text.trim());
}

function normalizeCategory(category) {
  return CATEGORY_MAP.has(category) ? category : 'other';
}

function truncate(value, length) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function stringifyTarget(target) {
  if (Array.isArray(target)) return target.join('~');
  return String(target ?? '');
}

/** 提取用于关键词兜底比对的词。 */
export function extractKeywords(text) {
  const stopwords = new Set([
    '应当', '应该', '必须', '需要', '要求', '满足', '符合', '提供', '支持', '具备', '配置', '采用',
    '覆盖', '达到', '确保', '保证', '保持', '实现', '开启', '启用', '部署', '通过', '以及', '并且',
    '或者', '进行', '相关', '上述', '以下', '其中', '根据', '按照', '不低于', '不小于', '不少于',
    '不高于', '不大于', '不超过', '至少', '至多', '良好', '正常', '有效', '完整', '齐全',
  ]);
  const tokens = String(text ?? '')
    .replace(/[，。；：、,.;:()[\]（）【】]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 24)
    .filter((token) => !stopwords.has(token))
    .filter((token) => !/^\d+(?:\.\d+)?$/.test(token));
  const ascii = [...String(text ?? '').matchAll(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g)].map((match) => match[0]);
  return [...new Set([...ascii, ...tokens])].slice(0, 12);
}

function summarizeRequirements(requirements, files) {
  const byCategory = {};
  const byType = {};
  for (const requirement of requirements) {
    byCategory[requirement.category] = (byCategory[requirement.category] ?? 0) + 1;
    byType[requirement.metricType ?? 'text'] = (byType[requirement.metricType ?? 'text'] ?? 0) + 1;
  }
  return {
    total: requirements.length,
    withMetric: requirements.filter((item) => item.metricKey !== null).length,
    generic: requirements.filter((item) => item.metricKey === null).length,
    byCategory,
    byType,
    files: files.length,
    chars: files.reduce((sum, file) => sum + (file.stats?.chars ?? 0), 0),
    tables: files.reduce((sum, file) => sum + (file.stats?.tables ?? 0), 0),
  };
}

function summarizeFacts(facts, files) {
  const byCategory = {};
  for (const fact of facts) byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;
  return {
    total: facts.length,
    byCategory,
    files: files.length,
    chars: files.reduce((sum, file) => sum + (file.stats?.chars ?? 0), 0),
    tables: files.reduce((sum, file) => sum + (file.stats?.tables ?? 0), 0),
  };
}
