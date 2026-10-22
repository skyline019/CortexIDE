/**
 * 轻量分词 + TF-IDF + 余弦相似度
 * 支持中英混排：英文按词切分（含 camelCase 拆分），中文按字符 bigram 切分。
 * 全部在本地内存计算，不依赖任何外部 embedding 服务。
 */

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'in', 'on',
  'at', 'by', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'as',
  'de', 'la', 'le', 'el', 'en', 'y', 'un', 'una', 'es', 'que',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '与', '就', '也', '都',
  '很', '把', '被', '给', '对', '这', '那', '个', '上', '下', '中', '要', '会', '去', '有',
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** 把文本切成 term 数组（可能重复，用于词频统计） */
export function tokenize(text) {
  const out = [];
  if (!text) return out;
  const lower = String(text).toLowerCase();

  // 英文 / 数字 / 标识符
  const latin = lower.match(/[a-z0-9_$][a-z0-9_$.-]{1,}/g) || [];
  for (const w of latin) {
    if (STOP.has(w)) continue;
    out.push(w);
    // camelCase / snake_case 拆分
    const parts = w.split(/[_\-.]/).filter(Boolean);
    if (parts.length > 1) for (const p of parts) if (p.length > 1 && !STOP.has(p)) out.push(p);
    if (/[a-z][A-Z]/.test(w)) {
      for (const p of w.split(/(?=[A-Z])/)) {
        const q = p.toLowerCase();
        if (q.length > 1 && !STOP.has(q)) out.push(q);
      }
    }
  }

  // 中文 / 日文 / 韩文：连续块内做 bigram
  const cjkBlocks = lower.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
  for (const block of cjkBlocks) {
    if (block.length === 1) {
      out.push(block);
      continue;
    }
    for (let i = 0; i < block.length - 1; i++) out.push(block.slice(i, i + 2));
  }
  return out;
}

export function termFreq(text) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

export function hasCJK(text) {
  return CJK_RE.test(text || '');
}

/**
 * 构建语料库索引
 * @param {{id:string, text:string}[]} docs
 */
export function buildIndex(docs) {
  const df = new Map();
  const tfs = new Map();
  for (const d of docs) {
    const tf = termFreq(d.text);
    tfs.set(d.id, tf);
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = Math.max(1, docs.length);
  const idf = new Map();
  for (const [term, n] of df) idf.set(term, Math.log(1 + N / (1 + n)) + 0.1);
  return { idf, tfs, N, docs };
}

function vecFromTf(tf, idf) {
  const v = new Map();
  let norm = 0;
  for (const [term, n] of tf) {
    const w = (1 + Math.log(n)) * (idf.get(term) || 0.35);
    if (!w) continue;
    v.set(term, w);
    norm += w * w;
  }
  return { v, norm: Math.sqrt(norm) || 1 };
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  const [small, large] = a.v.size <= b.v.size ? [a.v, b.v] : [b.v, a.v];
  let dot = 0;
  for (const [term, w] of small) {
    const w2 = large.get(term);
    if (w2) dot += w * w2;
  }
  return dot / (a.norm * b.norm);
}

/** 一次性计算 query 与语料库每条文档的相似度 */
export function rankByQuery(query, index) {
  const qtf = termFreq(query);
  const qv = vecFromTf(qtf, index.idf);
  const scored = [];
  for (const doc of index.docs) {
    const tf = index.tfs.get(doc.id);
    if (!tf) continue;
    const dv = vecFromTf(tf, index.idf);
    const sim = cosine(qv, dv);
    if (sim > 0) scored.push({ id: doc.id, sim });
  }
  return scored.sort((x, y) => y.sim - x.sim);
}

/** 两段短文本的相似度（用于去重） */
export function textSimilarity(a, b) {
  const idx = buildIndex([
    { id: 'a', text: a },
    { id: 'b', text: b },
  ]);
  const va = vecFromTf(termFreq(a), idx.idf);
  const vb = vecFromTf(termFreq(b), idx.idf);
  return cosine(va, vb);
}

/**
 * 字符级兜底检索：当 TF-IDF 没有命中时（常见于极短的中文查询），
 * 用字符重合度给一个保守的相似度，避免"搜不到"的死角。
 */
export function rankFuzzy(query, docs) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  const chars = [...new Set(q.split(''))].filter((c) => c.trim());
  if (!chars.length) return [];
  const out = [];
  for (const d of docs) {
    const text = d.text.toLowerCase();
    if (text.includes(q)) {
      out.push({ id: d.id, sim: 0.5 });
      continue;
    }
    let hit = 0;
    for (const c of chars) if (text.includes(c)) hit++;
    const ratio = hit / chars.length;
    if (ratio >= 0.5) out.push({ id: d.id, sim: 0.32 * ratio });
  }
  return out.sort((a, b) => b.sim - a.sim);
}
