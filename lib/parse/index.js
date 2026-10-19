/**
 * 文档解析入口：按文件签名/扩展名选择解析器，并统一输出 blocks + 文本。
 *
 * 支持：
 *   DOCX / XLSX / PPTX / PDF / CSV / TSV / Markdown / TXT / HTML / JSON / YAML
 *   以及包含上述文件的 ZIP 包（会展开成多条文件记录）。
 *
 * @module dsh-plugin-ascend-acceptance/parse
 */

import { basename, extname } from 'node:path';

import { listZipEntries, looksLikeZip, readZipEntry } from './archive.js';
import { parseDocx } from './docx.js';
import { parsePdf } from './pdf.js';
import { parsePptx } from './pptx.js';
import {
  decodeTextBuffer,
  htmlToBlocks,
  matrixToTable,
  normalizeText,
  parseDelimited,
  textToBlocks,
} from './text.js';
import { parseXlsx } from './xlsx.js';

export const SUPPORTED_EXTENSIONS = [
  '.docx', '.xlsx', '.pptx', '.pdf', '.csv', '.tsv', '.md', '.markdown', '.txt', '.log',
  '.html', '.htm', '.json', '.yaml', '.yml', '.xml', '.zip',
];

const EXTENSION_LABELS = {
  '.docx': 'Word',
  '.xlsx': 'Excel',
  '.pptx': 'PowerPoint',
  '.pdf': 'PDF',
  '.csv': 'CSV',
  '.tsv': 'TSV',
  '.md': 'Markdown',
  '.markdown': 'Markdown',
  '.txt': '文本',
  '.log': '日志',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.xml': 'XML',
  '.zip': 'ZIP 包',
};

/**
 * 解析一个上传文件。
 *
 * @param {{buffer: Buffer, name: string, mime?: string, size?: number}} input - 文件。
 * @returns {{archive?: boolean, children?: object[], blocks?: object[], text?: string, meta?: object, warnings?: string[], kind?: string, ext?: string, stats?: object}}
 */
export function parseDocument(input) {
  const name = String(input.name ?? '未命名文件');
  const ext = extname(name).toLowerCase();
  const buffer = input.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('文件为空');

  // 先按签名识别，避免扩展名写错时把 DOCX 当文本。
  if (looksLikeZip(buffer)) {
    const { entries } = listZipEntries(buffer);
    if (entries.has('word/document.xml')) return finalize(parseDocx(buffer), ext || '.docx', name);
    if (entries.has('xl/workbook.xml')) return finalize(parseXlsx(buffer), ext || '.xlsx', name);
    if ([...entries.keys()].some((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))) {
      return finalize(parsePptx(buffer), ext || '.pptx', name);
    }
    if (ext === '.zip' || ext === '') return expandZip(buffer, name, entries);
    throw new Error('ZIP 包中未找到可识别的 Office 文档');
  }

  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-' || ext === '.pdf') {
    const parsed = parsePdf(buffer);
    return finalize(parsed, '.pdf', name);
  }

  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0 && buffer.readUInt32BE(4) === 0xa1b11ae1) {
    throw new Error('这是旧版 Office 二进制格式（.doc/.xls/.ppt），请在 Office 中另存为 .docx/.xlsx/.pptx 后上传');
  }

  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    throw new Error(`文件扩展名为 ${ext}，但内容不是有效的 Office Open XML 包（可能已损坏或被改后缀）`);
  }

  if (ext === '.zip') throw new Error('ZIP 包为空或格式无效');

  if (ext === '.csv' || ext === '.tsv') {
    const decoded = decodeTextBuffer(buffer);
    const parsed = parseDelimited(decoded.text, { delimiter: ext === '.tsv' ? '\t' : undefined });
    const table = matrixToTable([parsed.headers, ...parsed.rows], { source: 'csv', title: name });
    const blocks = table === null ? [] : [table];
    return finalize({
      blocks,
      meta: {
        title: name,
        delimiter: parsed.delimiter,
        rows: parsed.rows.length,
        columns: parsed.headers.length,
        encoding: decoded.encoding,
      },
      warnings: decoded.replacementRatio > 0.02 ? ['文本中存在较多不可解码字符，请确认文件编码（UTF-8/GBK）'] : [],
    }, ext, name, decoded.text);
  }

  if (ext === '.html' || ext === '.htm') {
    const decoded = decodeTextBuffer(buffer);
    const blocks = htmlToBlocks(decoded.text);
    return finalize({ blocks, meta: { title: name, encoding: decoded.encoding } }, ext, name);
  }

  if (ext === '.json') {
    const decoded = decodeTextBuffer(buffer);
    const blocks = jsonToBlocks(decoded.text);
    return finalize({ blocks, meta: { title: name, encoding: decoded.encoding } }, ext, name);
  }

  // 其余按文本处理；未知扩展名只有“看起来像文本”才接受。
  const decoded = decodeTextBuffer(buffer);
  if (isLikelyBinary(buffer) && ext !== '.txt' && ext !== '.md' && ext !== '.markdown' && ext !== '.log' && ext !== '.yaml' && ext !== '.yml' && ext !== '.xml') {
    throw new Error(`暂不支持 ${ext || '该'} 格式；请上传 DOCX/XLSX/PPTX/PDF/CSV/Markdown/TXT/ZIP`);
  }
  const blocks = textToBlocks(decoded.text);
  return finalize({
    blocks,
    meta: { title: name, encoding: decoded.encoding },
    warnings: decoded.replacementRatio > 0.02 ? ['文本中存在较多不可解码字符，请确认文件编码（UTF-8/GBK）'] : [],
  }, ext || '.txt', name);
}

function expandZip(buffer, name, entries) {
  const children = [];
  const warnings = [];
  const limit = 24;
  const candidates = [...entries.values()]
    .filter((entry) => !entry.name.endsWith('/'))
    .filter((entry) => !entry.name.startsWith('__MACOSX/') && !/(^|\/)\._/.test(entry.name))
    .filter((entry) => SUPPORTED_EXTENSIONS.includes(extname(entry.name).toLowerCase()))
    .slice(0, limit);
  if (candidates.length === 0) throw new Error('ZIP 包中没有支持的文件（DOCX/XLSX/PPTX/PDF/CSV/MD/TXT）');
  if (entries.size > candidates.length) warnings.push(`ZIP 中共 ${entries.size} 个条目，仅解析前 ${candidates.length} 个受支持文件`);
  for (const entry of candidates) {
    try {
      const childBuffer = readZipEntry(buffer, entry, { maxBytes: 48 * 1024 * 1024 });
      const parsed = parseDocument({ buffer: childBuffer, name: `${name}/${basename(entry.name)}` });
      children.push(parsed);
    } catch (error) {
      warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (children.length === 0) throw new Error(`ZIP 内文件均解析失败：${warnings.join('；')}`);
  return { archive: true, children, warnings };
}

function finalize(parsed, ext, name, overrideText) {
  const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  const text = normalizeText(overrideText ?? blocks.map((block) => block.text).join('\n'));
  const stats = {
    chars: text.length,
    paragraphs: blocks.filter((block) => block.type === 'para').length,
    headings: blocks.filter((block) => block.type === 'heading').length,
    tables: blocks.filter((block) => block.type === 'table').length,
    pages: blocks.reduce((max, block) => Math.max(max, Number(block.page) || 1), 1),
  };
  return {
    kind: EXTENSION_LABELS[ext] ?? (ext.replace('.', '').toUpperCase() || '文本'),
    ext: ext || '.txt',
    name,
    blocks,
    text,
    stats,
    meta: { ...(parsed.meta ?? {}), fileName: name },
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

function jsonToBlocks(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return textToBlocks(text);
  }
  const blocks = [
    { type: 'heading', text: 'JSON 数据', page: 1, section: 'JSON 数据', level: 1 },
  ];
  const walk = (node, path, depth) => {
    if (depth > 5) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, path === '' ? key : `${path}.${key}`, depth + 1);
      return;
    }
    if (node === null || node === undefined) return;
    blocks.push({ type: 'para', text: `${path}: ${String(node)}`, page: 1, section: 'JSON 数据', columns: [path, String(node)] });
  };
  walk(value, '', 0);
  return blocks;
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / Math.max(1, sample.length) > 0.12;
}

export { parseDocx, parseXlsx, parsePptx, parsePdf };
