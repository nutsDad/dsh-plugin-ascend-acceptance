/**
 * 零依赖自测：解析示例 → 结构化提取 → 逐项比对。
 *
 *   node tools/selftest.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareAll } from '../lib/domain/compare.js';
import { extractFacts, extractRequirements } from '../lib/domain/extract.js';
import { compareVersions, parseRequirementExpression } from '../lib/domain/value.js';
import { parseDocument } from '../lib/parse/index.js';
import { SAMPLE_DELIVERY, SAMPLE_STANDARD } from '../lib/samples.js';
import { SessionStore } from '../lib/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadText(name, content) {
  const parsed = parseDocument({ name, buffer: Buffer.from(content, 'utf8') });
  return { id: name, name, ...parsed };
}

function loadFile(relative) {
  const path = join(ROOT, relative);
  const parsed = parseDocument({ name: path.split(/[\\/]/).pop(), buffer: readFileSync(path) });
  return { id: path, name: parsed.name, ...parsed };
}

console.log('ascend-acceptance selftest');

// ---------------------------------------------------------------- Markdown
const mdStandard = loadText('标准.md', SAMPLE_STANDARD);
const mdDelivery = loadText('交付件.md', SAMPLE_DELIVERY);
const mdReq = extractRequirements([mdStandard]);
const mdFacts = extractFacts([mdDelivery]);
check('Markdown 标准解析出 ≥ 45 条要求', () => assert.ok(mdReq.requirements.length >= 45, String(mdReq.requirements.length)));
check('Markdown 交付件解析出 ≥ 50 条证据', () => assert.ok(mdFacts.facts.length >= 50, String(mdFacts.facts.length)));
check('版本号比较正确', () => {
  assert.equal(compareVersions('8.0.RC2', '8.0.RC1'), 1);
  assert.equal(compareVersions('8.0.0', '8.0.RC1'), 1);
  assert.equal(compareVersions('23.0.3', '23.0.3'), 0);
});
check('区间表达式解析正确', () => {
  const expr = parseRequirementExpression('冷通道温度保持在 18 ℃～27 ℃');
  assert.equal(expr.operator, 'range');
  assert.deepEqual(expr.target, [18, 27]);
});
const mdCompare = compareAll({
  requirements: mdReq.requirements,
  facts: mdFacts.facts,
  standardFiles: [mdStandard],
  deliveryFiles: [mdDelivery],
});
check('Markdown 比对包含通过项', () => assert.ok(mdCompare.summary.pass > 0));
check('Markdown 比对包含不通过项', () => assert.ok(mdCompare.summary.fail >= 3, String(mdCompare.summary.fail)));
check('标准不符合项能被识别为不通过', () => {
  const item = mdCompare.comparisons.find((entry) => entry.metricKey === 'rack_power');
  assert.equal(item?.status, 'fail');
});
check('文档缺失能被识别为不通过', () => {
  const item = mdCompare.comparisons.find((entry) => entry.metricKey === 'doc_manual');
  assert.equal(item?.status, 'fail');
});

// -------------------------------------------------------------------- DOCX
const docxPath = 'samples/昇腾交付标准-示例.docx';
let docxReq = null;
check('DOCX 示例存在且能解析', () => {
  const docx = loadFile(docxPath);
  assert.equal(docx.kind, 'Word');
  assert.ok(docx.stats.tables >= 2);
  docxReq = extractRequirements([docx]);
  assert.ok(docxReq.requirements.length >= 30, String(docxReq.requirements.length));
});

// -------------------------------------------------------------------- XLSX
const xlsxPath = 'samples/验收交付件-示例.xlsx';
let xlsxFacts = null;
check('XLSX 示例存在且能解析', () => {
  const xlsx = loadFile(xlsxPath);
  assert.equal(xlsx.kind, 'Excel');
  assert.ok(xlsx.stats.tables >= 3);
  xlsxFacts = extractFacts([xlsx]);
  assert.ok(xlsxFacts.facts.length >= 30, String(xlsxFacts.facts.length));
});

check('DOCX × XLSX 形成完整比对', () => {
  assert.ok(docxReq !== null && xlsxFacts !== null);
  const result = compareAll({
    requirements: docxReq.requirements,
    facts: xlsxFacts.facts,
    standardFiles: [loadFile(docxPath)],
    deliveryFiles: [loadFile(xlsxPath)],
  });
  assert.ok(result.summary.total >= 30);
  assert.ok(result.summary.pass >= 20);
  assert.ok(result.summary.fail >= 3);
});

// --------------------------------------------------------------------- PDF
const pdfPath = join(ROOT, 'samples/昇腾交付标准-示例.pdf');
check('PDF 标准文本层能解析', () => {
  const pdf = loadFile('samples/昇腾交付标准-示例.pdf');
  assert.equal(pdf.meta.parser, 'pdf');
  assert.ok(pdf.stats.chars > 500);
  const req = extractRequirements([pdf]);
  assert.ok(req.requirements.length >= 20, String(req.requirements.length));
});

// ------------------------------------------------------------------- store
check('SessionStore 能完成上传、提取、比对', () => {
  const store = new SessionStore({ maxSessions: 2, ttlMs: 60_000 });
  const session = store.create();
  const standard = store.addFile(session.id, 'standard', {
    name: '标准.md',
    buffer: Buffer.from(SAMPLE_STANDARD, 'utf8'),
  });
  assert.ok(standard.ok);
  const delivery = store.addFile(session.id, 'delivery', {
    name: '交付件.md',
    buffer: Buffer.from(SAMPLE_DELIVERY, 'utf8'),
  });
  assert.ok(delivery.ok);
  const result = store.compare(session.id);
  assert.ok(result.ok);
  assert.equal(result.report.summary.total, mdCompare.summary.total);
  assert.ok(store.stats().sessions >= 1);
});

// ------------------------------------------------------------- unsupported
check('旧版 Office 格式返回可读错误', () => {
  assert.throws(() => parseDocument({
    name: 'legacy.doc',
    buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
  }), /旧版 Office|另存为/);
});

console.log('');
console.log(`passed ${passed}, failed ${failed}`);
if (failed > 0) process.exitCode = 1;
