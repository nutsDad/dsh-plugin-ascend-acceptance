/**
 * PDF 文本层解析器（零依赖）。
 *
 * 目标不是完整实现 PDF 规范，而是把“能复制文字”的交付/标准 PDF 转成带页码
 * 的段落，供验收比对使用。实现覆盖：
 *   * 普通对象、对象流（ObjStm）、FlateDecode / ASCIIHex / ASCII85；
 *   * 页面树、页面资源中的 Type0/简单字体、ToUnicode CMap；
 *   * BT/ET、Tf、Tj、TJ、Td/TD/T*、Tm 等文本操作符。
 *
 * 扫描版 PDF（只有图片、没有文本层）会得到空文本，并返回明确 warning，
 * 由页面提示用户提供可检索版或原始 Word/Excel。
 *
 * @module dsh-plugin-ascend-acceptance/parse/pdf
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

const MAX_OBJECTS = 20000;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_CHARS = 8 * 1024 * 1024;

/** 解析 PDF。 */
export function parsePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('不是有效的 PDF 文件');
  }
  const doc = parseObjects(buffer);
  hydrateObjectStreams(doc);

  const pages = collectPages(doc);
  const blocks = [];
  let chars = 0;
  let pagesWithText = 0;
  const fontsSeen = new Set();

  const targetPages = pages.length > 0 ? pages : fallbackPages(doc);
  targetPages.forEach((page, index) => {
    const pageNumber = page.pageNumber ?? index + 1;
    const content = pageContent(doc, page.object);
    if (content.length === 0) return;
    const fonts = pageFonts(doc, page.object, page.resources);
    for (const font of fonts.values()) fontsSeen.add(font.label);
    const runs = decodeContent(content, fonts);
    const pageBlocks = runsToBlocks(runs, pageNumber);
    if (pageBlocks.length > 0) pagesWithText += 1;
    for (const block of pageBlocks) {
      chars += block.text.length;
      blocks.push(block);
    }
  });

  // 没有页面树时，退化为扫描所有可能的内容流，至少拿到文本。
  if (blocks.length === 0) {
    const streams = [...doc.objects.values()].filter((object) => {
      if (object.stream === undefined) return false;
      const dict = object.dict;
      if (/\/Subtype\s*\/Image/.test(dict) || /\/Type\s*\/(?:Font|ObjStm|XRef|Metadata)/.test(dict)) return false;
      return /\/Length\b/.test(dict);
    }).slice(0, 80);
    for (const stream of streams) {
      let content;
      try {
        content = decodeStream(doc, stream).toString('latin1');
      } catch {
        continue;
      }
      if (!/\bBT\b/.test(content)) continue;
      const runs = decodeContent(content, new Map());
      const pageBlocks = runsToBlocks(runs, 1);
      for (const block of pageBlocks) {
        chars += block.text.length;
        blocks.push(block);
      }
    }
  }

  const warnings = [];
  if (blocks.length === 0 || chars < 20) {
    warnings.push('PDF 未检测到可提取文本层，可能是扫描件/图片型 PDF；请提供可检索 PDF 或 Word/Excel 原件');
  }
  if (pagesWithText > 0 && pagesWithText < targetPages.length) {
    warnings.push(`${targetPages.length - pagesWithText} 页未提取到文本，可能为扫描页或特殊字体`);
  }

  return {
    blocks,
    meta: {
      title: readInfoTitle(doc),
      pages: targetPages.length,
      pagesWithText,
      chars,
      fonts: [...fontsSeen].slice(0, 30),
      hasTextLayer: chars >= 20,
      parser: 'pdf',
    },
    warnings,
  };
}

// --------------------------------------------------------------------------
// 对象解析
// --------------------------------------------------------------------------

function parseObjects(buffer) {
  const text = buffer.toString('latin1');
  const objects = new Map();
  let warnings = 0;
  const regex = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = regex.exec(text)) !== null && objects.size < MAX_OBJECTS) {
    const id = Number(match[1]);
    const generation = Number(match[2]);
    const bodyStart = regex.lastIndex;
    const streamIndex = text.indexOf('stream', bodyStart);
    const endobjIndex = text.indexOf('endobj', bodyStart);
    if (endobjIndex < 0 && streamIndex < 0) break;

    if (streamIndex >= 0 && (endobjIndex < 0 || streamIndex < endobjIndex)) {
      const dict = text.slice(bodyStart, streamIndex);
      let dataStart = streamIndex + 'stream'.length;
      if (text[dataStart] === '\r') dataStart += 1;
      if (text[dataStart] === '\n') dataStart += 1;
      let dataEnd = -1;
      const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      if (lengthMatch !== null) {
        const declared = Number(lengthMatch[1]);
        if (declared >= 0 && dataStart + declared <= buffer.length) dataEnd = dataStart + declared;
      }
      if (dataEnd < 0) {
        const endStream = text.indexOf('endstream', dataStart);
        dataEnd = endStream >= 0 ? endStream : Math.min(buffer.length, dataStart + 1024 * 1024);
      }
      let data = buffer.subarray(dataStart, dataEnd);
      if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) data = data.subarray(0, -2);
      else if (data.length >= 1 && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.subarray(0, -1);
      objects.set(id, { id, generation, dict, stream: data, compressed: false });
      const endStream = text.indexOf('endstream', dataEnd);
      const nextEnd = text.indexOf('endobj', endStream >= 0 ? endStream : dataEnd);
      regex.lastIndex = nextEnd >= 0 ? nextEnd + 6 : dataEnd;
      if (nextEnd < 0) break;
    } else {
      if (endobjIndex < 0) break;
      const dict = text.slice(bodyStart, endobjIndex);
      objects.set(id, { id, generation, dict, stream: undefined, compressed: false });
      regex.lastIndex = endobjIndex + 6;
    }
  }
  if (objects.size === 0) warnings += 1;
  return { objects, warnings, buffer };
}

function hydrateObjectStreams(doc) {
  for (const object of [...doc.objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(object.dict) || object.stream === undefined) continue;
    let decoded;
    try {
      decoded = decodeStream(doc, object);
    } catch {
      continue;
    }
    const header = decoded.subarray(0, Math.min(decoded.length, 256 * 1024)).toString('latin1');
    const n = Number(/\/N\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    if (n <= 0 || first <= 0 || first > decoded.length) continue;
    const numbers = header.slice(0, first).trim().split(/\s+/).map(Number).filter((value) => Number.isFinite(value));
    const pairs = [];
    for (let index = 0; index + 1 < numbers.length && pairs.length < n; index += 2) {
      pairs.push({ id: numbers[index], offset: numbers[index + 1] });
    }
    for (let index = 0; index < pairs.length; index += 1) {
      if (doc.objects.has(pairs[index].id)) continue;
      const start = first + pairs[index].offset;
      const end = index + 1 < pairs.length ? first + pairs[index + 1].offset : decoded.length;
      if (start < 0 || start >= decoded.length || end <= start) continue;
      const body = decoded.subarray(start, end).toString('latin1').trim();
      doc.objects.set(pairs[index].id, { id: pairs[index].id, generation: 0, dict: body, stream: undefined, compressed: true });
    }
  }
}

function resolve(doc, ref) {
  if (ref === undefined || ref === null) return undefined;
  return doc.objects.get(Number(ref));
}

function refFromString(value) {
  // 只接受“整个值就是一个间接引用”的情况。内联字典/数组里也含有
  // `14 0 R`，如果这里不锚定首尾，就会把资源字典误当成它内部的字体对象。
  const match = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(String(value ?? ''));
  return match === null ? undefined : Number(match[1]);
}

function dictValue(dict, key) {
  const index = String(dict ?? '').indexOf(`/${key}`);
  if (index < 0) return '';
  let cursor = index + key.length + 1;
  const source = String(dict);
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source.startsWith('<<', cursor)) {
    let depth = 0;
    for (let position = cursor; position < source.length - 1; position += 1) {
      if (source.startsWith('<<', position)) {
        depth += 1;
        position += 1;
      } else if (source.startsWith('>>', position)) {
        depth -= 1;
        position += 1;
        if (depth === 0) return source.slice(cursor, position + 1);
      }
    }
    return source.slice(cursor);
  }
  if (source[cursor] === '[') {
    let depth = 0;
    for (let position = cursor; position < source.length; position += 1) {
      if (source[position] === '[') depth += 1;
      else if (source[position] === ']') {
        depth -= 1;
        if (depth === 0) return source.slice(cursor, position + 1);
      }
    }
    return source.slice(cursor);
  }
  const token = /^(\d+\s+\d+\s+R|\/[\w#.-]+|<[^>]*>|\([^)]*\)|-?\d+(?:\.\d+)?)/.exec(source.slice(cursor));
  return token === null ? '' : token[1];
}

function pageContent(doc, pageObject) {
  if (pageObject === undefined) return '';
  const contents = dictValue(pageObject.dict, 'Contents');
  const refs = [];
  if (contents.startsWith('[')) {
    const regex = /(\d+)\s+\d+\s+R/g;
    let match;
    while ((match = regex.exec(contents)) !== null) refs.push(Number(match[1]));
  } else {
    const ref = refFromString(contents);
    if (ref !== undefined) refs.push(ref);
  }
  const chunks = [];
  for (const ref of refs) {
    const object = resolve(doc, ref);
    if (object?.stream === undefined) continue;
    try {
      chunks.push(decodeStream(doc, object));
    } catch {
      // 单个内容流损坏不应让整页失败。
    }
  }
  return Buffer.concat(chunks).toString('latin1');
}

function pageFonts(doc, pageObject, inheritedResources = '') {
  const fonts = new Map();
  if (pageObject === undefined) return fonts;
  let resources = dictValue(pageObject.dict, 'Resources') || inheritedResources;
  const resourceRef = refFromString(resources);
  if (resourceRef !== undefined) resources = resolve(doc, resourceRef)?.dict ?? '';
  const fontDict = dictValue(resources, 'Font');
  const fontRef = refFromString(fontDict);
  const actualFontDict = fontRef === undefined ? fontDict : (resolve(doc, fontRef)?.dict ?? '');
  const regex = /\/([A-Za-z0-9#_.-]+)\s+(\d+)\s+\d+\s+R/g;
  let match;
  while ((match = regex.exec(actualFontDict)) !== null) {
    const label = match[1];
    const object = resolve(doc, Number(match[2]));
    if (object === undefined) continue;
    const encoding = dictValue(object.dict, 'Encoding');
    const cmapRef = refFromString(dictValue(object.dict, 'ToUnicode'));
    const twoByte = /\/Subtype\s*\/Type0/.test(object.dict) || /Identity-[HV]/.test(encoding);
    const unicodeCmap = /Uni[A-Z]+-UCS2/i.test(encoding) || /Uni[A-Z]+-UTF16/i.test(encoding);
    let map = new Map();
    let confidence = 0.3;
    if (cmapRef !== undefined) {
      const cmapObject = resolve(doc, cmapRef);
      if (cmapObject?.stream !== undefined) {
        try {
          map = parseCMap(decodeStream(doc, cmapObject).toString('latin1'));
          confidence = map.size > 0 ? 0.92 : 0.3;
        } catch {
          confidence = 0.2;
        }
      }
    }
    fonts.set(label, { label, map, twoByte, unicodeCmap, encoding, confidence, substype: dictValue(object.dict, 'Subtype') });
  }
  return fonts;
}

function collectPages(doc) {
  const pages = [];
  const catalog = [...doc.objects.values()].find((object) => /\/Type\s*\/Catalog/.test(object.dict));
  const rootRef = refFromString(dictValue(catalog?.dict ?? '', 'Pages'));
  const visited = new Set();
  const walk = (ref, inherited, depth) => {
    if (ref === undefined || visited.has(ref) || depth > 40) return;
    visited.add(ref);
    const object = resolve(doc, ref);
    if (object === undefined) return;
    const type = dictValue(object.dict, 'Type');
    const resources = dictValue(object.dict, 'Resources') || inherited;
    if (/\/Page\b/.test(type) && !/\/Pages\b/.test(type)) {
      pages.push({ object, resources, pageNumber: pages.length + 1 });
      return;
    }
    const kids = dictValue(object.dict, 'Kids');
    const regex = /(\d+)\s+\d+\s+R/g;
    let match;
    while ((match = regex.exec(kids)) !== null) walk(Number(match[1]), resources, depth + 1);
  };
  if (rootRef !== undefined) walk(rootRef, '', 0);
  if (pages.length === 0) {
    const all = [...doc.objects.values()]
      .filter((object) => /\/Type\s*\/Page\b/.test(object.dict) && !/\/Type\s*\/Pages\b/.test(object.dict))
      .sort((left, right) => left.id - right.id);
    all.forEach((object, index) => pages.push({ object, resources: '', pageNumber: index + 1 }));
  }
  return pages;
}

function fallbackPages(doc) {
  const pages = [];
  for (const object of doc.objects.values()) {
    if (object.stream === undefined) continue;
    if (/\/Subtype\s*\/Image|\/Type\s*\/(?:Font|ObjStm|XRef|Metadata)/.test(object.dict)) continue;
    pages.push({ object, pageNumber: pages.length + 1 });
  }
  return pages;
}

function readInfoTitle(doc) {
  const info = [...doc.objects.values()].find((object) => /\/Title\s*\(/.test(object.dict));
  if (info === undefined) return '';
  const match = /\/Title\s*\(([^)]*)\)/.exec(info.dict);
  if (match === null) return '';
  const raw = Buffer.from(match[1], 'latin1');
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(raw.subarray(2));
  }
  return decodeLiteralString(raw);
}

// --------------------------------------------------------------------------
// 流解码
// --------------------------------------------------------------------------

function decodeStream(doc, object) {
  let data = Buffer.from(object.stream ?? []);
  if (data.length > MAX_STREAM_BYTES) throw new Error('PDF 流超过大小上限');
  let filter = dictValue(object.dict, 'Filter');
  const filters = [];
  if (filter.startsWith('[')) {
    const regex = /\/([A-Za-z0-9]+)/g;
    let match;
    while ((match = regex.exec(filter)) !== null) filters.push(match[1]);
  } else if (filter.startsWith('/')) {
    filters.push(filter.slice(1));
  }
  let decodeParms = dictValue(object.dict, 'DecodeParms');
  const parmsRef = refFromString(decodeParms);
  if (parmsRef !== undefined) decodeParms = resolve(doc, parmsRef)?.dict ?? '';

  for (const name of filters) {
    if (name === 'FlateDecode' || name === 'Fl') {
      data = inflate(data);
      const predictor = Number(/\/Predictor\s+(\d+)/.exec(decodeParms)?.[1] ?? 1);
      if (predictor >= 10) data = unfilterPng(data, decodeParms);
      else if (predictor === 2) data = unfilterTiff(data, decodeParms);
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      data = decodeAsciiHex(data);
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      data = decodeAscii85(data);
    } else if (name === 'Crypt') {
      // 加密 PDF 无法在无口令时解密；交给上层报错。
      throw new Error('PDF 已加密，暂不支持解析');
    } else {
      throw new Error(`PDF 使用了暂不支持的过滤器 ${name}`);
    }
  }
  object.decoded = data;
  return data;
}

function inflate(data) {
  try {
    return inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
  } catch {
    return inflateRawSync(data, { maxOutputLength: MAX_STREAM_BYTES });
  }
}

function decodeAsciiHex(data) {
  const text = data.toString('latin1').replace(/\s+/g, '').replace(/>$/, '');
  const clean = text.length % 2 === 0 ? text : `${text}0`;
  return Buffer.from(clean, 'hex');
}

function decodeAscii85(data) {
  const text = data.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const output = [];
  let group = [];
  for (const char of text) {
    if (char === 'z' && group.length === 0) {
      output.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    group.push(code);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      output.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length > 0) {
    const length = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    output.push(...bytes.slice(0, length - 1));
  }
  return Buffer.from(output);
}

function unfilterPng(data, parms) {
  const columns = Math.max(1, Number(/\/Columns\s+(\d+)/.exec(parms)?.[1] ?? 1));
  const colors = Math.max(1, Number(/\/Colors\s+(\d+)/.exec(parms)?.[1] ?? 1));
  const bits = Math.max(1, Number(/\/BitsPerComponent\s+(\d+)/.exec(parms)?.[1] ?? 8));
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLength = Math.max(1, Math.ceil((columns * colors * bits) / 8));
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let previous = Buffer.alloc(rowLength);
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * (rowLength + 1)];
    const source = data.subarray(row * (rowLength + 1) + 1, row * (rowLength + 1) + 1 + rowLength);
    const current = Buffer.alloc(rowLength);
    for (let index = 0; index < rowLength; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      switch (filter) {
        case 1:
          current[index] = (source[index] + left) & 0xff;
          break;
        case 2:
          current[index] = (source[index] + up) & 0xff;
          break;
        case 3:
          current[index] = (source[index] + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          current[index] = (source[index] + predictor) & 0xff;
          break;
        }
        default:
          current[index] = source[index];
      }
    }
    current.copy(out, row * rowLength);
    previous = current;
  }
  return out;
}

function unfilterTiff(data, parms) {
  const columns = Math.max(1, Number(/\/Columns\s+(\d+)/.exec(parms)?.[1] ?? 1));
  const colors = Math.max(1, Number(/\/Colors\s+(\d+)/.exec(parms)?.[1] ?? 1));
  const bits = Math.max(1, Number(/\/BitsPerComponent\s+(\d+)/.exec(parms)?.[1] ?? 8));
  const rowLength = Math.max(1, Math.ceil((columns * colors * bits) / 8));
  const rows = Math.floor(data.length / rowLength);
  const out = Buffer.alloc(rows * rowLength);
  for (let row = 0; row < rows; row += 1) {
    for (let index = 0; index < rowLength; index += 1) {
      const left = index > 0 ? out[row * rowLength + index - 1] : 0;
      out[row * rowLength + index] = (data[row * rowLength + index] + left) & 0xff;
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// CMap 与文本解码
// --------------------------------------------------------------------------

function parseCMap(text) {
  const map = new Map();
  const bfcharBlock = /beginbfchar([\s\S]*?)endbfchar/g;
  let block;
  while ((block = bfcharBlock.exec(text)) !== null) {
    const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let pair;
    while ((pair = pairRegex.exec(block[1])) !== null) {
      const code = Number.parseInt(pair[1], 16);
      const value = hexToUnicode(pair[2]);
      if (Number.isFinite(code) && value !== '') map.set(code, value);
    }
  }
  const bfrangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = bfrangeBlock.exec(text)) !== null) {
    const rangeRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g;
    let range;
    while ((range = rangeRegex.exec(block[1])) !== null) {
      const start = Number.parseInt(range[1], 16);
      const end = Number.parseInt(range[2], 16);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 65535) continue;
      if (range[4] !== undefined) {
        const base = range[4];
        for (let code = start; code <= end; code += 1) {
          const value = incrementHexUnicode(base, code - start);
          if (value !== '') map.set(code, value);
        }
      } else {
        const items = [...String(range[5] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)].map((item) => item[1]);
        for (let offset = 0; offset <= end - start && offset < items.length; offset += 1) {
          const value = hexToUnicode(items[offset]);
          if (value !== '') map.set(start + offset, value);
        }
      }
    }
  }
  return map;
}

function hexToUnicode(hex) {
  const clean = String(hex ?? '').replace(/[^0-9A-Fa-f]/g, '');
  if (clean === '') return '';
  const even = clean.length % 2 === 0 ? clean : `${clean}0`;
  const bytes = Buffer.from(even, 'hex');
  // ToUnicode 目的串几乎总是 UTF-16BE；单字节时按 Latin-1 兜底。
  if (bytes.length === 1) return bytes.toString('latin1');
  try {
    return new TextDecoder('utf-16be').decode(bytes).replace(/\u0000/g, '');
  } catch {
    return bytes.toString('latin1');
  }
}

function incrementHexUnicode(base, offset) {
  const clean = String(base ?? '').replace(/[^0-9A-Fa-f]/g, '');
  if (clean === '') return '';
  const even = clean.length % 2 === 0 ? clean : `0${clean}`;
  const bytes = Buffer.from(even, 'hex');
  let value = 0;
  for (const byte of bytes) value = (value << 8) + byte;
  value += offset;
  const width = Math.max(2, even.length);
  const hex = value.toString(16).toUpperCase().padStart(width, '0');
  return hexToUnicode(hex);
}

function decodeLiteralString(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x5c) {
      text += String.fromCharCode(byte);
      continue;
    }
    index += 1;
    const next = bytes[index];
    if (next === undefined) break;
    if (next === 0x6e) text += '\n';
    else if (next === 0x72) text += '\r';
    else if (next === 0x74) text += '\t';
    else if (next === 0x62) text += '\b';
    else if (next === 0x66) text += '\f';
    else if (next >= 0x30 && next <= 0x37) {
      let octal = String.fromCharCode(next);
      for (let extra = 0; extra < 2; extra += 1) {
        const digit = bytes[index + 1];
        if (digit >= 0x30 && digit <= 0x37) {
          octal += String.fromCharCode(digit);
          index += 1;
        } else break;
      }
      text += String.fromCharCode(Number.parseInt(octal, 8));
    } else if (next === 0x0d) {
      if (bytes[index + 1] === 0x0a) index += 1;
      text += '\n';
    } else if (next === 0x0a) text += '\n';
    else text += String.fromCharCode(next);
  }
  return text;
}

function decodePdfBytes(bytes, font) {
  if (bytes.length === 0) return '';
  // UTF-16BE BOM：少数 PDF 会直接在简单字体里写 Unicode。
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // 预定义 UniGB-UCS2-H / UniCNS-UCS2-H 等 CMap 的字符串本身就是 UCS-2，
  // 没有 ToUnicode 也能直接按 UTF-16BE 解码。
  if (font?.unicodeCmap === true) {
    try {
      return new TextDecoder('utf-16be').decode(bytes).replace(/\u0000/g, '');
    } catch {
      // 继续走下面的映射兜底。
    }
  }
  const map = font?.map;
  if (map !== undefined && map.size > 0) {
    const twoByte = font.twoByte === true;
    let text = '';
    if (twoByte) {
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        const code = (bytes[index] << 8) | bytes[index + 1];
        const mapped = map.get(code);
        text += mapped ?? '';
      }
    } else {
      for (const byte of bytes) text += map.get(byte) ?? String.fromCharCode(byte);
    }
    return text;
  }
  // 没有 ToUnicode 时尽量还原 ASCII；中文简单字体常使用 GBK 字节。
  if (bytes.some((byte) => byte > 0x7f)) {
    try {
      const gbk = new TextDecoder('gb18030').decode(bytes);
      if (!gbk.includes('\uFFFD')) return gbk;
    } catch {
      // ignore
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

// --------------------------------------------------------------------------
// 内容流解释
// --------------------------------------------------------------------------

function decodeContent(content, fonts) {
  const scanner = new ContentScanner(content);
  const runs = [];
  let currentFont;
  let tx = 0;
  let ty = 0;
  let leading = 12;
  let operands = [];
  let pendingSpace = false;

  const append = (text) => {
    if (text === '') return;
    runs.push({ text, x: tx, y: ty });
    pendingSpace = false;
  };

  let token = scanner.next();
  while (token !== null) {
    if (token.type === 'operator') {
      const op = token.value;
      if (op === 'Tf') {
        const nameToken = operands[operands.length - 2];
        if (nameToken?.type === 'name') currentFont = fonts.get(nameToken.value);
      } else if (op === 'Tj') {
        const value = operands[operands.length - 1];
        if (value?.type === 'string') {
          if (pendingSpace) append(' ');
          append(decodePdfBytes(value.value, currentFont));
        }
      } else if (op === 'TJ') {
        const array = operands[operands.length - 1];
        if (array?.type === 'array') {
          for (const item of array.value) {
            if (item.type === 'string') {
              if (pendingSpace) append(' ');
              append(decodePdfBytes(item.value, currentFont));
            } else if (item.type === 'number' && item.value <= -120) {
              pendingSpace = true;
            }
          }
        }
      } else if (op === "'") {
        ty -= leading;
        const value = operands[operands.length - 1];
        if (value?.type === 'string') append(decodePdfBytes(value.value, currentFont));
      } else if (op === '"') {
        ty -= leading;
        const value = operands[operands.length - 1];
        if (value?.type === 'string') append(decodePdfBytes(value.value, currentFont));
      } else if (op === 'Td' || op === 'TD') {
        const x = operands[operands.length - 2];
        const y = operands[operands.length - 1];
        if (x?.type === 'number') tx += x.value;
        if (y?.type === 'number') ty += y.value;
        if (op === 'TD' && y?.type === 'number') leading = -y.value;
      } else if (op === 'Tm') {
        const e = operands[operands.length - 2];
        const f = operands[operands.length - 1];
        if (e?.type === 'number') tx = e.value;
        if (f?.type === 'number') ty = f.value;
      } else if (op === 'T*') {
        ty -= leading;
      } else if (op === 'TL') {
        const value = operands[operands.length - 1];
        if (value?.type === 'number') leading = value.value;
      } else if (op === 'BT') {
        tx = 0;
        ty = 0;
      }
      operands = [];
    } else {
      operands.push(token);
      if (operands.length > 64) operands = operands.slice(-64);
    }
    token = scanner.next();
  }
  return runs;
}

/**
 * 把带坐标的文本片段还原成行和表格。
 *
 * PDF 内容流通常按绘制顺序输出，而不是按视觉阅读顺序；直接逐条换行会把一个
 * 表格拆成“序号 / 指标 / 交付要求 / 1 / NPU / 型号 …”。这里按 y 坐标聚成
 * 行、按 x 坐标排序，再根据列间距决定是否拆列；连续的多列行直接还原为表格。
 */
function runsToBlocks(runs, page) {
  const usable = runs
    .filter((run) => run.text !== '' && run.text !== undefined)
    .map((run) => ({ ...run, text: String(run.text) }))
    .filter((run) => run.text.trim() !== '');
  if (usable.length === 0) return [];

  usable.sort((left, right) => (right.y - left.y) || (left.x - right.x));
  const rows = [];
  const tolerance = 3.2;
  for (const run of usable) {
    let row = rows.find((candidate) => Math.abs(candidate.y - run.y) <= tolerance);
    if (row === undefined) {
      row = { y: run.y, runs: [] };
      rows.push(row);
    }
    row.runs.push(run);
  }
  rows.sort((left, right) => right.y - left.y);

  const textRows = rows.map((row) => {
    row.runs.sort((left, right) => left.x - right.x);
    const columns = [];
    let current = '';
    let lastX = null;
    let lastEnd = null;
    for (const run of row.runs) {
      const text = run.text;
      if (text.trim() === '') {
        current += ' ';
        continue;
      }
      const gap = lastEnd === null ? 0 : run.x - lastEnd;
      if (lastX !== null && gap > 18 && current.trim() !== '') {
        columns.push(current.trim());
        current = '';
      } else if (lastEnd !== null && gap > 4 && current !== '' && !/\s$/.test(current) && !/^\s/.test(text)) {
        current += ' ';
      }
      current += text;
      lastX = run.x;
      lastEnd = run.x + Math.max(2, text.length * 4.2);
    }
    if (current.trim() !== '') columns.push(current.trim());
    return { y: row.y, columns: columns.filter((value) => value !== '') };
  }).filter((row) => row.columns.length > 0);

  const blocks = [];
  let section = '';
  let index = 0;
  while (index < textRows.length) {
    const row = textRows[index];
    const line = row.columns.join('  ');
    if (row.columns.length >= 3 && isHeaderLikeColumns(row.columns)) {
      const tableRows = [row.columns];
      let cursor = index + 1;
      while (cursor < textRows.length) {
        const candidate = textRows[cursor];
        if (candidate.columns.length < 2) break;
        if (isHeadingColumns(candidate.columns)) break;
        tableRows.push(candidate.columns);
        cursor += 1;
      }
      if (tableRows.length >= 2) {
        blocks.push({
          type: 'table',
          text: tableRows.map((cells) => cells.join(' | ')).join('\n'),
          rows: tableRows,
          headers: tableRows[0],
          page,
          section,
          meta: { source: 'pdf-table' },
        });
        index = cursor;
        continue;
      }
    }

    if (row.columns.length >= 3) {
      // 没有明确表头但版面是表格：连续的多列行也聚合为表格，后续按“指标名 +
      // 值”兜底提取，比拆成几十个单行段落可靠。
      const tableRows = [row.columns];
      let cursor = index + 1;
      while (cursor < textRows.length && textRows[cursor].columns.length >= 2) {
        if (isHeadingColumns(textRows[cursor].columns)) break;
        tableRows.push(textRows[cursor].columns);
        cursor += 1;
      }
      if (tableRows.length >= 2) {
        blocks.push({
          type: 'table',
          text: tableRows.map((cells) => cells.join(' | ')).join('\n'),
          rows: tableRows,
          headers: tableRows[0],
          page,
          section,
          meta: { source: 'pdf-table' },
        });
        index = cursor;
        continue;
      }
    }

    if (row.columns.length === 1) {
      const text = row.columns[0];
      const heading = /^(?:[一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十0-9]+[章节部分]|\d+(?:\.\d+){0,3}\s+\S)/.test(text)
        || (text.length <= 36 && !/[。；;，,：:]$/.test(text) && /(?:运行环境|机房|基础设施|交付文档|运维|网络|验收|标准|要求|范围|规范|环境|集群|配置|安全|供电|制冷)/.test(text));
      if (heading) {
        section = text;
        blocks.push({ type: 'heading', text, page, section, level: 2 });
      } else {
        blocks.push({ type: 'para', text, page, section });
      }
    } else {
      blocks.push({ type: 'para', text: line, page, section, columns: row.columns });
    }
    index += 1;
  }

  // PDF 的单元格换行经常把 “27℃”“作手册” 放到下一行。这里做两类保守合并：
  //   1. 表格后紧跟的“单位数值”补到上一行含 ~ 的单元格；
  //   2. 上一段未以句号结束、当前段又很短时，视为同一段的续行。
  const mergedBlocks = [];
  for (const block of blocks) {
    const previous = mergedBlocks[mergedBlocks.length - 1];
    const text = String(block.text ?? '').trim();
    if (previous?.type === 'table' && block.type === 'para' && !block.columns
      && /^[-+]?\d+(?:\.\d+)?\s*(?:℃|°C|%|GB|TB|kW|W|U|Ω|min|分钟|小时|年|月)?$/.test(text)) {
      const lastRow = previous.rows[previous.rows.length - 1];
      const separator = lastRow.findIndex((cell) => /^[~～]$/.test(String(cell).trim()));
      if (separator >= 0) lastRow[separator] = `${lastRow[separator]}${text}`;
      else lastRow[lastRow.length - 1] = `${lastRow[lastRow.length - 1]} ${text}`;
      previous.text = previous.rows.map((cells) => cells.join(' | ')).join('\n');
      continue;
    }
    if (previous?.type === 'para' && block.type === 'para' && !previous.columns && !block.columns
      && previous.text.length >= 8 && !/[。；;.!?]$/.test(previous.text) && text.length <= 12) {
      previous.text = `${previous.text}${text}`;
      continue;
    }
    mergedBlocks.push(block);
  }
  return mergedBlocks;
}

function isHeaderLikeColumns(columns) {
  const joined = columns.join(' ');
  return /(?:序号|编号|指标|项目|要求|标准|实测|结果|验证方法|检查项)/.test(joined)
    && columns.length >= 3
    && joined.length <= 80;
}

function isHeadingColumns(columns) {
  if (columns.length !== 1) return false;
  const text = columns[0];
  return text.length <= 40 && /^(?:[一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十0-9]+[章节部分]|\d+(?:\.\d+){0,3}\s+\S)/.test(text);
}

class ContentScanner {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  next() {
    this.skipSpace();
    if (this.index >= this.source.length) return null;
    const char = this.source[this.index];

    if (char === '(') return { type: 'string', value: this.readLiteralString() };
    if (char === '[') return { type: 'array', value: this.readArray() };
    if (char === '<') {
      if (this.source[this.index + 1] === '<') {
        this.skipDictionary();
        return this.next();
      }
      return { type: 'string', value: this.readHexString() };
    }
    if (char === '/') return { type: 'name', value: this.readName() };
    if (char === ']' || char === '>' || char === ')' || char === '{' || char === '}') {
      this.index += 1;
      return this.next();
    }
    if (char === '+' || char === '-' || char === '.' || /[0-9]/.test(char)) {
      const value = this.readNumber();
      if (value !== null) return { type: 'number', value };
    }
    if (char === "'" || char === '"') {
      this.index += 1;
      return { type: 'operator', value: char };
    }
    const word = this.readWord();
    if (word === '') {
      this.index += 1;
      return this.next();
    }
    return { type: 'operator', value: word };
  }

  skipSpace() {
    for (;;) {
      while (this.index < this.source.length && /[\s\u0000]/.test(this.source[this.index])) this.index += 1;
      if (this.source[this.index] === '%') {
        while (this.index < this.source.length && this.source[this.index] !== '\n' && this.source[this.index] !== '\r') this.index += 1;
        continue;
      }
      break;
    }
  }

  readLiteralString() {
    this.index += 1;
    const bytes = [];
    let depth = 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '\\') {
        this.index += 1;
        const next = this.source[this.index];
        if (next === undefined) break;
        if (next === 'n') bytes.push(0x0a);
        else if (next === 'r') bytes.push(0x0d);
        else if (next === 't') bytes.push(0x09);
        else if (next === 'b') bytes.push(0x08);
        else if (next === 'f') bytes.push(0x0c);
        else if (next === '(' || next === ')' || next === '\\') bytes.push(next.charCodeAt(0));
        else if (next === '\r') {
          if (this.source[this.index + 1] === '\n') this.index += 1;
        } else if (next === '\n') {
          // 行尾续行，不产生字符。
        } else if (next >= '0' && next <= '7') {
          let octal = next;
          for (let extra = 0; extra < 2; extra += 1) {
            const digit = this.source[this.index + 1];
            if (digit >= '0' && digit <= '7') {
              octal += digit;
              this.index += 1;
            } else break;
          }
          bytes.push(Number.parseInt(octal, 8) & 0xff);
        } else {
          bytes.push(next.charCodeAt(0));
        }
        this.index += 1;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          this.index += 1;
          break;
        }
      }
      bytes.push(char.charCodeAt(0) & 0xff);
      this.index += 1;
    }
    return Uint8Array.from(bytes);
  }

  readHexString() {
    this.index += 1;
    let hex = '';
    while (this.index < this.source.length && this.source[this.index] !== '>') {
      const char = this.source[this.index];
      if (/[0-9A-Fa-f]/.test(char)) hex += char;
      this.index += 1;
    }
    this.index += 1;
    if (hex.length % 2 === 1) hex += '0';
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }

  readArray() {
    this.index += 1;
    const items = [];
    for (;;) {
      this.skipSpace();
      if (this.index >= this.source.length) break;
      if (this.source[this.index] === ']') {
        this.index += 1;
        break;
      }
      const token = this.next();
      if (token === null) break;
      if (token.type === 'operator' && token.value === ']') break;
      items.push(token);
      if (items.length > 4000) break;
    }
    return items;
  }

  readName() {
    this.index += 1;
    let name = '';
    while (this.index < this.source.length && !/[\s/<>[\]()]/.test(this.source[this.index])) {
      name += this.source[this.index];
      this.index += 1;
    }
    return name;
  }

  readNumber() {
    const start = this.index;
    if (this.source[this.index] === '+' || this.source[this.index] === '-') this.index += 1;
    let digits = 0;
    while (this.index < this.source.length && /[0-9]/.test(this.source[this.index])) {
      this.index += 1;
      digits += 1;
    }
    if (this.source[this.index] === '.') {
      this.index += 1;
      while (this.index < this.source.length && /[0-9]/.test(this.source[this.index])) {
        this.index += 1;
        digits += 1;
      }
    }
    if (digits === 0) {
      this.index = start + 1;
      return null;
    }
    const value = Number(this.source.slice(start, this.index));
    return Number.isFinite(value) ? value : null;
  }

  readWord() {
    const start = this.index;
    while (this.index < this.source.length && !/[\s\u0000()<>[\]{}/%]/.test(this.source[this.index])) this.index += 1;
    return this.source.slice(start, this.index);
  }

  skipDictionary() {
    let depth = 0;
    while (this.index < this.source.length) {
      if (this.source.startsWith('<<', this.index)) {
        depth += 1;
        this.index += 2;
      } else if (this.source.startsWith('>>', this.index)) {
        depth -= 1;
        this.index += 2;
        if (depth <= 0) break;
      } else {
        this.index += 1;
      }
    }
  }
}

