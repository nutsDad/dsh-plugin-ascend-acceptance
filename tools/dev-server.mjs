/**
 * 独立开发/验收服务器：不启动完整 DSH，也能在浏览器里打开插件页面。
 *
 *   node tools/dev-server.mjs [port]
 *
 * 仅用于本地验证；正式使用由 DSH profile 加载 lib/index.js。
 */

import { createServer } from 'node:http';

import { apply } from '../lib/index.js';

const port = Number(process.argv[2] ?? process.env.PORT ?? 3199);
const routes = [];
const globals = [];

const ctx = {
  logger: console,
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  on(event, callback) {
    if (event === 'webserver/index-inject') {
      globals.push(callback);
      return () => {};
    }
    return () => {};
  },
  webServer: {
    host: '127.0.0.1',
    port,
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
};

const handle = apply(ctx, {});
if (handle?.disabled) {
  console.error(handle.error);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const route = routes[0];
  if (route === undefined) {
    res.writeHead(500);
    res.end('plugin route not mounted');
    return;
  }
  await route.handler(req, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ascend-acceptance dev page: http://127.0.0.1:${port}/ascend-acceptance/`);
  console.log(`health: http://127.0.0.1:${port}/ascend-acceptance/api/health`);
});
