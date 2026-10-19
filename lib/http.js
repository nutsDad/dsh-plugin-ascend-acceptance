/**
 * HTTP 基础工具：有界请求体、JSON/文本/二进制响应、静态文件与 HTML 转义。
 *
 * 插件自己持有 DSH webServer 的一个 URL 前缀，不引入 Express 等依赖，因此这里
 * 保持最小实现；所有上传都在读取过程中执行字节上限，避免超大文件先占满内存。
 *
 * @module dsh-plugin-ascend-acceptance/http
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 发送 JSON。 */
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** 发送文本。 */
export function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** 发送二进制。 */
export function sendBuffer(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

/** 发送 HTML。 */
export function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 读取请求体，超过上限立即销毁连接。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} maxBytes - 上限。
 * @returns {Promise<{buffer: Buffer, tooLarge: boolean, bytes: number, aborted: boolean}>}
 */
export async function readBody(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  let aborted = false;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        req.destroy();
        break;
      }
      chunks.push(chunk);
    }
  } catch {
    aborted = true;
  }
  return { buffer: Buffer.concat(chunks), tooLarge, bytes, aborted };
}

/** 读取并解析 JSON。 */
export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const body = await readBody(req, maxBytes);
  if (body.tooLarge) return { ok: false, tooLarge: true, error: `请求体超过 ${formatBytes(maxBytes)} 上限` };
  if (body.bytes === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.buffer.toString('utf8')) };
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 从静态根目录服务文件，拒绝目录穿越。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {string} root - 静态根目录。
 * @param {string} pathname - 相对路径。
 * @param {{fallback?: string}} [options] - 目录默认文件。
 * @returns {Promise<boolean>} 是否命中。
 */
export async function serveStaticFile(res, root, pathname, options = {}) {
  const resolvedRoot = resolve(root);
  let target = resolve(normalize(join(resolvedRoot, pathname)));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    res.writeHead(403);
    res.end();
    return true;
  }
  let info = await stat(target).catch(() => undefined);
  if (info?.isDirectory() === true) {
    target = join(target, options.fallback ?? 'index.html');
    info = await stat(target).catch(() => undefined);
  }
  if (info === undefined || !info.isFile()) return false;
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
    'content-length': info.size,
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(target);
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
    stream.pipe(res);
  });
  return true;
}

/** HTML 转义。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 人类可读字节数。 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 从 Content-Disposition 安全地生成下载文件名。 */
export function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 节流日志，避免页面轮询刷屏。 */
export function createThrottledLogger(logger, windowMs = 4000) {
  const seen = new Map();
  return (message, key = message) => {
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) {
      seen.set(`${key}:suppressed`, (seen.get(`${key}:suppressed`) ?? 0) + 1);
      return;
    }
    const suppressed = seen.get(`${key}:suppressed`) ?? 0;
    seen.set(key, now);
    seen.delete(`${key}:suppressed`);
    logger.info?.(suppressed > 0 ? `${message}（忽略 ${suppressed} 条同类日志）` : message);
  };
}
