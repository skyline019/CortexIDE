/**
 * 记忆库 HTTP API（多用户隔离）
 *
 * 身份：
 *   - 请求头 x-cortex-user 指定用户（默认 local）
 *   - 请求头 x-cortex-workspace 指定工作区（默认当前 CORTEX_WORKSPACE）
 *   - 所有查询都在 SQL 层强制带 user_id + workspace 过滤
 *
 * 路由：
 *   GET  /api/mem/status            后端能力、向量维度、统计
 *   GET  /api/mem/users             用户列表（含各自条数）
 *   POST /api/mem/users             创建/切换用户（写 last_seen）
 *   GET  /api/mem/list              当前用户在当前工作区的全部记忆
 *   POST /api/mem/sync              增量同步（携带向量）
 *   POST /api/mem/search            混合检索（向量 KNN + BM25，RRF 融合）
 *   POST /api/mem/delete            删除一条
 *   GET  /api/mem/export            导出当前用户的 JSON
 */
import {
  syncMemories,
  listMemories,
  searchMemories,
  deleteMemory,
  listUsers,
  touchUser,
  stats,
  lastStatus,
  exportAllMemories,
  warmAnnIndex,
  annWarmStatus,
  reloadAnnIndex,
  resetAnnIndex,
  flushAnnSaves,
  gcCaches,
} from './memory-store.js';
import { pgSyncMemories, pgListMemories, pgSearchMemories, pgDeleteMemory, pgStatus, importIntoPg } from './pg-store.js';

/* 后端选择：sqlite（默认，分区 vec0）或 pg（PGlite / 真实 Postgres + pgvector） */
let BACKEND = (process.env.CORTEX_MEMORY_BACKEND || 'sqlite').toLowerCase() === 'pg' ? 'pg' : 'sqlite';
const pgMode = () => BACKEND === 'pg';

/** 统一后端门面：路由只依赖这层，前后端契约在两种后端下完全一致 */
const be = {
  sync: (a) => (pgMode() ? pgSyncMemories(a) : Promise.resolve(syncMemories(a))),
  list: (u, w) => (pgMode() ? pgListMemories(u, w) : Promise.resolve(listMemories(u, w))),
  search: (a) => (pgMode() ? pgSearchMemories(a) : Promise.resolve(searchMemories(a))),
  del: (u, uid) => (pgMode() ? pgDeleteMemory(u, uid) : Promise.resolve(deleteMemory(u, uid))),
};

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function memoryApiPlugin({ workspace }) {
  const ctx = (req) => ({
    userId: String(req.headers['x-cortex-user'] || 'local').slice(0, 64),
    workspace: String(req.headers['x-cortex-workspace'] || workspace() || 'default').slice(0, 400),
  });

  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/mem/')) return next();
    const route = url.pathname.slice('/api/mem/'.length);

    const handle = async () => {
      const { userId, workspace: ws } = ctx(req);
      touchUser(userId);

      if (route === 'status' && req.method === 'GET') {
        if (pgMode()) {
          const st = await pgStatus();
          return sendJson(res, 200, {
            backend: st.available ? 'pgvector' : 'pgvector-offline',
            vecBackend: 'pgvector',
            bm25: true,
            partitionKey: st.partitionKey,
            memoryBackend: BACKEND,
            dim: st.dim,
            total: st.total || 0,
            vectors: st.vectors || 0,
            users: st.users || 0,
            pg: st,
            error: st.error,
            currentUser: userId,
            currentWorkspace: ws,
          });
        }
        // 顺手在后台预热 ANN 索引（分块建，不阻塞事件循环）：
        // 百万级建一次约 10s，等到第一次检索再建就会卡十几秒
        const st = stats();
        if (st.vectors >= (st.annMin || 20000)) {
          warmAnnIndex(userId).catch(() => {
            /* 预热失败不影响精确检索 */
          });
        }
        return sendJson(res, 200, {
          ...st,
          ...lastStatus(),
          annWarm: annWarmStatus(userId),
          memoryBackend: BACKEND,
          currentUser: userId,
          currentWorkspace: ws,
        });
      }
      if (route === 'backend' && req.method === 'GET') {
        const pg = await pgStatus();
        // currentUser / currentWorkspace 一起带上：面板要按「当前用户」挑索引文件，不能拿别人的
        return sendJson(res, 200, {
          memoryBackend: BACKEND,
          sqlite: { ...stats(), ...lastStatus(), currentUser: userId, currentWorkspace: ws },
          pg,
        });
      }
      if (route === 'backend' && req.method === 'POST') {
        const body = await readBody(req);
        const want = String(body.backend || '').toLowerCase();
        if (!['sqlite', 'pg'].includes(want)) return sendJson(res, 400, { error: 'backend 只能是 sqlite 或 pg' });
        if (want === 'pg') {
          const st = await pgStatus();
          if (!st.available) return sendJson(res, 503, { error: `pgvector 后端不可用：${st.error}`, pg: st });
        }
        BACKEND = want;
        // release=1：切回 sqlite 时顺手把嵌入式 PG 关掉，把 ~450MB 还给系统
        if (want === 'sqlite' && (body.release === true || body.release === '1')) {
          const { closePg } = await import('./pg-store.js');
          const closed = await closePg();
          return sendJson(res, 200, { memoryBackend: BACKEND, released: closed, pg: { available: false, backend: 'closed', error: null } });
        }
        return sendJson(res, 200, { memoryBackend: BACKEND, pg: await pgStatus() });
      }
      if (route === 'migrate' && req.method === 'POST') {
        // sqlite → pgvector 全量搬迁（含向量），用于单机切多机共享库
        const rows = exportAllMemories();
        if (!rows.length) return sendJson(res, 200, { migrated: 0, note: 'sqlite 里没有可迁移的记忆' });
        const out = await importIntoPg(rows);
        return sendJson(res, 200, { migrated: out.synced, withVector: out.withVector, scopes: out.scopes, backend: BACKEND });
      }
      if (route === 'ann' && req.method === 'POST') {
        // 索引运维：reload（丢掉内存索引，从盘上重读，等价于重启后第一次查询）/ reset（删文件，整库重建）/ save（立刻落盘）
        const body = await readBody(req);
        const action = String(body.action || 'reload');
        if (action === 'reload') return sendJson(res, 200, reloadAnnIndex(userId));
        if (action === 'reset') return sendJson(res, 200, resetAnnIndex(userId));
        if (action === 'save') return sendJson(res, 200, { saved: flushAnnSaves() });
        if (action === 'warm') return sendJson(res, 200, await warmAnnIndex(userId));
        if (action === 'gc') {
          // 清理可重建的派生数据：孤儿行（mem_q8 / vec_hot）+ 可选重建 vec0 + VACUUM
          const out = gcCaches({ rebuildVec: !!body.rebuildVec, vacuum: body.vacuum !== false });
          return sendJson(res, 200, { ...out, status: stats() });
        }
        return sendJson(res, 400, { error: 'action 只能是 reload / reset / save / warm / gc' });
      }
      if (route === 'users' && req.method === 'GET') {
        return sendJson(res, 200, { users: listUsers(), currentUser: userId });
      }
      if (route === 'users' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '').trim().slice(0, 64);
        if (!id) return sendJson(res, 400, { error: '缺少用户 id' });
        touchUser(id, body.name);
        return sendJson(res, 200, { ok: true, users: listUsers(), currentUser: id });
      }
      if (route === 'list' && req.method === 'GET') {
        return sendJson(res, 200, { memories: await be.list(userId, ws), backend: BACKEND, scope: { userId, workspace: ws } });
      }
      if (route === 'sync' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await be.sync({ userId, workspace: ws, items: body.items || [], deleted: body.deleted || [] });
        return sendJson(res, 200, { ...result, backend: BACKEND });
      }
      if (route === 'search' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await be.search({
          userId,
          workspace: ws,
          vector: Array.isArray(body.vector) ? body.vector : [],
          query: typeof body.query === 'string' ? body.query : '',
          k: body.k || 8,
          mode: ['hybrid', 'vector', 'bm25'].includes(body.mode) ? body.mode : 'hybrid',
          ann: ['on', 'off'].includes(body.ann) ? body.ann : 'auto',
        });
        return sendJson(res, 200, { ...result, backendName: BACKEND, scope: { userId, workspace: ws } });
      }
      if (route === 'delete' && req.method === 'POST') {
        const body = await readBody(req);
        const ok = await be.del(userId, String(body.uid || ''));
        return sendJson(res, 200, { ok });
      }
      if (route === 'export' && req.method === 'GET') {
        const memories = await be.list(userId, ws);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="cortex-memories-${userId}.json"`);
        return res.end(JSON.stringify({ userId, workspace: ws, exportedAt: Date.now(), memories }, null, 2));
      }
      return sendJson(res, 404, { error: `未知路由 ${req.method} /api/mem/${route}` });
    };

    handle().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  };

  return {
    name: 'cortex-memory-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
