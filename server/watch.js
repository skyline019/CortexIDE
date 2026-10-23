/**
 * 文件监听 + 变更推送（大仓友好）
 *
 * chokidar 监听工作区，事件在 120ms 内合并成一批，通过 WebSocket 推给已连接的编辑器：
 *   ← { type: 'fs', events: [{ path, kind: 'add'|'change'|'unlink', dir }], seq }
 *   → { type: 'sub', dirs: ['src', 'server'] }   订阅目录（只推这些目录下的变更）
 *   → { type: 'sub', dirs: [] }                  订阅全部
 *   → { type: 'mode', mode: 'poll'|'fs', interval }
 *
 * 大仓模式（CORTEX_WATCH_MODE=poll 或运行时切换）：
 *   - usePolling + interval=800ms：网络盘 / 容器挂载 / inotify 上限爆掉时更稳
 *   - depth 可配（CORTEX_WATCH_DEPTH，默认 8），超深目录不再逐个 inotify
 *   - 目录级订阅：客户端只关心展开的目录，服务端按订阅过滤，事件量能降一个数量级
 */
import path from 'node:path';
import { checkAuth } from './auth.js';

const IGNORED = [
  /node_modules/,
  /\.git\//,
  /\/dist\//,
  /\/build\//,
  /\.cortex\//,
  /\.next\//,
  /\.cache\//,
  /__pycache__/,
  /\.DS_Store$/,
  /\.log$/,
  /\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.ico$|\.woff2?$/,
];

export function watchPlugin({ workspace }) {
  let watcher = null;
  let clients = new Set();
  let pending = new Map();
  let flushTimer = null;
  let watching = '';
  let mode = process.env.CORTEX_WATCH_MODE === 'poll' ? 'poll' : 'fs';
  let interval = Number(process.env.CORTEX_WATCH_INTERVAL || 800);
  let depth = Number(process.env.CORTEX_WATCH_DEPTH || 8);
  let seq = 0;
  let suppressed = 0; // 被订阅过滤掉的事件数（可观测）
  let subscribedTotal = 0;

  const subsOf = (ws) => ws.__subs || (ws.__subs = null);

  /**
   * 目录订阅匹配：dirs=null 表示全量
   *
   * 订阅是「加深度」而不是「收窄范围」——根目录的文件永远推送，
   * 否则用户展开过某个子目录后，根目录的 package.json 改动就收不到了。
   */
  const matches = (ws, rel) => {
    const subs = subsOf(ws);
    if (!subs || !subs.length) return true;
    if (!rel.includes('/')) return true;
    return subs.some((d) => rel === d || rel.startsWith(d + '/'));
  };

  const flush = () => {
    flushTimer = null;
    if (!pending.size) return;
    const group = [...pending.values()];
    pending = new Map();
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const mine = group.filter((e) => matches(ws, e.path));
      suppressed += group.length - mine.length;
      if (mine.length) {
        seq += 1;
        ws.send(JSON.stringify({ type: 'fs', events: mine, at: Date.now(), seq }));
      }
    }
  };

  const queue = (kind, absPath) => {
    const rel = path.relative(watching, absPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || IGNORED.some((re) => re.test('/' + rel))) return;
    const existing = pending.get(rel);
    // add + change 合并成 change，unlink 覆盖其他
    const merged = existing && existing.kind === 'add' && kind === 'change' ? 'add' : kind;
    pending.set(rel, { path: rel, kind: merged, dir: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel) });
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  };

  const start = async (root, nextMode = mode) => {
    const { watch } = await import('chokidar');
    if (watcher) await watcher.close().catch(() => {});
    watching = root;
    mode = nextMode;
    pending.clear();
    watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      depth,
      usePolling: mode === 'poll',
      interval: mode === 'poll' ? interval : undefined,
      binaryInterval: mode === 'poll' ? interval * 2 : undefined,
      ignored: (p) => IGNORED.some((re) => re.test(p.split(path.sep).join('/'))),
      awaitWriteFinish: { stabilityThreshold: mode === 'poll' ? 400 : 120, pollInterval: 40 },
    });
    watcher.on('add', (p) => queue('add', p));
    watcher.on('change', (p) => queue('change', p));
    watcher.on('unlink', (p) => queue('unlink', p));
    watcher.on('unlinkDir', (p) => queue('unlink', p));
    watcher.on('error', (err) => console.warn('[cortex watch]', err.message));
    return watcher;
  };

  const status = () => ({
    watching,
    clients: clients.size,
    active: Boolean(watcher),
    mode,
    interval,
    depth,
    seq,
    suppressed,
    subscribed: subscribedTotal,
    pending: pending.size,
  });

  const sendJson = (res, payload) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };

  const middleware = (req, res, next) => {
    if (!req.url.startsWith('/api/watch/')) return next();
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/watch/status') return sendJson(res, status());
    if (url.pathname === '/api/watch/config' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', async () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          const nextMode = body.mode === 'poll' || body.mode === 'fs' ? body.mode : mode;
          if (body.interval) interval = Math.max(200, Math.min(10000, Number(body.interval)));
          if (body.depth) depth = Math.max(1, Math.min(24, Number(body.depth)));
          if (nextMode !== mode || watcher === null) await start(watching || workspace(), nextMode);
          // 通知所有客户端当前模式
          for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'mode', ...status() }));
          return sendJson(res, { ok: true, ...status() });
        } catch (err) {
          res.statusCode = 400;
          return sendJson(res, { error: err.message });
        }
      });
      return undefined;
    }
    return next();
  };

  const attach = (httpServer) => {
    if (!httpServer) return;
    import('ws').then(({ WebSocketServer }) => {
      const wss = new WebSocketServer({ noServer: true });
      httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/api/watch') return;
        // Connect middleware 不覆盖 upgrade；鉴权开启时必须在此校验（含 ?access_token=）
        const auth = checkAuth(req);
        if (!auth.ok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });
      wss.on('connection', (ws) => {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'hello', root: watching || workspace(), ...status() }));
        ws.on('close', () => {
          clients.delete(ws);
          if (subsOf(ws)) subscribedTotal -= subsOf(ws).length;
        });
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
            if (msg.type === 'watch' && msg.root) start(msg.root);
            if (msg.type === 'mode') start(watching || workspace(), msg.mode === 'poll' ? 'poll' : 'fs');
            if (msg.type === 'sub') {
              const dirs = Array.isArray(msg.dirs)
                ? msg.dirs
                    .map((d) => String(d).replace(/^\/+|\/+$/g, ''))
                    .filter((d) => d && !d.includes('..'))
                    .slice(0, 200)
                : [];
              if (subsOf(ws)) subscribedTotal -= subsOf(ws).length;
              ws.__subs = dirs;
              subscribedTotal += dirs.length;
              ws.send(JSON.stringify({ type: 'sub-ok', dirs, ...status() }));
            }
          } catch {
            /* ignore */
          }
        });
      });
    });
  };

  return {
    name: 'cortex-watch',
    async configureServer(server) {
      server.middlewares.use(middleware);
      attach(server.httpServer);
      const root = workspace();
      await start(root).catch((err) => console.warn('[cortex watch] 启动失败', err.message));
    },
    async configurePreviewServer(server) {
      server.middlewares.use(middleware);
      attach(server.httpServer);
      await start(workspace()).catch(() => {});
    },
  };
}
