/**
 * 浏览器端 BM25（Okapi BM25，k1=1.2, b=0.75）
 *
 * 用途：服务端不可用（或未启用 FTS5）时，在本地做稀疏检索，
 *       再和向量结果做 RRF 融合，保证"离线也走混合检索"。
 * 分词复用 tokenize.js（英文词 + 中文 bigram），与 FTS5 侧保持一致。
 */
import { tokenize } from './tokenize.js';

const K1 = 1.2;
const B = 0.75;

/**
 * 建索引
 * @param {Array<{id:string, text:string}>} docs
 */
export function buildBm25(docs) {
  const df = new Map(); // term -> 文档频次
  const postings = new Map(); // term -> Map(docIndex -> tf)
  const lens = new Array(docs.length).fill(0);

  docs.forEach((doc, i) => {
    const toks = tokenize(doc.text || '');
    lens[i] = toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      if (!postings.has(t)) postings.set(t, new Map());
      postings.get(t).set(i, n);
      df.set(t, (df.get(t) || 0) + 1);
    }
  });

  const avgdl = lens.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  return { docs, df, postings, lens, avgdl, N: docs.length };
}

/**
 * 打分
 * @returns {Array<{id:string, score:number}>} 按 BM25 降序
 */
export function searchBm25(index, query, limit = 40) {
  if (!index || !index.N) return [];
  const toks = [...new Set(tokenize(query || ''))];
  if (!toks.length) return [];

  const scores = new Map();
  for (const t of toks) {
    const plist = index.postings.get(t);
    if (!plist) continue;
    const n = index.df.get(t) || 0;
    // 加上 0.5 平滑，避免 N 很小时 idf 为负
    const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    for (const [i, tf] of plist) {
      const dl = index.lens[i] || 0;
      const denom = tf + K1 * (1 - B + (B * dl) / (index.avgdl || 1));
      const s = idf * ((tf * (K1 + 1)) / (denom || 1));
      scores.set(i, (scores.get(i) || 0) + s);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([i, score]) => ({ id: index.docs[i].id, score: Math.round(score * 10000) / 10000 }));
}

/**
 * RRF 融合（Reciprocal Rank Fusion）
 * @param {Array<{id:string, score:number}>} vecRanked 向量召回（已排序）
 * @param {Array<{id:string, score:number}>} bmRanked  BM25 召回（已排序）
 * @param {{k?:number, limit?:number}} opts
 */
export function fuseRrf(vecRanked, bmRanked, { k = 60, limit = 20 } = {}) {
  const rows = new Map();
  const row = (id) => {
    let r = rows.get(id);
    if (!r) {
      r = { id, rrf: 0 };
      rows.set(id, r);
    }
    return r;
  };
  vecRanked.forEach((h, i) => {
    const r = row(h.id);
    r.sim = h.score;
    r.vRank = i + 1;
    r.rrf += 1 / (k + i + 1);
  });
  bmRanked.forEach((h, i) => {
    const r = row(h.id);
    r.bm25 = h.score;
    r.bRank = i + 1;
    r.rrf += 1 / (k + i + 1);
  });
  return [...rows.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}
