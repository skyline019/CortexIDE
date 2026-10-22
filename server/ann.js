/**
 * 二值量化（binary quantization）向量索引 —— 在 sqlite-vec 之上补一层 ANN
 *
 * 背景：sqlite-vec 是精确暴力 KNN，512 维 float32 每条 2KB，百万级一次查询要
 * 读 2GB（I/O 受限，实测 4~6s）。而 v0.1.9 的 JS 绑定只肯把 Float32Array 写进
 * `float[N]` 列（`int8`/`bit` 建表能过、插入必报错），所以量化只在应用层做：
 *
 *   写入：每条向量按符号位压成 512 bit（64 字节）存 BLOB，内存里摊平成 Uint32Array
 *   召回：① 粗筛 —— 只比前一半字（512 维 → 8 个 uint32），一遍直方图定阈值
 *         ② 精算 —— 候选集上算完整 512 bit Hamming
 *         ③ 精排 —— 候选 rowid 走 int8 侧表算余弦（非对称量化）
 *
 * 位图放在 SharedArrayBuffer 里，1M 条以上会再拉一个 worker 线程各扫一半
 * （2 核机器实测约 2 倍），主线程用 Atomics.wait 同步等它，接口保持同步语义。
 */

import { Worker } from 'node:worker_threads';

const PC8 = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) PC8[i] = (i & 1) + PC8[i >> 1];
/** 16 bit 表（64KB，刚好在 L2 里）：每个 uint32 只查 2 次，比 4 次 8 bit 查表快约 20% */
const PC16 = new Uint8Array(65536);
for (let i = 0; i < 65536; i += 1) PC16[i] = PC8[i & 255] + PC8[i >>> 8];

const HAS_SAB = typeof SharedArrayBuffer !== 'undefined';
/** 超过这么多条才值得开 worker（线程启动 + 同步约 1ms） */
const PAR_MIN = Number(process.env.CORTEX_ANN_PAR_MIN || 200000);

const allocU32 = (n) => (HAS_SAB ? new Uint32Array(new SharedArrayBuffer(n * 4)) : new Uint32Array(n));
const allocU16 = (n) => (HAS_SAB ? new Uint16Array(new SharedArrayBuffer(n * 2)) : new Uint16Array(n));
const allocU8 = (n) => (HAS_SAB ? new Uint8Array(new SharedArrayBuffer(n)) : new Uint8Array(n));

/* ---------- worker 单例（懒启动，出错就永久降级为单线程） ---------- */
let worker = null;
let workerBroken = false;
function getWorker() {
  if (workerBroken || !HAS_SAB) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./ann-worker.js', import.meta.url));
    worker.unref();
    worker.on('error', () => {
      workerBroken = true;
      worker = null;
    });
    worker.on('exit', () => {
      worker = null;
    });
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

/** Float32 向量 → 512 bit 符号位，返回 64 字节 Buffer */
export function packSign(vector) {
  const n = vector.length;
  const words = Math.ceil(n / 32);
  const out = Buffer.alloc(words * 4);
  const view = new Int32Array(out.buffer, out.byteOffset, words);
  for (let i = 0; i < n; i += 1) {
    if (vector[i] > 0) view[i >> 5] |= 1 << (i & 31);
  }
  return out;
}

/** Buffer → Uint32Array 视图（复用同一块内存，不拷贝） */
export function asWords(buf) {
  return new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export class BitIndex {
  /**
   * @param {number} dim 向量维度
   */
  constructor(dim) {
    this.dim = dim;
    this.words = Math.ceil(dim / 32);
    this.capacity = 0;
    this.size = 0;
    this.sigs = new Uint32Array(0); // 每行 words 个 uint32
    this.ids = new Int32Array(0); // rowid（升序，便于二分）
    this.alive = new Uint8Array(0); // 1 = 有效；删除只打标记，攒够再压缩
    this.dead = 0;
    this.upserts = 0; // 增量应用计数（诊断用）
    this.removes = 0;
    this.builtAt = 0;
    this.buildMs = 0;
    this.parallelMs = 0; // 上一次查询里 worker 线程的耗时（诊断用）
  }

  get bytes() {
    return this.capacity * this.words * 4 + this.capacity * 4;
  }

  /** 预分配（配合 push 分批载入，避免一次性构造上百万个对象） */
  reserve(n) {
    const cap = Math.max(16, Math.ceil(n * 1.02));
    this.sigs = allocU32(cap * this.words);
    this.ids = new Int32Array(cap);
    this.alive = allocU8(cap);
    this.capacity = cap;
    this.size = 0;
    this.dead = 0;
  }

  /** 追加一行（需先 reserve） */
  push(id, sigBuf) {
    if (this.size >= this.capacity) {
      const cap = Math.ceil(this.capacity * 1.5) + 16;
      const sigs = allocU32(cap * this.words);
      sigs.set(this.sigs.subarray(0, this.size * this.words));
      const ids = new Int32Array(cap);
      ids.set(this.ids.subarray(0, this.size));
      const alive = allocU8(cap);
      alive.set(this.alive.subarray(0, this.size));
      this.sigs = sigs;
      this.ids = ids;
      this.alive = alive;
      this.capacity = cap;
    }
    const w = asWords(sigBuf);
    if (w.length !== this.words) return false;
    this.sigs.set(w, this.size * this.words);
    this.ids[this.size] = id;
    this.alive[this.size] = 1;
    this.size += 1;
    return true;
  }

  /** 二分找 id 所在行；找不到返回 -1 */
  rowOfId(id) {
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.ids[mid];
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * 增量写入：已有 id 就原地覆盖（向量改了），没有就追加（id 必须比现有最大值大，
   * 因为 ids 要保持升序供二分；乱序插入返回 false，调用方回退到整库重建）。
   */
  upsert(id, sigBuf) {
    const w = asWords(sigBuf);
    if (w.length !== this.words) return false;
    const row = this.rowOfId(id);
    if (row >= 0) {
      this.sigs.set(w, row * this.words);
      if (!this.alive[row]) {
        this.alive[row] = 1;
        this.dead = Math.max(0, this.dead - 1);
      }
      this.upserts += 1;
      return true;
    }
    if (this.size && id < this.ids[this.size - 1]) return false; // 乱序 → 交给调用方重建
    const ok = this.push(id, sigBuf);
    if (ok) this.upserts += 1;
    return ok;
  }

  /** 增量删除：只打墓碑，查询时跳过；攒够比例由调用方压缩 */
  remove(id) {
    const row = this.rowOfId(id);
    if (row < 0) return false;
    if (this.alive[row]) {
      this.alive[row] = 0;
      this.dead += 1;
      this.removes += 1;
    }
    return true;
  }

  /** 墓碑太多就该重建（一次性 10s）不如先看看比例 */
  get staleRatio() {
    return this.size ? this.dead / this.size : 0;
  }

  /**
   * 从落盘的数组直接恢复（ids / alive / sigs 已经是 SharedArrayBuffer 视图）
   * 比重新从 SQLite 读 100 万行快两个数量级：66MB memcpy 对 1M 次 DB 行读取。
   */
  restore({ ids, alive, sigs, size, dead = 0 }) {
    const t0 = performance.now();
    this.ids = ids;
    this.alive = alive;
    this.sigs = sigs;
    this.size = size;
    this.capacity = ids.length;
    this.dead = dead;
    this.buildMs = Math.round(performance.now() - t0);
    this.builtAt = Date.now();
    return size;
  }

  /** 一次性载入全部签名（rows: [{id, sig: Buffer}]） */
  build(rows) {
    const t0 = performance.now();
    const cap = Math.max(16, Math.ceil(rows.length * 1.25));
    this.sigs = allocU32(cap * this.words);
    this.ids = new Int32Array(cap);
    this.capacity = cap;
    this.size = 0;
    for (const r of rows) {
      if (!r.sig) continue;
      const w = asWords(r.sig);
      if (w.length !== this.words) continue;
      this.sigs.set(w, this.size * this.words);
      this.ids[this.size] = r.id;
      this.size += 1;
    }
    this.buildMs = Math.round(performance.now() - t0);
    this.builtAt = Date.now();
    return this.size;
  }

  /** 单线程粗筛一段（[start, end)），把距离写进 dist、直方图累加进 hist */
  _coarseRange(q, cw, start, end, dist, hist) {
    const sigs = this.sigs;
    const alive = this.alive;
    const W = this.words;
    for (let r = start; r < end; r += 1) {
      if (!alive[r]) continue;
      const base = r * W;
      let d = 0;
      for (let k = 0; k < cw; k += 2) {
        const x = sigs[base + k] ^ q[k];
        const y = sigs[base + k + 1] ^ q[k + 1];
        d += PC16[x & 65535] + PC16[x >>> 16] + PC16[y & 65535] + PC16[y >>> 16];
      }
      dist[r] = d;
      hist[d] += 1;
    }
  }

  /**
   * 粗筛：能并行就劈成两半，一半交给 worker，一半主线程自己跑。
   * 位图 / 距离 / 直方图 / 完成标志全在共享内存里，worker 不需要拷贝 64MB。
   */
  _coarse(q, cw, n, dist, hist) {
    const w = n >= PAR_MIN ? getWorker() : null;
    if (!w) {
      this._coarseRange(q, cw, 0, n, dist, hist);
      return;
    }
    if (!this._histB || this._histB.length < hist.length) {
      this._histB = allocU32(Math.max(hist.length, 1024));
      this._done = new Int32Array(new SharedArrayBuffer(4));
    }
    const half = n >> 1;
    const done = this._done;
    const histB = this._histB;
    histB.fill(0);
    Atomics.store(done, 0, 0);
    const t0 = performance.now();
    try {
      w.postMessage({
        sigs: this.sigs.buffer,
        alive: this.alive.buffer,
        dist: dist.buffer,
        hist: histB.buffer,
        done: done.buffer,
        q: Uint32Array.from(q),
        W: this.words,
        cw,
        start: half,
        end: n,
      });
    } catch {
      workerBroken = true;
      this._coarseRange(q, cw, 0, n, dist, hist);
      return;
    }
    this._coarseRange(q, cw, 0, half, dist, hist);
    // 等 worker 干完（带超时兜底，别让一次线程异常把服务卡死）
    const deadline = Date.now() + 3000;
    for (;;) {
      const st = Atomics.wait(done, 0, 0, Math.max(1, deadline - Date.now()));
      if (Atomics.load(done, 0) !== 0 || Date.now() > deadline) break;
      if (st === 'timed-out' && Date.now() > deadline) break;
    }
    if (Atomics.load(done, 0) === 1) {
      for (let d = 0; d < hist.length; d += 1) if (histB[d]) hist[d] += histB[d];
      this.parallelMs = Math.round((performance.now() - t0) * 100) / 100;
      return;
    }
    // worker 没按时回来：自己把另一半补算上（正确性优先）
    workerBroken = true;
    this._coarseRange(q, cw, half, n, dist, hist);
    this.parallelMs = 0;
  }

  /** 候选集上算完整位宽 */
  _refine(q, cand, outDist, hist2) {
    const sigs = this.sigs;
    const W = this.words;
    for (let i = 0; i < cand.length; i += 1) {
      const base = cand[i] * W;
      let d = 0;
      for (let k = 0; k < W; k += 2) {
        const x = sigs[base + k] ^ q[k];
        const y = sigs[base + k + 1] ^ q[k + 1];
        d += PC16[x & 65535] + PC16[x >>> 16] + PC16[y & 65535] + PC16[y >>> 16];
      }
      outDist[i] = d;
      hist2[d] += 1;
    }
  }

  /**
   * Hamming 近邻：返回 [{id, ham}]，按距离升序
   *
   * @param {Float32Array|number[]} vector 查询向量
   * @param {number} limit 候选数
   */
  search(vector, limit = 200) {
    if (!this.size) return [];
    const q = asWords(packSign(vector));
    const W = this.words;
    const ids = this.ids;
    const n = this.size;
    const maxD = this.dim + 1;
    if (!this._dist || this._dist.length < n) this._dist = allocU16(Math.max(n, 1024));
    const dist = this._dist;
    const hist = this._hist || (this._hist = new Uint32Array(maxD + 2));

    // ① 粗筛（位宽减半；W 很小时直接用全宽）
    const coarseWords = W >= 8 ? Math.max(2, W >> 1) : W;
    const K1 = Math.min(n, Math.max(limit * 8, 2048));
    hist.fill(0);
    this._coarse(q, coarseWords, n, dist, hist);

    let acc = 0;
    let thresh = maxD;
    for (let d = 0; d <= maxD; d += 1) {
      acc += hist[d];
      if (acc >= K1) {
        thresh = d;
        break;
      }
    }
    const cand = [];
    const alive = this.alive;
    for (let r = 0; r < n && cand.length < K1; r += 1) if (alive[r] && dist[r] <= thresh) cand.push(r);

    // ② 候选集上算完整位宽
    if (!this._fine || this._fine.length < cand.length) {
      this._fine = allocU16(Math.max(cand.length, 2048));
    }
    const fine = this._fine;
    const hist2 = this._hist2 || (this._hist2 = new Uint32Array(maxD + 2));
    hist2.fill(0);
    this._refine(q, cand, fine, hist2);
    let acc2 = 0;
    let thresh2 = maxD;
    for (let d = 0; d <= maxD; d += 1) {
      acc2 += hist2[d];
      if (acc2 >= limit) {
        thresh2 = d;
        break;
      }
    }

    // ③ 输出
    const out = [];
    for (let i = 0; i < cand.length && out.length < limit; i += 1) {
      if (fine[i] <= thresh2) out.push({ id: ids[cand[i]], ham: fine[i] });
    }
    out.sort((a, b) => a.ham - b.ham);
    return out;
  }

  stats() {
    return {
      size: this.size,
      dim: this.dim,
      bytes: this.bytes,
      buildMs: this.buildMs,
      builtAt: this.builtAt,
      live: this.size - this.dead,
      dead: this.dead,
      upserts: this.upserts,
      removes: this.removes,
      parallel: !!getWorker(),
      parMin: PAR_MIN,
      lastParallelMs: this.parallelMs,
      engine: 'bit',
    };
  }
}

/**
 * ANN 引擎门面。默认 `bit`（二值量化 BitIndex）。
 *
 * 升级路径（README「要不要换成 hnswlib」）：
 *   1. 机器 ≥ 16GB，可常驻约 2.5GB HNSW 图
 *   2. `npm i hnswlib-node`（linux x64 + node20 有预编译）
 *   3. `.env` 设 `CORTEX_ANN_ENGINE=hnsw`
 *   4. 在本文件实现 `HnswIndex`（search/upsert/remove 对齐 BitIndex），由此处返回
 *
 * 未实现或未安装时一律回退 BitIndex，不打断服务。
 */
let hnswWarned = false;
export function createAnnIndex(dim) {
  const engine = String(process.env.CORTEX_ANN_ENGINE || 'bit').toLowerCase();
  if (engine === 'hnsw' || engine === 'hnswlib') {
    if (!hnswWarned) {
      hnswWarned = true;
      console.warn(
        '[cortex-ann] CORTEX_ANN_ENGINE=hnsw：HnswIndex 尚未接线；当前仍用 BitIndex。见 README「要不要换成 hnswlib」。',
      );
    }
  }
  return new BitIndex(dim);
}
