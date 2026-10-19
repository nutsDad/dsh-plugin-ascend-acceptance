/**
 * 昇腾交付核验 — host half。
 *
 * 一个双端 DSH 插件：本模块注册 webServer 路由、解析上传、执行比对并输出报告；
 * 浏览器端（lib/client.js）只在会话侧边栏放一个入口，真正的 UI 是这里服务的
 * 独立页面 `web/`。
 *
 * API:
 *   POST   /api/sessions
 *   GET    /api/sessions/:id
 *   POST   /api/sessions/:id/files?role=standard|delivery&name=...
 *   DELETE /api/sessions/:id/files/:fileId?role=...
 *   POST   /api/sessions/:id/sample
 *   POST   /api/sessions/:id/compare
 *   GET    /api/sessions/:id/extraction?role=...
 *   GET    /api/sessions/:id/report[.md|.csv|.html]
 *   POST   /api/sessions/:id/reset
 *
 * @module dsh-plugin-ascend-acceptance
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogSummary, CATEGORIES, METRICS } from './domain/catalog.js';
import { renderCsvReport, renderHtmlReport, renderMarkdownReport } from './domain/report.js';
import {
  contentDisposition,
  createThrottledLogger,
  formatBytes,
  readBody,
  readJsonBody,
  sendBuffer,
  sendHtml,
  sendJson,
  sendText,
  serveStaticFile,
} from './http.js';
import { sampleFiles } from './samples.js';
import { SessionStore, sessionSummary } from './store.js';

/** 稳定 Cordis 插件名。 */
export const name = 'ascend-acceptance';

/** 需要 webServer 才能注册路由。 */
export const inject = ['webServer'];

/** 默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  routePrefix: '/ascend-acceptance',
  maxUploadBytes: 50 * 1024 * 1024,
  maxFilesPerRole: 30,
  maxRequirements: 800,
  maxFacts: 2400,
  sessionTtlMs: 2 * 60 * 60 * 1000,
  maxSessions: 12,
});

const VERSION = readVersion();
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(MODULE_DIR, '..');

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 挂载插件。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [userConfig] - bundle patch 行配置。
 * @returns {object} 插件句柄。
 */
export function apply(ctx, userConfig = {}) {
  try {
    return mount(ctx, userConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (ctx?.logger ?? console).error?.(`ascend-acceptance: activation failed — ${message}`);
    return { disabled: true, error: message };
  }
}

function mount(ctx, userConfig) {
  const config = normalizeConfig(userConfig);
  const prefix = normalizePrefix(config.routePrefix);
  const assetRoot = join(PACKAGE_DIR, 'web');
  const log = createThrottledLogger(ctx.logger ?? console);
  const store = new SessionStore({
    maxSessions: config.maxSessions,
    ttlMs: config.sessionTtlMs,
    maxRequirements: config.maxRequirements,
    maxFacts: config.maxFacts,
    maxFilesPerRole: config.maxFilesPerRole,
  });

  if (!existsSync(join(assetRoot, 'index.html'))) {
    log(`ascend-acceptance: 前端资源缺失（${assetRoot}），页面将无法加载`);
  }

  const handler = createHandler({ config, prefix, assetRoot, store, log });

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: prefix, handler }),
    `ascend-acceptance: 核验页面位于 ${prefix}/`,
  );

  // 把前缀和真实 origin 注入浏览器壳，客户端入口不需要硬编码端口。
  ctx.effect(() => ctx.on('webserver/index-inject', (rows) => {
    const host = ctx.webServer?.host ?? '127.0.0.1';
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    rows.push({
      kind: 'global',
      name: '__ASCEND_ACCEPTANCE__',
      value: {
        routePrefix: prefix,
        origin: port > 0 ? `http://${host}:${port}` : '',
        baseUrl: port > 0 ? `http://${host}:${port}${prefix}/` : '',
        host,
        port,
        title: '昇腾交付核验',
        version: VERSION,
      },
    });
  }), 'ascend-acceptance: index global');

  ctx.logger?.info?.(`ascend-acceptance: 交付核验页面位于 ${prefix}/`);
  return {
    store,
    routePrefix: prefix,
    version: VERSION,
    compare: (id) => store.compare(id),
    sessionSummary,
  };
}

function normalizePrefix(value) {
  const raw = String(value ?? DEFAULT_CONFIG.routePrefix).trim();
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function normalizeConfig(userConfig) {
  const merged = { ...DEFAULT_CONFIG, ...(userConfig ?? {}) };
  merged.maxUploadBytes = clampNumber(merged.maxUploadBytes, 1024 * 1024, 512 * 1024 * 1024, DEFAULT_CONFIG.maxUploadBytes);
  merged.maxFilesPerRole = clampNumber(merged.maxFilesPerRole, 1, 100, DEFAULT_CONFIG.maxFilesPerRole);
  merged.maxRequirements = clampNumber(merged.maxRequirements, 50, 5000, DEFAULT_CONFIG.maxRequirements);
  merged.maxFacts = clampNumber(merged.maxFacts, 50, 10000, DEFAULT_CONFIG.maxFacts);
  merged.maxSessions = clampNumber(merged.maxSessions, 1, 100, DEFAULT_CONFIG.maxSessions);
  merged.sessionTtlMs = clampNumber(merged.sessionTtlMs, 60_000, 24 * 60 * 60 * 1000, DEFAULT_CONFIG.sessionTtlMs);
  merged.routePrefix = normalizePrefix(merged.routePrefix);
  return merged;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/**
 * 创建请求处理器。导出供开发服务器和自测复用。
 */
export function createHandler({ config, prefix, assetRoot, store, log = console.log }) {
  return async function handler(req, res) {
    const method = req.method ?? 'GET';
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://dsh.invalid');
    } catch {
      sendJson(res, 400, { error: '无效的请求地址' });
      return;
    }
    let path = url.pathname;
    if (path === prefix) path = '/';
    else if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
    else if (path === '/') path = '/';
    else {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    try {
      if (path === '/' || path === '/index.html') {
        await serveStaticFile(res, assetRoot, 'index.html', { fallback: 'index.html' });
        return;
      }
      if (!path.startsWith('/api/')) {
        const served = await serveStaticFile(res, assetRoot, path.replace(/^\/+/, ''));
        if (!served) {
          if (method === 'GET' && acceptsHtml(req)) {
            await serveStaticFile(res, assetRoot, 'index.html', { fallback: 'index.html' });
          } else {
            sendJson(res, 404, { error: 'not found' });
          }
        }
        return;
      }
      await handleApi({ req, res, url, path: path.slice('/api'.length), config, store, log, prefix });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`ascend-acceptance: 处理 ${path} 失败 — ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  };
}

async function handleApi({ req, res, url, path, config, store, log, prefix }) {
  const method = req.method ?? 'GET';

  if (path === '/health' && method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      plugin: name,
      version: VERSION,
      routePrefix: prefix,
      catalog: catalogSummary(),
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        maxFilesPerRole: config.maxFilesPerRole,
        maxRequirements: config.maxRequirements,
        maxFacts: config.maxFacts,
        maxSessions: config.maxSessions,
        sessionTtlMs: config.sessionTtlMs,
      },
      store: store.stats(),
    });
    return;
  }

  if (path === '/catalog' && method === 'GET') {
    sendJson(res, 200, {
      ...catalogSummary(),
      categories: CATEGORIES,
      metrics: METRICS.map((metric) => ({
        key: metric.key,
        label: metric.label,
        category: metric.category,
        categoryLabel: metric.categoryLabel,
        type: metric.type,
        aliases: metric.aliases,
        evidence: metric.evidence,
      })),
    });
    return;
  }

  if (path === '/sessions' && method === 'POST') {
    const session = store.create();
    sendJson(res, 201, { ok: true, session: sessionSummary(session) });
    return;
  }

  const sessionMatch = /^\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(path);
  if (sessionMatch === null) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const sessionId = sessionMatch[1];
  const action = sessionMatch[2] ?? '';

  if (action === '' && method === 'GET') {
    const session = store.get(sessionId);
    if (session === null) return expired(res);
    sendJson(res, 200, { ok: true, session: sessionSummary(session) });
    return;
  }

  if (action === '/files' && method === 'POST') {
    const role = url.searchParams.get('role') ?? 'standard';
    const rawName = url.searchParams.get('name') ?? `未命名-${Date.now()}`;
    const fileName = sanitizeName(rawName);
    const body = await readBody(req, config.maxUploadBytes);
    if (body.tooLarge) {
      sendJson(res, 413, { error: `文件超过 ${formatBytes(config.maxUploadBytes)} 上限` });
      return;
    }
    if (body.bytes === 0 || body.buffer.length === 0) {
      sendJson(res, 400, { error: '文件为空' });
      return;
    }
    const result = store.addFile(sessionId, role, {
      name: fileName,
      buffer: body.buffer,
      size: body.bytes,
      mime: req.headers['content-type'] ?? '',
    });
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    log(`ascend-acceptance: ${role} 文件 ${fileName} 已解析（${formatBytes(body.bytes)}）`);
    sendJson(res, 200, result);
    return;
  }

  if (action.startsWith('/files/') && (method === 'DELETE' || method === 'POST')) {
    const fileId = decodeURIComponent(action.slice('/files/'.length));
    const role = url.searchParams.get('role') ?? 'standard';
    const result = store.removeFile(sessionId, role, fileId);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (action === '/sample' && method === 'POST') {
    const session = store.get(sessionId);
    if (session === null) return expired(res);
    store.reset(sessionId);
    const loaded = [];
    for (const sample of sampleFiles()) {
      const result = store.addFile(sessionId, sample.role, {
        name: sample.name,
        buffer: Buffer.from(sample.content, 'utf8'),
        size: Buffer.byteLength(sample.content, 'utf8'),
        mime: 'text/markdown',
      });
      if (result.ok) loaded.push(...(result.files ?? []));
    }
    const refreshed = store.get(sessionId);
    sendJson(res, 200, { ok: true, files: loaded, session: sessionSummary(refreshed) });
    return;
  }

  if (action === '/compare' && method === 'POST') {
    const result = store.compare(sessionId);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    log(`ascend-acceptance: 比对完成 ${result.report.summary.pass}/${result.report.summary.total} 通过`);
    sendJson(res, 200, {
      ok: true,
      report: result.report,
      session: sessionSummary(store.get(sessionId)),
    });
    return;
  }

  if (action === '/extraction' && method === 'GET') {
    const session = store.get(sessionId);
    if (session === null) return expired(res);
    const role = url.searchParams.get('role') === 'delivery' ? 'delivery' : 'standard';
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') ?? 500)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
    const key = url.searchParams.get('key') ?? '';
    const status = url.searchParams.get('status') ?? '';
    if (role === 'standard') {
      let items = session.extraction.standard.requirements;
      if (key !== '') items = items.filter((item) => item.metricKey === key);
      if (status !== '') items = items.filter((item) => item.category === status);
      sendJson(res, 200, {
        ok: true,
        role,
        total: items.length,
        items: items.slice(offset, offset + limit),
        stats: session.extraction.standard.stats,
        warnings: session.extraction.standard.warnings,
      });
    } else {
      let items = session.extraction.delivery.facts;
      if (key !== '') items = items.filter((item) => item.metricKey === key);
      if (status !== '') items = items.filter((item) => item.category === status);
      sendJson(res, 200, {
        ok: true,
        role,
        total: items.length,
        items: items.slice(offset, offset + limit),
        stats: session.extraction.delivery.stats,
        warnings: session.extraction.delivery.warnings,
      });
    }
    return;
  }

  if (action === '/reset' && method === 'POST') {
    const body = await readJsonBody(req, 16 * 1024);
    const role = body.ok && (body.value?.role === 'standard' || body.value?.role === 'delivery') ? body.value.role : undefined;
    const result = store.reset(sessionId, role);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (action === '/report' && method === 'GET') {
    const session = store.get(sessionId);
    if (session === null) return expired(res);
    if (session.report === null) {
      sendJson(res, 404, { error: '尚未执行比对，请先点击“开始逐项比对”' });
      return;
    }
    sendJson(res, 200, { ok: true, report: session.report });
    return;
  }

  if (action === '/report.md' && method === 'GET') {
    const session = store.get(sessionId);
    if (session?.report === null || session?.report === undefined) return noReport(res);
    const markdown = renderMarkdownReport(session.report);
    sendText(res, 200, `\uFEFF${markdown}`, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': contentDisposition(`昇腾交付核验报告-${dateStamp()}.md`),
    });
    return;
  }

  if (action === '/report.csv' && method === 'GET') {
    const session = store.get(sessionId);
    if (session?.report === null || session?.report === undefined) return noReport(res);
    const csv = renderCsvReport(session.report);
    sendText(res, 200, csv, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': contentDisposition(`昇腾交付核验报告-${dateStamp()}.csv`),
    });
    return;
  }

  if (action === '/report.html' && method === 'GET') {
    const session = store.get(sessionId);
    if (session?.report === null || session?.report === undefined) return noReport(res);
    const html = renderHtmlReport(session.report);
    sendHtml(res, 200, html);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function sanitizeName(value) {
  const raw = String(value ?? '').replace(/[\u0000-\u001F<>:"|?*]/g, '_').trim();
  const name = raw.split(/[\\/]/).filter(Boolean).pop() ?? '未命名文件';
  return name.length > 160 ? `${name.slice(0, 150)}…${name.slice(-8)}` : name;
}

function expired(res) {
  sendJson(res, 404, { error: '会话不存在或已过期，请刷新页面重新开始' });
}

function noReport(res) {
  sendJson(res, 404, { error: '尚未生成报告，请先执行比对' });
}

function acceptsHtml(req) {
  return String(req.headers.accept ?? '').includes('text/html');
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
