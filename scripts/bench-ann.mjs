/**
 * ANN / 冷热分层压测：同一批向量下比较「精确 KNN」与「二值量化两级召回」
 *
 *   node scripts/bench-ann.mjs 30000        # 先灌 N 条，再各测 30 次
 *   node scripts/bench-ann.mjs 30000 --keep # 保留测试库（默认跑完删除）
 */
import fs from 'node:fs';
import path from 'node:path';

const N = Number(process.argv[2] || 20000);
const KEEP = process.argv.includes('--keep');
const REUSE = process.argv.includes('--reuse') && fs.existsSync(process.env.CORTEX_BENCH_DB || '');
const DB = process.env.CORTEX_BENCH_DB || path.join(process.cwd(), '.cache', 'ann-bench.db');
const DIM = Number(process.env.EMBED_DIM || 512);
process.env.CORTEX_DB = DB;
process.env.EMBED_DIM = String(DIM);

fs.mkdirSync(path.dirname(DB), { recursive: true });
if (!REUSE) for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });

const store = await import('../server/memory-store.js');

// 模拟真实嵌入：128 个簇心 + 小幅噪声（同簇语义相近，才谈得上召回率）
const CLUSTERS = 128;
const centers = Array.from({ length: CLUSTERS }, (_, c) => {
  const v = new Array(DIM);
  let seed = c * 7919 + 13;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let j = 0; j < DIM; j += 1) v[j] = rnd();
  return v;
});
const vecOf = (i) => {
  const c = centers[i % CLUSTERS];
  const v = new Array(DIM);
  let seed = i * 2654435761 + 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let j = 0; j < DIM; j += 1) v[j] = c[j] + rnd() * 0.12; // 簇内余弦 ≈0.95，接近真实嵌入的分布
  return v;
};

const t0 = performance.now();
const CHUNK = 2000;
if (!REUSE) console.log(`写入 ${N} 条（${DIM} 维）…`);
else console.log(`复用已有测试库 ${DB}`);
for (let i = 0; !REUSE && i < N; i += CHUNK) {
  const items = [];
  for (let j = i; j < Math.min(N, i + CHUNK); j += 1) {
    items.push({ uid: `b${j}`, text: `压测记忆 #${j}`, vector: vecOf(j), importance: 3, kind: 'fact' });
  }
  store.syncMemories({ userId: 'bench', workspace: '/bench', items });
}
const syncMs = Math.round(performance.now() - t0);
if (!REUSE) console.log(`写入完成 ${syncMs}ms（${Math.round((N / syncMs) * 1000)} 条/秒）`);

const p50 = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

async function run(label, ann) {
  const lat = [];
  let last = null;
  const queries = Number(process.env.BENCH_QUERIES || 30);
  for (let i = 0; i < queries; i += 1) {
    const q = vecOf(i * 977);
    const r = store.searchMemories({ userId: 'bench', workspace: '/bench', vector: q, k: 10, mode: 'vector', ann });
    lat.push(r.vecMs);
    if (i === 0) last = r;
  }
  return {
    label,
    p50: Math.round(p50(lat)),
    mean: Math.round(mean(lat)),
    tier: last?.tier,
    ann: last?.ann,
    uids: last?.hits.map((h) => h.uid) || [],
    distances: last?.hits.map((h) => h.distance) || [],
  };
}

const SKIP_EXACT = process.env.BENCH_NO_EXACT === '1'; // 只量 ANN 的延迟分布时用（精确要 5s/次）
const exact = SKIP_EXACT ? { label: '精确 KNN', p50: 0, mean: 0, uids: [], distances: [] } : await run('精确 KNN', 'off');
const ann = await run('二值量化 + 精排', 'on');

// 首次落盘（全量）：等 1.2s 定时器跑完，记下作为对照
await new Promise((r) => setTimeout(r, 1600));
const persist0 = store.stats().annPersist || {};

// 召回率：ANN 的 top-10 有多少落在精确 top-10 里；再报一个 top-1 命中与距离误差
const truth = new Set((exact.uids || []).slice(0, 10));
const hit = ann.uids.slice(0, 10).filter((u) => truth.has(u)).length;
const rank1 = ann.uids[0] === exact.uids[0];
const dErr = Math.abs((ann.distances?.[0] ?? 0) - (exact.distances?.[0] ?? 0));
// 同一簇里近邻彼此距离几乎相等，集合重叠率天然很低；用「距离质量」判断更公允：
// ANN 返回的 top-10 里，有多少条不比精确结果的第 10 名更差
const cut = exact.distances?.[9] ?? Infinity;
const quality = (ann.distances || []).filter((d) => d <= cut + 1e-6).length;

/* ---------- 增量更新：改 K 条向量，下一次查询不该整库重建 ---------- */
const INCR = Number(process.env.BENCH_INCR || 200);
const ups = [];
for (let i = 0; i < INCR; i += 1) ups.push({ uid: `b${(i * 977) % N}`, text: `改过的记忆 #${i}`, vector: vecOf(i * 31 + 5) });
const tUp = performance.now();
store.syncMemories({ userId: 'bench', workspace: '/bench', items: ups });
const upMs = performance.now() - tUp;
const tQ = performance.now();
const after = store.searchMemories({ userId: 'bench', workspace: '/bench', vector: vecOf(4242), k: 10, mode: 'vector', ann: 'on' });
const qMs = performance.now() - tQ;

/* ---------- 增量落盘：改 N 条之后只写这几个字节 ---------- */
const tFlush = performance.now();
const flushed = store.flushAnnSaves(); // 立刻刷，不等 1.2s 定时器
const _flushMs = performance.now() - tFlush;
void _flushMs;
const flushInfo = flushed[0] || {};

/* ---------- 重载：等价于「进程重启后第一次查询」 ---------- */
const stBefore = store.stats(); // 重载会重置计数，先留一份
const reload = store.reloadAnnIndex('bench');
const tR = performance.now();
store.searchMemories({ userId: 'bench', workspace: '/bench', vector: vecOf(4242), k: 10, mode: 'vector', ann: 'on' });
const reloadQueryMs = performance.now() - tR;

store.stats();
console.log('\n档位         p50     均值     tier');
if (!SKIP_EXACT) console.log(`${exact.label.padEnd(12)} ${String(exact.p50).padStart(5)}ms ${String(exact.mean).padStart(5)}ms  ${exact.tier}`);
console.log(`${ann.label.padEnd(12)} ${String(ann.p50).padStart(5)}ms ${String(ann.mean).padStart(5)}ms  ${ann.tier}${ann.ann ? ` · 候选 ${ann.ann.candidates} · 索引 ${(ann.ann.bytes / 1048576).toFixed(1)}MB · 建索引 ${ann.ann.buildMs}ms` : ''}`);
if (ann.ann?.ms) console.log(`\nANN 分段（最后一次）：Hamming ${ann.ann.ms.hamming}ms · 精排 ${ann.ann.ms.rerank}ms · 取索引 ${ann.ann.ms.index}ms（建索引 ${ann.ann.buildMs}ms）`);
if (!SKIP_EXACT) console.log(`\n集合重叠（top-10 vs 精确）：${hit}/10 · top-1 命中：${rank1 ? '是' : '否'} · top-1 距离误差 ${dErr.toFixed(4)}`);
if (!SKIP_EXACT) console.log(`距离质量：ANN top-10 里有 ${quality}/10 条不差于精确第 10 名（阈值 ${cut.toFixed(4)}）`);
if (!SKIP_EXACT) console.log(`精确 top-10 平均距离 ${(exact.distances.reduce((a, b) => a + b, 0) / 10).toFixed(4)} · ANN ${(ann.distances.reduce((a, b) => a + b, 0) / 10).toFixed(4)}`);
if (!SKIP_EXACT) console.log(`加速比：${(exact.p50 / Math.max(1, ann.p50)).toFixed(1)}x`);

const idx = { ...(stBefore.ann?.[0] || {}), buildMs: stBefore.ann?.[0]?.buildMs || 0 };
console.log(
  `\n增量更新 ${INCR} 条后首查 ${qMs.toFixed(1)}ms（写入 ${upMs.toFixed(0)}ms · 建索引 ${after.ann?.ms?.index ?? '?'}ms · ` +
    `Hamming ${after.ann?.ms?.hamming ?? '?'}ms）· 索引 live ${idx.live} / 墓碑 ${idx.dead} / 已增量应用 ${idx.upserts} 次`,
);
console.log(`（对照：整库重建约 ${idx.buildMs}ms）`);

// 对照组：真整库重建一次（删掉内存索引 + 落盘文件，再查一次）
store.resetAnnIndex('bench');
const tRe0 = performance.now();
store.searchMemories({ userId: 'bench', workspace: '/bench', vector: vecOf(4242), k: 10, mode: 'vector', ann: 'on' });
const rebuildMs = performance.now() - tRe0;

console.log(
  `\n落盘重载：fromFile=${reload.fromFile} · 读盘 ${reload.loadMs}ms · 补差 改${reload.catchUp?.ups ?? 0}/删${reload.catchUp?.dels ?? 0}` +
    ` · 索引 ${reload.size} 条 · 重载后首查 ${reloadQueryMs.toFixed(1)}ms`,
);
console.log(
  `（对照：整库重建 ${Math.round(rebuildMs)}ms → 读盘 ${reload.loadMs}ms，省 ${(rebuildMs / Math.max(1, reload.loadMs)).toFixed(1)}×）`,
);
console.log(
  `\n落盘增量：${flushInfo.mode === 'delta' ? `增量写 ${((flushInfo.bytes || 0) / 1024).toFixed(1)}KB / ${(flushInfo.ms ?? 0).toFixed(2)}ms` : `全量写 ${((flushInfo.bytes || 0) / 1048576).toFixed(1)}MB / ${flushInfo.ms}ms`}` +
    ` · 全量对照 ${persist0.lastMode === 'full' ? `${((persist0.lastBytes || 0) / 1048576).toFixed(1)}MB / ${persist0.lastMs}ms` : '—'}` +
    ` · 索引 ${(reload.size || 0).toLocaleString()} 条`,
);

if (!KEEP) {
  store.closeDb();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
} else {
  console.log(`测试库保留在 ${DB}`);
}
