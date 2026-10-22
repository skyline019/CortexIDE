/**
 * 按工作区持久化多会话：localStorage + `.cortex/sessions/store.json`
 */

import { fsClient } from './fsClient.js';

const LS_PREFIX = 'cortex-chats:v2:';
const FILE_PATH = '.cortex/sessions/store.json';
const MAX_MESSAGES = 200;
const MAX_SESSIONS = 40;

function hashRoot(root) {
  const s = String(root || '').replace(/[/\\]+$/, '').toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function chatStorageKey(root) {
  return LS_PREFIX + hashRoot(root || '_none');
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_MESSAGES).map((m) => {
    if (!m || typeof m !== 'object') return m;
    const { pending, ...rest } = m;
    void pending;
    return { ...rest, pending: false };
  });
}

export function makeSession({ id, title, messages } = {}) {
  const now = Date.now();
  return {
    id: id || `ses_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: title || '新会话',
    messages: sanitizeMessages(messages || []),
    createdAt: now,
    updatedAt: now,
    tokenUsage: { prompt: 0, completion: 0, turns: 0 },
  };
}

export function titleFromMessages(messages) {
  const first = (messages || []).find((m) => m.role === 'user' && String(m.content || '').trim());
  if (!first) return '新会话';
  const t = String(first.content).replace(/\s+/g, ' ').trim();
  return t.length > 36 ? `${t.slice(0, 36)}…` : t;
}

function normalizeStore(raw, root) {
  if (!raw || typeof raw !== 'object') {
    const s = makeSession();
    return { version: 2, root, activeSessionId: s.id, sessions: [s] };
  }
  // v1：只有 messages
  if (Array.isArray(raw.messages) && !raw.sessions) {
    const s = makeSession({
      title: titleFromMessages(raw.messages),
      messages: raw.messages,
    });
    return { version: 2, root, activeSessionId: s.id, sessions: [s] };
  }
  let sessions = Array.isArray(raw.sessions)
    ? raw.sessions.map((s) => ({
        ...makeSession(),
        ...s,
        messages: sanitizeMessages(s.messages),
        tokenUsage: s.tokenUsage || { prompt: 0, completion: 0, turns: 0 },
      }))
    : [];
  if (!sessions.length) sessions = [makeSession()];
  sessions = sessions.slice(-MAX_SESSIONS);
  let activeSessionId = raw.activeSessionId;
  if (!sessions.some((s) => s.id === activeSessionId)) activeSessionId = sessions[sessions.length - 1].id;
  return { version: 2, root, activeSessionId, sessions };
}

export function loadChatStoreFromLocal(root) {
  if (!root) return null;
  try {
    const raw = localStorage.getItem(chatStorageKey(root));
    if (!raw) return null;
    return normalizeStore(JSON.parse(raw), root);
  } catch {
    return null;
  }
}

export function saveChatStoreToLocal(root, store) {
  if (!root || !store) return;
  try {
    localStorage.setItem(chatStorageKey(root), JSON.stringify({ ...store, root, savedAt: Date.now() }));
  } catch (err) {
    console.warn('[cortex] 会话 localStorage 写入失败', err);
  }
}

export async function saveChatStoreToWorkspace(root, store) {
  if (!root || !store) return false;
  const normalized = normalizeStore(store, root);
  saveChatStoreToLocal(root, normalized);
  try {
    await fsClient.mkdir('.cortex');
    await fsClient.mkdir('.cortex/sessions');
    await fsClient.write(FILE_PATH, JSON.stringify({ ...normalized, savedAt: Date.now() }, null, 2));
    return true;
  } catch (err) {
    console.warn('[cortex] 会话写入 .cortex/sessions 失败', err?.message || err);
    return false;
  }
}

export async function loadChatStoreForWorkspace(root) {
  if (!root) {
    const s = makeSession();
    return { version: 2, root: '', activeSessionId: s.id, sessions: [s] };
  }
  try {
    const file = await fsClient.read(FILE_PATH);
    if (file?.content) {
      const store = normalizeStore(JSON.parse(file.content), root);
      saveChatStoreToLocal(root, store);
      return store;
    }
  } catch {
    /* 无文件 */
  }
  const local = loadChatStoreFromLocal(root);
  if (local) return local;
  // 兼容旧版单文件 chat.json
  try {
    const legacy = await fsClient.read('.cortex/sessions/chat.json');
    if (legacy?.content) {
      const data = JSON.parse(legacy.content);
      if (Array.isArray(data?.messages)) {
        return normalizeStore({ messages: data.messages }, root);
      }
    }
  } catch {
    /* ignore */
  }
  return normalizeStore(null, root);
}

/** @deprecated 兼容旧调用：存当前 messages 为单会话 */
export function saveChatToLocal(root, messages) {
  const prev = loadChatStoreFromLocal(root);
  const store = prev || normalizeStore(null, root);
  const sid = store.activeSessionId;
  store.sessions = store.sessions.map((s) =>
    s.id === sid
      ? { ...s, messages: sanitizeMessages(messages), updatedAt: Date.now(), title: s.title === '新会话' ? titleFromMessages(messages) : s.title }
      : s,
  );
  saveChatStoreToLocal(root, store);
}

export async function saveChatToWorkspace(root, messages) {
  const prev = (await loadChatStoreForWorkspace(root).catch(() => null)) || normalizeStore(null, root);
  const sid = prev.activeSessionId;
  const next = {
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === sid
        ? {
            ...s,
            messages: sanitizeMessages(messages),
            updatedAt: Date.now(),
            title: !s.title || s.title === '新会话' ? titleFromMessages(messages) : s.title,
          }
        : s,
    ),
  };
  return saveChatStoreToWorkspace(root, next);
}

export async function loadChatForWorkspace(root) {
  const store = await loadChatStoreForWorkspace(root);
  const cur = store.sessions.find((s) => s.id === store.activeSessionId) || store.sessions[0];
  return cur?.messages || [];
}

export { sanitizeMessages, normalizeStore, MAX_SESSIONS };
