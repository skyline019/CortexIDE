/**
 * 服务端记忆库客户端（sqlite-vec / pgvector）
 *
 * - 身份：settings.userId（默认 local），所有请求带 x-cortex-user / x-cortex-workspace
 * - 公网鉴权：一并带 Authorization（见 apiAuth.js）；仅靠 x-cortex-user 不够
 * - 同步：把本地记忆（含 512 维向量）增量推给服务端，服务端负责持久化与 KNN
 * - 检索：优先走服务端 KNN（百万级也稳），不可用时回落到浏览器内索引
 */
import { apiHeaders, setApiAuth } from './apiAuth.js';

let userId = 'local';
let workspace = '';
let available = null; // null | true | false
let status = null;
let syncTimer = null;
let pendingItems = new Map();
let pendingDeleted = new Set();
let onSyncState = null;
let lastSync = { at: 0, pushed: 0, ms: 0, error: null };

export function configureBackend({ user, ws, token } = {}) {
  if (user) userId = user;
  if (ws !== undefined) workspace = ws;
  setApiAuth({ user: userId, workspace, ...(token !== undefined ? { token } : {}) });
}

export function setSyncListener(fn) {
  onSyncState = fn;
}

const headers = () =>
  apiHeaders({
    'Content-Type': 'application/json',
    'x-cortex-user': userId,
    'x-cortex-workspace': workspace || '',
  });

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/mem/${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export function getBackendState() {
  return { available, status, userId, workspace, lastSync };
}

export async function probeBackend() {
  try {
    const res = await fetch('/api/mem/status', { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = await res.json();
    available = true;
  } catch {
    available = false;
    status = null;
  }
  return { available, status };
}

export async function listUsers() {
  const res = await call('users');
  return res.users || [];
}

export async function createUser(id, name) {
  const res = await call('users', { method: 'POST', body: { id, name } });
  return res.users || [];
}

export async function pullMemories() {
  const res = await call('list');
  return res.memories || [];
}

/**
 * 服务端混合检索（向量 + BM25 → RRF）
 * @returns {{hits:Array, backend:string, mode:string, tookMs:number}|null}
 */
export async function searchServer(vector, k = 8, query = '', mode = 'hybrid') {
  if (!available) return null;
  try {
    const res = await call('search', {
      method: 'POST',
      body: { vector: vector ? Array.from(vector) : [], k, query, mode },
    });
    return {
      hits: res.hits || [],
      backend: res.backend,
      mode: res.mode,
      tookMs: res.tookMs,
      vecHits: res.vecHits,
      bmHits: res.bmHits,
      vecMs: res.vecMs,
      bm25Ms: res.bm25Ms,
    };
  } catch {
    return null;
  }
}

function scheduleFlush() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flush, 700);
}

/** 入队一条待同步记忆（需带 vector 与 hash） */
export function queueMemory(mem, vector, hash) {
  if (!available) return;
  pendingItems.set(mem.uid || mem.id, {
    uid: mem.uid || mem.id,
    kind: mem.kind,
    text: mem.text,
    tags: mem.tags || [],
    importance: mem.importance,
    uses: mem.uses || 0,
    pinned: Boolean(mem.pinned),
    source: mem.source || 'sync',
    createdAt: mem.createdAt,
    updatedAt: mem.updatedAt,
    lastUsedAt: mem.lastUsedAt || 0,
    hash,
    vector: vector ? Array.from(vector) : undefined,
  });
  scheduleFlush();
}

export function queueDelete(uid) {
  if (!available) return;
  pendingItems.delete(uid);
  pendingDeleted.add(uid);
  scheduleFlush();
}

export async function flush() {
  if (!available || (!pendingItems.size && !pendingDeleted.size)) return;
  const items = [...pendingItems.values()];
  const deleted = [...pendingDeleted];
  pendingItems = new Map();
  pendingDeleted = new Set();
  const t0 = performance.now();
  try {
    await call('sync', { method: 'POST', body: { items, deleted } });
    lastSync = { at: Date.now(), pushed: items.length + deleted.length, ms: Math.round(performance.now() - t0), error: null };
  } catch (err) {
    lastSync = { ...lastSync, error: err.message };
    // 失败回填，下次再试
    for (const it of items) pendingItems.set(it.uid, it);
    for (const d of deleted) pendingDeleted.add(d);
  }
  onSyncState?.({ ...lastSync, pending: pendingItems.size + pendingDeleted.size });
}

/** 立即全量同步（用于首次接入 / 用户切换） */
export async function pushAll(entries) {
  if (!available) return { pushed: 0 };
  let pushed = 0;
  for (const e of entries) {
    pendingItems.set(e.uid, e);
    pushed++;
  }
  await flush();
  return { pushed };
}

export async function deleteOnServer(uid) {
  if (!available) return;
  try {
    await call('delete', { method: 'POST', body: { uid } });
  } catch {
    /* ignore */
  }
}

/* ---------------- 记忆后端（sqlite ⇄ pgvector）---------------- */

export async function probeBackends() {
  try {
    const res = await fetch('/api/mem/backend', { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { memoryBackend: 'unknown', error: err.message };
  }
}

export async function switchBackend(backend) {
  const res = await fetch('/api/mem/backend', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ backend }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  await probeBackend();
  return json;
}

/** sqlite → pgvector 全量搬迁（含向量） */
export async function migrateToPg() {
  const res = await fetch('/api/mem/migrate', { method: 'POST', headers: headers(), body: '{}' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
