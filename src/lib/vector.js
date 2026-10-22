/**
 * 向量检索层
 *
 * - VectorStore：Float32Array 扁平存储 + L2 归一化 + 余弦 topK 扫描
 * - embedder 可插拔：
 *     neural  → 浏览器 Web Worker 里的 bge-small-zh-v1.5（transformers.js，512 维）
 *     lexical → 本地字符/词 n-gram 哈希嵌入（零依赖，离线可用，256 维）
 * - 向量按内容哈希缓存，避免重复编码；索引与缓存都持久化到 localStorage
 */
import { tokenize } from './tokenize.js';

const CACHE_KEY = 'cortex-ide:embeddings:v1';
const CACHE_LIMIT = 1200;

/* ------------------------------------------------------------------ */
/* 向量索引                                                            */
/* ------------------------------------------------------------------ */

export class VectorStore {
  constructor(dim = 0) {
    this.dim = dim;
    this.ids = [];
    this.data = new Float32Array(0);
    this.index = new Map();
  }

  get size() {
    return this.ids.length;
  }

  clear() {
    this.ids = [];
    this.index = new Map();
    this.data = new Float32Array(0);
  }

  upsert(id, vec) {
    if (!vec || !vec.length) return;
    if (!this.dim) {
      this.dim = vec.length;
      this.data = new Float32Array(0);
    }
    if (vec.length !== this.dim) throw new Error(`维度不一致：${vec.length} vs ${this.dim}`);
    const row = this.index.get(id);
    const norm = normalize(vec);
    if (row == null) {
      const at = this.ids.length;
      this.index.set(id, at);
      this.ids.push(id);
      const next = new Float32Array(this.data.length + this.dim);
      next.set(this.data, 0);
      next.set(norm, this.data.length);
      this.data = next;
    } else {
      this.data.set(norm, row * this.dim);
    }
  }

  remove(id) {
    if (!this.index.has(id)) return;
    const keep = this.ids.filter((x) => x !== id);
    const snapshot = new Map();
    for (const [key, row] of this.index) if (key !== id) snapshot.set(key, this.get(row));
    this.clear();
    for (const key of keep) this.upsert(key, snapshot.get(key));
  }

  get(row) {
    return this.data.subarray(row * this.dim, (row + 1) * this.dim);
  }

  has(id) {
    return this.index.has(id);
  }

  /** 余弦相似度 topK（向量已归一化，点积即余弦） */
  search(vec, k = 6) {
    if (!this.dim || !this.ids.length) return [];
    const q = normalize(vec);
    const out = [];
    for (let i = 0; i < this.ids.length; i++) {
      const row = this.data.subarray(i * this.dim, (i + 1) * this.dim);
      let dot = 0;
      for (let d = 0; d < this.dim; d++) dot += q[d] * row[d];
      out.push({ id: this.ids[i], score: dot });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** 导出成可序列化结构（Float32 -> 精度 3 位数组，压缩体积） */
  serialize() {
    return {
      dim: this.dim,
      ids: this.ids,
      data: Array.from(this.data, (v) => Math.round(v * 1000) / 1000),
    };
  }

  load(state) {
    if (!state?.dim || !Array.isArray(state.ids)) return;
    this.dim = state.dim;
    this.ids = state.ids;
    this.data = Float32Array.from(state.data || []);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
  }

  stats() {
    return {
      count: this.size,
      dim: this.dim,
      bytes: this.data.byteLength,
      memoryMb: +(this.data.byteLength / 1024 / 1024).toFixed(2),
    };
  }
}

export function normalize(vec) {
  const out = Float32Array.from ? Float32Array.from(vec) : new Float32Array(vec);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/* ------------------------------------------------------------------ */
/* 本地哈希嵌入（零依赖兜底）                                          */
/* ------------------------------------------------------------------ */

const LEXICAL_DIM = 256;

function hash32(str, seed = 0) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 特征哈希：词 + 中文 bigram + 字符 trigram 映射到固定维度。
 * 不是神经嵌入，但它是真正的向量表示（可做余弦近邻），且完全离线。
 */
export function lexicalEmbed(text) {
  const v = new Float32Array(LEXICAL_DIM);
  const terms = tokenize(text);
  const push = (term, weight) => {
    const h = hash32(term);
    const idx = h % LEXICAL_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    v[idx] += sign * weight;
  };
  for (const t of terms) push(t, 1);
  const compact = String(text || '').toLowerCase().replace(/\s+/g, '');
  for (let i = 0; i < compact.length - 2; i++) push(compact.slice(i, i + 3), 0.35);
  for (let i = 0; i < compact.length - 1; i++) push('#' + compact.slice(i, i + 2), 0.25);
  return normalize(v);
}

/* ------------------------------------------------------------------ */
/* 神经嵌入（Web Worker + transformers.js）                            */
/* ------------------------------------------------------------------ */

const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const MODEL_META = {
  id: MODEL_ID,
  dim: 512,
  size: '~24MB (q8)',
  queryPrefix: '为这个句子生成表示以用于检索相关文章：',
};

class NeuralEmbedder {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.status = 'idle'; // idle | loading | ready | error
    this.progress = 0;
    this.error = null;
    this.onStatus = null;
    this.readyPromise = null;
  }

  setStatus(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    this.onStatus?.({ status, progress: this.progress, error: this.error });
  }

  /** 确保模型可用；返回 Promise<boolean>，加载中会等待而不是立刻返回 */
  ensure() {
    if (this.status === 'ready') return Promise.resolve(true);
    if (this.status === 'error') return Promise.resolve(false);
    if (this.readyPromise) return this.readyPromise;

    this.setStatus('loading', { progress: 0 });
    this.readyPromise = new Promise((resolve) => {
      const finish = (ok) => {
        this.readyPromise = null;
        resolve(ok);
      };
      try {
        this.worker = new Worker(new URL('../workers/embedder.worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'progress') {
            this.progress = Math.round((msg.value || 0) * 100);
            this.setStatus('loading', { progress: this.progress });
          } else if (msg.type === 'ready') {
            this.setStatus('ready', { progress: 100 });
            finish(true);
          } else if (msg.type === 'error') {
            this.setStatus('error', { error: msg.message });
            finish(false);
          } else if (msg.type === 'result' || msg.type === 'fail') {
            const job = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (!job) return;
            if (msg.type === 'fail') job.reject(new Error(msg.message));
            else job.resolve(msg.vectors);
          }
        };
        this.worker.onerror = (err) => {
          this.setStatus('error', { error: err.message || 'Worker 加载失败' });
          finish(false);
        };
        this.worker.postMessage({ type: 'init', model: MODEL_ID });
        // 模型下载 + 初始化最多等 120s
        setTimeout(() => {
          if (this.status === 'loading') {
            this.setStatus('error', { error: '模型加载超时' });
            finish(false);
          }
        }, 120000);
      } catch (err) {
        this.setStatus('error', { error: err.message });
        finish(false);
      }
    });
    return this.readyPromise;
  }

  embed(texts, { isQuery = false } = {}) {
    if (!this.worker || this.status !== 'ready') return Promise.reject(new Error('模型尚未就绪'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'embed', id, texts, prefix: isQuery ? MODEL_META.queryPrefix : '' });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('嵌入超时（30s）'));
        }
      }, 30000);
    });
  }
}

export const neural = new NeuralEmbedder();
export const MODEL_INFO = MODEL_META;

/* ------------------------------------------------------------------ */
/* 嵌入缓存 + 统一入口                                                 */
/* ------------------------------------------------------------------ */

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

let cache = loadCache();
let cacheDirty = false;

function scheduleCacheSave() {
  if (cacheDirty) return;
  cacheDirty = true;
  setTimeout(() => {
    try {
      const entries = [...cache.entries()].slice(-CACHE_LIMIT);
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // 超出配额时丢弃一半缓存
      cache = new Map([...cache.entries()].slice(-CACHE_LIMIT / 2));
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
      } catch {
        /* ignore */
      }
    }
    cacheDirty = false;
  }, 800);
}

export function cacheSize() {
  return cache.size;
}

export function clearEmbeddingCache() {
  cache = new Map();
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

const lexCache = new Map();
function lexicalCached(text) {
  if (lexCache.has(text)) return lexCache.get(text);
  const v = lexicalEmbed(text);
  lexCache.set(text, v);
  if (lexCache.size > 4000) lexCache.clear();
  return v;
}

/**
 * 统一嵌入入口：优先神经模型，不可用时自动回落到本地哈希嵌入。
 * @returns {Promise<{vectors: Float32Array[], provider: 'neural'|'lexical'}>}
 */
export async function embed(texts, { provider = 'auto', isQuery = false } = {}) {
  const list = texts.map((t) => String(t || '').slice(0, 512));
  if (provider !== 'lexical') {
    const ready = await neural.ensure();
    if (ready) {
      try {
        const keyed = list.map((t) => `${isQuery ? 'q' : 'd'}:${t}`);
        const missing = [];
        list.forEach((t, i) => {
          if (!cache.has(keyed[i])) missing.push(i);
        });
        if (missing.length) {
          const vecs = await neural.embed(missing.map((i) => list[i]), { isQuery });
          missing.forEach((idx, j) => {
            cache.set(keyed[idx], Array.from(vecs[j], (v) => Math.round(v * 10000) / 10000));
          });
          scheduleCacheSave();
        }
        const vectors = list.map((t, i) => Float32Array.from(cache.get(keyed[i])));
        return { vectors, provider: 'neural' };
      } catch (err) {
        console.warn('[cortex] 神经嵌入失败，回落到本地向量：', err.message);
      }
    }
  }
  return { vectors: list.map(lexicalCached), provider: 'lexical' };
}

export const VECTOR_META = {
  neural: { label: '神经嵌入 · bge-small-zh', dim: 512, color: '#2dd4bf' },
  lexical: { label: '本地哈希向量（兜底）', dim: LEXICAL_DIM, color: '#a78bfa' },
};
