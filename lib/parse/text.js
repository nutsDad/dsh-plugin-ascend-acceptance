/**
 * 文本、CSV、Markdown、HTML 与半结构化行的解析。
 *
 * 所有解析器都统一输出 `blocks`：
 *   { type: 'heading'|'para'|'table'|'page', text, page, section, rows?, headers?, meta? }
 *
 * 上层提取器只依赖 blocks，因此新增一种文件格式时不需要改比对逻辑。
 *
 * @module dsh-plugin-ascend-acceptance/parse/text
 */

/** 常见中文编码的兜底顺序。 */
const DECODERS = ['utf-8', 'gb18030', 'utf-16le', 'utf-16be'];

/**
 * 解码文本，处理 BOM 与 GBK/GB18030 中文文件。
 *
 * @param {Buffer} buffer - 原始字节。
 * @returns {{text: string, encoding: string, replacementRatio: number}}
 */
export function decodeTextBuffer(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le', replacementRatio: 0 };
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be', replacementRatio: 0 };
    }
  }
  const utf8 = buffer.toString('utf8');
  const utf8Bad = countReplacement(utf8);
  if (utf8Bad === 0) return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8', replacementRatio: 0 };

  for (const encoding of DECODERS.slice(1)) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: false });
      const text = decoder.decode(buffer).replace(/^\uFEFF/, '');
      const bad = countReplacement(text);
      if (bad < utf8Bad) return { text, encoding, replacementRatio: bad / Math.max(1, text.length) };
    } catch {
      // 当前 Node 不支持该编码时继续尝试下一个。
    }
  }
  return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8', replacementRatio: utf8Bad / Math.max(1, utf8.length) };
}

function countReplacement(text) {
  let count = 0;
  for (const char of text) if (char === '\uFFFD') count += 1;
  return count;
}

/** 统一换行、去掉零宽字符、压缩过长的空行。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** 把一行按制表符/连续两个以上空格拆成列。 */
export function splitLooseColumns(line) {
  const trimmed = String(line ?? '').trim();
  if (trimmed === '') return [];
  if (trimmed.includes('\t')) return trimmed.split(/\t+/).map((cell) => cell.trim()).filter(Boolean);
  return trimmed.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
}

/** 把一段纯文本拆成带章节信息的 blocks。 */
export function textToBlocks(text, options = {}) {
  const lines = normalizeText(text).split('\n');
  const blocks = [];
  let section = '';
  let page = options.page ?? 1;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join('\n').trim();
    if (joined !== '') blocks.push({ type: 'para', text: joined, page, section });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    // 常见分页符：换页字符或显式“第 N 页”。
    if (line.includes('\f')) {
      flushParagraph();
      page += 1;
      const segments = line.split('\f');
      if (segments[0].trim() !== '') paragraph.push(segments[0].trim());
      flushParagraph();
      for (const segment of segments.slice(1)) if (segment.trim() !== '') paragraph.push(segment.trim());
      continue;
    }

    if (trimmed === '') {
      flushParagraph();
      continue;
    }

    const pageMatch = /^[-—\s]*(?:第\s*)?(\d{1,3})\s*(?:页|\/\s*\d+\s*页)[-—\s]*$/.exec(trimmed);
    if (pageMatch !== null && trimmed.length <= 20) {
      flushParagraph();
      page = Number(pageMatch[1]) || page;
      continue;
    }

    if (isMarkdownTableSeparator(trimmed)) continue;
    if (isMarkdownTableRow(trimmed)) {
      flushParagraph();
      const rows = [];
      while (index < lines.length && isMarkdownTableRow(lines[index].trim())) {
        if (!isMarkdownTableSeparator(lines[index].trim())) rows.push(parseMarkdownRow(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      if (rows.length > 0) {
        blocks.push({
          type: 'table',
          text: rows.map((row) => row.join(' | ')).join('\n'),
          page,
          section,
          rows,
          headers: rows[0],
          meta: { source: 'markdown-table' },
        });
      }
      continue;
    }

    const heading = detectHeading(trimmed, lines[index + 1]);
    if (heading !== null) {
      flushParagraph();
      section = heading.title;
      blocks.push({ type: 'heading', text: heading.title, page, section, level: heading.level });
      continue;
    }

    // 连续的非空行如果像“键：值”或表格行，保留为独立段落；普通正文合并。
    if (isLooseTableLine(trimmed) || looksLikeKeyValue(trimmed)) {
      flushParagraph();
      const columns = splitLooseColumns(trimmed);
      if (columns.length >= 2 && isLooseTableLine(trimmed)) {
        blocks.push({ type: 'para', text: trimmed, page, section, columns });
      } else {
        blocks.push({ type: 'para', text: trimmed, page, section });
      }
    } else {
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  return blocks;
}

function isMarkdownTableRow(line) {
  return line.startsWith('|') && line.endsWith('|') && line.length > 2;
}

function isMarkdownTableSeparator(line) {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line);
}

function parseMarkdownRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function looksLikeKeyValue(line) {
  return /^[\u4e00-\u9fa5A-Za-z0-9（）()_./×*+\- ]{2,48}\s*[:：=]\s*\S/.test(line);
}

function isLooseTableLine(line) {
  if (line.includes('\t')) return line.split('\t').filter((cell) => cell.trim() !== '').length >= 2;
  return /\S\s{2,}\S/.test(line) && line.length <= 240;
}

function detectHeading(line, nextLine = '') {
  if (line.length > 48) return null;
  const markdown = /^(#{1,6})\s+(.+)$/.exec(line);
  if (markdown !== null) return { title: markdown[2].trim(), level: markdown[1].length };
  if (/^[一二三四五六七八九十]+[、.．]/.test(line) && !/[。；;]$/.test(line)) {
    return { title: line, level: 2 };
  }
  if (/^第[一二三四五六七八九十百0-9]+[章节部分]/.test(line) && !/[。；;]$/.test(line)) {
    return { title: line, level: 2 };
  }
  if (/^\d+(?:\.\d+){0,3}\s+\S/.test(line) && !/[。；;]$/.test(line)) {
    return { title: line, level: 3 };
  }
  if (/^\d+(?:\.\d+){1,3}[、.．]?\s*[\u4e00-\u9fa5A-Za-z]/.test(line) && !/[。；;：:]$/.test(line) && nextLine.trim() === '') {
    return { title: line, level: 3 };
  }
  if (line.length <= 24 && !/[。；;，,：:]$/.test(line) && !/\d+(?:\.\d+)?\s*(?:℃|°C|%|GB|TB|kW|W|U|Ω|min|小时)/.test(line)
    && /(?:运行环境|机房|基础设施|交付文档|运维|网络|验收|标准|要求|范围|规范|环境|集群|配置|安全|供电|制冷)/.test(line)) {
    return { title: line, level: 2 };
  }
  return null;
}

/**
 * 解析 CSV/TSV。支持引号、转义引号、单元格内换行。
 *
 * @param {string} text - CSV 文本。
 * @param {{delimiter?: string}} [options] - 强制分隔符。
 * @returns {{headers: string[], rows: string[][], delimiter: string}}
 */
export function parseDelimited(text, options = {}) {
  const sample = text.slice(0, 8192);
  const delimiter = options.delimiter ?? detectDelimiter(sample);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
      continue;
    }
    if (char === delimiter) {
      row.push(cell.trim());
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cell.trim());
  if (row.some((value) => value !== '')) rows.push(row);

  const headers = rows.length > 0 ? rows[0] : [];
  return { headers, rows: rows.slice(1), delimiter };
}

function detectDelimiter(sample) {
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const delimiter of candidates) {
    const lines = sample.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 12);
    if (lines.length === 0) continue;
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const positive = counts.filter((count) => count > 0);
    if (positive.length < Math.max(1, lines.length * 0.6)) continue;
    const avg = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    const variance = counts.reduce((sum, count) => sum + (count - avg) ** 2, 0) / counts.length;
    const score = avg - variance;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) count += 1;
  }
  return count;
}

/** 把二维数组转成 table block。 */
export function matrixToTable(rows, options = {}) {
  const cleaned = rows
    .map((row) => row.map((cell) => String(cell ?? '').replace(/\s+/g, ' ').trim()))
    .filter((row) => row.some((cell) => cell !== ''));
  if (cleaned.length === 0) return null;
  return {
    type: 'table',
    text: cleaned.map((row) => row.join(' | ')).join('\n'),
    rows: cleaned,
    headers: cleaned[0],
    page: options.page ?? 1,
    section: options.section ?? '',
    meta: { source: options.source ?? 'table', sheet: options.sheet, title: options.title },
  };
}

/** 极简 HTML 文本化（不引入 DOM 解析器）。 */
export function htmlToBlocks(html) {
  const withoutNoise = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const blocks = [];
  let section = '';
  const tokenRegex = /<(h[1-6]|table|p|li|div|br)\b[^>]*>([\s\S]*?)<\/\1>|<br\s*\/?>/gi;
  let match;
  let lastIndex = 0;
  while ((match = tokenRegex.exec(withoutNoise)) !== null) {
    if (match.index > lastIndex) {
      const stray = stripHtml(withoutNoise.slice(lastIndex, match.index)).trim();
      if (stray !== '') blocks.push({ type: 'para', text: stray, page: 1, section });
    }
    lastIndex = tokenRegex.lastIndex;
    const tag = (match[1] ?? 'br').toLowerCase();
    const inner = match[2] ?? '';
    if (tag.startsWith('h')) {
      const title = stripHtml(inner).trim();
      if (title !== '') {
        section = title;
        blocks.push({ type: 'heading', text: title, page: 1, section, level: Number(tag[1]) });
      }
    } else if (tag === 'table') {
      const rows = [];
      const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(inner)) !== null) {
        const cells = [];
        const cellRegex = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) cells.push(stripHtml(cellMatch[1]).trim());
        if (cells.some((cell) => cell !== '')) rows.push(cells);
      }
      if (rows.length > 0) {
        blocks.push({ type: 'table', text: rows.map((row) => row.join(' | ')).join('\n'), rows, headers: rows[0], page: 1, section });
      }
    } else if (tag === 'br') {
      blocks.push({ type: 'para', text: '\n', page: 1, section });
    } else {
      const text = stripHtml(inner).replace(/\s+/g, ' ').trim();
      if (text !== '') blocks.push({ type: 'para', text, page: 1, section });
    }
  }
  const tail = stripHtml(withoutNoise.slice(lastIndex)).trim();
  if (tail !== '') blocks.push({ type: 'para', text: tail, page: 1, section });
  return blocks;
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value ?? '').replace(/<[^>]+>/g, ' '));
}

/** 解码常见 HTML/XML 实体。 */
export function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}
