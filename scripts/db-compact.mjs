/**
 * 记忆库压缩：把 memory.db 重写成一份「行 id 连续、没有空洞」的新库。
 *
 * 为什么要它：vec0 是按 chunk（每 chunk 1024 行 × 512 维 = 2MB）预分配的，
 * 高频增删之后 rowid 变成稀疏分布，一个几万行的库删到只剩几十行，
 * 文件仍然占着十几 MB 的 chunk 空间。VACUUM 只能还 free page，收不回 chunk。
 * 重写一遍（id 从 1 连续编号）就能把这类空洞彻底消掉。
 *
 * 用法：
 *   node scripts/db-compact.mjs            # 只试算，打印前后体积
 *   node scripts/db-compact.mjs --apply    # 真替换（旧库留 .cortex/memory.db.bak）
 *   CORTEX_DB=xxx node scripts/db-compact.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');
const sqliteVec = req('sqlite-vec');

const APPLY = process.argv.includes('--apply');
const KEEP = process.argv.includes('--keep'); // 保留临时文件，便于排查体积
const SRC = path.resolve(process.env.CORTEX_DB || '.cortex/memory.db');
const TMP = `${SRC}.compact`;
const DIM = Number(process.env.EMBED_DIM || 512);
// vec0 的 chunk 是按分区预分配的：新库用更小的 chunk 可以立刻把「每个用户 2MB」的空洞收掉
const CHUNK = Number(process.env.CORTEX_VEC_CHUNK || 256);

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}`);
  process.exit(1);
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const srcSize = fs.statSync(SRC).size;

/* ---------- 1. 读源库 ---------- */
const src = new Database(SRC, { readonly: true });
sqliteVec.load(src);
const vecTable = (() => {
  const row = src.prepare("select value from meta where key = 'vec_table'").get();
  const name = row?.value || 'vec_memories';
  try {
    src.prepare(`select 1 from ${name} limit 1`).get();
    return name;
  } catch {
    return null;
  }
})();
const rows = src
  .prepare(
    `select id, uid, user_id, workspace, kind, text, tags, importance, uses, pinned, source,
            created_at, updated_at, last_used_at, hash, tokens, sig, vec, vec_seq
     from memories order by id`,
  )
  .all();
const users = src.prepare('select * from users').all();
const meta = src.prepare('select * from meta').all();
const hotIds = new Set((() => {
  try {
    return src.prepare('select rowid as id from vec_hot').all().map((r) => Number(r.id));
  } catch {
    return [];
  }
})());
const vecOf = new Map();
if (vecTable) {
  for (const v of src.prepare(`select rowid as id, embedding from ${vecTable}`).all()) {
    vecOf.set(Number(v.id), v.embedding);
  }
}
console.log(`源库 ${SRC} · ${mb(srcSize)} · ${rows.length} 条记忆 · 向量 ${vecOf.size} 条`);

/* ---------- 2. 建新库（schema 与运行时保持一致） ---------- */
for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) fs.rmSync(f, { force: true });
const dst = new Database(TMP);
sqliteVec.load(dst);
dst.pragma('journal_mode = WAL');
dst.pragma('synchronous = NORMAL');
dst.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, last_seen INTEGER);
  CREATE TABLE memories (
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
    tokens TEXT,
    sig BLOB,
    vec_seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX mem_scope ON memories(user_id, workspace);
  CREATE INDEX mem_uid ON memories(uid);
  CREATE INDEX mem_vec_seq ON memories(user_id, vec_seq);
  CREATE TABLE mem_q8 (id INTEGER PRIMARY KEY, scale REAL, norm REAL, q BLOB);
  CREATE TABLE vec_del (id INTEGER PRIMARY KEY, user_id TEXT, seq INTEGER);
  CREATE INDEX vec_del_seq ON vec_del(seq);
`);
dst.exec(
  `CREATE VIRTUAL TABLE ${vecTable || 'vec_memories'} USING vec0(user_id text partition key, embedding float[${DIM}] distance_metric=cosine, chunk_size=${CHUNK})`,
);
const vecName = vecTable || 'vec_memories';
dst.exec(
  `CREATE VIRTUAL TABLE vec_hot USING vec0(user_id text partition key, embedding float[${DIM}] distance_metric=cosine, chunk_size=${CHUNK})`,
);

// FTS：外部内容表 + 触发器（和运行时一致），先建表后建触发器 → 插入时自动进索引
dst.exec(`
  CREATE VIRTUAL TABLE memories_fts USING fts5(tokens, content='memories', content_rowid='id', tokenize='unicode61');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, tokens) VALUES (new.id, new.tokens);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, tokens) VALUES ('delete', old.id, old.tokens);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, tokens) VALUES ('delete', old.id, old.tokens);
    INSERT INTO memories_fts(rowid, tokens) VALUES (new.id, new.tokens);
  END;
`);

/* ---------- 3. 搬数据（id 连续编号） ---------- */
const insMem = dst.prepare(
  `insert into memories(id, uid, user_id, workspace, kind, text, tags, importance, uses, pinned, source,
     created_at, updated_at, last_used_at, hash, tokens, sig, vec, vec_seq) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);
const insVec = dst.prepare(`insert into ${vecName}(rowid, user_id, embedding) values (?,?,?)`);
const insHot = dst.prepare('insert into vec_hot(rowid, user_id, embedding) values (?,?,?)');
const insQ8 = dst.prepare('insert into mem_q8(id, scale, norm, q) values (?,?,?,?)');
const srcQ8 = src.prepare('select scale, norm, q from mem_q8 where id = ?');
const insUser = dst.prepare('insert into users(id, name, created_at, last_seen) values (?,?,?,?)');
const insMeta = dst.prepare('insert into meta(key, value) values (?,?)');

let mapped = 0;
let hot = 0;
dst.transaction(() => {
  for (const u of users) insUser.run(u.id, u.name, u.created_at, u.last_seen);
  for (const m of meta) insMeta.run(m.key, m.value);
  let nextId = 0;
  for (const r of rows) {
    nextId += 1;
    insMem.run(
      nextId, r.uid, r.user_id, r.workspace, r.kind, r.text, r.tags, r.importance, r.uses, r.pinned,
      r.source, r.created_at, r.updated_at, r.last_used_at, r.hash, r.tokens, r.sig, r.vec, r.vec_seq || 0,
    );
    const emb = vecOf.get(Number(r.id));
    if (emb) {
      insVec.run(BigInt(nextId), r.user_id, emb);
      mapped += 1;
      if (hotIds.has(Number(r.id))) {
        insHot.run(BigInt(nextId), r.user_id, emb);
        hot += 1;
      }
    }
    const q8 = srcQ8.get(Number(r.id));
    if (q8) insQ8.run(nextId, q8.scale, q8.norm, q8.q);
  }
  // 索引水位重置为「全部已反映」：新库就是全量的快照
  const seq = Number(meta.find((m) => m.key === 'vec_seq')?.value || 0);
  dst.prepare("insert into meta(key,value) values ('vec_seq',?) on conflict(key) do update set value=excluded.value").run(String(seq));
})();

dst.pragma('wal_checkpoint(TRUNCATE)');
dst.exec('VACUUM');
dst.close();
src.close();

/* ---------- 4. 校验 ---------- */
const chk = new Database(TMP, { readonly: true });
sqliteVec.load(chk);
const counts = {
  memories: chk.prepare('select count(*) c from memories').get().c,
  vec: chk.prepare(`select count(*) c from ${vecName}`).get().c,
  fts: chk.prepare('select count(*) c from memories_fts').get().c,
  q8: chk.prepare('select count(*) c from mem_q8').get().c,
  hot: chk.prepare('select count(*) c from vec_hot').get().c,
};
chk.close();
const dstSize = fs.statSync(TMP).size;
console.log(
  `新库 ${mb(dstSize)}（-${mb(srcSize - dstSize)}，chunk_size=${CHUNK}）· memories ${counts.memories} · vec ${counts.vec} · fts ${counts.fts} · int8 ${counts.q8} · 热表 ${counts.hot}` +
    ` · 映射向量 ${mapped} / 热表 ${hot}`,
);
if (counts.memories !== rows.length || counts.vec !== vecOf.size) {
  console.error('校验失败：条数对不上，放弃替换');
  fs.rmSync(TMP, { force: true });
  process.exit(1);
}

/* ---------- 5. 替换 ---------- */
if (!APPLY) {
  console.log(`试算完成。要真替换：node scripts/db-compact.mjs --apply（临时文件 ${TMP}${KEEP ? ' 已保留' : ' 已删'}）`);
  if (!KEEP) fs.rmSync(TMP, { force: true });
} else {
  const bak = `${SRC}.bak`;
  for (const f of [`${SRC}-wal`, `${SRC}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(bak, { force: true });
  fs.renameSync(SRC, bak);
  fs.renameSync(TMP, SRC);
  console.log(`已替换：旧库留在 ${bak}（${mb(srcSize)}），新库 ${mb(dstSize)}。索引缓存会在下次查询时重建。`);
}
