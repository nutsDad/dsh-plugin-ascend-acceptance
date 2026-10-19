/**
 * 用 Edge headless + CDP 跑一遍浏览器端主流程并截图。
 * 仅用于开发验收：
 *   node tools/browser-flow.mjs http://127.0.0.1:3199/ascend-acceptance/
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:3199/ascend-acceptance/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9333;
const profile = 'D:\\00_gongkanAgent\\_edge-flow-profile';
const outDir = 'D:\\00_gongkanAgent\\docs\\screenshots';
mkdirSync(outDir, { recursive: true });

const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-dark-mode',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1200', url,
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPage() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // browser not ready
    }
    await sleep(250);
  }
  throw new Error('CDP page not found');
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    } else if (message.method) {
      for (const callback of events.get(message.method) ?? []) callback(message.params);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        id += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, callback) {
      if (!events.has(method)) events.set(method, []);
      events.get(method).push(callback);
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
  return result.result?.value;
}

async function waitFor(cdp, expression, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(250);
  }
  return false;
}

try {
  const page = await getPage();
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });
  await sleep(1500);

  const title = await evaluate(cdp, 'document.title');
  console.log('TITLE', title);
  const health = await evaluate(cdp, "document.querySelector('#healthText')?.textContent");
  console.log('HEALTH', health);

  const clicked = await evaluate(cdp, "(() => { const b = document.querySelector('#sampleBtn'); if (!b) return false; b.click(); return true; })()");
  console.log('CLICK_SAMPLE', clicked);
  const ready = await waitFor(cdp, "document.querySelectorAll('#reportBody .cmp').length > 0", 30000);
  console.log('REPORT_READY', ready);
  await sleep(800);

  const summary = await evaluate(cdp, `(() => {
    const q = (selector) => document.querySelector(selector)?.textContent?.trim() ?? '';
    return {
      verdict: q('.verdict-card h3'),
      kpis: [...document.querySelectorAll('.kpi')].map((node) => node.textContent.trim()),
      cards: document.querySelectorAll('#reportBody .cmp').length,
      failCards: document.querySelectorAll('#reportBody .cmp[data-status="fail"]').length,
      unknownCards: document.querySelectorAll('#reportBody .cmp[data-status="unknown"]').length,
      passCards: document.querySelectorAll('#reportBody .cmp[data-status="pass"]').length,
      toast: q('#toast'),
    };
  })()`);
  console.log('SUMMARY', JSON.stringify(summary));

  for (const name of ['report-top', 'report-list']) {
    const clip = name === 'report-top'
      ? { x: 0, y: 0, width: 1440, height: 1200, scale: 1 }
      : undefined;
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: name === 'report-list',
      ...(name === 'report-list' ? { clip: await evaluate(cdp, `(() => { const r = document.querySelector('#report').getBoundingClientRect(); return { x: 0, y: r.top + window.scrollY, width: 1440, height: Math.min(1800, document.querySelector('#report').scrollHeight), scale: 1 }; })()`) } : {}),
    });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log('SHOT', join(outDir, `${name}.png`));
  }

  // 切换到“解析提取”页签并截图解析表。
  await evaluate(cdp, "document.querySelector('[data-step=\"2\"]')?.click();");
  await sleep(500);
  await evaluate(cdp, "document.querySelector('[data-extraction=\"delivery\"]')?.click(); document.querySelector('#extraction')?.scrollIntoView();");
  await sleep(700);
  const ext = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(join(outDir, 'extraction.png'), Buffer.from(ext.data, 'base64'));
  console.log('SHOT', join(outDir, 'extraction.png'));
  cdp.close();
} catch (error) {
  console.error('FLOW_ERROR', error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
