/**
 * 昇腾交付核验 — browser half。
 *
 * 只做一件事：在会话侧边栏底部注册「交付核验」入口，点击后在右侧浏览器标签
 * 打开由 host 端服务的独立页面。真正的上传、解析、比对与报告都在 `web/` 中，
 * 因此即使侧边栏插槽 API 变化，页面本身仍可通过 URL 直接访问。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-ascend-acceptance',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const DEFAULT_PREFIX = '/ascend-acceptance';
    const STYLE_TAG = 'dsh-plugin-ascend-acceptance/sidebar-entry.css';

    const CSS = `
.asa-entry { display: flex; align-items: center; width: 100%; }
.asa-btn {
  display: inline-flex; align-items: center; gap: 8px; width: 100%; height: 38px; margin: 0 -2px;
  padding: 0 10px 0 8px; border: none; border-radius: 12px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-primary, #1a1d21); font: inherit; font-size: 13px; overflow: hidden;
}
.asa-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
.asa-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #c2410c); outline-offset: 1px; }
.asa-entry[data-wide="false"] { justify-content: center; }
.asa-entry[data-wide="false"] .asa-btn { width: 38px; height: 38px; justify-content: center; padding: 0; border-radius: 50%; }
.asa-icon {
  flex: none; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center;
  background: linear-gradient(135deg, #c2410c, #f59e0b); color: #fff; font-size: 11px; font-weight: 800;
  box-shadow: 0 2px 6px rgba(194, 65, 12, .28);
}
.asa-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asa-dot { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-tertiary, #7b828c); }
`;

    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css="${STYLE_TAG}"]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-ascend-acceptance';
      tag.dataset.pluginCss = STYLE_TAG;
      tag.textContent = CSS;
      document.head.append(tag);
    }

    function bootstrap() {
      const injected = globalThis.__ASCEND_ACCEPTANCE__;
      if (injected !== null && typeof injected === 'object') return injected;
      return { routePrefix: DEFAULT_PREFIX, title: '昇腾交付核验' };
    }

    function normalizePrefix(value) {
      const raw = String(value ?? DEFAULT_PREFIX).trim();
      const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
      return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
    }

    function normalizeOrigin(origin) {
      let url;
      try {
        url = new URL(String(origin));
      } catch {
        return undefined;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
      if (url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1') url.hostname = '127.0.0.1';
      return url.origin;
    }

    function resolveOrigin() {
      const injected = bootstrap();
      const fromHost = normalizeOrigin(injected.origin);
      if (fromHost !== undefined) return fromHost;
      const fromLocation = normalizeOrigin(globalThis.location?.origin ?? '');
      if (fromLocation !== undefined) return fromLocation;
      try {
        const script = globalThis.document?.currentScript?.src;
        const fromScript = normalizeOrigin(new URL(String(script ?? ''), globalThis.location?.href ?? '').origin);
        if (fromScript !== undefined) return fromScript;
      } catch {
        // fall through
      }
      return 'http://127.0.0.1:19387';
    }

    function pageUrl() {
      const injected = bootstrap();
      return `${resolveOrigin()}${normalizePrefix(injected.routePrefix)}/`;
    }

    function openInShellTab(ctx, url) {
      try {
        if (ctx === undefined || typeof ctx.get !== 'function') return false;
        const tabs = ctx.get('sidebarRightTabs');
        if (tabs === undefined || typeof tabs.get !== 'function' || tabs.get('browser') === undefined) return false;
        const right = ctx.get('sidebarRight');
        if (right === undefined || typeof right.openTab !== 'function') return false;
        right.openTab('browser', { params: { url } });
        return true;
      } catch {
        return false;
      }
    }

    function openPage(ctx) {
      const url = pageUrl();
      if (openInShellTab(ctx, url)) return 'tab';
      let opened;
      try {
        opened = globalThis.open(url, '_blank', 'noopener');
      } catch {
        opened = null;
      }
      if (opened !== null && opened !== undefined) return 'window';
      globalThis.location.assign(url);
      return 'self';
    }

    function AcceptanceEntry(props) {
      const wide = props.wide !== false;
      const onOpen = typeof props.onOpen === 'function' ? props.onOpen : () => openPage(undefined);
      const open = react.useCallback(() => { onOpen(); }, [onOpen]);
      return react.createElement(
        'div',
        { className: 'asa-entry', dataset: { wide: String(wide) } },
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'asa-btn',
            title: `打开昇腾交付核验（上传标准与交付件，逐项比对并生成报告）· ${pageUrl()}`,
            'aria-label': '打开昇腾交付核验',
            onClick: open,
          },
          react.createElement('span', { className: 'asa-icon', 'aria-hidden': true }, '验'),
          wide ? react.createElement('span', { className: 'asa-label' }, '交付核验') : null,
          wide ? react.createElement('span', { className: 'asa-dot' }, 'Ascend') : null,
        ),
      );
    }

    function apply(ctx) {
      ensureStyles();
      try {
        const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined);
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[ascend-acceptance] 侧边栏插槽不可用，核验页面未注册入口；可直接访问 ' + pageUrl());
          return;
        }
        slots.inject('sidebar.footer.action', () => slots.register({
          name: 'sidebar.footer.action',
          id: 'ascend-acceptance',
        }, (props) => AcceptanceEntry({ ...props, onOpen: () => openPage(ctx) })));
      } catch (error) {
        console.warn('[ascend-acceptance] 注册侧边栏入口失败：', error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.AcceptanceEntry = AcceptanceEntry;
    exports.pageUrl = pageUrl;
    exports.openPage = openPage;
    return module.exports;
  },
});
