/**
 * 最小 ZIP 读取器。
 *
 * 插件的 DOCX / XLSX / PPTX / ZIP 支持都必须零依赖，因此这里直接读取 ZIP
 * 中央目录，用 Node 自带的 zlib 解压。只支持单卷、无加密的 ZIP；遇到 ZIP64
 * 或未知压缩算法时返回明确错误，由上层把文件标记为“解析失败”，而不是让整个
 * 请求 500。
 *
 * @module dsh-plugin-ascend-acceptance/parse/archive
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** 读取一个 zip 条目。 */
function decodeName(bytes, utf8) {
  if (utf8) return bytes.toString('utf8');
  // 没有 UTF-8 标志时，中文文件名通常是 GBK；失败则退回 latin1。
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/**
 * 解析 ZIP 中央目录。
 *
 * @param {Buffer} buffer - ZIP 文件字节。
 * @returns {{entries: Map<string, {name: string, size: number, compressedSize: number, method: number, offset: number}>, warnings: string[]}}
 */
export function listZipEntries(buffer) {
  const warnings = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('ZIP 文件过小或为空');
  }

  // EOCD 在文件尾部，注释最长 65535 字节。
  const scanStart = Math.max(0, buffer.length - 22 - 65535);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录（文件可能损坏或被截断）');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式，请解压后上传内部文件');
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      warnings.push(`ZIP 中央目录在第 ${index + 1} 项处中断，后续条目已忽略`);
      break;
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(nameBytes, (flags & 0x0800) !== 0);
    if (name !== '') entries.set(name.replace(/\\/g, '/'), { name, size, compressedSize, method, offset, flags });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, warnings };
}

/**
 * 读取并解压一个 ZIP 条目。
 *
 * @param {Buffer} buffer - ZIP 文件字节。
 * @param {{offset: number, method: number, compressedSize: number, size: number, name: string}} entry - 条目。
 * @param {{maxBytes?: number}} [options] - 解压上限。
 * @returns {Buffer} 条目内容。
 */
export function readZipEntry(buffer, entry, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (entry.size > maxBytes) throw new Error(`${entry.name} 解压后超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限`);
  const offset = entry.offset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP 条目 ${entry.name} 的本地文件头无效`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error(`ZIP 条目 ${entry.name} 数据被截断`);
  const data = buffer.subarray(dataStart, dataEnd);

  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`ZIP 条目 ${entry.name} 使用了不支持的压缩算法 ${entry.method}`);
  const inflated = inflateRawSync(data, { maxOutputLength: maxBytes });
  return inflated;
}

/**
 * 一次性读取整个 zip 到 Map（只保留文本/XML 等小文件时使用）。
 *
 * @param {Buffer} buffer - ZIP 字节。
 * @param {{maxEntryBytes?: number}} [options] - 单条目上限。
 * @returns {Map<string, Buffer>} 文件名到内容。
 */
export function unzipToMap(buffer, options = {}) {
  const { entries } = listZipEntries(buffer);
  const map = new Map();
  for (const entry of entries.values()) {
    if (entry.name.endsWith('/')) continue;
    map.set(entry.name, readZipEntry(buffer, entry, { maxBytes: options.maxEntryBytes ?? 32 * 1024 * 1024 }));
  }
  return map;
}

/** 判断 Buffer 是否看起来像 ZIP。 */
export function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;
}
