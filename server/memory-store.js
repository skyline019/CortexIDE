/**
 * 服务端记忆库：SQLite + sqlite-vec（向量检索），支持多用户 / 多工作区隔离
 *
 * 表结构
 *   users(id, name, created_at, last_seen)
 *   memories(id INTEGER PK, uid TEXT UNIQUE, user_id, workspace, kind, text, tags,
 *            importance, uses, pinned, source, created_at, updated_at, last_used_at,
 *            hash, vec BLOB)
 *   vec_memories USING vec0(user_id text partition key, embedding float[DIM])
 *                                                    -- rowid = memories.id，按用户分区
 *   memories_fts USING fts5(tokens, content='memories')  -- BM25 稀疏检索（中文 bigram 分词）
 *   meta(key, value)                                 -- 记录维度、版本
 *
 * 隔离：向量表用 **partition key = user_id**，KNN 只扫本人分区（隔离下沉到索引层）；
 * 再加 workspace 过滤。FTS5 查询同样强制 user_id + workspace。
 *
 * 检索：vec0 的 KNN 与 FTS5 的 BM25 各自排名，用 RRF（Reciprocal Rank Fusion，
 * k=60）融合，兼顾语义召回与字面命中（长尾 query / 专有名词、命令、文件名）。
 */
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { tokensOf, ftsQuery, queryTokens } from './text-index.js';
import { createAnnIndex, packSign } from './ann.js';
import { AnnWriter, loadAnnFile, annFileInfo, deleteAnnFile, annDir } from './ann-store.js';
import { bindMemorySearch, searchMemories, cosine } from './memory-search.js';
export { searchMemories, cosine };

let vecLoadablePath = null;
try {
  // sqlite-vec 是可选扩展：加载失败时退化为 BLOB + JS 余弦扫描
  const mod = await import('sqlite-vec');
  vecLoadablePath = (mod.default || mod).getLoadablePath?.() || null;
} catch {
  vecLoadablePath = null;
}

const DIM = Number(process.env.EMBED_DIM || 512);
const DB_PATH = process.env.CORTEX_DB || path.join(process.cwd(), '.cortex', 'memory.db');

let db = null;
let VEC_TABLE = 'vec_memories'; // 迁移过程中可能要换名（旧库残留 shadow table 时）
let vecReady = false;
let ftsReady = false;
let lastError = null;

/* ---------- ANN（二值量化两级召回）与冷热分层 ---------- */
const ANN_MIN = Number(process.env.CORTEX_ANN_MIN || 20000); // 超过这么多条才启用 ANN
const ANN_CAND = Number(process.env.CORTEX_ANN_CAND || 256); // 二值层候选数（Hamming 取前 N）
// 真正回 int8 侧表精排的条数：侧表是随机主键读，代价和条数成正比（1M 库实测约 0.15ms/条）
const ANN_RERANK = Number(process.env.CORTEX_ANN_RERANK || 96);
const HOT_MAX = Number(process.env.CORTEX_HOT_MAX || 2000); // 每个用户的热点表上限
const HOT_SKIP_DIST = Number(process.env.CORTEX_HOT_SKIP || 0.11); // cos 距离，0.11 ≈ 相似度 0.89
/**
 * vec0 的 chunk_size：**按分区（用户）各分配一个 chunk**，默认 1024 行 × 512 维 = 2MB。
 * 也就是说「每个用户至少占 2MB」，多用户小数据量的库会被 chunk 空洞撑大
 * （实测 6 个用户 28 行 → 12MB；调到 256 → 3MB，调到 64 → 0.8MB）。
 * 大库（单用户百万级）保持大 chunk 扫描局部性更好，所以给个环境变量自己权衡。
 */
const VEC_CHUNK = Math.max(8, Number(process.env.CORTEX_VEC_CHUNK || 256)); // 热点命中够近就不扫冷数据
let sigVersion = 0; // 任何向量写入都 +1，用来失效索引
const annCache = new Map(); // userId -> { index, version, count }
const tierStats = { hotQueries: 0, hotShortCircuit: 0, annQueries: 0, exactQueries: 0, annBuildMs: 0 };
const countCache = new Map(); // userId -> { n, version }：vec0 上的 count(*) 很贵（30k 要 80ms），必须缓存
const hotCount = new Map(); // userId -> 热点条数（避免每次写入都 count(*)）

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

/**
 * 向量是否额外冗余存一份 BLOB 到 memories.vec：
 *  - sqlite-vec 可用 → 不存（vec0 已经存了一份，省一半磁盘与内存）
 *  - 扩展不可用 → 必须存，作为 JS 余弦降级的唯一数据来源
 */
function keepBlob() {
  return !vecReady;
}

function toBlob(vec) {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function open() {
  if (db) return db;
  ensureDir(DB_PATH);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // 随机主键读（int8 精排）靠页缓存吃饭：给 SQLite 64MB 页缓存 + 512MB mmap
  db.pragma('cache_size = -64000');
  try {
    db.pragma(`mmap_size = ${Number(process.env.CORTEX_MMAP_MB || 512) * 1024 * 1024}`);
  } catch {
    /* 有些平台不支持 mmap，忽略 */
  }

  if (vecLoadablePath) {
    try {
      db.loadExtension(vecLoadablePath);
      vecReady = true;
    } catch (err) {
      lastError = `sqlite-vec 加载失败：${err.message}`;
      vecReady = false;
    }
  } else {
    lastError = '未安装 sqlite-vec，使用 BLOB + JS 余弦扫描降级';
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at INTEGER,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      kind TEXT,
      text TEXT NOT NULL,
      tags TEXT,
      importance INTEGER DEFAULT 3,
      uses INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      source TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_used_at INTEGER,
      hash INTEGER,
      vec BLOB,
      tokens TEXT
    );
    CREATE INDEX IF NOT EXISTS mem_scope ON memories(user_id, workspace);
    CREATE INDEX IF NOT EXISTS mem_uid ON memories(uid);
  `);

  ensureColumn('memories', 'tokens', 'TEXT');
  ensureColumn('memories', 'vec', 'BLOB');
  ensureColumn('memories', 'sig', 'BLOB'); // 二值量化签名（512 bit / 64 字节）
  ensureColumn('memories', 'vec_seq', 'INTEGER NOT NULL DEFAULT 0'); // 向量变更批次号（索引落盘的水位）
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_del (
      id INTEGER PRIMARY KEY,
      user_id TEXT,
      seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS vec_del_seq ON vec_del(seq);
    CREATE INDEX IF NOT EXISTS mem_vec_seq ON memories(user_id, vec_seq);
  `);

  const currentDim = getMeta('dim');
  if (vecReady && String(DIM) !== String(currentDim || DIM)) {
    // 维度变化（换了嵌入模型）→ 重建向量表
    try {
      db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    } catch {
      /* ignore */
    }
  }
  if (vecReady) {
    ensureVecTable();
    migrateVecPartition();
    migrateVecCosine();
    ensureHotTable();
    ensureQ8();
  }
  backfillTokens(); // 必须早于 FTS 触发器创建，否则 'delete' 事件会带 NULL 内容
  setupFts();
  return db;
}


/** 热点表：小、常驻，装「最近常用 / 置顶」的记忆，命中即短路，不必扫冷数据 */
function ensureHotTable() {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_hot USING vec0(user_id text partition key, embedding float[${DIM}] distance_metric=cosine, chunk_size=${VEC_CHUNK})`,
    );
    return true;
  } catch (err) {
    lastError = `建热点表失败（冷热分层关闭）：${err.message}`;
    return false;
  }
}

const HOT_MIN_USES = 2;

/**
 * 判断一条记忆该不该进热点：置顶，或已被检索命中 ≥2 次。
 * 早先还加了「3 天内更新过」——结果所有新数据都挤进热点表，冷热分层失去意义，已去掉。
 */
function shouldBeHot(mem) {
  if (mem.pinned) return true;
  return (mem.uses || 0) >= HOT_MIN_USES;
}

/** 把一条向量写进 / 移出热点表，并维持上限 */
function syncHot(d, id, userId, vector, hot) {
  try {
    if (!hot) {
      const removed = d.prepare('delete from vec_hot where rowid = ?').run(BigInt(id)).changes;
      if (removed && hotCount.has(userId)) hotCount.set(userId, Math.max(0, hotCount.get(userId) - 1));
      return;
    }
    const existed = d.prepare('delete from vec_hot where rowid = ?').run(BigInt(id)).changes;
    d.prepare('insert into vec_hot(rowid, user_id, embedding) values (?,?,?)').run(BigInt(id), userId, toBlob(vector));
    let n = (hotCount.has(userId) ? hotCount.get(userId) : -1) + (existed ? 0 : 1);
    if (n < 0) {
      n = d.prepare('select count(*) c from vec_hot where user_id = ?').get(userId).c;
    }
    hotCount.set(userId, n);
    if (n > HOT_MAX) {
      // 超限就按「最久没更新」淘汰（rowid 顺序≈写入顺序，够用且便宜）
      const drop = n - HOT_MAX;
      d.prepare(
        `delete from vec_hot where rowid in (
           select v.rowid from vec_hot v join memories m on m.id = v.rowid
           where v.user_id = ? order by m.updated_at asc limit ${drop})`,
      ).run(userId);
      hotCount.set(userId, HOT_MAX);
    }
  } catch (err) {
    lastError = `热点表写入失败：${err.message}`;
  }
}

/** 该用户在向量表里的条数（缓存；vec0 上 count(*) 单次要 80ms，不能每次查询都算） */
function vecCountFor(d, userId) {
  const c = countCache.get(userId);
  if (c && c.version === sigVersion) return c.n;
  const n = d.prepare(`select count(*) c from ${VEC_TABLE} where user_id = ?`).get(userId).c;
  countCache.set(userId, { n, version: sigVersion });
  return n;
}

/**
 * int8 侧表：精确距离的「廉价替身」。
 *
 * 为什么需要它：sqlite-vec 的 `where rowid in (...)` 会退化成整表扫描
 *（200k 条取 256 个 rowid 实测 125ms，和全量 KNN 一样贵），所以精排不能再回 vec0；
 * 而普通表按主键取 256 行只要 1~2ms。代价是每行多 512 字节（int8 存 512 维）。
 */
function ensureQ8() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS mem_q8 (id INTEGER PRIMARY KEY, scale REAL, norm REAL, q BLOB)`);
    return true;
  } catch (err) {
    lastError = `建 int8 侧表失败（精排退回 vec0）：${err.message}`;
    return false;
  }
}

/** 把 float32 向量量化成 int8（对称量化，单条一个 scale） */
function toQ8(vector) {
  let maxAbs = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const a = Math.abs(vector[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const q = Buffer.alloc(vector.length);
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const v = Math.round(vector[i] / scale);
    q[i] = v < -127 ? 128 : v; // Buffer 写入按字节存 int8（128 == -128）
    const d = v * scale;
    norm += d * d;
  }
  return { scale, norm: Math.sqrt(norm), q };
}

/** int8 侧表里按 rowid 取候选并算余弦（float 查询向量 × 量化存储向量，非对称量化） */
function rerankQ8(d, ids, vector, userId, workspace) {
  const ph = ids.map(() => '?').join(',');
  // 一条 join 搞定「量化向量 + uid + 用户/工作区过滤」：
  // 早先分两条 SQL（mem_q8 一条、memories 一条）再在 JS 里对 Map，1M 库上多花一倍 RTT
  const rows = d
    .prepare(
      `select m.id as id, m.uid as uid, q.scale as scale, q.norm as norm, q.q as q
       from mem_q8 q join memories m on m.id = q.id
       where m.id in (${ph}) and m.user_id = ? and m.workspace = ?`,
    )
    .all(...ids.map((x) => Number(x)), userId, workspace);
  if (!rows.length) return [];
  let qn = 0;
  for (let i = 0; i < vector.length; i += 1) qn += vector[i] * vector[i];
  qn = Math.sqrt(qn) || 1;
  const scored = rows.map((r) => {
    const buf = r.q;
    const uid = r.uid;
    let dot = 0;
    for (let i = 0; i < vector.length; i += 1) {
      const qv = buf[i] > 127 ? buf[i] - 256 : buf[i];
      dot += qv * r.scale * vector[i];
    }
    const sim = dot / (qn * (r.norm || 1));
    // ⚠️ 距离口径必须和 sqlite-vec（distance_metric=cosine → 1-cos）一致，
    // 否则热点/冷数据归并、bench 对照都会错位
    return { uid, distance: 1 - sim, sim };
  });
  return scored.sort((a, b) => a.distance - b.distance);
}

/** 老库补齐二值签名与 int8 侧表（分批，避免一次性把上百万条 2KB 向量读进内存） */
function backfillSigs(userId) {
  const missing = db.prepare(`select count(*) c from memories where user_id = ? and sig is null`).get(userId).c;
  if (!missing) return 0;
  const batch = db.prepare(
    `select m.id as id, v.embedding as embedding
     from memories m join ${VEC_TABLE} v on v.rowid = m.id
     where m.user_id = ? and m.sig is null limit 2000`,
  );
  const upd = db.prepare('update memories set sig = ? where id = ?');
  const insQ = db.prepare('insert or replace into mem_q8(id, scale, norm, q) values (?,?,?,?)');
  let filled = 0;
  for (;;) {
    const rows = batch.all(userId);
    if (!rows.length) break;
    db.transaction(() => {
      for (const r of rows) {
        const f = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        if (f.length !== DIM) continue;
        upd.run(packSign(f), r.id);
        const q8 = toQ8(f);
        insQ.run(Number(r.id), q8.scale, q8.norm, q8.q);
        filled += 1;
      }
    })();
    if (rows.length < 2000) break;
  }
  if (filled) lastError = `已为 ${filled} 条老向量补算二值签名 / int8 侧表`;
  return filled;
}

/**
 * ANN 索引的增量更新队列。
 *
 * 以前的做法是「任何一条向量变动就 sigVersion + 1 → 整个索引作废 → 下次查询重建」，
 * 1M 库一次重建 10s，等于一条记忆改动就把检索打回冷启动。
 * 现在只记下「哪些 id 变了 / 删了」，下次查询前增量应用：
 *   - 改向量：二分找到行，原地覆盖 16 个 uint32（微秒级）
 *   - 新增：追加到尾部（id 自增，天然保持升序）
 *   - 删除：打墓碑，查询时跳过；墓碑超过 15% 才整库压缩
 *   - 乱序插入（比如恢复备份）→ 返回 false，老老实实重建
 */
/* ---------- 向量批次号（vec_seq）：索引落盘的水位 ---------- */
function currentVecSeq(d = open()) {
  const row = d.prepare("select value from meta where key = 'vec_seq'").get();
  return row ? Number(row.value) : 0;
}

/** 一次 sync 调用 = 一个批次号；这一批里所有向量改动都记在同一个 seq 上 */
function nextVecSeq(d) {
  const next = currentVecSeq(d) + 1;
  d.prepare("insert into meta(key,value) values ('vec_seq',?) on conflict(key) do update set value=excluded.value").run(String(next));
  return next;
}

/* ---------- 索引落盘（重启不再重建 10s） ---------- */
const ANN_PERSIST = process.env.CORTEX_ANN_PERSIST !== '0';
const annSaveTimers = new Map(); // userId -> timer（合并短时间内的多次变更）
const annFiles = new Map(); // userId -> { writer, size, dead, dirty:Set<number> }
let annSaveStats = { saves: 0, full: 0, delta: 0, lastMs: 0, lastBytes: 0, lastMode: null, fails: 0 };

const fileState = (userId) => {
  let st = annFiles.get(userId);
  if (!st) {
    st = { writer: null, size: 0, dead: 0, dirty: new Set() };
    annFiles.set(userId, st);
  }
  return st;
};

/**
 * 把索引刷到盘上。
 *
 * 关键点：**不走全量重写**。文件按「容量预留 + 尾部追加 + 就地 pwrite」组织（见 ann-store.js），
 * 所以：
 *   · 新增记忆 → ids / alive / sigs 各一次 append
 *   · 改向量、删记忆 → 只 pwrite 那几行（sigs 每行 64B，alive 1B）
 *   · 只有「容量不够」或「整库重建/压缩」才整份重写
 * 66MB 的全量写要 20~90ms，而改 300 条只要几毫秒。
 */
/**
 * 删除墓碑只对「已经有索引文件」的用户有意义：
 * 文件比库旧时才需要挖出「哪些 id 被删了」。没有文件的用户下次一定是整库重建，
 * 重建只信 memories 表 —— 所以这种用户干脆不记墓碑，省得压测/冒烟一删几千条就撑爆库。
 */
function needsTomb(userId) {
  if (!ANN_PERSIST) return false;
  const st = annFiles.get(userId);
  if (st && st.writer) return true;
  return Boolean(annFileInfo(DB_PATH, userId, DIM));
}

function flushAnn(userId, entry) {
  const e = entry || annCache.get(userId);
  if (!e || !ANN_PERSIST) return null;
  const st = fileState(userId);
  const index = e.index;

  // 首次落盘 / 文件被删：写全量并持有 fd
  if (!st.writer) {
    const opened = AnnWriter.open(DB_PATH, userId, DIM);
    if (opened) {
      st.writer = opened;
      st.size = 0; // 不确定盘上内容，按「全量覆盖一次最稳」
    } else {
      st.writer = null;
    }
  }

  let res;
  const needFull = !st.writer || index.size > st.writer.capacity || index.size < st.size;
  if (needFull) {
    if (!st.writer) st.writer = AnnWriter.create(DB_PATH, userId, DIM, index.size);
    res = st.writer.writeFull({
      // 只有「原有文件装不下、要扩容」才多留 25%；首次落盘/压缩用 8% 就够，避免文件虚胖
      headroom: st.size > 0 && index.size > st.size ? 0.25 : 0.08,
      ids: index.ids,
      alive: index.alive,
      sigs: index.sigs,
      size: index.size,
      dead: index.dead,
      seq: e.seq || 0,
      builtAt: index.builtAt,
    });
    st.size = index.size;
    st.dead = index.dead;
    st.dirty.clear();
  } else {
    res = st.writer.writeDelta({
      dirtyRows: [...st.dirty],
      ids: index.ids,
      alive: index.alive,
      sigs: index.sigs,
      persistedSize: st.size,
      size: index.size,
      dead: index.dead,
      seq: e.seq || 0,
    });
    if (res.ok) {
      st.size = index.size;
      st.dead = index.dead;
      st.dirty.clear();
    } else {
      // 容量不够（并发追加）→ 下一轮走全量
      st.dirty.clear();
      res = st.writer.writeFull({
        ids: index.ids,
        alive: index.alive,
        sigs: index.sigs,
        size: index.size,
        dead: index.dead,
        seq: e.seq || 0,
        builtAt: index.builtAt,
      });
      st.size = index.size;
      st.dead = index.dead;
    }
  }

  const mode = res.mode || (res.ok ? 'delta' : 'fail');
  annSaveStats = {
    saves: annSaveStats.saves + 1,
    full: annSaveStats.full + (mode === 'full' ? 1 : 0),
    delta: annSaveStats.delta + (mode === 'delta' ? 1 : 0),
    lastMs: res.ms ?? annSaveStats.lastMs,
    lastBytes: res.bytes ?? annSaveStats.lastBytes,
    lastMode: mode,
    fails: annSaveStats.fails + (res.ok ? 0 : 1),
  };
  e.persisted = {
    path: st.writer?.file,
    bytes: res.bytes,
    ms: res.ms,
    mode,
    savedAt: Date.now(),
    seq: e.seq || 0,
    capacity: st.writer?.capacity,
    covered: st.size,
  };
  if (res.ok) pruneTombstones(userId, e.seq || 0);
  return res;
}

/**
 * 清理已经没用的删除墓碑。
 *
 * 墓碑（vec_del）的唯一作用是「索引文件比库旧时，告诉它哪些 id 被删了」。
 * 文件一旦按当前 seq 落盘，那些 seq ≤ 文件水位 的墓碑就再也不会被读到 ——
 * 但以前它们会一直堆到上限 2 万条（冒烟/压测每轮删几千条），让 18 条记忆的库
 * 白白背 1.7MB 墓碑 + 300KB 索引。这里落盘成功后顺手删掉。
 *
 * 安全性：文件被删/损坏 → 走整库重建，重建只信 memories 表，同样用不到墓碑。
 */
function pruneTombstones(userId, seq) {
  if (!seq || !db) return 0;
  try {
    const r = db.prepare('delete from vec_del where user_id = ? and seq <= ?').run(userId, seq);
    return r.changes || 0;
  } catch {
    return 0; // 表还没建 / 库忙：不影响主流程
  }
}

/** 标记某几行「内容变了」，1.2s 后合并成一次增量写 */
function scheduleAnnSave(userId, entry, dirtyRows = null) {
  if (!ANN_PERSIST) return;
  const st = fileState(userId);
  if (dirtyRows) for (const r of dirtyRows) st.dirty.add(r);
  else if (entry) {
    // 整库重建 / 压缩：行号全变，交给 flushAnn 走全量
    st.writer?.close();
    st.writer = null;
    st.size = 0;
  }
  const prev = annSaveTimers.get(userId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    annSaveTimers.delete(userId);
    flushAnn(userId, entry);
  }, 1200);
  t.unref?.();
  annSaveTimers.set(userId, t);
}

/** 进程退出前把还在缓冲里的变更刷到盘上（同步写，保证数据不丢） */
export function flushAnnSaves() {
  const out = [];
  for (const [userId, entry] of annCache) {
    if (annSaveTimers.has(userId)) {
      clearTimeout(annSaveTimers.get(userId));
      annSaveTimers.delete(userId);
    }
    // 先把还排在队列里的改动应用到索引上，否则这次刷盘写的是「删除之前」的状态，
    // 下次重载就得靠墓碑补差才能纠正（能对，但没必要多绕一圈）
    if (annPending.has(userId) && entry) applyAnnPending(userId, entry);
    const st = annFiles.get(userId);
    const clean = st && !st.dirty.size && st.size === entry.index.size;
    if (clean) continue; // 没有任何变化，不必写盘
    const r = flushAnn(userId, entry);
    if (r) out.push({ user: userId, ...r });
  }
  return out;
}

const flushOnExit = () => {
  try {
    flushAnnSaves();
  } catch {
    /* 退出路径上不能抛 */
  }
};
process.on('exit', flushOnExit);
// Ctrl-C / kill / 容器 SIGTERM：先落盘再退（避免「刚建好的索引还没写就被杀」）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    flushOnExit();
    process.exit(0);
  });
}

const annDirHint = () => annDir(DB_PATH);

/**
 * 丢掉内存里的索引并从盘上重读（运维/验收用：等价于「进程重启后第一次查询」）。
 * @returns {{user:string, fromFile:boolean, loadMs:number, size:number, catchUp:any, reason?:string}}
 */
export function reloadAnnIndex(userId) {
  const t0 = performance.now();
  const t = annSaveTimers.get(userId);
  if (t) clearTimeout(t);
  annSaveTimers.delete(userId);
  annFiles.get(userId)?.writer?.close();
  annFiles.delete(userId);
  annCache.delete(userId);
  annPending.delete(userId);
  const entry = tryLoadAnnFromDisk(userId);
  if (!entry) {
    const st = annDiskState.get(userId) || {};
    return { user: userId, fromFile: false, loadMs: Math.round(performance.now() - t0), size: 0, catchUp: null, reason: st.reason || '没有可用的落盘索引' };
  }
  return {
    user: userId,
    fromFile: true,
    loadMs: Math.round(performance.now() - t0),
    size: entry.index.size - entry.index.dead,
    catchUp: annDiskState.get(userId)?.catchUp || { ups: 0, dels: 0 },
    seq: entry.seq,
  };
}

/**
 * 清理「可重建的缓存/派生数据」，不动记忆本身：
 *   ① 孤儿行：mem_q8 / vec_hot / memories_fts 里已经没有对应 memories 行的残留
 *   ② 可选重建向量表：vec0 是按 chunk 预分配的，删数据不会回收，重建才能把文件缩回去
 *   ③ VACUUM：把 free page 还给磁盘
 * @returns {{before:number, after:number, orphans:{mem_q8:number,vec_hot:number,vec:number}, rebuiltVec:boolean, vacuumMs:number}}
 */
export function gcCaches({ rebuildVec = false, vacuum = true, keepIndex = false } = {}) {
  const d = open();
  const sizeOf = () => {
    try {
      return d.prepare('pragma page_count').get().page_count * (d.prepare('pragma page_size').get().page_size || 4096);
    } catch {
      return 0;
    }
  };
  const before = sizeOf();
  const orphans = { mem_q8: 0, vec_hot: 0, vec: 0 };
  try {
    orphans.mem_q8 = d.prepare('delete from mem_q8 where id not in (select id from memories)').run().changes;
  } catch {
    /* 表不存在 */
  }
  try {
    orphans.vec_hot = d.prepare(`delete from vec_hot where rowid not in (select id from memories)`).run().changes;
  } catch {
    /* 表不存在 */
  }
  // 向量表里的孤儿：不走 syncMemories 删（比如直接删 memories 行）时会留下，
  // 每个 512 维 float32 = 2KB，同样要清。vec0 不支持那种子查询删除，只能逐个来。
  if (vecReady) {
    try {
      const live = new Set(d.prepare('select id from memories').all().map((r) => Number(r.id)));
      const vecIds = d.prepare(`select rowid as id from ${VEC_TABLE}`).all().map((r) => Number(r.id));
      const del = d.prepare(`delete from ${VEC_TABLE} where rowid = ?`);
      d.transaction(() => {
        for (const id of vecIds) {
          if (!live.has(id)) {
            del.run(BigInt(id));
            orphans.vec += 1;
          }
        }
      })();
    } catch (err) {
      lastError = `清理孤儿向量失败：${err.message}`;
    }
  }

  let rebuiltVec = false;
  if (rebuildVec && vecReady) {
    // 用「重建 + 分批搬运」把 vec0 的 chunk 空洞收掉（mem_q8 已经在上面清干净了）
    const target = `${VEC_TABLE}_compact`;
    try {
      d.exec(`DROP TABLE IF EXISTS ${target}`);
      d.exec(`CREATE VIRTUAL TABLE ${target} USING vec0(user_id text partition key, embedding float[${DIM}] distance_metric=cosine)`);
      const page = d.prepare(`select rowid as id, user_id as uid, embedding as emb from ${VEC_TABLE} where rowid > ? order by rowid limit 2000`);
      const ins = d.prepare(`insert into ${target}(rowid, user_id, embedding) values (?,?,?)`);
      let last = 0;
      for (;;) {
        const rows = page.all(last);
        if (!rows.length) break;
        d.transaction(() => {
          for (const r of rows) ins.run(BigInt(r.id), r.uid, r.emb);
        })();
        last = Number(rows[rows.length - 1].id);
        if (rows.length < 2000) break;
      }
      const old = VEC_TABLE;
      d.exec(`DROP TABLE IF EXISTS ${old}`);
      VEC_TABLE = target;
      setMeta('vec_table', target);
      rebuiltVec = true;
    } catch (err) {
      lastError = `重建向量表失败（保留原表）：${err.message}`;
    }
  }

  if (!keepIndex) {
    // 表换了名 / 行被清了，内存索引与落盘文件都要作废
    for (const [userId] of [...annCache]) resetAnnIndex(userId);
  }

  const t0 = performance.now();
  if (vacuum) {
    try {
      d.pragma('wal_checkpoint(TRUNCATE)');
      d.exec('VACUUM');
    } catch (err) {
      lastError = `VACUUM 失败：${err.message}`;
    }
  }
  return { before, after: sizeOf(), orphans, rebuiltVec, vacuumMs: Math.round(performance.now() - t0) };
}

/** 删掉索引（内存 + 落盘文件），下次查询整库重建。改嵌入模型或怀疑索引坏了时用 */
export function resetAnnIndex(userId) {
  annCache.delete(userId);
  annPending.delete(userId);
  annDiskState.delete(userId);
  const cached = annSaveTimers.get(userId);
  if (cached) clearTimeout(cached);
  annSaveTimers.delete(userId);
  annFiles.get(userId)?.writer?.close();
  annFiles.delete(userId);
  // 文件都删了，这个用户的墓碑也就没用了（重建只信 memories 表）
  const tombs = pruneTombstones(userId, Number.MAX_SAFE_INTEGER);
  return { user: userId, fileRemoved: deleteAnnFile(DB_PATH, userId, DIM), tombsPruned: tombs };
}

/* ---------- 变更队列 ---------- */
const annPending = new Map(); // userId -> { up:Map<id,sig|null>, del:Set, bytes }
const ANN_QUEUE_BYTES = 16 * 1024 * 1024; // 队列里最多攒 16MB 签名，超了改回读库
const ANN_QUEUE_MAX = 50000; // 队列条数上限：再多就不逐条应用了，直接整库重建（读库才是真相）

function annQueue(userId) {
  let q = annPending.get(userId);
  if (!q) {
    q = { up: new Map(), del: new Set(), bytes: 0, maxSeq: 0 };
    annPending.set(userId, q);
  }
  if (q.up.size + q.del.size > ANN_QUEUE_MAX) {
    // 变更太多，逐条应用不划算了：丢掉缓存与队列，下次查询从库里整批重建
    annPending.delete(userId);
    annCache.delete(userId);
    q = { up: new Map(), del: new Set(), bytes: 0, maxSeq: 0 };
    annPending.set(userId, q);
    lastError = `变更超过 ${ANN_QUEUE_MAX} 条，ANN 索引下次查询将整库重建`;
  }
  return q;
}

/**
 * 标记「这条 id 的向量变了」。
 * 顺手把 64 字节的二值签名带在队列里：1M 库改 300 条时，回 SQLite 按主键捞签名要 200ms+，
 * 而写的时候签名本来就在手上，直接拿过来应用就只剩微秒级。
 */
function annTouchUp(userId, id, sig = null, isNew = false, seq = 0) {
  const q = annQueue(userId);
  const key = Number(id);
  const cached = sig && q.bytes + sig.length <= ANN_QUEUE_BYTES ? sig : null;
  if (cached) q.bytes += cached.length;
  q.up.set(key, cached);
  if (seq > q.maxSeq) q.maxSeq = seq;
  if (isNew) sigVersion += 1; // 只用于向量条数缓存失效（索引不再整库作废）
}

/** 标记「这条 id 被删了」 */
function annTouchDel(userId, id, seq = 0) {
  const q = annQueue(userId);
  q.del.add(Number(id));
  q.up.delete(Number(id));
  if (seq > q.maxSeq) q.maxSeq = seq;
  sigVersion += 1;
}

export function annDirtyCount(userId) {
  const q = annPending.get(userId);
  return q ? q.up.size + q.del.size : 0;
}

/**
 * 把队列里的变更应用到索引上。
 * @returns {boolean} false 表示需要整库重建（乱序插入 / 墓碑过多）
 */
function applyAnnPending(userId, entry) {
  const q = annPending.get(userId);
  if (!q || (!q.up.size && !q.del.size)) return true;
  const index = entry.index;
  const dirtyRows = new Set(); // 落盘时只需要重写这些行

  for (const id of q.del) {
    const row = index.rowOfId(Number(id));
    if (row >= 0) dirtyRows.add(row);
    index.remove(Number(id));
  }

  // ① 队列里带着签名的，直接原地应用（微秒级）
  const needRead = [];
  for (const [id, sig] of q.up) {
    if (sig) {
      const row = index.rowOfId(Number(id));
      if (row >= 0) dirtyRows.add(row);
      if (!index.upsert(id, sig)) {
        lastError = 'ANN 增量失败（乱序插入），回退整库重建';
        return false;
      }
    } else {
      needRead.push(id);
    }
  }

  // ② 没带签名的（队列超限 / 老调用），回库里批量捞
  if (needRead.length) {
    const ids = needRead;
    // 分批取签名，避免超长 SQL（1M 条里改几千条也很正常）
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const ph = batch.map(() => '?').join(',');
      const rows = db.prepare(`select id, sig from memories where user_id = ? and id in (${ph})`).all(userId, ...batch);
      const seen = new Set();
      for (const r of rows) {
        if (!r.sig) continue;
        seen.add(Number(r.id));
        const row = index.rowOfId(Number(r.id));
        if (row >= 0) dirtyRows.add(row);
        if (!index.upsert(Number(r.id), r.sig)) {
          lastError = 'ANN 增量失败（乱序插入），回退整库重建';
          return false;
        }
      }
      // 取不到签名 = 这条已经不在库里了
      for (const id of batch) {
        if (seen.has(id)) continue;
        const row = index.rowOfId(Number(id));
        if (row >= 0) dirtyRows.add(row);
        index.remove(Number(id));
      }
    }
  }
  annPending.delete(userId);
  entry.count = index.size - index.dead;
  if (q.maxSeq > (entry.seq || 0)) entry.seq = q.maxSeq;
  entry.dirtySinceSave = true;
  scheduleAnnSave(userId, entry, dirtyRows); // 1.2s 后合并成一次增量写（只碰这几行）
  return true;
}

/**
 * 从盘上恢复索引：校验 CRC → 补 vec_seq 水位之后的改动 → 核对条数。
 * 任何一步对不上就返回 null，调用方退回整库重建（宁可慢也不能给错结果）。
 */
function tryLoadAnnFromDisk(userId) {
  if (!ANN_PERSIST) return null;
  const t0 = performance.now();
  const loaded = loadAnnFile(DB_PATH, userId, DIM);
  if (!loaded.ok) {
    annDiskState.set(userId, { fromFile: false, reason: loaded.reason });
    return null;
  }
  const index = createAnnIndex(DIM);
  index.restore(loaded);
  const seq0 = Number(loaded.seq) || 0;
  let ups = 0;
  let dels = 0;
  const dirtyRows = new Set();
  try {
    const rows = db.prepare(`select id, sig from memories where user_id = ? and vec_seq > ? and sig is not null order by id`).all(userId, seq0);
    for (const r of rows) {
      const row = index.rowOfId(Number(r.id));
      if (row >= 0) dirtyRows.add(row);
      if (index.upsert(Number(r.id), r.sig)) ups += 1;
      else return null; // 乱序（比如恢复了旧备份）→ 重建更稳
    }
    const tombs = db.prepare('select id from vec_del where user_id = ? and seq > ?').all(userId, seq0);
    for (const t of tombs) {
      const row = index.rowOfId(Number(t.id));
      if (row >= 0) dirtyRows.add(row);
      if (index.remove(Number(t.id))) dels += 1;
    }
  } catch (err) {
    annDiskState.set(userId, { fromFile: false, reason: `补差失败：${err.message}` });
    return null;
  }

  // 条数核对：索引里的活条目必须和库里的签名条数一致
  const live = index.size - index.dead;
  const dbLive = db.prepare('select count(*) c from memories where user_id = ? and sig is not null').get(userId).c;
  if (live !== dbLive) {
    annDiskState.set(userId, { fromFile: false, reason: `条数对不上（盘上 ${live} / 库里 ${dbLive}）` });
    return null;
  }

  const seqNow = currentVecSeq();
  const entry = { index, version: sigVersion, count: live, seq: seqNow };
  annCache.set(userId, entry);
  annPending.delete(userId);
  tierStats.annBuildMs = 0;
  // 接管文件句柄：后续改一条就 pwrite 那一行
  const writer = AnnWriter.open(DB_PATH, userId, DIM);
  annFiles.set(userId, { writer, size: loaded.size, dead: loaded.dead, dirty: new Set() });
  const ms = Math.round(performance.now() - t0);
  annDiskState.set(userId, {
    fromFile: true,
    loadMs: ms,
    bytes: loaded.bytes,
    savedAt: loaded.savedAt,
    catchUp: { ups, dels },
    reason: null,
  });
  // 有补差就顺手把这几行 + 新水位写回文件（增量，不是全量）
  if (ups || dels) scheduleAnnSave(userId, entry, dirtyRows);
  return entry;
}

/** 构建该用户的二值索引（懒加载；有增量队列就先应用，不再整库重建） */
function annIndexFor(userId) {
  const cached = annCache.get(userId);
  if (cached) {
    if (applyAnnPending(userId, cached)) {
      if (cached.index.staleRatio < 0.15) return cached;
      annCache.delete(userId); // 墓碑太多，压缩
    } else {
      annCache.delete(userId);
    }
  }
  const fromDisk = tryLoadAnnFromDisk(userId);
  if (fromDisk) return fromDisk;
  backfillSigs(userId);
  // 分块读 id + sig（64 字节/条）：1M 条也只有 64MB，且不构造 100 万个对象
  const index = createAnnIndex(DIM);
  const t0 = performance.now();
  const total = db
    .prepare(`select count(*) c from memories where user_id = ? and sig is not null`)
    .get(userId).c;
  index.reserve(total);
  const page = db.prepare(`select id, sig from memories where user_id = ? and sig is not null and id > ? order by id limit 20000`);
  let last = 0;
  for (;;) {
    const chunk = page.all(userId, last);
    if (!chunk.length) break;
    for (const r of chunk) {
      index.push(r.id, r.sig);
      last = r.id;
    }
    if (chunk.length < 20000) break;
  }
  index.buildMs = Math.round(performance.now() - t0);
  tierStats.annBuildMs = index.buildMs;
  const entry = { index, version: sigVersion, count: index.size, seq: currentVecSeq() };
  annCache.set(userId, entry);
  annPending.delete(userId); // 刚从库里全量读的，队列里的变更已经包含在内
  annDiskState.set(userId, { fromFile: false, reason: '整库重建' });
  annFiles.get(userId)?.writer?.close();
  annFiles.delete(userId);
  scheduleAnnSave(userId, entry); // 建完就落盘（全量），下次启动直接读
  return entry;
}

/* ---------- 后台预热：分块建 ANN 索引，避免首次查询卡十秒 ---------- */
const annWarm = new Map(); // userId -> { done, total, startedAt }
const annDiskState = new Map(); // userId -> { fromFile, loadMs, bytes, savedAt, catchUp, reason }

export function annWarmStatus(userId) {
  const st = annWarm.get(userId);
  if (st) return { warming: true, done: st.done, total: st.total, ms: Date.now() - st.startedAt };
  const cached = annCache.get(userId);
  return { warming: false, size: cached?.index?.size || 0, buildMs: cached?.index?.buildMs || 0 };
}

/**
 * 后台建索引：每 20000 条让出一次事件循环（单次停顿时延 ~50ms），
 * 建完才放进缓存；中途 sigVersion 变了就作废，下次再建。
 */
export async function warmAnnIndex(userId) {
  const cached = annCache.get(userId);
  if (cached) {
    const ok = applyAnnPending(userId, cached);
    if (ok && cached.index.staleRatio < 0.15) {
      return { ready: true, incremental: true, size: cached.index.size - cached.index.dead, ms: 0 };
    }
    annCache.delete(userId);
  }
  if (annWarm.has(userId)) return { ready: false, ...annWarmStatus(userId) };
  const fromDisk = tryLoadAnnFromDisk(userId);
  if (fromDisk) return { ready: true, fromFile: true, size: fromDisk.index.size - fromDisk.index.dead, ms: annDiskState.get(userId)?.loadMs || 0 };
  const version = sigVersion;
  backfillSigs(userId);
  const total = db.prepare(`select count(*) c from memories where user_id = ? and sig is not null`).get(userId).c;
  if (!total) return { ready: false, reason: 'empty', total: 0 };
  if (total < ANN_MIN) return { ready: false, reason: 'below-threshold', total, annMin: ANN_MIN };

  const index = createAnnIndex(DIM);
  index.reserve(total);
  const page = db.prepare(`select id, sig from memories where user_id = ? and sig is not null and id > ? order by id limit 20000`);
  const st = { done: 0, total, startedAt: Date.now() };
  annWarm.set(userId, st);
  let last = 0;
  try {
    for (;;) {
      const chunk = page.all(userId, last);
      if (!chunk.length) break;
      for (const r of chunk) {
        index.push(r.id, r.sig);
        last = r.id;
      }
      st.done += chunk.length;
      await new Promise((r) => setImmediate(r));
      if (chunk.length < 20000) break;
    }
  } finally {
    annWarm.delete(userId);
  }
  index.buildMs = Date.now() - st.startedAt;
  if (version !== sigVersion && annDirtyCount(userId) > 5000) {
    return { ready: false, reason: 'stale', size: index.size, ms: index.buildMs };
  }
  const warmEntry = { index, version: sigVersion, count: index.size, seq: currentVecSeq() };
  annCache.set(userId, warmEntry);
  annDiskState.set(userId, { fromFile: false, reason: '整库重建（后台）' });
  annFiles.get(userId)?.writer?.close();
  annFiles.delete(userId);
  scheduleAnnSave(userId, warmEntry);
  annPending.delete(userId);
  tierStats.annBuildMs = index.buildMs;
  return { ready: true, size: index.size, ms: index.buildMs };
}

/** 建分区向量表；同名建不出来（旧库残留 shadow table）就自动换名 */
function ensureVecTable() {
  const candidates = [getMeta('vec_table') || 'vec_memories', 'vec_memories_v2', 'vec_memories_v3'];
  for (const name of candidates) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(user_id text partition key, embedding float[${DIM}] distance_metric=cosine, chunk_size=${VEC_CHUNK})`,
      );
      VEC_TABLE = name;
      setMeta('vec_table', name);
      setMeta('dim', String(DIM));
      return true;
    } catch (err) {
      lastError = `创建 ${name} 失败：${err.message}`;
    }
  }
  vecReady = false;
  return false;
}

/** 向量表是不是分区结构？ */
function vecTablePartitioned(name) {
  try {
    db.prepare(`select user_id from ${name} limit 1`).get();
    return true;
  } catch {
    return false;
  }
}

/**
 * 距离度量迁移：vec0 默认是 **L2**，而「语义相似度」要的是 **cosine**。
 *
 * 早先版本没写 `distance_metric=cosine`，于是 KNN 返回的是 L2 距离，
 * 代码却按「cos 距离」解释（`sim = 1 - d/2`），结果：排序是对的，
 * 但近邻的相似度被严重低估（真实 cos 0.988 会被显示成 0.49）。
 *
 * 这里把向量表重建一遍：新表带 cosine 度量，按 2000 条一批搬运，搬完切表名。
 * 热点表只是缓存，直接丢掉重建（下次写入会自动回来）。
 */
function migrateVecCosine() {
  let ddl = '';
  try {
    ddl = db.prepare('select sql from sqlite_master where name = ?').get(VEC_TABLE)?.sql || '';
  } catch {
    ddl = '';
  }
  if (/distance_metric\s*=\s*cosine/i.test(ddl)) {
    setMeta('vec_schema', 'v3-cosine');
    return;
  }

  const target = 'vec_memories_v3';
  try {
    db.exec(`DROP TABLE IF EXISTS ${target}`);
    db.exec(
      `CREATE VIRTUAL TABLE ${target} USING vec0(user_id text partition key, embedding float[${DIM}] distance_metric=cosine, chunk_size=${VEC_CHUNK})`,
    );
  } catch (err) {
    lastError = `cosine 距离表建不出来，继续用 L2（相似度会偏低）：${err.message}`;
    return;
  }

  const page = db.prepare(`select rowid as id, user_id as uid, embedding as emb from ${VEC_TABLE} where rowid > ? order by rowid limit 2000`);
  const ins = db.prepare(`insert into ${target}(rowid, user_id, embedding) values (?,?,?)`);
  let last = 0;
  let n = 0;
  for (;;) {
    const rows = page.all(last);
    if (!rows.length) break;
    db.transaction(() => {
      for (const r of rows) {
        ins.run(BigInt(r.id), r.uid, r.emb);
        n += 1;
      }
    })();
    last = Number(rows[rows.length - 1].id);
    if (rows.length < 2000) break;
  }

  const old = VEC_TABLE;
  try {
    db.exec(`DROP TABLE IF EXISTS ${old}`);
  } catch {
    /* 旧表删不掉就留着，反正已经切到新表 */
  }
  VEC_TABLE = target;
  setMeta('vec_table', target);
  setMeta('vec_schema', 'v3-cosine');
  // 热点表按新度量重建（只是缓存，不搬数据）
  try {
    db.exec('DROP TABLE IF EXISTS vec_hot');
  } catch {
    /* ignore */
  }
  hotCount.clear();
  lastError = `已把 ${n} 条向量迁到 cosine 距离表（${target}）`;
}

/**
 * 老库迁移：v0.4 的 vec0 表没有分区键（KNN 要扫全表再 JOIN 过滤）。
 *
 *   读旧表向量 → DROP（虚拟表会连 shadow table 一起带走）→
 *   重建 `vec0(user_id text partition key, embedding float[DIM])` → 回填
 *
 * 如果同名重建失败（旧库残留 shadow table），自动换名 vec_memories_v2 继续。
 */
function migrateVecPartition() {
  try {
    if (vecTablePartitioned(VEC_TABLE)) {
      setMeta('vec_schema', 'v2-partition');
      return;
    }

    // 找出无分区键的旧表（vec_memories / vec_memories_old 都可能是）
    const legacies = ['vec_memories', 'vec_memories_old'].filter((n) =>
      db.prepare("select name from sqlite_master where type='table' and name=?").get(n),
    );

    let rows = [];
    for (const name of legacies) {
      try {
        const got = db
          .prepare(`select v.rowid as id, v.embedding as emb, m.user_id as uid from ${name} v join memories m on m.id = v.rowid`)
          .all()
          .filter((r) => r.uid);
        if (got.length) {
          rows = got;
          break;
        }
      } catch (err) {
        lastError = `读取旧向量表 ${name} 失败：${err.message}`;
      }
    }

    for (const name of legacies) {
      try {
        db.exec(`DROP TABLE IF EXISTS ${name}`);
      } catch (err) {
        lastError = `删除旧向量表 ${name} 失败：${err.message}`;
      }
    }

    // 重建（换名兜底）
    let created = false;
    for (const name of ['vec_memories', 'vec_memories_v2', 'vec_memories_v3']) {
      try {
        db.exec(
          `CREATE VIRTUAL TABLE ${name} USING vec0(user_id text partition key, embedding float[${DIM}] distance_metric=cosine, chunk_size=${VEC_CHUNK})`,
        );
        VEC_TABLE = name;
        setMeta('vec_table', name);
        created = true;
        break;
      } catch (err) {
        lastError = `创建分区表 ${name} 失败：${err.message}`;
      }
    }
    if (!created) {
      vecReady = false;
      return;
    }

    if (rows.length) {
      const ins = db.prepare(`insert into ${VEC_TABLE}(rowid, user_id, embedding) values (?,?,?)`);
      db.transaction(() => {
        for (const r of rows) ins.run(BigInt(r.id), r.uid, r.emb);
      })();
      lastError = `已迁移 ${rows.length} 条向量到分区索引（${VEC_TABLE}）`;
    }
    setMeta('vec_schema', 'v2-partition');
  } catch (err) {
    lastError = `分区索引迁移失败（回落到全表 KNN）：${err.message}`;
  }
}

/** FTS5 稀疏索引（外部内容表 + 触发器），tokens 由统一的 tokenize() 生成 */
function setupFts() {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        tokens, content='memories', content_rowid='id', tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, tokens) VALUES (new.id, new.tokens);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, tokens) VALUES ('delete', old.id, coalesce(old.tokens, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, tokens) VALUES ('delete', old.id, coalesce(old.tokens, ''));
        INSERT INTO memories_fts(rowid, tokens) VALUES (new.id, coalesce(new.tokens, ''));
      END;
    `);
    if (getMeta('fts_ready') !== '1') {
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
      setMeta('fts_ready', '1');
    }
    ftsReady = true;
  } catch (err) {
    ftsReady = false;
    lastError = `FTS5 不可用（BM25 关闭）：${err.message}`;
  }
}

function backfillTokens() {
  let rows = [];
  try {
    rows = db.prepare('select id, text, tags from memories where tokens is null').all();
  } catch {
    return;
  }
  if (!rows.length) return;
  const upd = db.prepare('update memories set tokens = ? where id = ?');
  db.transaction(() => {
    for (const r of rows) upd.run(tokensOf(r.text, r.tags), r.id);
  })();
}

/** 记忆文本 → 空格分隔的 token 串（英文词 + 中文 bigram）；与 Postgres 后端共用 */
export { tokensOf, ftsQuery } from './text-index.js';
function ensureColumn(table, column, decl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      if (column === 'tokens') setMeta('fts_ready', '0');
    }
  } catch (err) {
    lastError = `补列 ${table}.${column} 失败：${err.message}`;
  }
}

function getMeta(key) {
  try {
    return open().prepare('select value from meta where key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function setMeta(key, value) {
  open().prepare('insert into meta(key,value) values (?,?) on conflict(key) do update set value=excluded.value').run(key, String(value));
}

/* ------------------------------------------------------------------ */
/* 用户                                                                */
/* ------------------------------------------------------------------ */

export function touchUser(id, name) {
  const d = open();
  const now = Date.now();
  d.prepare(
    `insert into users(id, name, created_at, last_seen) values (?,?,?,?)
     on conflict(id) do update set last_seen = excluded.last_seen, name = coalesce(excluded.name, users.name)`,
  ).run(id, name || id, now, now);
  return { id, name: name || id };
}

export function listUsers() {
  const d = open();
  const rows = d.prepare('select id, name, created_at, last_seen from users order by last_seen desc').all();
  return rows.map((r) => ({
    ...r,
    memories: d.prepare('select count(*) c from memories where user_id = ?').get(r.id).c,
  }));
}

/* ------------------------------------------------------------------ */
/* 同步（客户端 → 服务端，增量）                                        */
/* ------------------------------------------------------------------ */

function upsertOne(d, mem, userId, workspace, seq = 0) {
  const now = Date.now();
  const tags = JSON.stringify(mem.tags || []);
  const existing = d.prepare('select id, hash from memories where uid = ?').get(mem.uid);

  if (existing) {
    if (existing.hash === mem.hash && existing.id) {
      // 内容没变，只更新元信息
      d.prepare(
        `update memories set importance=?, uses=?, pinned=?, updated_at=?, last_used_at=?, source=? where id=?`,
      ).run(mem.importance ?? 3, mem.uses ?? 0, mem.pinned ? 1 : 0, mem.updatedAt || now, mem.lastUsedAt || 0, mem.source || 'sync', existing.id);
      return { id: existing.id, uid: mem.uid, changed: false };
    }
    const sigBuf = mem.vector && mem.vector.length === DIM ? packSign(mem.vector) : null;
    d.prepare(
      `update memories set user_id=?, workspace=?, kind=?, text=?, tags=?, importance=?, uses=?, pinned=?,
        source=?, updated_at=?, last_used_at=?, hash=?, vec=?, tokens=?, sig=?, vec_seq=? where id=?`,
    ).run(
      userId,
      workspace,
      mem.kind || 'fact',
      mem.text,
      tags,
      mem.importance ?? 3,
      mem.uses ?? 0,
      mem.pinned ? 1 : 0,
      mem.source || 'sync',
      mem.updatedAt || now,
      mem.lastUsedAt || 0,
      mem.hash ?? null,
      keepBlob() && mem.vector ? toBlob(mem.vector) : null,
      tokensOf(mem.text, mem.tags),
      sigBuf,
      mem.vector ? seq : 0,
      existing.id,
    );
    if (vecReady && mem.vector) {
      annTouchUp(userId, existing.id, sigBuf, false, seq);
      d.prepare(`delete from ${VEC_TABLE} where rowid = ?`).run(BigInt(existing.id));
      d.prepare(`insert or replace into ${VEC_TABLE}(rowid, user_id, embedding) values (?,?,?)`).run(
        BigInt(existing.id),
        userId,
        toBlob(mem.vector),
      );
      syncHot(d, existing.id, userId, mem.vector, shouldBeHot({ ...mem, uses: mem.uses ?? 0 }));
      const q8 = toQ8(mem.vector);
      d.prepare('insert or replace into mem_q8(id, scale, norm, q) values (?,?,?,?)').run(
        Number(existing.id),
        q8.scale,
        q8.norm,
        q8.q,
      );
    }
    return { id: existing.id, uid: mem.uid, changed: true };
  }

  const sigBuf = mem.vector && mem.vector.length === DIM ? packSign(mem.vector) : null;
  const info = d
    .prepare(
      `insert into memories(uid, user_id, workspace, kind, text, tags, importance, uses, pinned, source,
        created_at, updated_at, last_used_at, hash, vec, tokens, sig, vec_seq) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      mem.uid,
      userId,
      workspace,
      mem.kind || 'fact',
      mem.text,
      tags,
      mem.importance ?? 3,
      mem.uses ?? 0,
      mem.pinned ? 1 : 0,
      mem.source || 'sync',
      mem.createdAt || now,
      mem.updatedAt || now,
      mem.lastUsedAt || 0,
      mem.hash ?? null,
      keepBlob() && mem.vector ? toBlob(mem.vector) : null,
      tokensOf(mem.text, mem.tags),
      sigBuf,
      mem.vector ? seq : 0,
    );
  const id = info.lastInsertRowid;
  if (vecReady && mem.vector) {
    annTouchUp(userId, id, sigBuf, true, seq);
    d.prepare(`insert or replace into ${VEC_TABLE}(rowid, user_id, embedding) values (?,?,?)`).run(BigInt(id), userId, toBlob(mem.vector));
    syncHot(d, id, userId, mem.vector, shouldBeHot(mem));
    const q8 = toQ8(mem.vector);
    d.prepare('insert or replace into mem_q8(id, scale, norm, q) values (?,?,?,?)').run(Number(id), q8.scale, q8.norm, q8.q);
  }
  return { id, uid: mem.uid, changed: true, created: true };
}

/**
 * 增量同步一批记忆
 * @param {{userId:string, workspace:string, items:any[], deleted?:string[]}} payload
 */
export function syncMemories({ userId, workspace, items = [], deleted = [] }) {
  const d = open();
  touchUser(userId);
  const needTomb = deleted.length ? needsTomb(userId) : false;
  const tx = d.transaction(() => {
    const saved = [];
    let vectorized = 0;
    const seq = items.some((m) => m.vector) || deleted.length ? nextVecSeq(d) : 0;
    for (const mem of items) {
      const r = upsertOne(d, mem, userId, workspace, seq);
      if (mem.vector) vectorized++;
      saved.push(r);
    }
    const removed = [];
    for (const uid of deleted) {
      const row = d.prepare('select id from memories where uid = ? and user_id = ?').get(uid, userId);
      if (!row) continue;
      d.prepare('delete from memories where id = ?').run(row.id);
      if (vecReady) d.prepare(`delete from ${VEC_TABLE} where rowid = ?`).run(BigInt(row.id));
      // int8 侧表与热点表也要一起删，否则每次删除都留一份 512 字节的孤儿（实测漏了几万行、白占 25MB）
      try {
        d.prepare('delete from mem_q8 where id = ?').run(Number(row.id));
        d.prepare('delete from vec_hot where rowid = ?').run(BigInt(row.id));
      } catch {
        /* 表还没建 */
      }
      if (needTomb) d.prepare('insert or replace into vec_del(id, user_id, seq) values (?,?,?)').run(Number(row.id), userId, seq);
      annTouchDel(userId, row.id, seq);
      removed.push(uid);
    }
    // 墓碑只留最近的 2 万条（更老的早已被所有索引水位越过）
    if (deleted.length) {
      const tomb = d.prepare('select count(*) c from vec_del').get().c;
      if (tomb > 20000) {
        d.prepare('delete from vec_del where id in (select id from vec_del order by seq asc limit ?)').run(tomb - 20000);
      }
    }
    return { saved, removed, vectorized, seq };
  });
  const res = tx();
  return {
    ...res,
    backend: vecReady ? 'sqlite-vec' : 'sqlite-blob',
    dim: DIM,
    scope: { userId, workspace },
  };
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 导出全部用户/工作区的记忆（含向量），用于 sqlite → pgvector 迁移 */
export function exportAllMemories() {
  if (!db) return [];
  const rows = db
    .prepare(
      `select user_id, workspace, uid, text, tags, kind, importance, created_at, updated_at, vec
       from memories where user_id is not null order by id asc`,
    )
    .all();
  // 向量优先从分区 vec0 表读（平时 BLOB 列为了省空间是空的）
  let vecMap = new Map();
  if (vecReady) {
    try {
      for (const v of db.prepare(`select rowid as id, embedding from ${VEC_TABLE}`).all()) {
        if (!v.embedding) continue;
        const b = v.embedding;
        vecMap.set(Number(v.id), Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)));
      }
    } catch (err) {
      lastError = `导出向量失败（将只导文本）：${err.message}`;
    }
  }
  const byId = db.prepare('select id, user_id, workspace, uid from memories').all();
  const idOf = new Map(byId.map((r) => [`${r.user_id}\u0000${r.workspace}\u0000${r.uid}`, r.id]));
  return rows.map((r) => ({
    userId: r.user_id,
    workspace: r.workspace,
    uid: r.uid,
    text: r.text,
    tags: (() => {
      try {
        return JSON.parse(r.tags || '[]');
      } catch {
        return [];
      }
    })(),
    kind: r.kind,
    importance: r.importance,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    vector: (() => {
      if (r.vec) return Array.from(new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4));
      const id = idOf.get(`${r.user_id}\u0000${r.workspace}\u0000${r.uid}`);
      return id ? vecMap.get(id) || null : null;
    })(),
  }));
}

export function listMemories(userId, workspace) {
  const d = open();
  const rows = d
    .prepare(
      `select uid, kind, text, tags, importance, uses, pinned, source, created_at, updated_at, last_used_at
       from memories where user_id = ? and workspace = ? order by updated_at desc`,
    )
    .all(userId, workspace);
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]'), pinned: Boolean(r.pinned) }));
}

export function deleteMemory(userId, uid) {
  const d = open();
  const row = d.prepare('select id from memories where uid = ? and user_id = ?').get(uid, userId);
  if (!row) return false;
  const id = Number(row.id);
  // 和批量同步里的删除走完全一样的清理：主表 + 向量表 + 两张侧表 + 墓碑
  // （早先这个函数只删主表和向量表，导致 ANN 索引不知道有条被删了：
  //   要么继续返回已删的记忆，要么落盘时条数对不上被迫整库重建）
  const seq = nextVecSeq(d);
  const needTomb = needsTomb(userId);
  d.transaction(() => {
    d.prepare('delete from memories where id = ?').run(id);
    if (vecReady) d.prepare(`delete from ${VEC_TABLE} where rowid = ?`).run(BigInt(id));
    try {
      d.prepare('delete from mem_q8 where id = ?').run(id);
      d.prepare('delete from vec_hot where rowid = ?').run(BigInt(id));
    } catch {
      /* 表还没建 */
    }
    if (needTomb) d.prepare('insert or replace into vec_del(id, user_id, seq) values (?,?,?)').run(id, userId, seq);
  })();
  annTouchDel(userId, id, seq);
  return true;
}

/** 内部状态（排查用，也供 /api/mem/status 展示） */
export function lastStatus() {
  return { vecTable: VEC_TABLE, vecReady, ftsReady, lastError };
}

export function stats() {
  const d = open();
  const total = d.prepare('select count(*) c from memories').get().c;
  const users = d.prepare('select count(*) c from users').get().c;
  let vec = 0;
  if (vecReady) {
    try {
      vec = d.prepare(`select count(*) c from ${VEC_TABLE}`).get().c;
    } catch (err) {
      vecReady = false;
      lastError = `向量表不可用：${err.message}`;
    }
  }
  const scopes = d.prepare('select user_id, workspace, count(*) c from memories group by user_id, workspace order by c desc limit 10').all();
  let hotRows = 0;
  try {
    hotRows = d.prepare('select count(*) c from vec_hot').get().c;
  } catch {
    /* 热表还没建 */
  }
  const ann = [...annCache.entries()].map(([user, e]) => ({
    user,
    ...e.index.stats(),
    seq: e.seq || 0,
    persisted: e.persisted || null,
    disk: annDiskState.get(user) || null,
  }));
  return {
    backend: vecReady ? (ftsReady ? 'sqlite-vec+fts5' : 'sqlite-vec') : ftsReady ? 'sqlite-fts5' : 'sqlite-blob',
    vecBackend: vecReady ? 'sqlite-vec' : 'sqlite-blob',
    bm25: ftsReady,
    partitionKey: vecReady ? 'user_id' : null,
    dim: DIM,
    dbPath: DB_PATH,
    total,
    users,
    vectors: vec,
    scopes,
    annMin: ANN_MIN,
    annCand: ANN_CAND,
    vecChunk: VEC_CHUNK,
    annRerank: ANN_RERANK,
    ann,
    hot: { rows: hotRows, max: HOT_MAX, minUses: HOT_MIN_USES, skipDist: HOT_SKIP_DIST },
    annPending: [...annPending.entries()].map(([user, q]) => ({ user, ups: q.up.size, dels: q.del.size })),
    annPersist: {
      enabled: ANN_PERSIST,
      dir: annDirHint(),
      saves: annSaveStats.saves,
      full: annSaveStats.full,
      delta: annSaveStats.delta,
      lastMode: annSaveStats.lastMode,
      lastMs: annSaveStats.lastMs,
      lastBytes: annSaveStats.lastBytes,
      fails: annSaveStats.fails,
      files: [...annCache.keys()].map((u) => ({
        user: u,
        ...(annFileInfo(DB_PATH, u, DIM) || {}),
        covered: annFiles.get(u)?.size ?? null,
        capacity: annFiles.get(u)?.writer?.capacity ?? null,
        dirty: annFiles.get(u)?.dirty.size ?? 0,
      })),
    },
    tierStats: { ...tierStats },
    error: lastError,
  };
}


bindMemorySearch({
  open,
  toBlob,
  get VEC_TABLE() {
    return VEC_TABLE;
  },
  get vecReady() {
    return vecReady;
  },
  get ftsReady() {
    return ftsReady;
  },
  get lastError() {
    return lastError;
  },
  set lastError(v) {
    lastError = v;
  },
  HOT_SKIP_DIST,
  ANN_MIN,
  ANN_CAND,
  ANN_RERANK,
  tierStats,
  vecCountFor,
  annIndexFor,
  rerankQ8,
});

export function closeDb() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}
