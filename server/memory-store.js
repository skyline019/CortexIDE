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
import { bindMemorySearch, searchMemories, cosine } from './memory-search.js';
import {
  bindMemoryCrud,
  touchUser,
  listUsers,
  syncMemories,
  listMemories,
  deleteMemory,
  exportAllMemories,
} from './memory-crud.js';
import {
  bindMemoryMigrate,
  ensureColumn,
  getMeta,
  setMeta,
  ensureVecTable,
  migrateVecPartition,
  migrateVecCosine,
  backfillTokens,
  setupFts,
} from './memory-migrate.js';
import {
  bindMemoryAnn,
  ensureHotTable,
  ensureQ8,
  syncHot,
  shouldBeHot,
  toQ8,
  annTouchUp,
  annTouchDel,
  needsTomb,
  nextVecSeq,
  vecCountFor,
  annIndexFor,
  rerankQ8,
  flushAnnSaves,
  reloadAnnIndex,
  gcCaches,
  resetAnnIndex,
  annDirtyCount,
  annWarmStatus,
  warmAnnIndex,
  annStatsSection,
  hotCount,
  tierStats,
  ANN_MIN,
  ANN_CAND,
  ANN_RERANK,
  HOT_MAX,
  HOT_SKIP_DIST,
  HOT_MIN_USES,
} from './memory-ann.js';

export { searchMemories, cosine };
export { touchUser, listUsers, syncMemories, listMemories, deleteMemory, exportAllMemories };
export { flushAnnSaves, reloadAnnIndex, gcCaches, resetAnnIndex, annDirtyCount, annWarmStatus, warmAnnIndex };

let vecLoadablePath = null;
try {
  const mod = await import('sqlite-vec');
  vecLoadablePath = (mod.default || mod).getLoadablePath?.() || null;
} catch {
  vecLoadablePath = null;
}

const DIM = Number(process.env.EMBED_DIM || 512);
const DB_PATH = process.env.CORTEX_DB || path.join(process.cwd(), '.cortex', 'memory.db');
const VEC_CHUNK = Math.max(8, Number(process.env.CORTEX_VEC_CHUNK || 256));

let db = null;
let VEC_TABLE = 'vec_memories';
let vecReady = false;
let ftsReady = false;
let lastError = null;

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

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
  ensureColumn('memories', 'sig', 'BLOB');
  ensureColumn('memories', 'vec_seq', 'INTEGER NOT NULL DEFAULT 0');
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
  backfillTokens();
  setupFts();
  return db;
}

export { tokensOf, ftsQuery } from './text-index.js';

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
  const { ann, annPending, annPersist } = annStatsSection();
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
    annPending,
    annPersist,
    tierStats: { ...tierStats },
    error: lastError,
  };
}

bindMemoryMigrate({
  open,
  DIM,
  VEC_CHUNK,
  hotCount,
  get VEC_TABLE() {
    return VEC_TABLE;
  },
  set VEC_TABLE(v) {
    VEC_TABLE = v;
  },
  get vecReady() {
    return vecReady;
  },
  set vecReady(v) {
    vecReady = v;
  },
  get ftsReady() {
    return ftsReady;
  },
  set ftsReady(v) {
    ftsReady = v;
  },
  get lastError() {
    return lastError;
  },
  set lastError(v) {
    lastError = v;
  },
});

bindMemoryCrud({
  open,
  DIM,
  keepBlob,
  toBlob,
  get vecReady() {
    return vecReady;
  },
  get VEC_TABLE() {
    return VEC_TABLE;
  },
  syncHot,
  shouldBeHot,
  toQ8,
  annTouchUp,
  annTouchDel,
  needsTomb,
  nextVecSeq,
  get db() {
    return db;
  },
  get lastError() {
    return lastError;
  },
  set lastError(v) {
    lastError = v;
  },
});

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

bindMemoryAnn({
  open,
  DB_PATH,
  DIM,
  VEC_CHUNK,
  toBlob,
  setMeta,
  get VEC_TABLE() {
    return VEC_TABLE;
  },
  set VEC_TABLE(v) {
    VEC_TABLE = v;
  },
  get vecReady() {
    return vecReady;
  },
  get lastError() {
    return lastError;
  },
  set lastError(v) {
    lastError = v;
  },
});

export function closeDb() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}
