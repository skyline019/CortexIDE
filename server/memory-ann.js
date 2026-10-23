/**
 * ANN 二值量化索引、冷热分层、int8 精排侧表
 * 通过 bindMemoryAnn 注入 memory-store 运行时，避免环形依赖。
 */
import { createAnnIndex, packSign } from './ann.js';
import { AnnWriter, loadAnnFile, annFileInfo, deleteAnnFile, annDir } from './ann-store.js';

/** @type {any} */
let D = null;

export function bindMemoryAnn(runtime) {
  D = runtime;
}

/* ---------- 常量 ---------- */
export const ANN_MIN = Number(process.env.CORTEX_ANN_MIN || 20000);
export const ANN_CAND = Number(process.env.CORTEX_ANN_CAND || 256);
export const ANN_RERANK = Number(process.env.CORTEX_ANN_RERANK || 96);
export const HOT_MAX = Number(process.env.CORTEX_HOT_MAX || 2000);
export const HOT_SKIP_DIST = Number(process.env.CORTEX_HOT_SKIP || 0.11);
export const ANN_PERSIST = process.env.CORTEX_ANN_PERSIST !== '0';
export const HOT_MIN_USES = 2;

/* ---------- 模块状态 ---------- */
let sigVersion = 0;
const annCache = new Map();
export const tierStats = { hotQueries: 0, hotShortCircuit: 0, annQueries: 0, exactQueries: 0, annBuildMs: 0 };
const countCache = new Map();
export const hotCount = new Map();

const annSaveTimers = new Map();
const annFiles = new Map();
let annSaveStats = { saves: 0, full: 0, delta: 0, lastMs: 0, lastBytes: 0, lastMode: null, fails: 0 };

const fileState = (userId) => {
  let st = annFiles.get(userId);
  if (!st) {
    st = { writer: null, size: 0, dead: 0, dirty: new Set() };
    annFiles.set(userId, st);
  }
  return st;
};

const annPending = new Map();
const ANN_QUEUE_BYTES = 16 * 1024 * 1024;
const ANN_QUEUE_MAX = 50000;

const annWarm = new Map();
const annDiskState = new Map();

const annDirHint = () => annDir(D.DB_PATH);

/* ---------- 热点表 ---------- */

export function ensureHotTable() {
  const db = D.open();
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_hot USING vec0(user_id text partition key, embedding float[${D.DIM}] distance_metric=cosine, chunk_size=${D.VEC_CHUNK})`,
    );
    return true;
  } catch (err) {
    D.lastError = `建热点表失败（冷热分层关闭）：${err.message}`;
    return false;
  }
}

export function shouldBeHot(mem) {
  if (mem.pinned) return true;
  return (mem.uses || 0) >= HOT_MIN_USES;
}

export function syncHot(d, id, userId, vector, hot) {
  try {
    if (!hot) {
      const removed = d.prepare('delete from vec_hot where rowid = ?').run(BigInt(id)).changes;
      if (removed && hotCount.has(userId)) hotCount.set(userId, Math.max(0, hotCount.get(userId) - 1));
      return;
    }
    const existed = d.prepare('delete from vec_hot where rowid = ?').run(BigInt(id)).changes;
    d.prepare('insert into vec_hot(rowid, user_id, embedding) values (?,?,?)').run(BigInt(id), userId, D.toBlob(vector));
    let n = (hotCount.has(userId) ? hotCount.get(userId) : -1) + (existed ? 0 : 1);
    if (n < 0) {
      n = d.prepare('select count(*) c from vec_hot where user_id = ?').get(userId).c;
    }
    hotCount.set(userId, n);
    if (n > HOT_MAX) {
      const drop = n - HOT_MAX;
      d.prepare(
        `delete from vec_hot where rowid in (
           select v.rowid from vec_hot v join memories m on m.id = v.rowid
           where v.user_id = ? order by m.updated_at asc limit ${drop})`,
      ).run(userId);
      hotCount.set(userId, HOT_MAX);
    }
  } catch (err) {
    D.lastError = `热点表写入失败：${err.message}`;
  }
}

export function vecCountFor(d, userId) {
  const c = countCache.get(userId);
  if (c && c.version === sigVersion) return c.n;
  const n = d.prepare(`select count(*) c from ${D.VEC_TABLE} where user_id = ?`).get(userId).c;
  countCache.set(userId, { n, version: sigVersion });
  return n;
}

/* ---------- int8 侧表 ---------- */

export function ensureQ8() {
  const db = D.open();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS mem_q8 (id INTEGER PRIMARY KEY, scale REAL, norm REAL, q BLOB)`);
    return true;
  } catch (err) {
    D.lastError = `建 int8 侧表失败（精排退回 vec0）：${err.message}`;
    return false;
  }
}

export function toQ8(vector) {
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
    q[i] = v < -127 ? 128 : v;
    const d = v * scale;
    norm += d * d;
  }
  return { scale, norm: Math.sqrt(norm), q };
}

export function rerankQ8(d, ids, vector, userId, workspace) {
  const ph = ids.map(() => '?').join(',');
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
    return { uid, distance: 1 - sim, sim };
  });
  return scored.sort((a, b) => a.distance - b.distance);
}

function backfillSigs(userId) {
  const db = D.open();
  const missing = db.prepare(`select count(*) c from memories where user_id = ? and sig is null`).get(userId).c;
  if (!missing) return 0;
  const batch = db.prepare(
    `select m.id as id, v.embedding as embedding
     from memories m join ${D.VEC_TABLE} v on v.rowid = m.id
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
        if (f.length !== D.DIM) continue;
        upd.run(packSign(f), r.id);
        const q8 = toQ8(f);
        insQ.run(Number(r.id), q8.scale, q8.norm, q8.q);
        filled += 1;
      }
    })();
    if (rows.length < 2000) break;
  }
  if (filled) D.lastError = `已为 ${filled} 条老向量补算二值签名 / int8 侧表`;
  return filled;
}

/* ---------- vec_seq ---------- */

function currentVecSeq(d = D.open()) {
  const row = d.prepare("select value from meta where key = 'vec_seq'").get();
  return row ? Number(row.value) : 0;
}

export function nextVecSeq(d) {
  const next = currentVecSeq(d) + 1;
  d.prepare("insert into meta(key,value) values ('vec_seq',?) on conflict(key) do update set value=excluded.value").run(String(next));
  return next;
}

/* ---------- 索引落盘 ---------- */

export function needsTomb(userId) {
  if (!ANN_PERSIST) return false;
  const st = annFiles.get(userId);
  if (st && st.writer) return true;
  return Boolean(annFileInfo(D.DB_PATH, userId, D.DIM));
}

function flushAnn(userId, entry) {
  const e = entry || annCache.get(userId);
  if (!e || !ANN_PERSIST) return null;
  const st = fileState(userId);
  const index = e.index;

  if (!st.writer) {
    const opened = AnnWriter.open(D.DB_PATH, userId, D.DIM);
    if (opened) {
      st.writer = opened;
      st.size = 0;
    } else {
      st.writer = null;
    }
  }

  let res;
  const needFull = !st.writer || index.size > st.writer.capacity || index.size < st.size;
  if (needFull) {
    if (!st.writer) st.writer = AnnWriter.create(D.DB_PATH, userId, D.DIM, index.size);
    res = st.writer.writeFull({
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

function pruneTombstones(userId, seq) {
  if (!seq || !D.open()) return 0;
  try {
    const r = D.open().prepare('delete from vec_del where user_id = ? and seq <= ?').run(userId, seq);
    return r.changes || 0;
  } catch {
    return 0;
  }
}

function scheduleAnnSave(userId, entry, dirtyRows = null) {
  if (!ANN_PERSIST) return;
  const st = fileState(userId);
  if (dirtyRows) for (const r of dirtyRows) st.dirty.add(r);
  else if (entry) {
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

export function flushAnnSaves() {
  const out = [];
  for (const [userId, entry] of annCache) {
    if (annSaveTimers.has(userId)) {
      clearTimeout(annSaveTimers.get(userId));
      annSaveTimers.delete(userId);
    }
    if (annPending.has(userId) && entry) applyAnnPending(userId, entry);
    const st = annFiles.get(userId);
    const clean = st && !st.dirty.size && st.size === entry.index.size;
    if (clean) continue;
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
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    flushOnExit();
    process.exit(0);
  });
}

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

export function gcCaches({ rebuildVec = false, vacuum = true, keepIndex = false } = {}) {
  const d = D.open();
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
  if (D.vecReady) {
    try {
      const live = new Set(d.prepare('select id from memories').all().map((r) => Number(r.id)));
      const vecIds = d.prepare(`select rowid as id from ${D.VEC_TABLE}`).all().map((r) => Number(r.id));
      const del = d.prepare(`delete from ${D.VEC_TABLE} where rowid = ?`);
      d.transaction(() => {
        for (const id of vecIds) {
          if (!live.has(id)) {
            del.run(BigInt(id));
            orphans.vec += 1;
          }
        }
      })();
    } catch (err) {
      D.lastError = `清理孤儿向量失败：${err.message}`;
    }
  }

  let rebuiltVec = false;
  if (rebuildVec && D.vecReady) {
    const target = `${D.VEC_TABLE}_compact`;
    try {
      d.exec(`DROP TABLE IF EXISTS ${target}`);
      d.exec(`CREATE VIRTUAL TABLE ${target} USING vec0(user_id text partition key, embedding float[${D.DIM}] distance_metric=cosine)`);
      const page = d.prepare(`select rowid as id, user_id as uid, embedding as emb from ${D.VEC_TABLE} where rowid > ? order by rowid limit 2000`);
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
      const old = D.VEC_TABLE;
      d.exec(`DROP TABLE IF EXISTS ${old}`);
      D.VEC_TABLE = target;
      D.setMeta('vec_table', target);
      rebuiltVec = true;
    } catch (err) {
      D.lastError = `重建向量表失败（保留原表）：${err.message}`;
    }
  }

  if (!keepIndex) {
    for (const [userId] of [...annCache]) resetAnnIndex(userId);
  }

  const t0 = performance.now();
  if (vacuum) {
    try {
      d.pragma('wal_checkpoint(TRUNCATE)');
      d.exec('VACUUM');
    } catch (err) {
      D.lastError = `VACUUM 失败：${err.message}`;
    }
  }
  return { before, after: sizeOf(), orphans, rebuiltVec, vacuumMs: Math.round(performance.now() - t0) };
}

export function resetAnnIndex(userId) {
  annCache.delete(userId);
  annPending.delete(userId);
  annDiskState.delete(userId);
  const cached = annSaveTimers.get(userId);
  if (cached) clearTimeout(cached);
  annSaveTimers.delete(userId);
  annFiles.get(userId)?.writer?.close();
  annFiles.delete(userId);
  const tombs = pruneTombstones(userId, Number.MAX_SAFE_INTEGER);
  return { user: userId, fileRemoved: deleteAnnFile(D.DB_PATH, userId, D.DIM), tombsPruned: tombs };
}

/* ---------- 变更队列 ---------- */

function annQueue(userId) {
  let q = annPending.get(userId);
  if (!q) {
    q = { up: new Map(), del: new Set(), bytes: 0, maxSeq: 0 };
    annPending.set(userId, q);
  }
  if (q.up.size + q.del.size > ANN_QUEUE_MAX) {
    annPending.delete(userId);
    annCache.delete(userId);
    q = { up: new Map(), del: new Set(), bytes: 0, maxSeq: 0 };
    annPending.set(userId, q);
    D.lastError = `变更超过 ${ANN_QUEUE_MAX} 条，ANN 索引下次查询将整库重建`;
  }
  return q;
}

export function annTouchUp(userId, id, sig = null, isNew = false, seq = 0) {
  const q = annQueue(userId);
  const key = Number(id);
  const cached = sig && q.bytes + sig.length <= ANN_QUEUE_BYTES ? sig : null;
  if (cached) q.bytes += cached.length;
  q.up.set(key, cached);
  if (seq > q.maxSeq) q.maxSeq = seq;
  if (isNew) sigVersion += 1;
}

export function annTouchDel(userId, id, seq = 0) {
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

function applyAnnPending(userId, entry) {
  const q = annPending.get(userId);
  if (!q || (!q.up.size && !q.del.size)) return true;
  const index = entry.index;
  const dirtyRows = new Set();

  for (const id of q.del) {
    const row = index.rowOfId(Number(id));
    if (row >= 0) dirtyRows.add(row);
    index.remove(Number(id));
  }

  const needRead = [];
  for (const [id, sig] of q.up) {
    if (sig) {
      const row = index.rowOfId(Number(id));
      if (row >= 0) dirtyRows.add(row);
      if (!index.upsert(id, sig)) {
        D.lastError = 'ANN 增量失败（乱序插入），回退整库重建';
        return false;
      }
    } else {
      needRead.push(id);
    }
  }

  if (needRead.length) {
    const ids = needRead;
    const db = D.open();
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
          D.lastError = 'ANN 增量失败（乱序插入），回退整库重建';
          return false;
        }
      }
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
  scheduleAnnSave(userId, entry, dirtyRows);
  return true;
}

function tryLoadAnnFromDisk(userId) {
  if (!ANN_PERSIST) return null;
  const t0 = performance.now();
  const loaded = loadAnnFile(D.DB_PATH, userId, D.DIM);
  if (!loaded.ok) {
    annDiskState.set(userId, { fromFile: false, reason: loaded.reason });
    return null;
  }
  const index = createAnnIndex(D.DIM);
  index.restore(loaded);
  const seq0 = Number(loaded.seq) || 0;
  let ups = 0;
  let dels = 0;
  const dirtyRows = new Set();
  const db = D.open();
  try {
    const rows = db.prepare(`select id, sig from memories where user_id = ? and vec_seq > ? and sig is not null order by id`).all(userId, seq0);
    for (const r of rows) {
      const row = index.rowOfId(Number(r.id));
      if (row >= 0) dirtyRows.add(row);
      if (index.upsert(Number(r.id), r.sig)) ups += 1;
      else return null;
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
  const writer = AnnWriter.open(D.DB_PATH, userId, D.DIM);
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
  if (ups || dels) scheduleAnnSave(userId, entry, dirtyRows);
  return entry;
}

export function annIndexFor(userId) {
  const cached = annCache.get(userId);
  if (cached) {
    if (applyAnnPending(userId, cached)) {
      if (cached.index.staleRatio < 0.15) return cached;
      annCache.delete(userId);
    } else {
      annCache.delete(userId);
    }
  }
  const fromDisk = tryLoadAnnFromDisk(userId);
  if (fromDisk) return fromDisk;
  backfillSigs(userId);
  const db = D.open();
  const index = createAnnIndex(D.DIM);
  const t0 = performance.now();
  const total = db.prepare(`select count(*) c from memories where user_id = ? and sig is not null`).get(userId).c;
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
  annPending.delete(userId);
  annDiskState.set(userId, { fromFile: false, reason: '整库重建' });
  annFiles.get(userId)?.writer?.close();
  annFiles.delete(userId);
  scheduleAnnSave(userId, entry);
  return entry;
}

/* ---------- 后台预热 ---------- */

export function annWarmStatus(userId) {
  const st = annWarm.get(userId);
  if (st) return { warming: true, done: st.done, total: st.total, ms: Date.now() - st.startedAt };
  const cached = annCache.get(userId);
  return { warming: false, size: cached?.index?.size || 0, buildMs: cached?.index?.buildMs || 0 };
}

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
  const db = D.open();
  const total = db.prepare(`select count(*) c from memories where user_id = ? and sig is not null`).get(userId).c;
  if (!total) return { ready: false, reason: 'empty', total: 0 };
  if (total < ANN_MIN) return { ready: false, reason: 'below-threshold', total, annMin: ANN_MIN };

  const index = createAnnIndex(D.DIM);
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

/** stats() 用的 ANN 相关字段 */
export function annStatsSection() {
  const ann = [...annCache.entries()].map(([user, e]) => ({
    user,
    ...e.index.stats(),
    seq: e.seq || 0,
    persisted: e.persisted || null,
    disk: annDiskState.get(user) || null,
  }));
  return {
    ann,
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
        ...(annFileInfo(D.DB_PATH, u, D.DIM) || {}),
        covered: annFiles.get(u)?.size ?? null,
        capacity: annFiles.get(u)?.writer?.capacity ?? null,
        dirty: annFiles.get(u)?.dirty.size ?? 0,
      })),
    },
  };
}
