/**
 * 记忆检索：热点短路 → ANN → 精确 KNN + BM25 RRF
 * 通过 bindMemorySearch 注入 memory-store 运行时，避免环形依赖。
 */
import { ftsQuery, queryTokens } from './text-index.js';

/** @type {any} */
let D = null;

export function bindMemorySearch(runtime) {
  D = runtime;
}

/** 候选 rowid 回 sqlite-vec 精排（精确余弦距离） */
function rerank(d, ids, vector, userId, workspace) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  // ⚠️ 不要在这里 join memories：一旦 join，vec0 的 rowid 过滤就退化成全表扫描
  //（实测 30k 条从 7ms 变成 370ms）。分两步：vec0 里按 rowid 取距离，再回普通表取元信息。
  const rows = d
    .prepare(`select rowid as id, vec_distance_cosine(embedding, ?) as distance from ${D.VEC_TABLE} where rowid in (${ph})`)
    .all(D.toBlob(vector), ...ids.map((x) => BigInt(x)));
  if (!rows.length) return [];
  const meta = d
    .prepare(`select id, uid from memories where id in (${ph}) and user_id = ? and workspace = ?`)
    .all(...ids, userId, workspace);
  const uidOf = new Map(meta.map((m) => [String(m.id), m.uid]));
  return rows
    .filter((r) => uidOf.has(String(r.id)))
    .map((r) => ({ uid: uidOf.get(String(r.id)), distance: r.distance, sim: 1 - r.distance }))
    .sort((a, b) => a.distance - b.distance);
}

/** 热点表精确 KNN（小表，通常几百~两千条，亚毫秒级） */
function hotSearch(d, vector, userId, workspace, limit) {
  try {
    return d
      .prepare(
        `select m.uid as uid, v.distance as distance
         from (select rowid, distance from vec_hot where embedding match ? and k = ? and user_id = ?) v
         join memories m on m.id = v.rowid
         where m.workspace = ? order by v.distance asc limit ?`,
      )
      .all(D.toBlob(vector), limit, userId, workspace, limit)
      .map((r) => ({ uid: r.uid, distance: r.distance, sim: 1 - r.distance }));
  } catch (err) {
    D.lastError = `热点查询失败：${err.message}`;
    return [];
  }
}


export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * 向量检索（严格限定在 user + workspace 范围内）
 * @returns {{hits: {uid:string, sim:number, distance:number}[], backend:string, tookMs:number}}
 */
const RRF_K = 60; // RRF 常数：rank 贡献 = 1/(K + rank)

/**
 * 检索：向量 KNN（分区索引） + BM25（FTS5），RRF 融合
 *
 * @param {{userId:string, workspace:string, vector?:number[]|Float32Array,
 *          query?:string, k?:number, mode?:'hybrid'|'vector'|'bm25', pool?:number}} p
 * @returns {{hits:Array<{uid,distance?,sim?,bm25?,vRank?,bRank?,rrf}>, backend:string,
 *            mode:string, tookMs:number, vecMs:number, bm25Ms:number, fused:number}}
 */
export function searchMemories({ userId, workspace, vector, query, k = 8, mode = 'hybrid', pool, ann = 'auto' } = {}) {
  const d = D.open();
  const t0 = performance.now();
  const limit = Math.max(1, Math.min(200, Number(k) || 8));
  const fetchN = pool || Math.max(limit * 8, 40);

  const useVec = mode !== 'bm25' && vector && vector.length;
  const useBm25 = mode !== 'vector' && D.ftsReady && query && String(query).trim();

  /* ---------- 1. 向量召回：热点短路 → 二值量化 ANN → 精确 KNN ---------- */
  let vecHits = [];
  let vecMs = 0;
  let tier = 'exact';
  let annInfo = null;
  if (useVec) {
    const t = performance.now();
    if (D.vecReady) {
      // 1a. 热点表（小表，亚毫秒）
      const hot = hotSearch(d, vector, userId, workspace, Math.max(limit, 8));
      if (hot.length) D.tierStats.hotQueries += 1;
      const hotEnough = hot.length >= limit && hot[hot.length - 1].distance <= D.HOT_SKIP_DIST;
      if (hotEnough) {
        vecHits = hot.slice(0, fetchN);
        tier = 'hot';
        D.tierStats.hotShortCircuit += 1;
      } else {
        // 1b. 冷数据：条数够多就走「二值量化 + 精排」，否则精确 KNN
        let cold = [];
        let vecCount = 0;
        try {
          vecCount = D.vecCountFor(d, userId);
        } catch {
          vecCount = 0;
        }
        const useAnn = ann === 'on' ? true : ann === 'off' ? false : vecCount >= D.ANN_MIN;
        if (useAnn) {
          const tIdx = performance.now();
          const { index } = D.annIndexFor(userId);
          const searchMs = performance.now() - tIdx;
          const tSearch = performance.now();
          const candAll = index.search(vector, Math.max(D.ANN_CAND, fetchN * 4));
          const cand = candAll.slice(0, Math.max(D.ANN_RERANK, fetchN * 2));
          const hamMs = performance.now() - tSearch;
          const tRe = performance.now();
          // 优先用 int8 侧表精排（主键查询，快）；侧表还没建好就退回 vec0
          cold = D.rerankQ8(d, cand.map((c) => c.id), vector, userId, workspace);
          if (!cold.length) cold = rerank(d, cand.map((c) => c.id), vector, userId, workspace);
          const rerankMs = performance.now() - tRe;
          if (cold.length) {
            D.tierStats.annQueries += 1;
            tier = hot.length ? 'hot+ann' : 'ann';
          }
          const r2 = (x) => Math.round(x * 100) / 100;
          annInfo = {
            mode: 'binary-quant',
            candidates: candAll.length,
            reranked: cand.length,
            indexSize: index.size,
            buildMs: index.buildMs,
            bytes: index.bytes,
            ms: { index: r2(searchMs), hamming: r2(hamMs), rerank: r2(rerankMs) },
          };
        }
        if (!cold.length) {
          cold = d
            .prepare(
              `select m.uid as uid, v.distance as distance
               from (select rowid, distance from ${D.VEC_TABLE}
                     where embedding match ? and k = ? and user_id = ?) v
               join memories m on m.id = v.rowid
               where m.workspace = ?
               order by v.distance asc
               limit ?`,
            )
            .all(D.toBlob(vector), fetchN, userId, workspace, fetchN)
            .map((r) => ({ uid: r.uid, distance: r.distance, sim: 1 - r.distance }));
          if (!hot.length) tier = 'exact';
          D.tierStats.exactQueries += 1;
        }
        // 1c. 热点与冷数据按距离合并（两边都是精确距离，直接归并）
        const seen = new Set();
        vecHits = [...hot, ...cold]
          .sort((a, b) => a.distance - b.distance)
          .filter((h) => (seen.has(h.uid) ? false : seen.add(h.uid)))
          .slice(0, fetchN);
      }
    }
    if (!vecHits.length && !D.vecReady) {
      // 扩展缺失：拉该用户该工作区的 BLOB 在 JS 里算余弦
      const rows = d
        .prepare('select uid, vec from memories where user_id = ? and workspace = ? and vec is not null')
        .all(userId, workspace);
      const scored = rows.map((r) => {
        const f = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
        const sim = cosine(vector, f);
        return { uid: r.uid, sim, distance: 1 - sim };
      });
      scored.sort((a, b) => b.sim - a.sim);
      vecHits = scored.slice(0, fetchN);
      tier = 'js-scan';
    }
    vecMs = Math.round((performance.now() - t) * 100) / 100;
  }

  /* ---------- 2. BM25 召回（FTS5，同样按用户 / 工作区过滤） ---------- */
  let bmHits = [];
  let bm25Ms = 0;
  if (useBm25) {
    const t = performance.now();
    const expr = ftsQuery(query);
    if (expr) {
      try {
        const qToks = queryTokens(query);
        // 覆盖率门槛：中文 bigram 很容易只命中一个泛词（如「代码」），
        // 一条只覆盖 1/10 查询词的记忆不该靠 BM25 挤掉语义召回的答案。
        const minCover = qToks.length > 1 ? Math.max(1, Math.ceil(qToks.length * 0.2)) : 1;
        bmHits = d
          .prepare(
            `select m.uid as uid, m.tokens as tokens, bm25(memories_fts) as score
             from memories_fts
             join memories m on m.id = memories_fts.rowid
             where memories_fts match ? and m.user_id = ? and m.workspace = ?
             order by score
             limit ?`,
          )
          .all(expr, userId, workspace, fetchN)
          .map((r) => {
            const docToks = new Set(String(r.tokens || '').split(' '));
            const cover = qToks.filter((t) => docToks.has(t)).length;
            return { uid: r.uid, bm25: -r.score, cover };
          })
          .filter((h) => h.cover >= minCover)
          .map(({ uid, bm25, cover }) => ({ uid, bm25, cover }));
      } catch (err) {
        D.lastError = `BM25 查询失败：${err.message}`;
      }
    }
    bm25Ms = Math.round((performance.now() - t) * 100) / 100;
  }

  /* ---------- 3. RRF 融合 ---------- */
  const fused = new Map();
  const rowOf = (uid) => {
    let row = fused.get(uid);
    if (!row) {
      row = { uid, rrf: 0 };
      fused.set(uid, row);
    }
    return row;
  };
  vecHits.forEach((h, i) => {
    const row = rowOf(h.uid);
    row.sim = Math.round(h.sim * 10000) / 10000;
    row.distance = h.distance;
    row.vRank = i + 1;
    row.rrf += 1 / (RRF_K + i + 1);
  });
  bmHits.forEach((h, i) => {
    const row = rowOf(h.uid);
    row.bm25 = Math.round(h.bm25 * 10000) / 10000;
    row.bRank = i + 1;
    row.rrf += 1 / (RRF_K + i + 1);
  });

  const hits = [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map((r) => ({ ...r, rrf: Math.round(r.rrf * 1e6) / 1e6 }));

  return {
    hits,
    backend: D.vecReady ? (D.ftsReady ? 'sqlite-vec+fts5' : 'sqlite-vec') : D.ftsReady ? 'sqlite-fts5' : 'sqlite-blob',
    mode: useVec && useBm25 ? 'hybrid' : useVec ? 'vector' : useBm25 ? 'bm25' : 'none',
    fused: fused.size,
    tier,
    ann: annInfo,
    vecHits: vecHits.length,
    bmHits: bmHits.length,
    vecMs,
    bm25Ms,
    tookMs: Math.round((performance.now() - t0) * 100) / 100,
  };
}

