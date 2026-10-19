/**
 * XLSX 解析器（零依赖）。
 *
 * 读取工作簿、共享字符串与工作表 XML，把每个工作表转换为 table block。
 * 保留隐藏工作表标记，但默认仍解析；验收清单经常把“说明”表隐藏起来，
 * 里面的指标仍然是有效证据。
 *
 * @module dsh-plugin-ascend-acceptance/parse/xlsx
 */

import { unzipToMap } from './archive.js';
import { decodeHtmlEntities, matrixToTable } from './text.js';

const MAX_ROWS = 12000;
const MAX_COLS = 256;

/** 解析 XLSX。 */
export function parseXlsx(buffer) {
  const files = unzipToMap(buffer, { maxEntryBytes: 120 * 1024 * 1024 });
  const workbook = files.get('xl/workbook.xml');
  if (workbook === undefined) throw new Error('XLSX 中缺少 xl/workbook.xml（可能是旧版 .xls 或文件损坏）');

  const sharedStrings = parseSharedStrings(files.get('xl/sharedStrings.xml'));
  const relationships = parseRelationships(files.get('xl/_rels/workbook.xml.rels'));
  const workbookXml = workbook.toString('utf8');
  const sheets = [];
  const sheetRegex = /<sheet\b([^>]*)\/?>/g;
  let match;
  while ((match = sheetRegex.exec(workbookXml)) !== null) {
    const attrs = parseAttributes(match[1]);
    const name = decodeHtmlEntities(attrs.name ?? '');
    const relId = attrs['r:id'] ?? attrs.id ?? '';
    const state = attrs.state ?? 'visible';
    const target = relationships.get(relId) ?? (relId === '' ? '' : `worksheets/${relId}.xml`);
    if (target !== '') sheets.push({ name, relId, state, target });
  }

  if (sheets.length === 0) throw new Error('XLSX 中没有工作表');

  const blocks = [];
  const sheetStats = [];
  let totalRows = 0;
  let truncated = false;

  sheets.forEach((sheet, index) => {
    const path = normalizeSheetPath(sheet.target);
    const xml = files.get(path);
    if (xml === undefined) {
      sheetStats.push({ name: sheet.name, state: sheet.state, rows: 0, cells: 0, missing: true });
      return;
    }
    const parsed = parseSheet(xml.toString('utf8'), sharedStrings);
    totalRows += parsed.rows.length;
    if (parsed.truncatedRows) truncated = true;
    const table = matrixToTable(parsed.rows, {
      page: index + 1,
      section: sheet.name,
      source: 'xlsx-sheet',
      sheet: sheet.name,
      title: sheet.name,
    });
    if (table !== null) {
      table.meta = { ...(table.meta ?? {}), sheetState: sheet.state, truncatedRows: parsed.truncatedRows };
      blocks.push(table);
    }
    // 在表格之前插入工作表标题，便于“章节”定位与阅读。
    blocks.splice(Math.max(0, blocks.length - 1), 0, {
      type: 'heading',
      text: sheet.name,
      page: index + 1,
      section: sheet.name,
      level: 2,
    });
    sheetStats.push({
      name: sheet.name,
      state: sheet.state,
      rows: parsed.rows.length,
      cells: parsed.rows.reduce((sum, row) => sum + row.filter((cell) => cell !== '').length, 0),
      truncatedRows: parsed.truncatedRows,
    });
  });

  return {
    blocks,
    meta: {
      title: sheets[0]?.name ?? '',
      sheets: sheetStats,
      totalRows,
      truncated,
      parser: 'xlsx',
    },
  };
}

function normalizeSheetPath(target) {
  let normalized = String(target ?? '').replace(/\\/g, '/');
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (!normalized.startsWith('xl/')) normalized = `xl/${normalized}`;
  return normalized;
}

function parseRelationships(buffer) {
  const map = new Map();
  if (buffer === undefined) return map;
  const xml = buffer.toString('utf8');
  const regex = /<Relationship\b([^>]*)\/?>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Id !== undefined && attrs.Target !== undefined) map.set(attrs.Id, attrs.Target);
  }
  return map;
}

function parseSharedStrings(buffer) {
  const strings = [];
  if (buffer === undefined) return strings;
  const xml = buffer.toString('utf8');
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = siRegex.exec(xml)) !== null) {
    const parts = [];
    const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let textMatch;
    while ((textMatch = textRegex.exec(match[1])) !== null) parts.push(decodeHtmlEntities(textMatch[1]));
    strings.push(parts.join(''));
  }
  return strings;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  let rowCount = 0;
  let truncatedRows = false;
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let match;
  while ((match = rowRegex.exec(xml)) !== null) {
    rowCount += 1;
    if (rowCount > MAX_ROWS) {
      truncatedRows = true;
      break;
    }
    const rowAttrs = parseAttributes(match[1]);
    const rowNumber = rowAttrs.r === undefined ? rowCount : Number(rowAttrs.r);
    const cells = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(match[2])) !== null) {
      const attrs = parseAttributes(cellMatch[1]);
      const ref = attrs.r ?? '';
      const columnIndex = columnToIndex(ref) ?? cells.length;
      if (columnIndex >= MAX_COLS) continue;
      const type = attrs.t ?? 'n';
      let value = '';
      if (type === 'inlineStr') {
        const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cellMatch[2]);
        value = inline === null ? '' : collectText(inline[1]);
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellMatch[2]);
        const raw = vMatch === null ? '' : decodeHtmlEntities(vMatch[1]).trim();
        if (type === 's') value = sharedStrings[Number(raw)] ?? raw;
        else if (type === 'b') value = raw === '1' ? '是' : raw === '0' ? '否' : raw;
        else value = raw;
      }
      while (cells.length < columnIndex) cells.push('');
      cells[columnIndex] = value.replace(/\s+/g, ' ').trim();
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells);
    if (rowNumber > MAX_ROWS) {
      truncatedRows = true;
      break;
    }
  }
  // 行号可能跳跃；按出现顺序保留，不补空行，避免把版面空白当成数据。
  return { rows, truncatedRows };
}

function collectText(xml) {
  const parts = [];
  const regex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) parts.push(decodeHtmlEntities(match[1]));
  return parts.join('');
}

function columnToIndex(ref) {
  const match = /^([A-Z]+)/i.exec(String(ref ?? ''));
  if (match === null) return undefined;
  let index = 0;
  for (const char of match[1].toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function parseAttributes(source) {
  const attrs = {};
  const regex = /([:\w.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = regex.exec(String(source ?? ''))) !== null) attrs[match[1]] = match[2];
  return attrs;
}
