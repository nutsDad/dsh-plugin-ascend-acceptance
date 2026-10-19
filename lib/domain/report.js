/**
 * 比对报告渲染：Markdown、CSV 与可独立打开的 HTML。
 *
 * 报告结构严格对应验收会上的阅读顺序：
 *   范围 → 结论 → 不通过项（含依据与建议）→ 待确认项 → 通过项明细 → 方法与限制。
 *
 * @module dsh-plugin-ascend-acceptance/domain/report
 */

import { escapeHtml } from '../http.js';

/** 渲染 Markdown 报告。 */
export function renderMarkdownReport(report) {
  const summary = report.summary;
  const lines = [];
  lines.push(`# 昇腾交付核验报告`);
  lines.push('');
  lines.push(`- 生成时间：${formatDate(summary.generatedAt)}`);
  lines.push(`- 核验结论：**${summary.verdict}**`);
  lines.push(`- 核验范围：${summary.fileCount} 个文件（标准 ${summary.standardFiles} 份 / 交付件 ${summary.deliveryFiles} 份），${summary.total} 项指标`);
  lines.push('');
  lines.push('## 一、总体结论');
  lines.push('');
  lines.push('| 指标 | 数量 |');
  lines.push('| --- | ---: |');
  lines.push(`| 标准文件 | ${summary.standardFiles} |`);
  lines.push(`| 验收交付件 | ${summary.deliveryFiles} |`);
  lines.push(`| 比对指标 | ${summary.total} |`);
  lines.push(`| 通过 | ${summary.pass} |`);
  lines.push(`| 不通过 | ${summary.fail} |`);
  lines.push(`| 待确认 | ${summary.unknown} |`);
  lines.push(`| 总体通过率 | ${summary.complianceRate}% |`);
  lines.push(`| 可判定项通过率 | ${summary.decidableRate}% |`);
  lines.push('');
  lines.push(`> ${summary.verdict}。通过率按“通过 / 全部比对项”计算；待确认项不计为通过。`);
  lines.push('');

  lines.push('## 二、核验文件');
  lines.push('');
  lines.push('| 角色 | 文件 | 类型 | 大小 | 解析结果 | 提取项 | 警告 |');
  lines.push('| --- | --- | --- | ---: | --- | ---: | --- |');
  for (const file of summary.files) {
    lines.push(`| ${file.roleLabel} | ${escapeMd(file.name)} | ${escapeMd(file.kind)} | ${formatBytes(file.size)} | ${file.status === 'parsed' ? '已解析' : escapeMd(file.error || '解析失败')} | ${file.extracted} | ${escapeMd((file.warnings ?? []).join('；'))} |`);
  }
  lines.push('');

  const failed = report.comparisons.filter((item) => item.status === 'fail');
  const unknown = report.comparisons.filter((item) => item.status === 'unknown');
  const passed = report.comparisons.filter((item) => item.status === 'pass');

  lines.push(`## 三、不通过项明细（${failed.length} 项）`);
  lines.push('');
  if (failed.length === 0) {
    lines.push('本次核验没有不通过项。');
    lines.push('');
  } else {
    for (const item of failed) lines.push(...renderMarkdownItem(item));
  }

  lines.push(`## 四、待确认项（${unknown.length} 项）`);
  lines.push('');
  if (unknown.length === 0) {
    lines.push('本次核验没有待确认项。');
    lines.push('');
  } else {
    for (const item of unknown) lines.push(...renderMarkdownItem(item));
  }

  lines.push(`## 五、通过项明细及依据（${passed.length} 项）`);
  lines.push('');
  if (passed.length === 0) {
    lines.push('本次核验没有通过项。');
    lines.push('');
  } else {
    lines.push('| 编号 | 分类 | 指标 | 标准要求 | 交付证据 | 判定依据 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const item of passed) {
      lines.push(`| ${item.id} | ${escapeMd(item.categoryLabel)} | ${escapeMd(item.metricLabel)} | ${escapeMd(item.requirementText)} | ${escapeMd(item.deliveryBasis)} | ${escapeMd(item.reason)} |`);
    }
    lines.push('');
  }

  lines.push('## 六、分类统计');
  lines.push('');
  lines.push('| 分类 | 总数 | 通过 | 不通过 | 待确认 | 通过率 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const stat of Object.values(summary.byCategory)) {
    lines.push(`| ${escapeMd(stat.label)} | ${stat.total} | ${stat.pass} | ${stat.fail} | ${stat.unknown} | ${stat.rate}% |`);
  }
  lines.push('');

  lines.push('## 七、判定方法与限制');
  lines.push('');
  lines.push('1. 标准条款优先按表格表头（指标/要求/实测值）逐行提取，其次按“应/不低于/不少于/支持/提供”等措辞分句提取。');
  lines.push('2. 交付证据优先取表格中的实测值列；同一指标存在多份证据时，数值类指标按最不利值判定，避免汇总表掩盖现场异常。');
  lines.push('3. 未映射到标准指标的条款使用关键词弱证据判定，置信度标为“低”，不应作为最终验收结论的唯一依据。');
  lines.push('4. PDF 仅解析文本层；扫描件、图片、加密 PDF 无法自动核验，需提供可检索版本或原件。');
  lines.push('5. 报告中的“待确认”不等于通过，需补充证据或由标准方确认判定口径后复验。');
  lines.push('');
  lines.push(`_本报告由昇腾交付核验插件生成，共 ${summary.total} 项比对、${summary.fileCount} 个输入文件。_`);
  return `${lines.join('\n')}\n`;
}

function renderMarkdownItem(item) {
  const lines = [];
  lines.push(`### ${item.id} · ${item.metricLabel}（${item.categoryLabel}）`);
  lines.push('');
  lines.push(`- **状态**：${item.statusLabel}（置信度：${item.confidenceLabel}）`);
  lines.push(`- **标准要求**：${escapeMd(item.requirementText)}`);
  lines.push(`- **实测/交付值**：${item.actual === null ? '未找到' : escapeMd(formatActual(item.actual, item.metricType))}`);
  lines.push(`- **标准依据**：${escapeMd(item.standardBasis)}`);
  lines.push(`- **交付依据**：${escapeMd(item.deliveryBasis)}`);
  lines.push(`- **判定说明**：${escapeMd(item.reason)}`);
  lines.push(`- **建议措施**：${escapeMd(item.recommendation)}`);
  lines.push('');
  return lines;
}

/** 渲染 CSV（UTF-8 BOM，Excel 直接打开不乱码）。 */
export function renderCsvReport(report) {
  const rows = [
    ['编号', '分类', '指标', '标准要求', '运算符', '目标值', '单位', '实测值', '状态', '置信度', '标准依据', '交付依据', '判定说明', '建议措施', '来源文件'],
  ];
  for (const item of report.comparisons) {
    rows.push([
      item.id,
      item.categoryLabel,
      item.metricLabel,
      item.requirementText,
      item.operatorLabel,
      Array.isArray(item.target) ? item.target.join('~') : String(item.target ?? ''),
      item.unit,
      item.actual === null ? '' : formatActual(item.actual, item.metricType),
      item.statusLabel,
      item.confidenceLabel,
      item.standardBasis,
      item.deliveryBasis,
      item.reason,
      item.recommendation,
      item.sourceFile,
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** 渲染可独立打开/打印的 HTML 报告。 */
export function renderHtmlReport(report) {
  const summary = report.summary;
  const failed = report.comparisons.filter((item) => item.status === 'fail');
  const unknown = report.comparisons.filter((item) => item.status === 'unknown');
  const passed = report.comparisons.filter((item) => item.status === 'pass');
  const statusClass = summary.status === 'accepted' ? 'pass' : summary.status === 'needs-remediation' ? 'fail' : 'unknown';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>昇腾交付核验报告</title>
<style>
  :root { --ink:#111827; --muted:#5b6472; --line:#dbe2ea; --bg:#f4f7fa; --card:#fff; --pass:#0f9d63; --fail:#d64545; --unknown:#c58a00; --brand:#c2410c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.65 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif; }
  main { max-width:1080px; margin:0 auto; padding:40px 28px 64px; }
  header { border-bottom:4px solid var(--ink); padding-bottom:20px; margin-bottom:28px; }
  .eyebrow { color:var(--brand); font-weight:700; letter-spacing:.12em; font-size:12px; text-transform:uppercase; }
  h1 { font-size:32px; margin:6px 0 8px; letter-spacing:-.02em; }
  h2 { font-size:20px; margin:38px 0 14px; padding-bottom:8px; border-bottom:1px solid var(--line); }
  h3 { font-size:15px; margin:22px 0 8px; }
  .meta { color:var(--muted); font-size:13px; }
  .verdict { display:flex; gap:18px; align-items:center; padding:18px 20px; margin:22px 0; background:var(--card); border:1px solid var(--line); border-left:6px solid var(--brand); }
  .verdict strong { font-size:18px; }
  .kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin:18px 0 8px; }
  .kpi { background:var(--card); border:1px solid var(--line); padding:14px; }
  .kpi span { display:block; color:var(--muted); font-size:12px; }
  .kpi b { font-size:24px; font-variant-numeric:tabular-nums; }
  .kpi.pass b { color:var(--pass); } .kpi.fail b { color:var(--fail); } .kpi.unknown b { color:var(--unknown); }
  table { width:100%; border-collapse:collapse; background:var(--card); font-size:12.5px; }
  th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#edf2f6; font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); padding:16px 18px; margin:12px 0; page-break-inside:avoid; }
  .card h3 { display:flex; gap:10px; align-items:center; margin-top:0; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#fff; }
  .badge.pass { background:var(--pass); } .badge.fail { background:var(--fail); } .badge.unknown { background:var(--unknown); }
  .basis { background:#f8fafc; border-left:3px solid var(--line); padding:8px 12px; margin:8px 0; color:#374151; }
  .basis b { color:var(--ink); }
  .advice { background:#fff7ed; border-left:3px solid var(--brand); padding:8px 12px; margin:8px 0; }
  .muted { color:var(--muted); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media print { body{background:#fff;} main{padding:0;} .verdict,.kpi,.card{break-inside:avoid;} }
  @media (max-width:760px) { .kpis{grid-template-columns:repeat(2,1fr);} .grid2{grid-template-columns:1fr;} }
</style>
</head>
<body>
<main>
<header>
  <div class="eyebrow">Ascend Delivery Acceptance · 结构化核验</div>
  <h1>昇腾交付核验报告</h1>
  <div class="meta">生成时间：${escapeHtml(formatDate(summary.generatedAt))} · 共 ${summary.fileCount} 个文件 · ${summary.total} 项指标</div>
</header>

<div class="verdict"><span class="badge ${statusClass}">${escapeHtml(summary.status === 'accepted' ? '通过' : summary.status === 'needs-remediation' ? '需整改' : '待补充')}</span><strong>${escapeHtml(summary.verdict)}</strong></div>

<div class="kpis">
  <div class="kpi"><span>标准文件</span><b>${summary.standardFiles}</b></div>
  <div class="kpi"><span>交付件</span><b>${summary.deliveryFiles}</b></div>
  <div class="kpi"><span>比对指标</span><b>${summary.total}</b></div>
  <div class="kpi pass"><span>通过</span><b>${summary.pass}</b></div>
  <div class="kpi fail"><span>不通过</span><b>${summary.fail}</b></div>
  <div class="kpi unknown"><span>待确认</span><b>${summary.unknown}</b></div>
</div>
<p class="muted">总体通过率 ${summary.complianceRate}%（通过 / 全部比对项）；可判定项通过率 ${summary.decidableRate}%（通过 /（通过 + 不通过））。待确认项不计入通过。</p>

<h2>核验文件</h2>
<table><thead><tr><th>角色</th><th>文件</th><th>类型</th><th>大小</th><th>解析</th><th>提取项</th></tr></thead><tbody>
${summary.files.map((file) => `<tr><td>${escapeHtml(file.roleLabel)}</td><td>${escapeHtml(file.name)}</td><td>${escapeHtml(file.kind)}</td><td>${formatBytes(file.size)}</td><td>${file.status === 'parsed' ? '已解析' : escapeHtml(file.error || '失败')}</td><td>${file.extracted}</td></tr>`).join('')}
</tbody></table>

<h2>不通过项（${failed.length}）</h2>
${failed.length === 0 ? '<p class="muted">没有不通过项。</p>' : failed.map((item) => renderHtmlItem(item)).join('')}

<h2>待确认项（${unknown.length}）</h2>
${unknown.length === 0 ? '<p class="muted">没有待确认项。</p>' : unknown.map((item) => renderHtmlItem(item)).join('')}

<h2>通过项明细及依据（${passed.length}）</h2>
${passed.length === 0 ? '<p class="muted">没有通过项。</p>' : `<table><thead><tr><th>编号</th><th>分类</th><th>指标</th><th>标准要求</th><th>交付依据</th><th>判定</th></tr></thead><tbody>${passed.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.categoryLabel)}</td><td>${escapeHtml(item.metricLabel)}</td><td>${escapeHtml(item.requirementText)}</td><td>${escapeHtml(item.deliveryBasis)}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('')}</tbody></table>`}

<h2>分类统计</h2>
<table><thead><tr><th>分类</th><th>总数</th><th>通过</th><th>不通过</th><th>待确认</th><th>通过率</th></tr></thead><tbody>
${Object.values(summary.byCategory).map((stat) => `<tr><td>${escapeHtml(stat.label)}</td><td>${stat.total}</td><td>${stat.pass}</td><td>${stat.fail}</td><td>${stat.unknown}</td><td>${stat.rate}%</td></tr>`).join('')}
</tbody></table>

<h2>判定方法与限制</h2>
<ol class="muted">
  <li>标准条款优先按表格逐行提取，其次按规范措辞分句提取；交付证据优先取实测值列。</li>
  <li>同一指标有多份证据时，数值类按最不利值判定，避免汇总表掩盖现场异常。</li>
  <li>未映射到标准指标的条款使用关键词弱证据，置信度标为“低”，不宜作为最终结论的唯一依据。</li>
  <li>PDF 仅解析文本层；扫描件、图片、加密 PDF 无法自动核验。</li>
  <li>待确认不等于通过，需补证或由标准方确认判定口径后复验。</li>
</ol>
<p class="muted">本报告由 DSH 昇腾交付核验插件生成。</p>
</main>
</body>
</html>`;
}

function renderHtmlItem(item) {
  return `<div class="card">
  <h3><span class="badge ${item.status}">${escapeHtml(item.statusLabel)}</span>${escapeHtml(item.id)} · ${escapeHtml(item.metricLabel)} <span class="muted">/ ${escapeHtml(item.categoryLabel)}</span></h3>
  <div class="grid2">
    <div class="basis"><b>标准要求：</b>${escapeHtml(item.requirementText)}<br><b>标准依据：</b>${escapeHtml(item.standardBasis)}</div>
    <div class="basis"><b>交付值：</b>${item.actual === null ? '未找到' : escapeHtml(formatActual(item.actual, item.metricType))}<br><b>交付依据：</b>${escapeHtml(item.deliveryBasis)}</div>
  </div>
  <p><b>判定说明：</b>${escapeHtml(item.reason)} <span class="muted">（置信度：${escapeHtml(item.confidenceLabel)}）</span></p>
  <div class="advice"><b>建议措施：</b>${escapeHtml(item.recommendation)}</div>
</div>`;
}

function formatActual(actual, metricType) {
  if (actual === null || actual === undefined) return '未找到';
  if (typeof actual.value === 'boolean') {
    if (metricType === 'presence') return actual.value ? '已提供' : '未提供';
    return actual.value ? '正常 / 支持' : '异常 / 不支持';
  }
  const value = Array.isArray(actual.value) ? `${actual.value[0]}~${actual.value[1]}` : actual.value;
  return `${value ?? ''}${actual.unit ?? ''}`.trim();
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return String(value ?? '');
  }
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
