/**
 * Postgres + pgvector 记忆后端（多机部署路径）
 *
 * 同一个 `searchMemories()` 契约下，这里用**真 SQL** 做两件事：
 *   1. 向量召回：`embedding <=> $1::vector` + HNSW 索引（`vector_cosine_ops`）
 *   2. 稀疏召回：`to_tsvector('simple', tokens)` + GIN 索引 + `ts_rank`
 *   3. 融合：与应用层一致的 RRF（1/(60+rank)）
 *
 * 隔离：所有语句都带 `user_id = $n and workspace = $n`；pgvector 没有
 * 「分区键」概念，但 HNSW + where 过滤在 PG 12+ 走 iterative scan，
 * 语义上与 sqlite-vec 的 partition key 等价（见 README「多机部署」）。
 *
 * 后端选择：
 *   CORTEX_MEMORY_BACKEND=sqlite   （默认）
 *   CORTEX_MEMORY_BACKEND=pg       → 用 PGlite（嵌入式 PG 18 + pgvector 0.8.7，
 *                                    数据落在 .cortex/pgdata，无需 docker）
 *   设置了 PG_URL                    → 用真实 Postgres（需 `npm i pg`，见 README）
 */
import fs from 'node:fs';
import path from 'node:path';
import { tokensOf, tsQuery, queryTokens, fuseRrf } from './text-index.js';

const DIM = Number(process.env.EMBED_DIM || 512);
const VEC_LITERAL = (arr) => `[${Array.from(arr, (x) => (Number.isFinite(x) ? Number(x.toFixed(6)) : 0)).join(',')}]`;

let sql = null; // 统一查询接口：{ query(text, params), exec(text) }
let ready = false;
let backendName = 'none';
let lastError = null;
let initPromise = null;
let dbHandle = null; // PGlite / Pool 句柄，closePg() 用

async function init() {
  const dataDir = process.env.CORTEX_PG_DIR || path.join(process.cwd(), '.cortex', 'pgdata');
  if (process.env.PG_URL) {
    try {
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: process.env.PG_URL, max: 8 });
      dbHandle = pool;
      sql = {
        query: (text, params) => pool.query(text, params),
        exec: (text) => pool.query(text),
      };
      backendName = 'postgres+pgvector';
    } catch (err) {
      lastError = `PG_URL 已配置但缺少 pg 客户端（npm i pg）：${err.message}`;
      return;
    }
  } else {
    try {
      const { PGlite } = await import('@electric-sql/pglite');
      const { vector } = await import('@electric-sql/pglite-pgvector');
      if (process.env.CORTEX_PG_RESET === '1' && fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
        const bak = `${dataDir}.corrupt-${Date.now()}`;
        fs.renameSync(dataDir, bak);
        lastError = `按 CORTEX_PG_RESET=1 重建：旧数据目录已挪到 ${path.basename(bak)}`;
      }
      fs.mkdirSync(dataDir, { recursive: true });
      const db = await PGlite.create({ dataDir, extensions: { vector } });
      dbHandle = db;
      await db.exec('create extension if not exists vector');
      const inst = {
        query: (text, params) => db.query(text, params || []),
        exec: (text) => db.exec(text),
      };
      sql = inst;
      backendName = 'pglite+pgvector';
    } catch (err) {
      // 真机踩到过：进程被 OOM 杀掉时 PGlite 正在写数据目录，下次启动就起不来
      // （报 “PGlite failed to initialize properly”，一个字也说不出为什么）。
      // 数据目录坏了不该自动删（那是用户数据），但必须给出**可执行的恢复动作**。
      const hint = fs.existsSync(dataDir)
        ? `（数据目录 ${path.relative(process.cwd(), dataDir)} 可能是上一次异常退出时写坏的；` +
          '执行 `npm run pg:reset` 会把它挪到旁边后重建，或设置 CORTEX_PG_RESET=1 让服务端下次启动时自动重建）'
        : '';
      lastError = `PGlite 启动失败：${err.message}${hint}`;
      return;
    }
  }

  try {
    await sql.exec(`
      create table if not exists memories (
        id bigserial primary key,
        uid text not null,
        user_id text not null,
        workspace text not null,
        text text not null,
        tags jsonb not null default '[]'::jsonb,
        kind text,
        importance int not null default 3,
        created_at bigint not null default 0,
        updated_at bigint not null default 0,
        tokens text not null default '',
        embedding vector(${DIM}),
        unique (user_id, workspace, uid)
      );
      create index if not exists memories_scope on memories (user_id, workspace);
      create index if not exists memories_uid on memories (user_id, uid);
      create index if not exists memories_tokens on memories using gin (to_tsvector('simple', tokens));
    `);
    try {
      await sql.exec(`create index if not exists memories_vec on memories using hnsw (embedding vector_cosine_ops)`);
    } catch (err) {
      lastError = `HNSW 索引创建失败（退化为顺序扫描）：${err.message}`;
    }
    backendName += ` · vector(${DIM}) · hnsw`;
    ready = true;
  } catch (err) {
    lastError = `建表失败：${err.message}`;
  }
}

export function ensurePgReady() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

/**
 * 主动关掉 PG 连接，把内存还回来（PGlite 常驻约 450MB）。
 * 单机自用场景下「看完 pg 后端切回 sqlite」之后没必要一直占着内存 ——
 * 2GB 的开发机上，这 450MB 决定了浏览器还开不开得起来。
 */
export async function closePg() {
  if (!dbHandle) {
    sql = null;
    ready = false;
    initPromise = null;
    return { closed: false, reason: '没有已建立的连接' };
  }
  const handle = dbHandle;
  dbHandle = null;
  sql = null;
  ready = false;
  initPromise = null;
  try {
    await handle.close?.();
    return { closed: true };
  } catch (err) {
    return { closed: false, reason: err.message };
  }
}

export async function pgStatus() {
  await ensurePgReady();
  if (!ready) return { available: false, backend: 'postgres', error: lastError };
  try {
    const r = await sql.query(
      `select count(*)::int as total,
              count(embedding)::int as vectors,
              count(distinct user_id)::int as users
       from memories`,
    );
    const ext = await sql.query(`select extversion from pg_extension where extname = 'vector'`);
    return {
      available: true,
      backend: backendName,
      pgvector: ext.rows[0]?.extversion || null,
      dim: DIM,
      partitionKey: 'user_id (where 过滤) · hnsw',
      ...r.rows[0],
      error: lastError,
    };
  } catch (err) {
    return { available: false, backend: backendName, error: err.message };
  }
}

/** 与 sqlite 后端同名的同步接口（前端 memory.js 不区分后端） */
export async function pgSyncMemories({ userId, workspace, items = [], deleted = [] }) {
  await ensurePgReady();
  if (!ready) return { synced: 0, error: lastError };
  let n = 0;
  for (const m of items) {
    const emb = m.vector || m.embedding || m.vec;
    const toks = tokensOf(m.text, m.tags);
    const params = [
      String(m.uid),
      userId,
      workspace,
      String(m.text || ''),
      JSON.stringify(m.tags || []),
      m.kind || 'fact',
      Number(m.importance || 3),
      Number(m.createdAt || m.created_at || Date.now()),
      Number(m.updatedAt || m.updated_at || Date.now()),
      toks,
    ];
    if (emb && emb.length === DIM) {
      params.push(VEC_LITERAL(emb));
      await sql.query(
        `insert into memories (uid,user_id,workspace,text,tags,kind,importance,created_at,updated_at,tokens,embedding)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::vector)
         on conflict (user_id,workspace,uid) do update set
           text=excluded.text, tags=excluded.tags, kind=excluded.kind,
           importance=excluded.importance, updated_at=excluded.updated_at,
           tokens=excluded.tokens, embedding=excluded.embedding`,
        params,
      );
    } else {
      await sql.query(
        `insert into memories (uid,user_id,workspace,text,tags,kind,importance,created_at,updated_at,tokens)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
         on conflict (user_id,workspace,uid) do update set
           text=excluded.text, tags=excluded.tags, kind=excluded.kind,
           importance=excluded.importance, updated_at=excluded.updated_at,
           tokens=excluded.tokens`,
        params,
      );
    }
    n += 1;
  }
  for (const uid of deleted) {
    await sql.query(`delete from memories where user_id=$1 and workspace=$2 and uid=$3`, [userId, workspace, String(uid)]);
  }
  return { synced: n, deleted: deleted.length };
}

export async function pgListMemories(userId, workspace) {
  await ensurePgReady();
  const r = await sql.query(
    `select uid, text, tags, kind, importance, created_at, updated_at, embedding is not null as has_vec
     from memories where user_id=$1 and workspace=$2 order by updated_at desc limit 5000`,
    [userId, workspace],
  );
  return r.rows;
}

export async function pgDeleteMemory(userId, uid) {
  await ensurePgReady();
  const r = await sql.query(`delete from memories where user_id=$1 and uid=$2`, [userId, String(uid)]);
  return { deleted: r.rowCount ?? 0 };
}

/** 混合检索：KNN + 全文，RRF 融合（与 sqlite 后端返回结构一致） */
export async function pgSearchMemories({ userId, workspace, vector, query, k = 8, mode = 'hybrid', pool } = {}) {
  await ensurePgReady();
  if (!ready) return { hits: [], backend: 'postgres', mode, error: lastError, fused: false };
  const t0 = performance.now();
  const fetchN = Number(pool || Math.max(k * 4, 32));
  const wantVec = (mode === 'hybrid' || mode === 'vector') && Array.isArray(vector) && vector.length === DIM;
  const wantBm = mode === 'hybrid' || mode === 'bm25';

  let vecHits = [];
  let bmHits = [];
  let vecMs = 0;
  let bm25Ms = 0;

  if (wantVec) {
    const t = performance.now();
    try {
      const r = await sql.query(
        `select uid, (embedding <=> $1::vector) as distance
         from memories
         where user_id = $2 and workspace = $3 and embedding is not null
         order by embedding <=> $1::vector
         limit $4`,
        [VEC_LITERAL(vector), userId, workspace, fetchN],
      );
      // pgvector 的 `<=>` 就是 cosine 距离（1-cos），和 sqlite-vec 的 cosine 度量同口径
      vecHits = r.rows.map((x) => ({ uid: x.uid, distance: Number(x.distance), sim: 1 - Number(x.distance) }));
    } catch (err) {
      lastError = `pg 向量召回失败：${err.message}`;
    }
    vecMs = Math.round((performance.now() - t) * 100) / 100;
  }

  if (wantBm) {
    const t = performance.now();
    const q = tsQuery(query);
    if (q) {
      try {
        const qToks = queryTokens(query);
        const minCover = qToks.length > 1 ? Math.max(1, Math.ceil(qToks.length * 0.2)) : 1;
        const r = await sql.query(
          `select uid, tokens, ts_rank(to_tsvector('simple', tokens), to_tsquery('simple', $1)) as score
           from memories
           where user_id = $2 and workspace = $3
             and to_tsvector('simple', tokens) @@ to_tsquery('simple', $1)
           order by score desc
           limit $4`,
          [q, userId, workspace, fetchN],
        );
        // 与 sqlite 后端保持同一套「覆盖率门槛」
        bmHits = r.rows
          .map((x) => {
            const docToks = new Set(String(x.tokens || '').split(' '));
            return { uid: x.uid, score: Number(x.score), cover: qToks.filter((t) => docToks.has(t)).length };
          })
          .filter((h) => h.cover >= minCover);
      } catch (err) {
        lastError = `pg 全文召回失败：${err.message}`;
      }
    }
    bm25Ms = Math.round((performance.now() - t) * 100) / 100;
  }

  let hits;
  if (mode === 'bm25') hits = bmHits.slice(0, k).map((h, i) => ({ uid: h.uid, bm25: h.score, bRank: i + 1, rrf: 1 / (60 + i + 1) }));
  else if (mode === 'vector') hits = vecHits.slice(0, k).map((h, i) => ({ uid: h.uid, sim: h.sim, distance: h.distance, vRank: i + 1, rrf: 1 / (60 + i + 1) }));
  else hits = fuseRrf(vecHits, bmHits, { limit: k });

  return {
    hits,
    backend: backendName,
    mode,
    fused: mode === 'hybrid',
    vecHits: vecHits.length,
    bmHits: bmHits.length,
    vecMs,
    bm25Ms,
    tookMs: Math.round((performance.now() - t0) * 100) / 100,
    error: lastError,
  };
}

/**
 * 把 sqlite 后端里的记忆（含向量）整批搬到 Postgres。
 * 用于「单机 sqlite → 多机共享 pg」的迁移，也可当后端一致性自测。
 */
export async function importIntoPg(rows) {
  await ensurePgReady();
  let vec = 0;
  for (const r of rows) {
    const emb = r.vector || r.vec;
    if (emb && emb.length === DIM) vec += 1;
  }
  const byScope = new Map();
  for (const r of rows) {
    const key = `${r.userId || r.user_id}\u0000${r.workspace}`;
    if (!byScope.has(key)) byScope.set(key, { userId: r.userId || r.user_id, workspace: r.workspace, items: [] });
    byScope.get(key).items.push({
      uid: r.uid,
      text: r.text,
      tags: r.tags,
      kind: r.kind,
      importance: r.importance,
      createdAt: r.createdAt || r.created_at,
      updatedAt: r.updatedAt || r.updated_at,
      vector: r.vector || r.vec,
    });
  }
  let synced = 0;
  for (const scope of byScope.values()) {
    const res = await pgSyncMemories(scope);
    synced += res.synced || 0;
  }
  return { synced, withVector: vec, scopes: byScope.size };
}

export function pgTokenDebug(query) {
  return { tokens: queryTokens(query), expr: tsQuery(query) };
}
