/**
 * 记忆检索层（向量索引管理）
 *
 * 职责：
 *  - 为每条记忆生成向量（神经嵌入优先，失败回落本地哈希向量）
 *  - 维护增量索引：只对新增/变更的记忆重新编码
 *  - 提供同步的 topK 近邻查询（查询向量异步获取后走内存索引）
 *  - 索引与状态持久化，刷新后免重建
 */
import { VectorStore, embed, neural, MODEL_INFO, cacheSize, clearEmbeddingCache, VECTOR_META } from './vector.js';
import { searchServer, getBackendState } from './memoryBackend.js';
import { buildBm25, searchBm25, fuseRrf } from './bm25.js';

const INDEX_KEY = 'cortex-ide:vector-index:v1';

const KIND_LABEL = { fact: '事实', pref: '偏好', episode: '情节', task: '任务' };

let index = new VectorStore();
let hashes = new Map();
let meta = {
  provider: null,
  dim: 0,
  count: 0,
  builtAt: 0,
  building: false,
  state: 'idle', // idle | building | ready | error
  progress: 0,
  error: null,
  lastQueryMs: 0,
  embedMs: 0,
};
const listeners = new Set();
const queryCache = new Map();

export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit() {
  for (const cb of listeners) cb({ ...meta, stats: index.stats(), cache: cacheSize(), model: MODEL_INFO });
}

function setMeta(patch) {
  meta = { ...meta, ...patch };
  emit();
}

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function docText(m) {
  return `${m.text} ${(m.tags || []).join(' ')} ${KIND_LABEL[m.kind] || ''}`.trim();
}

/* ---------------- 持久化 ---------------- */

export function loadIndex() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data?.dim || !Array.isArray(data.ids)) return false;
    index = new VectorStore();
    index.load(data);
    hashes = new Map(Object.entries(data.hashes || {}));
    meta = { ...meta, provider: data.provider || 'lexical', dim: index.dim, count: index.size, builtAt: data.builtAt || 0, state: 'ready' };
    emit();
    return true;
  } catch {
    return false;
  }
}

function saveIndex() {
  try {
    const payload = {
      provider: meta.provider,
      builtAt: meta.builtAt,
      hashes: Object.fromEntries(hashes),
      ...index.serialize(),
    };
    localStorage.setItem(INDEX_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[cortex] 向量索引持久化失败（容量已满？）', err.message);
  }
}

export function clearIndex() {
  index = new VectorStore();
  hashes = new Map();
  queryCache.clear();
  try {
    localStorage.removeItem(INDEX_KEY);
  } catch {
    /* ignore */
  }
  setMeta({ provider: null, dim: 0, count: 0, builtAt: 0, state: 'idle', progress: 0 });
}

/* ---------------- 建索引 ---------------- */

let buildPromise = null;

/**
 * 增量同步索引。返回本次是否重建过。
 */
export async function ensureIndex(memories, { force = false, provider = 'auto', onProgress } = {}) {
  const pending = [];
  const texts = [];
  for (const m of memories) {
    const text = docText(m);
    const h = hashText(text);
    if (force || !index.has(m.id) || hashes.get(m.id) !== h) {
      pending.push({ mem: m, h });
      texts.push(text);
    }
  }

  // 索引里多出来的（已删除的记忆）需要剔除
  const alive = new Set(memories.map((m) => m.id));
  const stale = index.ids.filter((id) => !alive.has(id));
  if (stale.length) {
    for (const id of stale) index.remove(id);
    saveIndex();
  }

  if (!pending.length) {
    if (meta.state !== 'ready') setMeta({ state: 'ready', count: index.size, dim: index.dim });
    return false;
  }
  if (buildPromise && !force) return buildPromise;

  setMeta({ building: true, state: 'building', progress: 0, error: null });
  const t0 = performance.now();

  buildPromise = (async () => {
    try {
      // 分批编码，避免一次塞太长的数组
      const batch = 16;
      let done = 0;
      let usedProvider = meta.provider;
      for (let i = 0; i < pending.length; i += batch) {
        const slice = pending.slice(i, i + batch);
        const { vectors, provider: p } = await embed(
          slice.map((s) => docText(s.mem)),
          { provider },
        );
        usedProvider = p;
        if (index.dim && p === 'neural' && index.dim !== VECTOR_META.neural.dim) {
          // 维度变化（例如从词频向量切到 512 维神经向量）→ 全量重建
          index = new VectorStore();
          hashes = new Map();
        }
        slice.forEach((s, j) => {
          index.upsert(s.mem.id, vectors[j]);
          hashes.set(s.mem.id, s.h);
        });
        done += slice.length;
        const progress = Math.round((done / pending.length) * 100);
        setMeta({ progress, provider: usedProvider, dim: index.dim, count: index.size });
        onProgress?.(progress);
      }
      setMeta({
        building: false,
        state: 'ready',
        provider: usedProvider,
        dim: index.dim,
        count: index.size,
        builtAt: Date.now(),
        embedMs: Math.round(performance.now() - t0),
        progress: 100,
      });
      saveIndex();
    } catch (err) {
      setMeta({ building: false, state: 'error', error: err.message });
    } finally {
      buildPromise = null;
    }
  })();

  return buildPromise;
}

/* ---------------- 查询 ---------------- */

/**
 * 向量检索：返回 [{ id, sim }]
 * 查询向量异步计算，索引扫描是同步的。
 */
export async function vectorSearch(query, memories, { k = 6, provider = 'auto', mode = 'hybrid' } = {}) {
  const q = String(query || '').trim();
  if (!q || !memories.length) {
    return { hits: [], tookMs: 0, provider: meta.provider, dim: index.dim, engine: 'none', mode: 'none' };
  }

  const t0 = performance.now();
  let vec = queryCache.get(q);
  if (!vec) {
    const res = await embed([q], { provider, isQuery: true });
    vec = res.vectors[0];
    queryCache.set(q, vec);
    if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value);
  }

  /* ---- 1. 服务端混合检索（向量 KNN + BM25 → RRF），百万级记忆走这条 ---- */
  if (getBackendState().available) {
    const remote = await searchServer(vec, Math.max(k * 2, 10), q, mode);
    if (remote && remote.hits.length) {
      const tookMs = Math.round((performance.now() - t0) * 100) / 100;
      setMeta({ lastQueryMs: tookMs });
      return {
        hits: remote.hits.map((h) => {
          const sim = h.sim ?? 1 - (h.distance || 0);
          return {
            id: h.uid,
            score: sim,
            sim,
            rrf: h.rrf,
            vRank: h.vRank,
            bRank: h.bRank,
            bm25: h.bm25,
          };
        }),
        tookMs,
        provider: remote.backend,
        dim: vec.length,
        engine: remote.backend, // sqlite-vec+fts5
        mode: remote.mode || mode,
        stats: { vecHits: remote.vecHits, bmHits: remote.bmHits, vecMs: remote.vecMs, bm25Ms: remote.bm25Ms },
      };
    }
  }

  /* ---- 2. 浏览器内混合检索（离线兜底）：本地向量索引 + 本地 BM25 → RRF ---- */
  await ensureIndex(memories, { provider });
  if (index.dim && vec.length !== index.dim) {
    await ensureIndex(memories, { force: true, provider });
    const again = await embed([q], { provider, isQuery: true });
    vec = again.vectors[0];
  }
  const pool = Math.max(k * 2, 10);
  const raw = mode === 'bm25' ? [] : index.search(vec, pool);

  let bmRanked = [];
  if (mode !== 'vector') {
    const bmIdx = bm25Index(memories);
    bmRanked = searchBm25(bmIdx, q, pool);
  }

  const fused = fuseRrf(raw, bmRanked, { limit: pool });
  const tookMs = Math.round((performance.now() - t0) * 100) / 100;
  setMeta({ lastQueryMs: tookMs });
  return {
    hits: fused,
    tookMs,
    provider: meta.provider,
    dim: index.dim,
    engine: 'browser+bm25',
    mode: mode === 'bm25' ? 'bm25' : 'hybrid',
    stats: { vecHits: raw.length, bmHits: bmRanked.length },
  };
}

/** 本地 BM25 索引（按记忆内容和数量缓存，增删后自动重建） */
let bmCache = { key: '', index: null };
function bm25Index(memories) {
  const key = memories.map((m) => `${m.id}:${m.updatedAt}`).join('|');
  if (bmCache.key === key && bmCache.index) return bmCache.index;
  const docs = memories.map((m) => ({ id: m.id, text: docText(m) }));
  bmCache = { key, index: buildBm25(docs) };
  return bmCache.index;
}

export function getState() {
  return { ...meta, stats: index.stats(), cache: cacheSize(), model: MODEL_INFO };
}

export async function warmup(provider = 'auto') {
  if (provider === 'lexical') return { provider: 'lexical' };
  const ok = await neural.ensure();
  return { provider: ok ? 'neural' : 'lexical', status: neural.status, error: neural.error };
}

export { VECTOR_META, MODEL_INFO, cacheSize, clearEmbeddingCache };

/**
 * 语义去重：用向量相似度合并"说法不同但意思一样"的记忆。
 * 只比较同类型记忆，阈值默认 0.90；保留重要度更高 / 更常被用到的那条。
 */
export async function dedupeByVector(memories, { threshold = 0.88, provider = 'auto' } = {}) {
  if (memories.length < 2) return { memories, removed: [] };
  let vectors;
  try {
    const res = await embed(memories.map(docText), { provider });
    vectors = res.vectors;
  } catch {
    return { memories, removed: [] };
  }
  const drop = new Set();
  const upgraded = new Map();
  for (let i = 0; i < memories.length; i++) {
    if (drop.has(memories[i].id)) continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (drop.has(memories[j].id)) continue;
      const a = memories[i];
      const b = memories[j];
      // 类型不同也允许合并（同一条约定常被分别记成 fact 与 pref），但阈值更严
      const limit = a.kind === b.kind ? threshold : threshold + 0.02;
      let dot = 0;
      const va = vectors[i];
      const vb = vectors[j];
      for (let d = 0; d < va.length; d++) dot += va[d] * vb[d];
      if (dot < limit) continue;
      // 保留分数更高的一条
      const scoreA = (a.importance || 0) * 2 + (a.uses || 0) + (a.pinned ? 5 : 0);
      const scoreB = (b.importance || 0) * 2 + (b.uses || 0) + (b.pinned ? 5 : 0);
      const [keep, gone] = scoreA >= scoreB ? [a, b] : [b, a];
      if (!drop.has(keep.id)) {
        upgraded.set(keep.id, { ...keep, uses: (keep.uses || 0) + (gone.uses || 0) + 1, mergedCount: (keep.mergedCount || 1) + 1 });
        drop.add(gone.id);
      }
    }
  }
  if (!drop.size) return { memories, removed: [] };
  const next = memories.filter((m) => !drop.has(m.id)).map((m) => upgraded.get(m.id) || m);
  return { memories: next, removed: [...drop] };
}
