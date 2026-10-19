/**
 * 核验会话存储与编排。
 *
 * 所有数据仅保存在内存中：上传的原始字节在解析后即丢弃，只保留结构化 blocks
 * 与证据文本；会话按空闲时间过期，不写磁盘、不注册后台任务。
 *
 * @module dsh-plugin-ascend-acceptance/store
 */

import { randomUUID } from 'node:crypto';

import { compareAll } from './domain/compare.js';
import { extractFacts, extractRequirements } from './domain/extract.js';
import { parseDocument } from './parse/index.js';

/** 生成短 id。 */
function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * 会话存储。
 */
export class SessionStore {
  constructor(options = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 12);
    this.ttlMs = Math.max(60_000, options.ttlMs ?? 2 * 60 * 60 * 1000);
    this.maxRequirements = Math.max(50, options.maxRequirements ?? 800);
    this.maxFacts = Math.max(50, options.maxFacts ?? 2400);
    this.maxFilesPerRole = Math.max(1, options.maxFilesPerRole ?? 30);
    this.sessions = new Map();
    this.created = 0;
  }

  /** 清理空闲会话。 */
  sweep(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) this.sessions.delete(id);
    }
    if (this.sessions.size > this.maxSessions) {
      const ordered = [...this.sessions.values()].sort((left, right) => left.updatedAt - right.updatedAt);
      while (this.sessions.size > this.maxSessions) {
        this.sessions.delete(ordered.shift().id);
      }
    }
  }

  /** 创建会话。 */
  create() {
    this.sweep();
    const now = Date.now();
    const session = {
      id: newId('acc'),
      createdAt: now,
      updatedAt: now,
      standardFiles: [],
      deliveryFiles: [],
      extraction: emptyExtraction(),
      report: null,
      lastCompareAt: null,
    };
    this.sessions.set(session.id, session);
    this.created += 1;
    return session;
  }

  /** 读取会话。 */
  get(id) {
    this.sweep();
    const session = this.sessions.get(String(id ?? ''));
    if (session === undefined) return null;
    session.updatedAt = Date.now();
    return session;
  }

  /**
   * 添加文件并重新提取。
   *
   * @param {string} id - 会话 id。
   * @param {'standard'|'delivery'} role - 文件角色。
   * @param {{name: string, buffer: Buffer, size?: number, mime?: string}} upload - 上传文件。
   * @returns {{ok: boolean, files?: object[], error?: string, session?: object}}
   */
  addFile(id, role, upload) {
    const session = this.get(id);
    if (session === null) return { ok: false, error: '会话不存在或已过期，请刷新页面后重试' };
    if (role !== 'standard' && role !== 'delivery') return { ok: false, error: 'role 只能是 standard 或 delivery' };
    const bucket = role === 'standard' ? session.standardFiles : session.deliveryFiles;
    if (bucket.length >= this.maxFilesPerRole) {
      return { ok: false, error: `每类文件最多 ${this.maxFilesPerRole} 份；请删除不需要的文件后重试` };
    }

    const started = Date.now();
    let parsed;
    try {
      parsed = parseDocument({ buffer: upload.buffer, name: upload.name, mime: upload.mime });
    } catch (error) {
      const record = makeErrorFile(upload, error);
      bucket.push(record);
      this.refreshExtraction(session);
      session.updatedAt = Date.now();
      return { ok: true, files: [publicFile(record)], session: sessionSummary(session) };
    }

    const documents = parsed.archive === true ? parsed.children : [parsed];
    const added = [];
    for (const document of documents) {
      if (bucket.length >= this.maxFilesPerRole) break;
      const record = makeFileRecord(document, upload, parsed);
      bucket.push(record);
      added.push(publicFile(record));
    }
    this.refreshExtraction(session);
    session.lastParseMs = Date.now() - started;
    session.updatedAt = Date.now();
    return {
      ok: true,
      files: added,
      warnings: parsed.warnings ?? [],
      parseMs: session.lastParseMs,
      session: sessionSummary(session),
    };
  }

  /** 删除文件。 */
  removeFile(id, role, fileId) {
    const session = this.get(id);
    if (session === null) return { ok: false, error: '会话不存在或已过期' };
    const bucket = role === 'standard' ? session.standardFiles : role === 'delivery' ? session.deliveryFiles : null;
    if (bucket === null) return { ok: false, error: 'role 无效' };
    const index = bucket.findIndex((file) => file.id === fileId);
    if (index < 0) return { ok: false, error: '文件不存在' };
    bucket.splice(index, 1);
    this.refreshExtraction(session);
    session.updatedAt = Date.now();
    return { ok: true, session: sessionSummary(session) };
  }

  /** 清空一类或全部文件。 */
  reset(id, role) {
    const session = this.get(id);
    if (session === null) return { ok: false, error: '会话不存在或已过期' };
    if (role === 'standard') session.standardFiles = [];
    else if (role === 'delivery') session.deliveryFiles = [];
    else {
      session.standardFiles = [];
      session.deliveryFiles = [];
    }
    this.refreshExtraction(session);
    session.updatedAt = Date.now();
    return { ok: true, session: sessionSummary(session) };
  }

  /** 重新提取。 */
  refreshExtraction(session) {
    const standard = extractRequirements(session.standardFiles, { maxRequirements: this.maxRequirements });
    const delivery = extractFacts(session.deliveryFiles, { maxFacts: this.maxFacts });
    for (const file of session.standardFiles) {
      file.requirementCount = standard.requirements.filter((item) => item.sourceFileId === file.id).length;
    }
    for (const file of session.deliveryFiles) {
      file.factCount = delivery.facts.filter((item) => item.sourceFileId === file.id).length;
    }
    session.extraction = {
      standard: { requirements: standard.requirements, stats: standard.stats, warnings: standard.warnings },
      delivery: { facts: delivery.facts, stats: delivery.stats, warnings: delivery.warnings },
    };
    session.report = null;
    session.lastCompareAt = null;
    return session.extraction;
  }

  /**
   * 执行比对并保存报告。
   *
   * @param {string} id - 会话 id。
   * @returns {{ok: boolean, report?: object, error?: string}}
   */
  compare(id) {
    const session = this.get(id);
    if (session === null) return { ok: false, error: '会话不存在或已过期' };
    if (session.standardFiles.length === 0) return { ok: false, error: '请先上传至少一份交付标准' };
    if (session.deliveryFiles.length === 0) return { ok: false, error: '请先上传至少一份验收交付件' };
    const standard = session.extraction.standard;
    const delivery = session.extraction.delivery;
    if (standard.requirements.length === 0) {
      return { ok: false, error: '标准文件中没有提取到可核验的条款，请检查文件内容或格式' };
    }
    const result = compareAll({
      requirements: standard.requirements,
      facts: delivery.facts,
      standardFiles: session.standardFiles,
      deliveryFiles: session.deliveryFiles,
    });
    session.report = {
      id: newId('rpt'),
      sessionId: session.id,
      ...result,
      extraction: {
        standard: { stats: standard.stats, warnings: standard.warnings },
        delivery: { stats: delivery.stats, warnings: delivery.warnings },
      },
      createdAt: Date.now(),
    };
    session.lastCompareAt = Date.now();
    session.updatedAt = Date.now();
    return { ok: true, report: session.report };
  }

  /** 统计信息。 */
  stats() {
    this.sweep();
    return {
      sessions: this.sessions.size,
      created: this.created,
      ttlMs: this.ttlMs,
      maxSessions: this.maxSessions,
    };
  }
}

function makeFileRecord(document, upload, parentParsed) {
  return {
    id: newId('file'),
    name: document.name ?? upload.name,
    size: upload.size ?? (parentParsed?.archive === true ? document.stats?.chars ?? 0 : upload.buffer.length),
    mime: upload.mime ?? '',
    ext: document.ext ?? '',
    kind: document.kind ?? '文件',
    status: 'parsed',
    error: '',
    blocks: document.blocks ?? [],
    text: document.text ?? '',
    stats: document.stats ?? { chars: 0, tables: 0, paragraphs: 0, headings: 0, pages: 1 },
    meta: document.meta ?? {},
    warnings: document.warnings ?? [],
    requirementCount: 0,
    factCount: 0,
    fromArchive: parentParsed?.archive === true,
    addedAt: Date.now(),
  };
}

function makeErrorFile(upload, error) {
  return {
    id: newId('file'),
    name: upload.name,
    size: upload.size ?? upload.buffer?.length ?? 0,
    mime: upload.mime ?? '',
    ext: /(\.[^.\/]+)$/.exec(upload.name ?? '')?.[1]?.toLowerCase() ?? '',
    kind: '未知',
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    blocks: [],
    text: '',
    stats: { chars: 0, tables: 0, paragraphs: 0, headings: 0, pages: 0 },
    meta: {},
    warnings: [],
    requirementCount: 0,
    factCount: 0,
    addedAt: Date.now(),
  };
}

/** 会话摘要（不含大段文本/blocks）。 */
export function sessionSummary(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    standardFiles: session.standardFiles.map(publicFile),
    deliveryFiles: session.deliveryFiles.map(publicFile),
    extraction: {
      standard: session.extraction.standard.stats,
      delivery: session.extraction.delivery.stats,
    },
    warnings: {
      standard: session.extraction.standard.warnings,
      delivery: session.extraction.delivery.warnings,
    },
    reportSummary: session.report?.summary ?? null,
    lastCompareAt: session.lastCompareAt,
  };
}

/** 对外暴露的文件信息（去掉 blocks/text）。 */
export function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    ext: file.ext,
    kind: file.kind,
    status: file.status,
    error: file.error,
    stats: file.stats,
    meta: publicMeta(file.meta),
    warnings: file.warnings ?? [],
    requirementCount: file.requirementCount ?? 0,
    factCount: file.factCount ?? 0,
    fromArchive: Boolean(file.fromArchive),
    addedAt: file.addedAt,
  };
}

function publicMeta(meta) {
  if (meta === null || typeof meta !== 'object') return {};
  const copy = { ...meta };
  delete copy.title;
  return copy;
}

function emptyExtraction() {
  return {
    standard: { requirements: [], stats: { total: 0, byCategory: {}, byType: {}, files: 0, chars: 0, tables: 0 }, warnings: [] },
    delivery: { facts: [], stats: { total: 0, byCategory: {}, files: 0, chars: 0, tables: 0 }, warnings: [] },
  };
}
