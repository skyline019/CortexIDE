/**
 * 稀疏检索的公共部分：分词 → tokens 串 / MATCH 表达式 / RRF 融合
 * SQLite(FTS5) 与 Postgres(tsvector) 两个后端共用同一套分词结果，
 * 保证同一句记忆在两种后端下的 BM25 命中一致。
 */
import { tokenize } from '../src/lib/tokenize.js';

/** 记忆文本 → 空格分隔的 token 串（英文词 + 中文 bigram） */
export function tokensOf(text, tags) {
  let t = String(text || '');
  if (tags) {
    try {
      const arr = typeof tags === 'string' ? JSON.parse(tags) : tags;
      if (Array.isArray(arr)) t += ' ' + arr.join(' ');
    } catch {
      /* ignore */
    }
  }
  return [...new Set(tokenize(t))].join(' ');
}

/** 查询 → FTS5 MATCH 表达式（每个 token 加引号，OR 连接） */
export function ftsQuery(query) {
  const toks = queryTokens(query);
  if (!toks.length) return null;
  return toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** 查询 → tsquery 表达式（Postgres：tok1 | tok2） */
export function tsQuery(query) {
  const toks = queryTokens(query);
  if (!toks.length) return null;
  return toks.map((t) => `'${t.replace(/'/g, "''")}'`).join(' | ');
}

export function queryTokens(query) {
  return [...new Set(tokenize(String(query || '')))]
    .filter((t) => t.length > 1 || /^[a-z0-9]$/i.test(t))
    .slice(0, 32);
}

export const RRF_K = 60;

/**
 * RRF 融合：分数 = Σ 1/(K + rank)
 * @param {Array<{uid:string, sim?:number, distance?:number}>} vecHits
 * @param {Array<{uid:string, score:number}>} bmHits
 */
export function fuseRrf(vecHits, bmHits, { k = RRF_K, limit = 20 } = {}) {
  const rows = new Map();
  const rowOf = (uid) => {
    let row = rows.get(uid);
    if (!row) {
      row = { uid, rrf: 0 };
      rows.set(uid, row);
    }
    return row;
  };
  vecHits.forEach((h, i) => {
    const row = rowOf(h.uid);
    if (typeof h.sim === 'number') row.sim = Math.round(h.sim * 10000) / 10000;
    if (typeof h.distance === 'number') row.distance = h.distance;
    row.vRank = i + 1;
    row.rrf += 1 / (k + i + 1);
  });
  bmHits.forEach((h, i) => {
    const row = rowOf(h.uid);
    if (typeof h.score === 'number') row.bm25 = Math.round(h.score * 10000) / 10000;
    row.bRank = i + 1;
    row.rrf += 1 / (k + i + 1);
  });
  return [...rows.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map((r) => ({ ...r, rrf: Math.round(r.rrf * 1e6) / 1e6 }));
}
