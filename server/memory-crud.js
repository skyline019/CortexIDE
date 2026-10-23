/**
 * 记忆库 CRUD / 同步：用户、增量 sync、列表、删除、导出
 * 通过 bindMemoryCrud 注入 memory-store 运行时，避免环形依赖。
 */
import { tokensOf } from './text-index.js';
import { packSign } from './ann.js';

/** @type {any} */
let D = null;

export function bindMemoryCrud(runtime) {
  D = runtime;
}

/* ------------------------------------------------------------------ */
/* 用户                                                                */
/* ------------------------------------------------------------------ */

export function touchUser(id, name) {
  const d = D.open();
  const now = Date.now();
  d.prepare(
    `insert into users(id, name, created_at, last_seen) values (?,?,?,?)
     on conflict(id) do update set last_seen = excluded.last_seen, name = coalesce(excluded.name, users.name)`,
  ).run(id, name || id, now, now);
  return { id, name: name || id };
}

export function listUsers() {
  const d = D.open();
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
    const sigBuf = mem.vector && mem.vector.length === D.DIM ? packSign(mem.vector) : null;
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
      D.keepBlob() && mem.vector ? D.toBlob(mem.vector) : null,
      tokensOf(mem.text, mem.tags),
      sigBuf,
      mem.vector ? seq : 0,
      existing.id,
    );
    if (D.vecReady && mem.vector) {
      D.annTouchUp(userId, existing.id, sigBuf, false, seq);
      d.prepare(`delete from ${D.VEC_TABLE} where rowid = ?`).run(BigInt(existing.id));
      d.prepare(`insert or replace into ${D.VEC_TABLE}(rowid, user_id, embedding) values (?,?,?)`).run(
        BigInt(existing.id),
        userId,
        D.toBlob(mem.vector),
      );
      D.syncHot(d, existing.id, userId, mem.vector, D.shouldBeHot({ ...mem, uses: mem.uses ?? 0 }));
      const q8 = D.toQ8(mem.vector);
      d.prepare('insert or replace into mem_q8(id, scale, norm, q) values (?,?,?,?)').run(
        Number(existing.id),
        q8.scale,
        q8.norm,
        q8.q,
      );
    }
    return { id: existing.id, uid: mem.uid, changed: true };
  }

  const sigBuf = mem.vector && mem.vector.length === D.DIM ? packSign(mem.vector) : null;
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
      D.keepBlob() && mem.vector ? D.toBlob(mem.vector) : null,
      tokensOf(mem.text, mem.tags),
      sigBuf,
      mem.vector ? seq : 0,
    );
  const id = info.lastInsertRowid;
  if (D.vecReady && mem.vector) {
    D.annTouchUp(userId, id, sigBuf, true, seq);
    d.prepare(`insert or replace into ${D.VEC_TABLE}(rowid, user_id, embedding) values (?,?,?)`).run(BigInt(id), userId, D.toBlob(mem.vector));
    D.syncHot(d, id, userId, mem.vector, D.shouldBeHot(mem));
    const q8 = D.toQ8(mem.vector);
    d.prepare('insert or replace into mem_q8(id, scale, norm, q) values (?,?,?,?)').run(Number(id), q8.scale, q8.norm, q8.q);
  }
  return { id, uid: mem.uid, changed: true, created: true };
}

/**
 * 增量同步一批记忆
 * @param {{userId:string, workspace:string, items:any[], deleted?:string[]}} payload
 */
export function syncMemories({ userId, workspace, items = [], deleted = [] }) {
  const d = D.open();
  touchUser(userId);
  const needTomb = deleted.length ? D.needsTomb(userId) : false;
  const tx = d.transaction(() => {
    const saved = [];
    let vectorized = 0;
    const seq = items.some((m) => m.vector) || deleted.length ? D.nextVecSeq(d) : 0;
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
      if (D.vecReady) d.prepare(`delete from ${D.VEC_TABLE} where rowid = ?`).run(BigInt(row.id));
      // int8 侧表与热点表也要一起删，否则每次删除都留一份 512 字节的孤儿（实测漏了几万行、白占 25MB）
      try {
        d.prepare('delete from mem_q8 where id = ?').run(Number(row.id));
        d.prepare('delete from vec_hot where rowid = ?').run(BigInt(row.id));
      } catch {
        /* 表还没建 */
      }
      if (needTomb) d.prepare('insert or replace into vec_del(id, user_id, seq) values (?,?,?)').run(Number(row.id), userId, seq);
      D.annTouchDel(userId, row.id, seq);
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
    backend: D.vecReady ? 'sqlite-vec' : 'sqlite-blob',
    dim: D.DIM,
    scope: { userId, workspace },
  };
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 导出全部用户/工作区的记忆（含向量），用于 sqlite → pgvector 迁移 */
export function exportAllMemories() {
  if (!D.db) return [];
  const rows = D.db
    .prepare(
      `select user_id, workspace, uid, text, tags, kind, importance, created_at, updated_at, vec
       from memories where user_id is not null order by id asc`,
    )
    .all();
  // 向量优先从分区 vec0 表读（平时 BLOB 列为了省空间是空的）
  let vecMap = new Map();
  if (D.vecReady) {
    try {
      for (const v of D.db.prepare(`select rowid as id, embedding from ${D.VEC_TABLE}`).all()) {
        if (!v.embedding) continue;
        const b = v.embedding;
        vecMap.set(Number(v.id), Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)));
      }
    } catch (err) {
      D.lastError = `导出向量失败（将只导文本）：${err.message}`;
    }
  }
  const byId = D.db.prepare('select id, user_id, workspace, uid from memories').all();
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
  const d = D.open();
  const rows = d
    .prepare(
      `select uid, kind, text, tags, importance, uses, pinned, source, created_at, updated_at, last_used_at
       from memories where user_id = ? and workspace = ? order by updated_at desc`,
    )
    .all(userId, workspace);
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]'), pinned: Boolean(r.pinned) }));
}

export function deleteMemory(userId, uid) {
  const d = D.open();
  const row = d.prepare('select id from memories where uid = ? and user_id = ?').get(uid, userId);
  if (!row) return false;
  const id = Number(row.id);
  // 和批量同步里的删除走完全一样的清理：主表 + 向量表 + 两张侧表 + 墓碑
  // （早先这个函数只删主表和向量表，导致 ANN 索引不知道有条被删了：
  //   要么继续返回已删的记忆，要么落盘时条数对不上被迫整库重建）
  const seq = D.nextVecSeq(d);
  const needTomb = D.needsTomb(userId);
  d.transaction(() => {
    d.prepare('delete from memories where id = ?').run(id);
    if (D.vecReady) d.prepare(`delete from ${D.VEC_TABLE} where rowid = ?`).run(BigInt(id));
    try {
      d.prepare('delete from mem_q8 where id = ?').run(id);
      d.prepare('delete from vec_hot where rowid = ?').run(BigInt(id));
    } catch {
      /* 表还没建 */
    }
    if (needTomb) d.prepare('insert or replace into vec_del(id, user_id, seq) values (?,?,?)').run(id, userId, seq);
  })();
  D.annTouchDel(userId, id, seq);
  return true;
}
