/**
 * PPTX 解析器（零依赖）。
 *
 * 按幻灯片顺序提取标题、正文与表格；幻灯片备注不进入正文，但会在 meta 中
 * 记录备注数量，方便报告说明“证据来自演示稿第 N 页”。
 *
 * @module dsh-plugin-ascend-acceptance/parse/pptx
 */

import { unzipToMap } from './archive.js';
import { decodeHtmlEntities, matrixToTable } from './text.js';

/** 解析 PPTX。 */
export function parsePptx(buffer) {
  const files = unzipToMap(buffer, { maxEntryBytes: 80 * 1024 * 1024 });
  const slideNames = [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  if (slideNames.length === 0) throw new Error('PPTX 中没有幻灯片');

  const blocks = [];
  let notes = 0;
  slideNames.forEach((name, index) => {
    const page = index + 1;
    const xml = files.get(name).toString('utf8');
    const title = extractTitle(xml) || `第 ${page} 页`;
    blocks.push({ type: 'heading', text: title, page, section: title, level: 2 });

    const tableRegex = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g;
    let tableMatch;
    while ((tableMatch = tableRegex.exec(xml)) !== null) {
      const rows = [];
      const rowRegex = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
        const cells = [];
        const cellRegex = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) cells.push(collectText(cellMatch[1]));
        if (cells.some((cell) => cell !== '')) rows.push(cells);
      }
      const table = matrixToTable(rows, { page, section: title, source: 'pptx-table' });
      if (table !== null) blocks.push(table);
    }

    const paragraphs = extractTextParagraphs(xml);
    for (const paragraph of paragraphs) {
      if (paragraph === '' || paragraph === title) continue;
      blocks.push({ type: 'para', text: paragraph, page, section: title });
    }

    const notesName = `ppt/notesSlides/notesSlide${page}.xml`;
    if (files.has(notesName)) notes += 1;
  });

  return {
    blocks,
    meta: { title: blocks.find((block) => block.type === 'heading')?.text ?? '', slides: slideNames.length, notes },
  };
}

function slideNumber(name) {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function extractTitle(xml) {
  const titleShape = /<p:sp\b[^>]*>[\s\S]*?<p:ph\b[^>]*type="(?:title|ctrTitle)"[^>]*>([\s\S]*?)<\/p:sp>/.exec(xml);
  if (titleShape !== null) {
    const text = collectText(titleShape[1]);
    if (text !== '') return text;
  }
  const first = extractTextParagraphs(xml)[0] ?? '';
  return first.length <= 80 ? first : '';
}

function extractTextParagraphs(xml) {
  const paragraphs = [];
  const regex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = collectText(match[1]);
    if (text !== '') paragraphs.push(text);
  }
  return paragraphs;
}

function collectText(xml) {
  const parts = [];
  const regex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let match;
  while ((match = regex.exec(String(xml ?? ''))) !== null) parts.push(decodeHtmlEntities(match[1]));
  return parts.join('').replace(/\s+/g, ' ').trim();
}
