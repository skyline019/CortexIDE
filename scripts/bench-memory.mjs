/**
 * 记忆库压测：直接写入 SQLite + sqlite-vec，测写入吞吐与 KNN 延迟
 *
 * 用法：
 *   node scripts/bench-memory.mjs            # 默认 10 万条
 *   node scripts/bench-memory.mjs 1000000    # 100 万条（约 2GB 磁盘，注意空间）
 *
 * 注意：默认写到 .cache/cortex-bench.db，不会污染 .cortex/memory.db
 *      每条 512 维记忆约 6KB 磁盘（向量存两份 + WAL），100 万条需要约 6GB 空间
 */
import fs from 'node:fs';

const N = Number(process.argv[2] || 100000);
// 默认写到 .cache/（不进版本库、不占 /tmp 内存盘）
const DB = process.env.CORTEX_DB || '.cache/cortex-bench.db';
fs.mkdirSync('.cache', { recursive: true });
const DIM = Number(process.env.EMBED_DIM || 512);
if (fs.existsSync(DB)) fs.rmSync(DB, { force: true });
process.env.CORTEX_DB = DB;

const store = await import('../server/memory-store.js');

const USER = 'bench';
const WS = '/bench';
const { backend } = store.stats();
console.log(`后端：${backend} · 维度 ${DIM} · 目标条数 ${N.toLocaleString()} · 库 ${DB}`);

/* ---------- 1. 合成数据（随机单位向量 + 少量“热点”方向，模拟真实分布） ---------- */
const base = Array.from({ length: 8 }, () => {
  const v = Float32Array.from({ length: DIM }, () => Math.random() - 0.5);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
});
const mkVec = (i) => {
  const b = base[i % base.length];
  return Float32Array.from({ length: DIM }, (_, j) => b[j] + (Math.random() - 0.5) * 1.2);
};

/* ---------- 2. 分批写入 ---------- */
const BATCH = 2000;
let done = 0;
const t0 = performance.now();
while (done < N) {
  const n = Math.min(BATCH, N - done);
  const items = Array.from({ length: n }, (_, k) => {
    const i = done + k;
    return {
      uid: `bench-${i}`,
      kind: 'fact',
      text: `压测记忆 #${i}：项目在第 ${i} 次迭代里调整了接口超时与重试策略`,
      tags: ['bench'],
      importance: 3,
      hash: i,
      vector: Array.from(mkVec(i)),
    };
  });
  store.syncMemories({ userId: USER, workspace: WS, items });
  done += n;
  if (done % 20000 === 0 || done === N) {
    const sec = (performance.now() - t0) / 1000;
    console.log(`  写入 ${done.toLocaleString()} / ${N.toLocaleString()} · ${(done / sec).toFixed(0)} 条/秒`);
  }
}
const writeSec = (performance.now() - t0) / 1000;
const sizeMb = (fs.statSync(DB).size / 1024 / 1024).toFixed(1);
console.log(`写入完成：${writeSec.toFixed(1)}s · ${(N / writeSec).toFixed(0)} 条/秒 · 库大小 ${sizeMb} MB`);

/* ---------- 3. KNN 延迟 ---------- */
const queries = Array.from({ length: 20 }, (_, i) => Array.from(mkVec(i * 977)));
store.searchMemories({ userId: USER, workspace: WS, vector: queries[0], k: 10 }); // 预热
const times = [];
for (const q of queries) {
  const s = performance.now();
  const { hits } = store.searchMemories({ userId: USER, workspace: WS, vector: q, k: 10 });
  times.push(performance.now() - s);
  if (!hits.length) console.warn('⚠ 空结果');
}
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(2);
console.log(`KNN 延迟（k=10）：p50 ${p(0.5)}ms · p95 ${p(0.95)}ms · max ${times[times.length - 1].toFixed(2)}ms`);

/* ---------- 4. 隔离校验 ---------- */
const other = store.searchMemories({ userId: 'someone-else', workspace: WS, vector: queries[0], k: 10 });
console.log(`隔离校验：其他用户命中 ${other.hits.length} 条（应为 0）`);
const st = store.stats();
console.log(`统计：${st.total.toLocaleString()} 条记忆 · ${st.vectors.toLocaleString()} 个向量 · ${st.backend}`);

fs.rmSync(DB, { force: true });
fs.rmSync(DB + '-wal', { force: true });
fs.rmSync(DB + '-shm', { force: true });
console.log('临时库已清理');
