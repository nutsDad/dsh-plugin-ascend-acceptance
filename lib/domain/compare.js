/**
 * 标准要求 × 交付证据的逐项比对。
 *
 * 判定原则：
 *   * 同一指标有明确实测值 → 按类型比较（数值、版本、布尔、文本）；
 *   * 文档类要求 → 按交付件内容/文件名中的存在性判定；
 *   * 同一指标存在多份互相矛盾的证据 → 数值指标取“最不利值”，避免用一份
 *     好看的汇总表掩盖现场异常；
 *   * 标准条款没有映射到指标 → 走关键词弱证据，并明确标注低置信度，绝不把
 *     “没找到证据”伪装成“通过”。
 *
 * @module dsh-plugin-ascend-acceptance/domain/compare
 */

import { CATEGORIES, CATEGORY_MAP, METRIC_MAP, normalizeForMatch } from './catalog.js';
import {
  compareValues,
  formatNumber,
  operatorLabel,
} from './value.js';

/**
 * 执行逐项比对。
 *
 * @param {object} input - 输入。
 * @param {object[]} input.requirements - 标准要求。
 * @param {object[]} input.facts - 交付证据。
 * @param {object[]} input.standardFiles - 标准文件记录。
 * @param {object[]} input.deliveryFiles - 交付文件记录。
 * @returns {{comparisons: object[], summary: object, warnings: string[]}}
 */
export function compareAll(input) {
  const { requirements, facts, standardFiles = [], deliveryFiles = [] } = input;
  const warnings = [];
  const factsByMetric = new Map();
  for (const fact of facts) {
    if (!factsByMetric.has(fact.metricKey)) factsByMetric.set(fact.metricKey, []);
    factsByMetric.get(fact.metricKey).push(fact);
  }

  const deliveryCorpus = [
    ...deliveryFiles.map((file) => file.name),
    ...deliveryFiles.map((file) => file.text ?? ''),
  ].join('\n');
  const normalizedCorpus = normalizeForMatch(deliveryCorpus);

  const comparisons = requirements.map((requirement, index) => {
    const base = {
      id: `CMP-${String(index + 1).padStart(3, '0')}`,
      reqId: requirement.id,
      category: requirement.category,
      categoryLabel: requirement.categoryLabel,
      metricKey: requirement.metricKey,
      metricLabel: requirement.metricLabel,
      metricType: requirement.metricType,
      title: requirement.title,
      requirementText: requirement.requirementText,
      raw: requirement.raw,
      operator: requirement.operator,
      operatorLabel: operatorLabel(requirement.operator),
      target: requirement.target,
      unit: requirement.unit,
      negative: requirement.negative,
      sourceFile: requirement.sourceFile,
      sourceSection: requirement.section,
      sourcePage: requirement.page,
      sourceLocation: requirement.location,
      standardBasis: formatStandardBasis(requirement),
      method: requirement.method,
      extractionConfidence: requirement.confidence,
    };

    if (requirement.metricKey !== null || requirement.metricType === 'presence') {
      const candidates = candidatesFor(requirement, factsByMetric);
      if (candidates.length === 0) {
        return makeResult(base, {
          status: 'unknown',
          reason: '交付件中未找到与该指标对应的证据',
          actual: null,
          deliveryBasis: '未找到对应证据',
          confidence: Math.min(0.55, requirement.confidence),
          matchType: 'metric-missing',
          recommendation: buildRecommendation('unknown', requirement, null),
        });
      }

      const evaluated = candidates.map((fact) => ({
        fact,
        result: compareOne(requirement, fact),
      }));
      const failed = evaluated.filter((item) => item.result.status === 'fail' && item.result.confidence >= 0.6);
      const passed = evaluated.filter((item) => item.result.status === 'pass');
      const chosen = failed.length > 0
        ? pickWorst(failed, requirement)
        : pickBest(passed.length > 0 ? passed : evaluated, requirement);
      const result = chosen.result;
      const fact = chosen.fact;
      return makeResult(base, {
        status: result.status,
        reason: result.reason,
        actual: {
          value: fact.value,
          unit: fact.unit,
          raw: fact.raw,
          sourceFile: fact.sourceFile,
          section: fact.section,
          page: fact.page,
          location: fact.location,
          evidence: fact.evidence,
          confidence: fact.confidence,
          parsedFrom: fact.parsedFrom,
        },
        alternateEvidence: evaluated.filter((item) => item.fact.id !== fact.id).slice(0, 3).map((item) => ({
          value: item.fact.value,
          unit: item.fact.unit,
          sourceFile: item.fact.sourceFile,
          section: item.fact.section,
          evidence: item.fact.evidence,
          status: item.result.status,
        })),
        deliveryBasis: formatDeliveryBasis(fact),
        confidence: Math.min(result.confidence, 0.55 + fact.confidence * 0.45),
        matchType: failed.length > 0 ? 'metric-worst-case' : 'metric',
        recommendation: buildRecommendation(result.status, requirement, fact),
      });
    }

    // 没有映射到指标：用交付件文本中的关键词做弱证据。
    const generic = compareGeneric(requirement, normalizedCorpus, deliveryFiles, deliveryCorpus);
    return makeResult(base, {
      status: generic.status,
      reason: generic.reason,
      actual: generic.actual,
      deliveryBasis: generic.deliveryBasis,
      confidence: generic.confidence,
      matchType: 'keyword',
      recommendation: buildRecommendation(generic.status, requirement, generic.actual),
    });
  });

  const summary = summarize(comparisons, {
    standardFiles,
    deliveryFiles,
    requirements,
    facts,
  });
  if (summary.unknown > 0) {
    warnings.push(`${summary.unknown} 项因证据缺失或无法量化而标记为“待确认”，不计入通过。`);
  }
  if (summary.fail > 0) {
    warnings.push(`${summary.fail} 项未通过，请按报告中的建议措施整改后复验。`);
  }
  return { comparisons, summary, warnings };
}

function compareOne(requirement, fact) {
  const metric = requirement.metricKey === null ? null : METRIC_MAP.get(requirement.metricKey);
  if (fact.value === null || fact.value === undefined) {
    return { status: 'unknown', reason: '证据中没有可用值', confidence: 0.3 };
  }
  // 文档类要求：证据存在且未被标注“未提供”即通过。
  if (metric?.type === 'presence' || requirement.metricType === 'presence') {
    if (fact.value === true) {
      return { status: 'pass', reason: '交付件中存在对应文档/证据', confidence: 0.88 };
    }
    return { status: 'fail', reason: '交付件明确缺少对应文档/证据', confidence: 0.88 };
  }
  return compareValues(metric ?? { type: requirement.metricType }, requirement, fact);
}

function candidatesFor(requirement, factsByMetric) {
  if (requirement.metricKey !== null) {
    const exact = factsByMetric.get(requirement.metricKey) ?? [];
    if (exact.length > 0) return exact;
  }
  // 指标目录升级后旧数据可能没有 key：按标签/证据文本做一次兜底。
  const target = normalizeForMatch(requirement.metricLabel);
  return [...factsByMetric.values()]
    .flat()
    .filter((fact) => {
      if (requirement.metricKey !== null && fact.metricKey === requirement.metricKey) return true;
      const label = normalizeForMatch(fact.metricLabel);
      return label === target || label.includes(target) || target.includes(label);
    })
    .slice(0, 20);
}

function pickWorst(evaluated, requirement) {
  const numeric = requirement.metricType === 'number';
  const actualNumber = (item) => {
    const value = item.fact.value;
    if (Array.isArray(value)) return requirement.operator === 'lte' || requirement.operator === 'range' ? Math.max(...value) : Math.min(...value);
    return Number(value);
  };
  return [...evaluated].sort((left, right) => {
    if (numeric) {
      const a = actualNumber(left);
      const b = actualNumber(right);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return requirement.operator === 'lte' || requirement.operator === 'range' ? b - a : a - b;
      }
    }
    return right.result.confidence - left.result.confidence;
  })[0];
}

function pickBest(evaluated, requirement) {
  return [...evaluated].sort((left, right) => {
    const tableBoost = (item) => (item.fact.parsedFrom === 'table' ? 0.08 : 0);
    const leftScore = left.result.confidence + left.fact.confidence * 0.4 + tableBoost(left);
    const rightScore = right.result.confidence + right.fact.confidence * 0.4 + tableBoost(right);
    return rightScore - leftScore;
  })[0];
}

function compareGeneric(requirement, normalizedCorpus, deliveryFiles, deliveryCorpus) {
  const targetText = normalizeForMatch(requirement.target);
  if (targetText !== '' && targetText.length >= 2 && normalizedCorpus.includes(targetText)) {
    return {
      status: 'pass',
      reason: `交付件中出现要求值“${requirement.target}”`,
      actual: {
        value: requirement.target,
        unit: requirement.unit,
        raw: '关键词命中',
        sourceFile: '交付件全文',
        section: '',
        evidence: findSnippet(deliveryCorpus, String(requirement.target)),
        confidence: 0.55,
        parsedFrom: 'keyword',
      },
      deliveryBasis: `交付件全文中出现“${requirement.target}”`,
      confidence: 0.55,
    };
  }

  const keywords = (requirement.keywords ?? [])
    .map((keyword) => String(keyword).trim())
    .filter((keyword) => keyword.length >= 2 && !/^\d+$/.test(keyword))
    .filter((keyword) => !/^(?:应|须|必须|要求|满足|符合|提供|支持|具备|配置|采用|覆盖|达到|确保|保证|相关|进行)$/.test(keyword));
  const matched = keywords.filter((keyword) => normalizedCorpus.includes(normalizeForMatch(keyword)));
  const strong = matched.filter((keyword) => keyword.length >= 4 || /[A-Za-z]{3,}/.test(keyword));

  if (requirement.negative) {
    if (strong.length > 0) {
      return {
        status: 'fail',
        reason: `标准禁止项在交付件中出现关键词“${strong[0]}”`,
        actual: {
          value: strong[0],
          unit: '',
          raw: '禁止项关键词命中',
          sourceFile: '交付件全文',
          section: '',
          evidence: findSnippet(deliveryCorpus, strong[0]),
          confidence: 0.5,
          parsedFrom: 'keyword',
        },
        deliveryBasis: `交付件全文中出现禁止项关键词“${strong[0]}”`,
        confidence: 0.5,
      };
    }
    return {
      status: 'pass',
      reason: '未在交付件中发现标准禁止项关键词',
      actual: null,
      deliveryBasis: '未发现禁止项关键词',
      confidence: 0.42,
    };
  }

  if (strong.length >= 1 && requirement.target === null) {
    return {
      status: 'pass',
      reason: `交付件中出现关键证据词“${strong[0]}”（该条款未映射到标准指标，按关键词弱证据判定）`,
      actual: {
        value: strong[0],
        unit: '',
        raw: '关键词弱证据',
        sourceFile: '交付件全文',
        section: '',
        evidence: findSnippet(deliveryCorpus, strong[0]),
        confidence: 0.5,
        parsedFrom: 'keyword',
      },
      deliveryBasis: `交付件全文中出现“${strong[0]}”`,
      confidence: 0.5,
    };
  }

  return {
    status: 'unknown',
    reason: '该条款没有映射到可计算的指标，且交付件中未找到足以判定的关键词证据',
    actual: null,
    deliveryBasis: '未找到可判定的对应证据',
    confidence: 0.28,
  };
}

function makeResult(base, result) {
  const status = result.status;
  return {
    ...base,
    status,
    statusLabel: status === 'pass' ? '通过' : status === 'fail' ? '不通过' : '待确认',
    reason: result.reason,
    actual: result.actual,
    alternateEvidence: result.alternateEvidence ?? [],
    deliveryBasis: result.deliveryBasis ?? '未找到对应证据',
    confidence: clamp(result.confidence ?? 0.3, 0, 1),
    confidenceLabel: confidenceLabel(result.confidence ?? 0.3),
    matchType: result.matchType ?? 'metric',
    recommendation: result.recommendation ?? '',
    standardBasis: base.standardBasis,
    deliveryBasisDetail: result.deliveryBasis,
  };
}

function formatStandardBasis(requirement) {
  const location = [requirement.sourceFile, requirement.section, requirement.location]
    .filter((item) => item !== undefined && item !== null && String(item).trim() !== '')
    .join(' · ');
  return `${location}：${requirement.raw}`.replace(/^：/, '');
}

function formatDeliveryBasis(fact) {
  const location = [fact.sourceFile, fact.section, fact.location]
    .filter((item) => item !== undefined && item !== null && String(item).trim() !== '')
    .join(' · ');
  return `${location}：${fact.evidence ?? fact.raw}`.replace(/^：/, '');
}

function buildRecommendation(status, requirement, actual) {
  const metric = requirement.metricKey === null ? null : METRIC_MAP.get(requirement.metricKey);
  const label = metric?.label ?? requirement.metricLabel ?? '该要求';
  const evidence = metric?.evidence ?? '对应的测试报告/截图/配置输出';
  const targetText = Array.isArray(requirement.target)
    ? `${requirement.target[0]}~${requirement.target[1]}${requirement.unit ?? ''}`
    : `${requirement.target ?? ''}${requirement.unit ?? ''}`;
  const actualText = actual === null || actual === undefined
    ? '未提供'
    : Array.isArray(actual.value)
      ? `${formatNumber(actual.value[0])}~${formatNumber(actual.value[1])}${actual.unit ?? ''}`
      : `${typeof actual.value === 'number' ? formatNumber(actual.value) : actual.value}${actual.unit ?? ''}`;

  if (status === 'pass') {
    return `无需整改。保留“${evidence}”作为本项验收证据，确保与交付件版本一致。`;
  }
  if (status === 'fail') {
    if (metric?.type === 'version') {
      return `将${label}从 ${actualText} 调整到${operatorLabel(requirement.operator)} ${targetText}；升级/回退后重新执行兼容性验证，并附版本查询命令输出与复测记录。`;
    }
    if (metric?.type === 'number') {
      return `将${label}从 ${actualText} 调整到${operatorLabel(requirement.operator)} ${targetText}；按“${evidence}”复测，并附测试时间、测试人/盖章与原始记录。`;
    }
    if (metric?.type === 'boolean') {
      return `完成${label}的配置/整改，使其达到“${requirement.requirementText}”；保留配置截图、命令输出或演练记录，整改后复验。`;
    }
    if (metric?.type === 'presence') {
      return `补齐${label}并完成签字/盖章后随交付件提交；若已提交，请在文件清单中明确文件名与版本。`;
    }
    return `${metric?.advice ?? '按标准条款完成整改'}；整改后补充“${evidence}”并重新提交核验。`;
  }
  // unknown
  if (metric === null) {
    return `该条款尚未映射到标准指标。请在交付件中补充与“${truncate(requirement.requirementText, 40)}”对应的章节、测试记录或证明文件；必要时由标准方确认判定口径。`;
  }
  return `补充${label}的有效证据（${evidence}），确保包含指标值、测试时间、执行人/盖章；若该项不适用，请由标准方出具书面豁免说明。当前交付值：${actualText}。`;
}

function findSnippet(text, keyword) {
  const source = String(text ?? '');
  const index = normalizeForMatch(source).indexOf(normalizeForMatch(keyword));
  if (index < 0) return source.slice(0, 160);
  // 规范化坐标和原文坐标有差异，使用原文 indexOf 再找一次。
  const rawIndex = source.indexOf(keyword);
  const start = Math.max(0, (rawIndex >= 0 ? rawIndex : index) - 50);
  return `${start > 0 ? '…' : ''}${source.slice(start, start + 200).replace(/\s+/g, ' ').trim()}${source.length > start + 200 ? '…' : ''}`;
}

function summarize(comparisons, context) {
  const pass = comparisons.filter((item) => item.status === 'pass').length;
  const fail = comparisons.filter((item) => item.status === 'fail').length;
  const unknown = comparisons.filter((item) => item.status === 'unknown').length;
  const total = comparisons.length;
  const byCategory = {};
  for (const category of CATEGORIES) {
    const items = comparisons.filter((item) => item.category === category.key);
    if (items.length === 0) continue;
    byCategory[category.key] = {
      key: category.key,
      label: category.label,
      color: category.color,
      total: items.length,
      pass: items.filter((item) => item.status === 'pass').length,
      fail: items.filter((item) => item.status === 'fail').length,
      unknown: items.filter((item) => item.status === 'unknown').length,
      rate: items.length === 0 ? 0 : Math.round((items.filter((item) => item.status === 'pass').length / items.length) * 1000) / 10,
    };
  }
  const fileStats = [
    ...context.standardFiles.map((file) => fileRow(file, 'standard')),
    ...context.deliveryFiles.map((file) => fileRow(file, 'delivery')),
  ];
  const status = fail > 0 ? 'needs-remediation' : unknown > 0 ? 'needs-evidence' : 'accepted';
  return {
    total,
    pass,
    fail,
    unknown,
    standardFiles: context.standardFiles.length,
    deliveryFiles: context.deliveryFiles.length,
    fileCount: context.standardFiles.length + context.deliveryFiles.length,
    requirements: context.requirements.length,
    facts: context.facts.length,
    complianceRate: total === 0 ? 0 : Math.round((pass / total) * 1000) / 10,
    decidableRate: pass + fail === 0 ? 0 : Math.round((pass / (pass + fail)) * 1000) / 10,
    status,
    verdict: status === 'accepted'
      ? '交付件满足当前标准要求'
      : status === 'needs-remediation'
        ? '存在不通过项，建议整改后复验'
        : '存在待确认项，需补充证据后复验',
    byCategory,
    files: fileStats,
    generatedAt: new Date().toISOString(),
  };
}

function fileRow(file, role) {
  return {
    id: file.id,
    name: file.name,
    kind: file.kind,
    ext: file.ext,
    size: file.size,
    role,
    roleLabel: role === 'standard' ? '标准' : '交付件',
    status: file.status ?? 'parsed',
    error: file.error ?? '',
    chars: file.stats?.chars ?? 0,
    tables: file.stats?.tables ?? 0,
    paragraphs: file.stats?.paragraphs ?? 0,
    pages: file.stats?.pages ?? 1,
    extracted: role === 'standard' ? (file.requirementCount ?? 0) : (file.factCount ?? 0),
    warnings: file.warnings ?? [],
  };
}

function confidenceLabel(value) {
  if (value >= 0.82) return '高';
  if (value >= 0.6) return '中';
  return '低';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function truncate(value, length) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export { CATEGORY_MAP };
