/**
 * 记忆库 schema / 迁移：vec0 分区、cosine 度量、FTS5、meta 列
 * 通过 bindMemoryMigrate 注入 memory-store 运行时，避免环形依赖。
 */
import { tokensOf } from './text-index.js';

/** @type {any} */
let D = null;

export function bindMemoryMigrate(runtime) {
  D = runtime;
}

/** 建分区向量表；同名建不出来（旧库残留 shadow table）就自动换名 */
export function ensureVecTable() {
  const db = D.open();
  const candidates = [getMeta('vec_table') || 'vec_memories', 'vec_memories_v2', 'vec_memories_v3'];
  for (const name of candidates) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(user_id text partition key, embedding float[${D.DIM}] distance_metric=cosine, chunk_size=${D.VEC_CHUNK})`,
      );
      D.VEC_TABLE = name;
      setMeta('vec_table', name);
      setMeta('dim', String(D.DIM));
      return true;
    } catch (err) {
      D.lastError = `创建 ${name} 失败：${err.message}`;
    }
  }
  D.vecReady = false;
  return false;
}

/** 向量表是不是分区结构？ */
export function vecTablePartitioned(name) {
  const db = D.open();
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
export function migrateVecCosine() {
  const db = D.open();
  let ddl = '';
  try {
    ddl = db.prepare('select sql from sqlite_master where name = ?').get(D.VEC_TABLE)?.sql || '';
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
      `CREATE VIRTUAL TABLE ${target} USING vec0(user_id text partition key, embedding float[${D.DIM}] distance_metric=cosine, chunk_size=${D.VEC_CHUNK})`,
    );
  } catch (err) {
    D.lastError = `cosine 距离表建不出来，继续用 L2（相似度会偏低）：${err.message}`;
    return;
  }

  const page = db.prepare(`select rowid as id, user_id as uid, embedding as emb from ${D.VEC_TABLE} where rowid > ? order by rowid limit 2000`);
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

  const old = D.VEC_TABLE;
  try {
    db.exec(`DROP TABLE IF EXISTS ${old}`);
  } catch {
    /* 旧表删不掉就留着，反正已经切到新表 */
  }
  D.VEC_TABLE = target;
  setMeta('vec_table', target);
  setMeta('vec_schema', 'v3-cosine');
  // 热点表按新度量重建（只是缓存，不搬数据）
  try {
    db.exec('DROP TABLE IF EXISTS vec_hot');
  } catch {
    /* ignore */
  }
  D.hotCount.clear();
  D.lastError = `已把 ${n} 条向量迁到 cosine 距离表（${target}）`;
}

/**
 * 老库迁移：v0.4 的 vec0 表没有分区键（KNN 要扫全表再 JOIN 过滤）。
 *
 *   读旧表向量 → DROP（虚拟表会连 shadow table 一起带走）→
 *   重建 `vec0(user_id text partition key, embedding float[DIM])` → 回填
 *
 * 如果同名重建失败（旧库残留 shadow table），自动换名 vec_memories_v2 继续。
 */
export function migrateVecPartition() {
  const db = D.open();
  try {
    if (vecTablePartitioned(D.VEC_TABLE)) {
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
        D.lastError = `读取旧向量表 ${name} 失败：${err.message}`;
      }
    }

    for (const name of legacies) {
      try {
        db.exec(`DROP TABLE IF EXISTS ${name}`);
      } catch (err) {
        D.lastError = `删除旧向量表 ${name} 失败：${err.message}`;
      }
    }

    // 重建（换名兜底）
    let created = false;
    for (const name of ['vec_memories', 'vec_memories_v2', 'vec_memories_v3']) {
      try {
        db.exec(
          `CREATE VIRTUAL TABLE ${name} USING vec0(user_id text partition key, embedding float[${D.DIM}] distance_metric=cosine, chunk_size=${D.VEC_CHUNK})`,
        );
        D.VEC_TABLE = name;
        setMeta('vec_table', name);
        created = true;
        break;
      } catch (err) {
        D.lastError = `创建分区表 ${name} 失败：${err.message}`;
      }
    }
    if (!created) {
      D.vecReady = false;
      return;
    }

    if (rows.length) {
      const ins = db.prepare(`insert into ${D.VEC_TABLE}(rowid, user_id, embedding) values (?,?,?)`);
      db.transaction(() => {
        for (const r of rows) ins.run(BigInt(r.id), r.uid, r.emb);
      })();
      D.lastError = `已迁移 ${rows.length} 条向量到分区索引（${D.VEC_TABLE}）`;
    }
    setMeta('vec_schema', 'v2-partition');
  } catch (err) {
    D.lastError = `分区索引迁移失败（回落到全表 KNN）：${err.message}`;
  }
}

/** FTS5 稀疏索引（外部内容表 + 触发器），tokens 由统一的 tokenize() 生成 */
export function setupFts() {
  const db = D.open();
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
    D.ftsReady = true;
  } catch (err) {
    D.ftsReady = false;
    D.lastError = `FTS5 不可用（BM25 关闭）：${err.message}`;
  }
}

export function backfillTokens() {
  const db = D.open();
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

export function ensureColumn(table, column, decl) {
  const db = D.open();
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      if (column === 'tokens') setMeta('fts_ready', '0');
    }
  } catch (err) {
    D.lastError = `补列 ${table}.${column} 失败：${err.message}`;
  }
}

export function getMeta(key) {
  try {
    return D.open().prepare('select value from meta where key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

export function setMeta(key, value) {
  D.open().prepare('insert into meta(key,value) values (?,?) on conflict(key) do update set value=excluded.value').run(key, String(value));
}
