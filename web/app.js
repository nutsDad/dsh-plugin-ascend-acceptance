/* 昇腾交付核验 — 页面控制器。零依赖，直接由 host 端的 web/ 静态路由提供。 */
(() => {
  'use strict';

  const API = 'api';
  const SESSION_KEY = 'ascend-acceptance-session';
  const MAX_EXTRACTION_ROWS = 200;

  const state = {
    sessionId: null,
    session: null,
    report: null,
    pending: { standard: [], delivery: [] },
    extraction: {
      standard: { items: [], total: 0, loaded: false, loading: false },
      delivery: { items: [], total: 0, loaded: false, loading: false },
    },
    activeTab: 'standard',
    extQuery: '',
    extCategory: '',
    reportFilter: { status: 'all', category: '', q: '' },
    uploading: false,
    comparing: false,
    sampleLoading: false,
    catalog: null,
    health: null,
    version: '',
    reportOpen: new Set(),
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // ------------------------------------------------------------------ utils
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtDate(value) {
    if (value === null || value === undefined) return '—';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(value));
    } catch {
      return String(value);
    }
  }

  function truncate(value, length = 110) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function toast(message, kind = '') {
    const node = $('#toast');
    node.textContent = message;
    node.className = `toast show ${kind}`.trim();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.className = 'toast'; }, kind === 'err' ? 5600 : 3600);
  }

  function setBusy(kind, value) {
    state[kind] = value;
    renderButtons();
    renderFiles('standard');
    renderFiles('delivery');
  }

  function statusLabel(status) {
    return status === 'pass' ? '通过' : status === 'fail' ? '不通过' : '待确认';
  }

  function statusClass(status) {
    return status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'unknown';
  }

  // -------------------------------------------------------------------- api
  async function api(path, options = {}) {
    const response = await fetch(`${API}/${path}`, {
      ...options,
      headers: {
        ...(options.body instanceof Blob ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    let data = {};
    try {
      data = text === '' ? {} : JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 240) };
    }
    if (!response.ok) {
      const error = new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function ensureSession() {
    let saved;
    try {
      saved = sessionStorage.getItem(SESSION_KEY);
    } catch {
      saved = null;
    }
    if (saved) {
      try {
        const data = await api(`sessions/${encodeURIComponent(saved)}`);
        state.sessionId = data.session.id;
        state.session = data.session;
        if (data.session.reportSummary) await loadReport();
        return;
      } catch (error) {
        if (error.status !== 404) throw error;
        try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
      }
    }
    await createSession();
  }

  async function createSession() {
    const data = await api('sessions', { method: 'POST', body: '{}' });
    state.sessionId = data.session.id;
    state.session = data.session;
    state.report = null;
    try { sessionStorage.setItem(SESSION_KEY, state.sessionId); } catch { /* ignore */ }
  }

  async function loadReport() {
    if (!state.sessionId) return;
    try {
      const data = await api(`sessions/${encodeURIComponent(state.sessionId)}/report`);
      state.report = data.report;
      state.reportOpen = new Set();
    } catch (error) {
      if (error.status !== 404) throw error;
      state.report = null;
    }
  }

  async function loadExtraction(role, force = false) {
    if (!state.sessionId) return;
    const bucket = state.extraction[role];
    if (bucket.loading || (bucket.loaded && !force)) return;
    bucket.loading = true;
    renderExtraction();
    try {
      const data = await api(`sessions/${encodeURIComponent(state.sessionId)}/extraction?role=${role}&limit=1000`);
      state.extraction[role] = { items: data.items ?? [], total: data.total ?? 0, loaded: true, loading: false, stats: data.stats, warnings: data.warnings ?? [] };
    } catch (error) {
      bucket.loading = false;
      bucket.loaded = true;
      toast(error.message, 'err');
    }
    renderExtraction();
  }

  function invalidateExtraction() {
    for (const role of ['standard', 'delivery']) {
      state.extraction[role] = { items: [], total: 0, loaded: false, loading: false };
    }
  }

  // --------------------------------------------------------------- lifecycle
  async function boot() {
    applyTheme(localStorageTheme());
    wireEvents();
    renderAll();
    await checkHealth();
    try {
      await ensureSession();
    } catch (error) {
      toast(`无法创建核验会话：${error.message}`, 'err');
      setHealth(false, '会话不可用');
    }
    renderAll();
    if (state.session && (state.session.standardFiles.length > 0 || state.session.deliveryFiles.length > 0)) {
      loadExtraction(state.activeTab);
    }
  }

  async function checkHealth() {
    try {
      const data = await api('health');
      state.health = data;
      state.version = data.version ?? '';
      state.catalog = data.catalog ?? null;
      setHealth(true, `v${data.version ?? '1.0.0'}`);
      const foot = $('#footVersion');
      if (foot) foot.textContent = `DSH Plugin v${data.version ?? ''}`;
      populateCategories();
    } catch (error) {
      setHealth(false, '插件未连接');
      toast(`无法连接核验服务：${error.message}`, 'err');
    }
  }

  function setHealth(ok, text) {
    const dot = $('#healthDot');
    const label = $('#healthText');
    if (!dot || !label) return;
    dot.className = `health-dot ${ok ? 'ok' : 'bad'}`;
    label.textContent = text;
  }

  function localStorageTheme() {
    try {
      const saved = localStorage.getItem('ascend-acceptance-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* ignore */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('ascend-acceptance-theme', theme); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------- wire
  function wireEvents() {
    $('#themeBtn')?.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    for (const role of ['standard', 'delivery']) {
      const zone = $(`[data-drop="${role}"]`);
      const input = role === 'standard' ? $('#standardInput') : $('#deliveryInput');
      if (!zone || !input) continue;
      zone.addEventListener('click', (event) => {
        if (event.target !== input) input.click();
      });
      zone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          input.click();
        }
      });
      input.addEventListener('change', () => {
        uploadFiles(role, input.files);
        input.value = '';
      });
      for (const type of ['dragenter', 'dragover']) {
        zone.addEventListener(type, (event) => {
          event.preventDefault();
          zone.classList.add('is-over');
        });
      }
      for (const type of ['dragleave', 'drop']) {
        zone.addEventListener(type, (event) => {
          event.preventDefault();
          zone.classList.remove('is-over');
        });
      }
      zone.addEventListener('drop', (event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length > 0) uploadFiles(role, files);
      });
    }

    $$('[data-clear]').forEach((button) => {
      button.addEventListener('click', () => clearRole(button.dataset.clear));
    });

    $('#compareBtn')?.addEventListener('click', () => runCompare());
    $('#sampleBtn')?.addEventListener('click', () => loadSample());

    $$('.step').forEach((step) => {
      step.addEventListener('click', () => {
        const index = Number(step.dataset.step);
        const target = index <= 1 ? $('#intake') : index === 2 ? $('#extraction') : $('#report');
        if (target && !target.classList.contains('hidden')) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (index === 2 && state.session) {
          $('#extraction')?.classList.remove('hidden');
          loadExtraction(state.activeTab, true);
          $('#extraction')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    $('#extractionTabs')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-extraction]');
      if (!button) return;
      state.activeTab = button.dataset.extraction;
      $$('#extractionTabs .seg').forEach((seg) => seg.classList.toggle('is-active', seg === button));
      loadExtraction(state.activeTab);
      renderExtraction();
    });

    $('#extractionSearch')?.addEventListener('input', debounce((event) => {
      state.extQuery = event.target.value.trim();
      renderExtraction();
    }, 140));
    $('#extractionCategory')?.addEventListener('change', (event) => {
      state.extCategory = event.target.value;
      renderExtraction();
    });

    $('#reportBody')?.addEventListener('click', (event) => {
      const head = event.target.closest('.cmp-head');
      if (head) {
        const card = head.closest('.cmp');
        if (!card) return;
        card.classList.toggle('is-open');
        head.setAttribute('aria-expanded', String(card.classList.contains('is-open')));
        return;
      }
      const tab = event.target.closest('[data-report-status]');
      if (tab) {
        state.reportFilter.status = tab.dataset.reportStatus;
        renderReport();
        return;
      }
      const expand = event.target.closest('[data-expand-all]');
      if (expand) {
        const cards = $$('.cmp', $('#reportBody'));
        const allOpen = cards.every((card) => card.classList.contains('is-open'));
        cards.forEach((card) => {
          card.classList.toggle('is-open', !allOpen);
          const button = $('.cmp-head', card);
          button?.setAttribute('aria-expanded', String(!allOpen));
        });
        expand.textContent = allOpen ? '展开全部' : '收起全部';
      }
    });

    $('#reportBody')?.addEventListener('change', (event) => {
      if (event.target.matches('[data-report-category]')) {
        state.reportFilter.category = event.target.value;
        updateComparisonList();
      }
    });

    $('#reportBody')?.addEventListener('input', debounce((event) => {
      if (event.target.matches('[data-report-search]')) {
        state.reportFilter.q = event.target.value.trim();
        updateComparisonList();
      }
    }, 140));

    $$('[data-export]').forEach((button) => {
      button.addEventListener('click', () => exportReport(button.dataset.export));
    });

    $('#modalClose')?.addEventListener('click', closeModal);
    $('#modal')?.addEventListener('click', (event) => {
      if (event.target === $('#modal')) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeModal();
    });
  }

  // ------------------------------------------------------------------ upload
  async function uploadFiles(role, fileList) {
    const files = [...(fileList ?? [])];
    if (files.length === 0) return;
    if (!state.sessionId) {
      toast('核验会话尚未就绪，请稍后再试', 'err');
      return;
    }
    if (state.uploading) {
      toast('正在解析上一个文件，请稍候');
      return;
    }
    state.uploading = true;
    renderButtons();
    hideIntakeAlert();
    const maxBytes = Number(state.health?.limits?.maxUploadBytes ?? 50 * 1024 * 1024);
    let success = 0;
    for (const file of files) {
      if (file.size > maxBytes) {
        toast(`${file.name} 超过 ${fmtBytes(maxBytes)} 上限`, 'err');
        continue;
      }
      const temp = {
        id: `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        size: file.size,
        ext: `.${(file.name.split('.').pop() ?? '').toLowerCase()}`,
        kind: '解析中',
        status: 'uploading',
        stats: { chars: 0, tables: 0 },
      };
      state.pending[role].push(temp);
      renderFiles(role);
      updateSummary();
      renderButtons();
      try {
        const response = await fetch(
          `${API}/sessions/${encodeURIComponent(state.sessionId)}/files?role=${role}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? `上传失败（HTTP ${response.status}）`);
        state.pending[role] = state.pending[role].filter((item) => item.id !== temp.id);
        state.session = data.session ?? state.session;
        state.report = null;
        invalidateExtraction();
        success += 1;
        const failedFiles = (data.files ?? []).filter((item) => item.status === 'error');
        if (failedFiles.length > 0) toast(`${failedFiles[0].name}：${failedFiles[0].error}`, 'err');
      } catch (error) {
        state.pending[role] = state.pending[role].filter((item) => item.id !== temp.id);
        toast(`${file.name}：${error.message}`, 'err');
      }
      renderFiles(role);
      updateSummary();
    }
    state.uploading = false;
    try {
      const data = await api(`sessions/${encodeURIComponent(state.sessionId)}`);
      state.session = data.session;
    } catch { /* keep last known summary */ }
    renderAll();
    if (state.session) await loadExtraction(state.activeTab, true);
    if (success > 0) {
      toast(`已解析 ${success} 份文件；可以继续上传或开始比对`, 'ok');
      setStep(2);
    }
  }

  // --------------------------------------------------------------- actions
  async function loadSample() {
    if (state.sampleLoading || state.uploading || state.comparing) return;
    if (!state.sessionId) {
      toast('核验会话尚未就绪', 'err');
      return;
    }
    if (state.session && (state.session.standardFiles.length > 0 || state.session.deliveryFiles.length > 0)) {
      const ok = await confirmModal('载入示例并核验', '当前会话中的文件会被示例材料替换。是否继续？');
      if (!ok) return;
    }
    state.sampleLoading = true;
    renderButtons();
    try {
      const data = await api(`sessions/${encodeURIComponent(state.sessionId)}/sample`, { method: 'POST', body: '{}' });
      state.session = data.session;
      state.report = null;
      invalidateExtraction();
      renderAll();
      await runCompare(true);
      toast('示例已载入并完成核验', 'ok');
    } catch (error) {
      toast(`载入示例失败：${error.message}`, 'err');
    } finally {
      state.sampleLoading = false;
      renderButtons();
    }
  }

  async function runCompare(fromSample = false) {
    if (!state.sessionId || state.comparing) return;
    if (!canCompare()) {
      toast('请先在标准与交付件两侧各上传至少一份可解析文件', 'err');
      return;
    }
    state.comparing = true;
    renderButtons();
    setStep(3);
    try {
      const data = await api(`sessions/${encodeURIComponent(state.sessionId)}/compare`, { method: 'POST', body: '{}' });
      state.report = data.report;
      state.session = data.session ?? state.session;
      state.reportOpen = new Set();
      renderAll();
      // 比对完成后收起“解析提取”长表，让报告直接进入视野；用户仍可点步骤 02
      // 或向上滚动查看结构化条目。
      $('#extraction')?.classList.add('hidden');
      setStep(4);
      if (!fromSample) toast(`比对完成：通过 ${data.report.summary.pass} 项，不通过 ${data.report.summary.fail} 项`, 'ok');
      setTimeout(() => {
        $('#report')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    } catch (error) {
      toast(`比对失败：${error.message}`, 'err');
      setStep(2);
    } finally {
      state.comparing = false;
      renderButtons();
    }
  }

  async function clearRole(role) {
    if (!state.sessionId) return;
    const files = role === 'standard' ? state.session?.standardFiles : state.session?.deliveryFiles;
    if (!files || files.length === 0) return;
    const ok = await confirmModal('清空文件', `确定清空所有${role === 'standard' ? '标准' : '交付件'}文件吗？`);
    if (!ok) return;
    try {
      const data = await api(`sessions/${encodeURIComponent(state.sessionId)}/reset`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      });
      state.session = data.session;
      state.report = null;
      invalidateExtraction();
      renderAll();
      toast('已清空', 'ok');
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  async function removeFile(role, fileId) {
    if (!state.sessionId) return;
    try {
      const data = await api(`sessions/${encodeURIComponent(state.sessionId)}/files/${encodeURIComponent(fileId)}?role=${role}`, {
        method: 'DELETE',
      });
      state.session = data.session;
      state.report = null;
      invalidateExtraction();
      renderAll();
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  function canCompare() {
    if (!state.session) return false;
    if (state.pending.standard.length > 0 || state.pending.delivery.length > 0) return false;
    const standard = state.session.standardFiles?.some((file) => file.status === 'parsed') ?? false;
    const delivery = state.session.deliveryFiles?.some((file) => file.status === 'parsed') ?? false;
    const reqs = state.session.extraction?.standard?.total ?? 0;
    return standard && delivery && reqs > 0;
  }

  function renderButtons() {
    const button = $('#compareBtn');
    if (!button) return;
    const ready = canCompare();
    button.disabled = !ready || state.uploading || state.comparing || state.sampleLoading;
    button.innerHTML = state.comparing
      ? '<span class="spinner"></span> 正在比对…'
      : '开始逐项比对 <span class="btn-arrow">→</span>';
    const hint = $('#compareHint');
    if (hint) {
      if (state.uploading) hint.textContent = '正在解析文件…';
      else if (state.comparing) hint.textContent = '正在逐项判定并整理证据…';
      else if (!state.session?.standardFiles?.length) hint.textContent = '先上传交付标准';
      else if (!state.session?.deliveryFiles?.length) hint.textContent = '再上传验收交付件';
      else if ((state.session.extraction?.standard?.total ?? 0) === 0) hint.textContent = '标准中尚未提取到条款';
      else hint.textContent = `已就绪：${state.session.extraction.standard.total} 项条款 × ${state.session.extraction.delivery.total} 条证据`;
    }
    const sample = $('#sampleBtn');
    if (sample) {
      sample.disabled = state.sampleLoading || state.uploading || state.comparing;
      sample.innerHTML = state.sampleLoading
        ? '<span class="spinner"></span> 正在载入示例…'
        : '<span class="spark">✦</span> 载入示例并核验';
    }
  }

  // ------------------------------------------------------------------ render
  function renderAll() {
    renderFiles('standard');
    renderFiles('delivery');
    updateSummary();
    renderButtons();
    renderExtraction();
    renderReport();
    updateSteps();
    populateCategories();
    const hasParsed = Boolean(state.session && (
      state.session.standardFiles.some((file) => file.status === 'parsed')
      || state.session.deliveryFiles.some((file) => file.status === 'parsed')
    ));
    $('#extraction')?.classList.toggle('hidden', !hasParsed);
  }

  function renderFiles(role) {
    const list = $(`[data-list="${role}"]`);
    if (!list) return;
    const files = [
      ...state.pending[role],
      ...(role === 'standard' ? state.session?.standardFiles ?? [] : state.session?.deliveryFiles ?? []),
    ];
    if (files.length === 0) {
      list.innerHTML = `<div class="file-empty">${role === 'standard' ? '尚未上传标准文件' : '尚未上传验收交付件'}</div>`;
    } else {
      list.innerHTML = files.map((file) => fileItem(role, file)).join('');
      $$('.file-remove', list).forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          removeFile(role, button.dataset.fileId);
        });
      });
    }
    const count = $(`[data-count="${role}"]`);
    if (count) count.textContent = `${files.filter((file) => file.status !== 'uploading').length} 份`;
    const stats = $(`[data-stats="${role}"]`);
    if (stats) {
      const parsed = files.filter((file) => file.status === 'parsed');
      if (parsed.length === 0) stats.textContent = files.length > 0 ? '解析中…' : '等待解析';
      else {
        const extracted = role === 'standard'
          ? parsed.reduce((sum, file) => sum + (file.requirementCount ?? 0), 0)
          : parsed.reduce((sum, file) => sum + (file.factCount ?? 0), 0);
        stats.textContent = `已解析 ${parsed.length} 份 · 提取 ${extracted} 条`;
      }
    }
  }

  function fileItem(role, file) {
    const ext = String(file.ext ?? '').toLowerCase();
    const extLabel = ext.replace('.', '').slice(0, 4).toUpperCase() || 'FILE';
    if (file.status === 'uploading') {
      return `<div class="file-item">
        <span class="file-icon ${esc(ext.slice(1))}">${esc(extLabel)}</span>
        <span class="file-main"><span class="file-name">${esc(file.name)}</span><span class="file-meta">${fmtBytes(file.size)} · 正在解析</span></span>
        <span class="file-state uploading"><span class="spinner"></span>解析中</span>
      </div>`;
    }
    const parsed = file.status === 'parsed';
    const meta = parsed
      ? `${esc(file.kind)} · ${fmtBytes(file.size)} · ${file.stats?.tables ?? 0} 表 · ${file.stats?.chars ?? 0} 字`
      : `${esc(file.kind || '文件')} · ${fmtBytes(file.size)} · 解析失败`;
    const extracted = parsed ? (role === 'standard' ? `${file.requirementCount ?? 0} 条要求` : `${file.factCount ?? 0} 条证据`) : '';
    const status = parsed
      ? `<span class="file-state ok">✓ ${extracted}</span>`
      : `<span class="file-state bad" title="${esc(file.error || '解析失败')}">! 解析失败</span>`;
    return `<div class="file-item" title="${esc(file.error || file.name)}">
      <span class="file-icon ${esc(ext.slice(1))}">${esc(extLabel)}</span>
      <span class="file-main"><span class="file-name">${esc(file.name)}</span><span class="file-meta">${meta}${file.fromArchive ? ' · 来自 ZIP' : ''}</span></span>
      ${status}
      <button class="file-remove" type="button" data-file-id="${esc(file.id)}" title="移除文件" aria-label="移除文件">×</button>
    </div>`;
  }

  function updateSummary() {
    const groups = {
      standard: state.session?.standardFiles ?? [],
      delivery: state.session?.deliveryFiles ?? [],
    };
    const parsedStandard = groups.standard.filter((file) => file.status === 'parsed');
    const parsedDelivery = groups.delivery.filter((file) => file.status === 'parsed');
    const reqs = state.session?.extraction?.standard?.total ?? parsedStandard.reduce((sum, file) => sum + (file.requirementCount ?? 0), 0);
    const facts = state.session?.extraction?.delivery?.total ?? parsedDelivery.reduce((sum, file) => sum + (file.factCount ?? 0), 0);
    const warnings = [
      ...(state.session?.warnings?.standard ?? []),
      ...(state.session?.warnings?.delivery ?? []),
      ...groups.standard.flatMap((file) => file.warnings ?? []),
      ...groups.delivery.flatMap((file) => file.warnings ?? []),
    ];
    setText('#sumFiles', parsedStandard.length + parsedDelivery.length);
    setText('#sumReqs', reqs);
    setText('#sumFacts', facts);
    setText('#sumWarn', warnings.length);
    setText('#tabReqCount', reqs);
    setText('#tabFactCount', facts);

    const meta = $('#intakeMeta');
    if (meta) {
      const total = groups.standard.length + groups.delivery.length;
      meta.innerHTML = total === 0
        ? '<span class="meta-dot"></span>等待材料'
        : `<span class="meta-dot ok"></span>已接收 ${total} 份文件 · ${parsedStandard.length + parsedDelivery.length} 份已解析`;
    }

    const errors = [...groups.standard, ...groups.delivery].filter((file) => file.status === 'error');
    if (errors.length > 0) {
      showIntakeAlert(errors.map((file) => `${file.name}：${file.error}`).join('；'), false);
    } else if (warnings.length > 0) {
      showIntakeAlert(warnings.slice(0, 3).join('；'), true);
    } else {
      hideIntakeAlert();
    }
  }

  function setText(selector, value) {
    const node = $(selector);
    if (node) node.textContent = String(value);
  }

  function showIntakeAlert(message, warn) {
    const alert = $('#intakeAlert');
    if (!alert) return;
    alert.hidden = false;
    alert.className = `inline-alert${warn ? ' warn' : ''}`;
    alert.textContent = message;
  }

  function hideIntakeAlert() {
    const alert = $('#intakeAlert');
    if (alert) alert.hidden = true;
  }

  function updateSteps() {
    const hasFiles = Boolean(state.session && (state.session.standardFiles.length > 0 || state.session.deliveryFiles.length > 0));
    const hasExtraction = (state.session?.extraction?.standard?.total ?? 0) > 0;
    const hasReport = Boolean(state.report);
    setStep(hasReport ? 4 : hasExtraction ? 2 : hasFiles ? 1 : 1);
    const steps = $$('.step');
    steps.forEach((step) => {
      const index = Number(step.dataset.step);
      step.classList.toggle('is-done', hasReport ? index < 4 : hasExtraction ? index < 2 : false);
    });
  }

  function setStep(active) {
    const steps = $$('.step');
    steps.forEach((step) => step.classList.toggle('is-active', Number(step.dataset.step) === active));
  }

  // -------------------------------------------------------------- extraction
  function populateCategories() {
    const select = $('#extractionCategory');
    if (!select) return;
    const categories = state.catalog?.categories ?? [];
    if (categories.length === 0) return;
    const current = select.value;
    select.innerHTML = '<option value="">全部分类</option>'
      + categories.map((category) => `<option value="${esc(category.key)}">${esc(category.label)}（${category.metrics ?? ''}）</option>`).join('');
    select.value = current;
  }

  function renderExtraction() {
    const panel = $('#extractionPanel');
    if (!panel) return;
    const role = state.activeTab;
    const bucket = state.extraction[role];
    if (bucket.loading && bucket.items.length === 0) {
      panel.innerHTML = '<div class="empty-state"><b>正在提取结构化信息…</b>解析文件并建立指标映射</div>';
      return;
    }
    if (!bucket.loaded && state.session) {
      panel.innerHTML = '<div class="empty-state"><b>等待文件</b>上传后会在这里显示结构化条款/证据</div>';
      if (state.session.standardFiles.length > 0 || state.session.deliveryFiles.length > 0) loadExtraction(role);
      return;
    }
    let items = bucket.items;
    const query = state.extQuery.toLowerCase();
    if (query) {
      items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(query));
    }
    if (state.extCategory) items = items.filter((item) => item.category === state.extCategory);
    const note = $('#extractionNote');
    if (note) {
      note.textContent = bucket.total > MAX_EXTRACTION_ROWS
        ? `显示 ${Math.min(items.length, MAX_EXTRACTION_ROWS)} / ${bucket.total} 条`
        : `${items.length} 条`;
    }
    if (items.length === 0) {
      panel.innerHTML = `<div class="empty-state"><b>没有匹配的条目</b>${query || state.extCategory ? '试试清除筛选条件' : '上传文件后自动提取'}</div>`;
      return;
    }
    const rows = items.slice(0, MAX_EXTRACTION_ROWS);
    if (role === 'standard') {
      panel.innerHTML = `<div class="ext-table">
        <div class="ext-head"><span>编号</span><span>分类</span><span>指标 / 标准条款</span><span>要求</span><span>来源</span></div>
        ${rows.map((item) => `<div class="ext-row">
          <span class="ext-id">${esc(item.id)}</span>
          <span class="ext-cat">${esc(item.categoryLabel)}</span>
          <div class="ext-main"><b>${esc(item.metricLabel)}</b><span>${esc(item.raw)}</span></div>
          <div class="ext-value">${esc(item.operatorLabel)} <em>${esc(formatTarget(item))}</em></div>
          <div class="ext-source">${esc(item.sourceFile)}<br>${esc(item.section || item.location)}</div>
        </div>`).join('')}
      </div>`;
    } else {
      panel.innerHTML = `<div class="ext-table">
        <div class="ext-head"><span>编号</span><span>分类</span><span>指标 / 证据原文</span><span>实测值</span><span>来源</span></div>
        ${rows.map((item) => `<div class="ext-row">
          <span class="ext-id">${esc(item.id)}</span>
          <span class="ext-cat">${esc(item.categoryLabel)}</span>
          <div class="ext-main"><b>${esc(item.metricLabel)}</b><span>${esc(item.evidence || item.raw)}</span></div>
          <div class="ext-value"><em>${esc(formatActualValue(item))}</em><br><span class="ext-status">置信度 ${esc(item.confidence >= 0.8 ? '高' : item.confidence >= 0.6 ? '中' : '低')}</span></div>
          <div class="ext-source">${esc(item.sourceFile)}<br>${esc(item.section || item.location)}</div>
        </div>`).join('')}
      </div>`;
    }
  }

  // ------------------------------------------------------------------ report
  function renderReport() {
    const section = $('#report');
    const body = $('#reportBody');
    if (!section || !body) return;
    if (!state.report) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    const report = state.report;
    const summary = report.summary;
    const subtitle = $('#reportSubtitle');
    if (subtitle) subtitle.textContent = `生成于 ${fmtDate(summary.generatedAt)} · 共 ${summary.fileCount} 个文件 · ${summary.total} 项指标 · 每条结论可回溯原文`;
    const total = Math.max(1, summary.total);
    const pPct = (summary.pass / total) * 100;
    const fPct = (summary.fail / total) * 100;
    const uPct = (summary.unknown / total) * 100;
    const accepted = summary.status === 'accepted';
    const verdictClass = accepted ? 'pass' : summary.status === 'needs-remediation' ? 'fail' : 'unknown';
    const statusText = accepted ? '通过' : summary.status === 'needs-remediation' ? '需整改' : '待补充';

    const categoryRows = Object.values(summary.byCategory ?? {});
    const fileRows = summary.files ?? [];
    const warnings = report.warnings ?? [];

    body.innerHTML = `
      <div class="report-overview">
        <div class="verdict-card">
          <div class="verdict-top"><span class="status-badge ${verdictClass}">${statusText}</span>VERIFICATION VERDICT</div>
          <h3>${esc(summary.verdict)}</h3>
          <p>共接收标准文件 ${summary.standardFiles} 份、验收交付件 ${summary.deliveryFiles} 份，解析出 ${summary.requirements} 项标准要求与 ${summary.facts} 条交付证据，逐项比对 ${summary.total} 项。通过 ${summary.pass} 项，不通过 ${summary.fail} 项，待确认 ${summary.unknown} 项。</p>
          <div class="verdict-meta">
            <div><b>${summary.complianceRate}%</b><span>总体通过率</span></div>
            <div><b>${summary.decidableRate}%</b><span>可判定项通过率</span></div>
            <div><b>${summary.fileCount}</b><span>比对文件</span></div>
            <div><b>${summary.total}</b><span>比对指标</span></div>
          </div>
        </div>
        <div class="overview-chart">
          <div class="report-donut" style="--p:${pPct.toFixed(2)};--f:${fPct.toFixed(2)};--u:${uPct.toFixed(2)}">
            <div class="report-donut-center"><div><b>${summary.complianceRate}%</b><span>PASS RATE</span></div></div>
          </div>
          <div class="donut-legend">
            <div class="legend-item pass"><i></i>通过<b>${summary.pass}</b></div>
            <div class="legend-item fail"><i></i>不通过<b>${summary.fail}</b></div>
            <div class="legend-item unknown"><i></i>待确认<b>${summary.unknown}</b></div>
            <div class="legend-item"><i style="background:var(--faint)"></i>比对总数<b>${summary.total}</b></div>
          </div>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi"><span>来源文件</span><b>${summary.fileCount}</b><small>标准 ${summary.standardFiles} · 交付 ${summary.deliveryFiles}</small></div>
        <div class="kpi"><span>比对指标</span><b>${summary.total}</b><small>标准要求逐项映射</small></div>
        <div class="kpi pass"><span>通过</span><b>${summary.pass}</b><small>有明确证据且满足要求</small></div>
        <div class="kpi fail"><span>不通过</span><b>${summary.fail}</b><small>证据明确不满足要求</small></div>
        <div class="kpi unknown"><span>待确认</span><b>${summary.unknown}</b><small>缺证据或口径不明确</small></div>
        <div class="kpi rate"><span>总体通过率</span><b>${summary.complianceRate}%</b><small>待确认不计为通过</small></div>
      </div>

      ${warnings.length > 0 ? `<div class="inline-alert warn" style="margin-bottom:14px">${esc(warnings.join('；'))}</div>` : ''}

      <div class="category-panel">
        <div class="panel-title"><strong>分类通过情况</strong><span>按交付标准领域拆分</span></div>
        <div class="cat-bars">
          ${categoryRows.map((cat) => `<div class="cat-row">
            <div class="cat-name"><i style="background:${esc(cat.color)}"></i><span>${esc(cat.label)}</span></div>
            <div class="cat-track" title="通过 ${cat.pass} / 不通过 ${cat.fail} / 待确认 ${cat.unknown}">
              <span class="p" style="width:${(cat.pass / cat.total * 100).toFixed(2)}%"></span>
              <span class="f" style="width:${(cat.fail / cat.total * 100).toFixed(2)}%"></span>
              <span class="u" style="width:${(cat.unknown / cat.total * 100).toFixed(2)}%"></span>
            </div>
            <div class="cat-num"><b>${cat.pass}/${cat.total}</b> · ${cat.rate}%</div>
          </div>`).join('')}
        </div>
      </div>

      <details class="file-inventory">
        <summary>核验文件清单 <b>${fileRows.length}</b> 份 · 点击展开</summary>
        <div class="file-inv-table">
          <div class="file-inv-row head"><span>角色</span><span>文件</span><span>类型</span><span>大小</span><span>状态</span><span>提取项</span></div>
          ${fileRows.map((file) => `<div class="file-inv-row">
            <span>${esc(file.roleLabel)}</span>
            <span class="name" title="${esc(file.name)}">${esc(file.name)}</span>
            <span>${esc(file.kind)}</span>
            <span>${fmtBytes(file.size)}</span>
            <span>${file.status === 'parsed' ? '<span style="color:var(--green)">已解析</span>' : `<span style="color:var(--red)" title="${esc(file.error)}">失败</span>`}</span>
            <span>${file.extracted}</span>
          </div>`).join('')}
        </div>
      </details>

      <div class="report-filter">
        <div class="filter-tabs">
          <button class="filter-tab ${state.reportFilter.status === 'all' ? 'is-active' : ''}" data-report-status="all" type="button">全部 <b>${summary.total}</b></button>
          <button class="filter-tab ${state.reportFilter.status === 'fail' ? 'is-active' : ''}" data-report-status="fail" type="button">不通过 <b>${summary.fail}</b></button>
          <button class="filter-tab ${state.reportFilter.status === 'unknown' ? 'is-active' : ''}" data-report-status="unknown" type="button">待确认 <b>${summary.unknown}</b></button>
          <button class="filter-tab ${state.reportFilter.status === 'pass' ? 'is-active' : ''}" data-report-status="pass" type="button">通过 <b>${summary.pass}</b></button>
        </div>
        <select data-report-category aria-label="按分类筛选报告">
          <option value="">全部分类</option>
          ${categoryRows.map((cat) => `<option value="${esc(cat.key)}" ${state.reportFilter.category === cat.key ? 'selected' : ''}>${esc(cat.label)}（${cat.total}）</option>`).join('')}
        </select>
        <div class="search-box" style="max-width:270px;min-width:180px">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>
          <input data-report-search type="search" placeholder="搜索指标、依据或建议…" value="${esc(state.reportFilter.q)}">
        </div>
        <span class="filter-spacer"></span>
        <button class="mini-action" data-expand-all type="button">展开全部</button>
        <span class="cmp-count" id="cmpCount"></span>
      </div>
      <div class="cmp-list" id="cmpList"></div>
    `;
    updateComparisonList();
  }

  function updateComparisonList() {
    const list = $('#cmpList');
    if (!list || !state.report) return;
    const comparisons = filteredComparisons();
    const count = $('#cmpCount');
    if (count) count.textContent = `显示 ${comparisons.length} / ${state.report.comparisons.length} 项`;
    if (comparisons.length === 0) {
      list.innerHTML = '<div class="empty-state"><b>没有匹配的比对项</b>清空筛选条件后再试</div>';
      return;
    }
    list.innerHTML = comparisons.map((item) => comparisonCard(item)).join('');
  }

  function filteredComparisons() {
    if (!state.report) return [];
    const order = { fail: 0, unknown: 1, pass: 2 };
    const query = state.reportFilter.q.toLowerCase();
    return state.report.comparisons
      .filter((item) => state.reportFilter.status === 'all' || item.status === state.reportFilter.status)
      .filter((item) => state.reportFilter.category === '' || item.category === state.reportFilter.category)
      .filter((item) => {
        if (query === '') return true;
        return [item.id, item.metricLabel, item.requirementText, item.reason, item.standardBasis, item.deliveryBasis, item.recommendation]
          .join(' ').toLowerCase().includes(query);
      })
      .sort((left, right) => (order[left.status] ?? 3) - (order[right.status] ?? 3));
  }

  function comparisonCard(item) {
    const open = item.status !== 'pass';
    const actual = item.actual === null || item.actual === undefined
      ? '未找到对应证据'
      : `${formatActual(item.actual, item.metricType)}`;
    const alternates = (item.alternateEvidence ?? []).filter((alt) => alt.value !== undefined && alt.value !== null);
    return `<article class="cmp ${open ? 'is-open' : ''}" data-status="${esc(item.status)}" data-category="${esc(item.category)}">
      <button class="cmp-head" type="button" aria-expanded="${open}">
        <span class="status-badge ${statusClass(item.status)} cmp-status">${statusLabel(item.status)}</span>
        <span class="cmp-main"><b>${esc(item.id)} · ${esc(item.metricLabel)}</b><span>${esc(truncate(item.requirementText, 110))}</span></span>
        <span class="cmp-cat">${esc(item.categoryLabel)}</span>
        <span class="cmp-target">${esc(item.operatorLabel)} ${esc(formatTarget(item))}</span>
        <span class="cmp-chevron">›</span>
      </button>
      <div class="cmp-body">
        <div class="cmp-basis">
          <div class="basis-box"><b>标准依据</b><p>${esc(item.standardBasis)}</p></div>
          <div class="basis-box"><b>交付依据 · 实测 ${esc(actual)}</b><p>${esc(item.deliveryBasis)}</p></div>
        </div>
        <div class="cmp-reason"><span class="reason-mark">判</span><span>${esc(item.reason)} <span class="confidence">置信度 ${esc(item.confidenceLabel)}</span></span></div>
        <div class="cmp-advice"><span class="advice-mark">→</span><span><b>${item.status === 'pass' ? '证据保留建议：' : '建议措施：'}</b>${esc(item.recommendation)}</span></div>
        ${alternates.length > 0 ? `<details class="cmp-alt"><summary>其他证据（${alternates.length} 条，判定按最不利/最高置信度）</summary>${alternates.map((alt) => `<div>${esc(alt.sourceFile)} · ${esc(alt.section || '')} · ${esc(formatActual(alt))} · ${statusLabel(alt.status)}</div>`).join('')}</details>` : ''}
      </div>
    </article>`;
  }

  function formatTarget(item) {
    if (typeof item.target === 'boolean') return item.target ? '正常 / 支持' : '异常 / 不支持';
    const target = Array.isArray(item.target) ? item.target.join('~') : item.target;
    if (target === null || target === undefined || target === '') return '—';
    const unit = item.unit ?? '';
    return `${target}${unit}`.trim();
  }

  function formatActualValue(item) {
    if (typeof item.value === 'boolean') {
      if (item.metricType === 'presence') return item.value ? '已提供' : '未提供';
      return item.value ? '正常 / 支持' : '异常 / 不支持';
    }
    const value = Array.isArray(item.value) ? item.value.join('~') : item.value;
    return `${value ?? '—'}${item.unit ?? ''}`.trim();
  }

  function formatActual(actual, metricType) {
    if (actual === null || actual === undefined) return '—';
    if (typeof actual.value === 'boolean') {
      if (metricType === 'presence') return actual.value ? '已提供' : '未提供';
      return actual.value ? '正常 / 支持' : '异常 / 不支持';
    }
    const value = Array.isArray(actual.value) ? actual.value.join('~') : actual.value;
    return `${value ?? '—'}${actual.unit ?? ''}`.trim();
  }

  // ------------------------------------------------------------------ export
  function exportReport(kind) {
    if (!state.report || !state.sessionId) {
      toast('尚未生成报告', 'err');
      return;
    }
    const base = `${API}/sessions/${encodeURIComponent(state.sessionId)}/report`;
    if (kind === 'print') {
      window.print();
      return;
    }
    if (kind === 'html') {
      const url = `${base}.html`;
      const opened = window.open(url, '_blank', 'noopener');
      if (opened === null) window.location.href = url;
      return;
    }
    if (kind === 'md' || kind === 'csv') {
      const link = document.createElement('a');
      link.href = `${base}.${kind}`;
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
      return;
    }
  }

  // ------------------------------------------------------------------- modal
  function confirmModal(title, message) {
    return new Promise((resolve) => {
      const modal = $('#modal');
      const titleNode = $('#modalTitle');
      const body = $('#modalBody');
      if (!modal || !titleNode || !body) {
        resolve(window.confirm(message));
        return;
      }
      titleNode.textContent = title;
      body.innerHTML = `<p>${esc(message)}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button class="mini-action" data-modal-cancel type="button">取消</button>
          <button class="mini-action primary" data-modal-ok type="button">继续</button>
        </div>`;
      modal.hidden = false;
      const cleanup = () => {
        modal.hidden = true;
        body.innerHTML = '';
      };
      $('[data-modal-cancel]', body)?.addEventListener('click', () => { cleanup(); resolve(false); }, { once: true });
      $('[data-modal-ok]', body)?.addEventListener('click', () => { cleanup(); resolve(true); }, { once: true });
      $('#modalClose')?.addEventListener('click', () => { cleanup(); resolve(false); }, { once: true });
    });
  }

  function closeModal() {
    const modal = $('#modal');
    if (modal) modal.hidden = true;
  }

  // -------------------------------------------------------------------- start
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
