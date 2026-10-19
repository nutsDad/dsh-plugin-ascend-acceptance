/**
 * DOCX 解析器（零依赖）。
 *
 * 直接读 `word/document.xml`，按文档顺序输出标题、段落和表格；保留 Heading
 * 样式、自动编号文本和分页符，供后续提取“标准条款”与“交付证据”时定位。
 * 图片、批注、修订删除内容不进入文本，避免把修订前的要求误当成现行要求。
 *
 * @module dsh-plugin-ascend-acceptance/parse/docx
 */

import { unzipToMap } from './archive.js';
import { decodeHtmlEntities, matrixToTable } from './text.js';

/** 解析 DOCX。 */
export function parseDocx(buffer) {
  const files = unzipToMap(buffer, { maxEntryBytes: 80 * 1024 * 1024 });
  const documentXml = files.get('word/document.xml');
  if (documentXml === undefined) throw new Error('DOCX 中缺少 word/document.xml（可能是旧版 .doc 或文件损坏）');
  const xml = documentXml.toString('utf8');
  const blocks = [];
  let section = '';
  let page = 1;

  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  const body = bodyMatch?.[1] ?? xml;
  const topBlocks = extractTopLevel(body);

  for (const raw of topBlocks) {
    if (raw.kind === 'p') {
      const paragraph = parseParagraph(raw.xml);
      if (paragraph.pageBreaks > 0) {
        // 分页符出现在本段开头时，本段属于新页。
        page += paragraph.pageBreaks;
      }
      const text = paragraph.text.trim();
      if (text === '') continue;
      const headingLevel = detectHeadingLevel(paragraph.style, text);
      if (headingLevel > 0) {
        section = cleanHeading(text);
        blocks.push({ type: 'heading', text: section, page, section, level: headingLevel });
      } else {
        blocks.push({ type: 'para', text, page, section, style: paragraph.style || undefined });
      }
    } else {
      const rows = parseTable(raw.xml);
      if (rows.length > 0) {
        const table = matrixToTable(rows, { page, section, source: 'docx-table' });
        if (table !== null) blocks.push(table);
      }
    }
  }

  return {
    blocks,
    meta: {
      title: readCoreTitle(files) || firstHeading(blocks) || '',
      creator: readCoreCreator(files),
      paragraphs: blocks.filter((block) => block.type === 'para').length,
      tables: blocks.filter((block) => block.type === 'table').length,
    },
  };
}

/** 提取 body 顶层的 `<w:p>` / `<w:tbl>`，保留顺序。 */
function extractTopLevel(xml) {
  const result = [];
  const tagRegex = /<(\/?)(w:p|w:tbl|w:tr|w:tc)\b[^>]*?(\/?)>/g;
  let depth = 0;
  let start = -1;
  let kind = '';
  let match;
  while ((match = tagRegex.exec(xml)) !== null) {
    const closing = match[1] === '/';
    const tag = match[2];
    const selfClosing = match[3] === '/';
    if (!closing) {
      if (depth === 0) {
        start = match.index;
        kind = tag === 'w:tbl' ? 'tbl' : 'p';
      }
      if (!selfClosing) depth += 1;
      else if (depth === 0) {
        // 自闭合的顶层块，直接产出。
        const end = tagRegex.lastIndex;
        result.push({ kind, xml: xml.slice(start, end) });
        start = -1;
        kind = '';
      }
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        const end = tagRegex.lastIndex;
        result.push({ kind, xml: xml.slice(start, end) });
        start = -1;
        kind = '';
      }
    }
  }
  return result;
}

/** 解析一个 `<w:p>`。 */
function parseParagraph(xml) {
  const style = readParagraphStyle(xml);
  let text = '';
  let pageBreaks = 0;
  const tokenRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b([^>]*?)\/?>|<w:lastRenderedPageBreak\s*\/>/g;
  let match;
  while ((match = tokenRegex.exec(xml)) !== null) {
    if (match[0] === '<w:lastRenderedPageBreak/>' || /^<w:lastRenderedPageBreak/.test(match[0])) {
      pageBreaks += 1;
      text += '\n';
      continue;
    }
    if (match[1] !== undefined) {
      text += decodeHtmlEntities(match[1]).replace(/<[^>]+>/g, '');
      continue;
    }
    const tag = match[2];
    if (tag === 'tab') text += '\t';
    else if (tag === 'br') {
      if (/w:type\s*=\s*"page"/.test(match[3] ?? '')) {
        pageBreaks += 1;
        text += '\n';
      } else {
        text += '\n';
      }
    } else if (tag === 'cr') {
      text += '\n';
    }
  }
  return { text, style, pageBreaks };
}

function readParagraphStyle(xml) {
  const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(xml);
  if (style !== null) return style[1];
  const outline = /<w:outlineLvl\b[^>]*w:val="([0-9])"/.exec(xml);
  if (outline !== null) return `Heading${Number(outline[1]) + 1}`;
  return '';
}

function detectHeadingLevel(style, text) {
  const normalizedStyle = String(style ?? '').toLowerCase();
  const styleMatch = /heading\s*([1-9])/.exec(normalizedStyle);
  if (styleMatch !== null) return Number(styleMatch[1]);
  if (/标题\s*[1-9]/.test(style ?? '')) return Number((/标题\s*([1-9])/.exec(style) ?? [])[1] ?? 2);
  if (/^(?:title|subtitle)$/i.test(style ?? '')) return 1;
  if (text.length <= 40 && /^[一二三四五六七八九十]+[、.．]/.test(text) && !/[。；;]$/.test(text)) return 2;
  if (text.length <= 40 && /^第[一二三四五六七八九十百0-9]+[章节部分]/.test(text) && !/[。；;]$/.test(text)) return 2;
  return 0;
}

function cleanHeading(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 解析 `<w:tbl>` 为二维数组。 */
function parseTable(xml) {
  const rows = [];
  const rowRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const cells = [];
    const cellRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const paragraphs = [];
      const paragraphRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
      let pMatch;
      while ((pMatch = paragraphRegex.exec(cellMatch[1])) !== null) {
        const parsed = parseParagraph(pMatch[0]);
        const text = parsed.text.replace(/\s*\n\s*/g, ' ').trim();
        if (text !== '') paragraphs.push(text);
      }
      let text = paragraphs.join(' ').trim();
      const span = /<w:gridSpan\b[^>]*w:val="([0-9]+)"/.exec(cellMatch[1]);
      const spanCount = span === null ? 1 : Math.max(1, Number(span[1]));
      cells.push(text);
      // 合并单元格会让后续列整体右移；补空列以保持表头对位。
      for (let extra = 1; extra < spanCount; extra += 1) cells.push('');
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells);
  }
  return rows;
}

function readCoreTitle(files) {
  const core = files.get('docProps/core.xml');
  if (core === undefined) return '';
  const match = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core.toString('utf8'));
  return match === null ? '' : decodeHtmlEntities(match[1]).trim();
}

function readCoreCreator(files) {
  const core = files.get('docProps/core.xml');
  if (core === undefined) return '';
  const match = /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(core.toString('utf8'));
  return match === null ? '' : decodeHtmlEntities(match[1]).trim();
}

function firstHeading(blocks) {
  return blocks.find((block) => block.type === 'heading')?.text ?? '';
}
