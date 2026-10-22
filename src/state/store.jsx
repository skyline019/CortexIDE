import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { seedFiles, langOf, baseName } from '../lib/vfs.js';
import { seedMemories } from '../lib/memory.js';
import { installFetchAuth, setApiAuth } from '../lib/apiAuth.js';
import { saveChatStoreToWorkspace, makeSession } from '../lib/chatSession.js';
import { reduceFilesTabs } from './reducers/filesTabs.js';
import { reduceWorkspace } from './reducers/workspace.js';
import { reduceChat, sealChatForPersist } from './reducers/chat.js';
import { createOps } from './createOps.js';

installFetchAuth();

const STORAGE_KEY = 'cortex-ide:v1';

function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const SCHEMA_VERSION = 4;

const DEFAULT_SETTINGS = {
  mode: 'api', // api | local
  provider: 'server', // server（服务端注入 Key）| custom（自填 Key / Base URL）
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-flash',
  temperature: 0.3,
  maxToolRounds: 8,
  autoMemory: true, // 从对话里自动蒸馏记忆
  autoSessionSummary: true,
  topK: 6,
  chatWidth: 424,
  embedProvider: 'auto', // auto | neural | lexical
  userId: 'local',
  execAutoApprove: false, // 命令执行是否需要人工确认
  retrievalMode: 'hybrid', // hybrid | vector | bm25
  agentMode: 'agent', // agent | ask | plan（plan 产出可构建的计划）
  accessToken: '', // 公网鉴权：对应服务端 CORTEX_AUTH_TOKEN / CORTEX_AUTH_TOKENS
};

function defaultState() {
  const files = seedFiles();
  return {
    version: SCHEMA_VERSION,
    workspace: {
      mode: 'real', // real = 服务端真实目录 | virtual = 浏览器沙盒
      root: '',
      name: '',
      connected: false,
      entries: [],
      loading: false,
      error: null,
      depth: 2,
    },
    files,
    activeFileId: files[1].id,
    openTabs: [files[1].id, files[0].id],
    messages: [], // 投影：始终等于 activeSession.messages
    chatSessions: [],
    activeSessionId: null,
    memories: seedMemories(),
    memoriesByUser: {},
    backend: { available: null, status: null, users: [], syncing: false, lastSync: null },
    approvals: [], // 待人工确认的命令
    execLog: [], // 本会话执行过的命令
    sessions: [], // 归档情节摘要（侧栏旧「情节记忆」）
    settings: { ...DEFAULT_SETTINGS },
    stats: {
      retrievals: 0,
      hits: 0,
      tokensSaved: 0,
      turns: 0,
      memoryWrites: 0,
      promptTokens: 0,
      completionTokens: 0,
      createdAt: Date.now(),
    },
    lastSavedAt: 0,
  };
}

function hydrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  // v1 -> v2：早期版本默认本地引擎，接入真实模型后默认切到 API 模式
  const migrated = raw.version === 1;
  return {
    ...base,
    ...raw,
    workspace: {
      ...base.workspace,
      mode: raw.workspace?.mode === 'virtual' ? 'virtual' : 'real',
      root: raw.workspace?.root || '',
    },
    settings: {
      ...DEFAULT_SETTINGS,
      ...(raw.settings || {}),
      ...(migrated ? { mode: 'api', provider: 'server', model: raw.settings?.model || 'deepseek-chat' } : {}),
    },
    stats: { ...base.stats, ...(raw.stats || {}) },
    files: Array.isArray(raw.files) && raw.files.length ? raw.files : base.files,
    memoriesByUser:
      raw.memoriesByUser && typeof raw.memoriesByUser === 'object'
        ? raw.memoriesByUser
        : Array.isArray(raw.memories)
          ? { local: raw.memories }
          : {},
    memories:
      (raw.memoriesByUser && raw.memoriesByUser[raw.settings?.userId || 'local']) ||
      (Array.isArray(raw.memories) ? raw.memories : base.memories),
    chatSessions: Array.isArray(raw.chatSessions) ? raw.chatSessions : [],
    activeSessionId: raw.activeSessionId || null,
    // 兼容旧版：仅有 messages、无 chatSessions 时收成单会话
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    version: SCHEMA_VERSION,
  };
}

/** 启动时把旧双轨数据收敛为单一会话源 */
function coerceChatSource(state) {
  let sessions = Array.isArray(state.chatSessions) ? state.chatSessions : [];
  if (!sessions.length && Array.isArray(state.messages) && state.messages.length) {
    const s = makeSession({ messages: state.messages });
    return { ...state, chatSessions: [s], activeSessionId: s.id, messages: s.messages };
  }
  if (!sessions.length) {
    const s = makeSession();
    return { ...state, chatSessions: [s], activeSessionId: s.id, messages: [] };
  }
  const activeId =
    state.activeSessionId && sessions.some((x) => x.id === state.activeSessionId)
      ? state.activeSessionId
      : sessions[sessions.length - 1].id;
  const cur = sessions.find((x) => x.id === activeId) || sessions[0];
  return {
    ...state,
    chatSessions: sessions,
    activeSessionId: activeId,
    messages: Array.isArray(cur.messages) ? cur.messages : [],
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return coerceChatSource(defaultState());
    return coerceChatSource(hydrate(JSON.parse(raw)));
  } catch (err) {
    console.warn('[cortex] 读取持久化状态失败，回退到默认状态', err);
    return coerceChatSource(defaultState());
  }
}

export function persistState(state) {
  const sealed = sealChatForPersist(state);
  const payload = {
    version: SCHEMA_VERSION,
    workspace: { mode: state.workspace.mode, root: state.workspace.root },
    files: state.files.slice(-24),
    activeFileId: state.activeFileId,
    openTabs: state.openTabs,
    // 单一数据源：只持久化 chatSessions；messages 仅作启动兼容投影
    messages: sealed.messages,
    chatSessions: sealed.chatSessions,
    activeSessionId: sealed.activeSessionId,
    memories: state.memories,
    memoriesByUser: { ...(state.memoriesByUser || {}), [state.settings.userId || 'local']: state.memories },
    sessions: state.sessions.slice(-30),
    settings: state.settings,
    stats: state.stats,
    lastSavedAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

function reduceRest(state, action) {
  switch (action.type) {
    /* ---------------- 记忆 ---------------- */
    case 'mem/set':
      return { ...state, memories: action.memories };
    case 'mem/update':
      return {
        ...state,
        memories: state.memories.map((m) => (m.id === action.id ? { ...m, ...action.patch, updatedAt: Date.now() } : m)),
      };
    case 'mem/delete':
      return { ...state, memories: state.memories.filter((m) => m.id !== action.id) };
    case 'mem/touch': {
      const ids = new Set(action.ids || []);
      if (!ids.size) return state;
      return {
        ...state,
        memories: state.memories.map((m) =>
          ids.has(m.id) ? { ...m, uses: (m.uses || 0) + 1, lastUsedAt: Date.now() } : m,
        ),
      };
    }

    /* ---------------- 设置 / 统计 / 会话 ---------------- */
    case 'mem/switchUser': {
      const byUser = { ...(state.memoriesByUser || {}), [state.settings.userId || 'local']: state.memories };
      return {
        ...state,
        memoriesByUser: byUser,
        memories: action.memories || byUser[action.userId] || [],
        settings: { ...state.settings, userId: action.userId },
      };
    }
    case 'approval/add':
      return { ...state, approvals: [...state.approvals, action.item] };
    case 'approval/remove':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };
    case 'exec/log':
      return { ...state, execLog: [action.item, ...state.execLog].slice(0, 80) };
    case 'backend/set':
      return { ...state, backend: { ...state.backend, ...action.patch } };
    case 'settings/set':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'stats/bump': {
      const next = { ...state.stats };
      for (const [k, v] of Object.entries(action.patch)) next[k] = (next[k] || 0) + v;
      return { ...state, stats: next };
    }
    case 'session/add':
      return { ...state, sessions: [...state.sessions, action.session].slice(-50) };
    case 'state/import':
      return coerceChatSource(hydrate(action.data));
    case 'state/reset':
      return coerceChatSource(defaultState());
    default:
      return state;
  }
}

function reducer(state, action) {
  return (
    reduceFilesTabs(state, action) ??
    reduceWorkspace(state, action) ??
    reduceChat(state, action) ??
    reduceRest(state, action)
  );
}

const Ctx = createContext(null);

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const saveTimer = useRef(null);
  const chatFileTimer = useRef(null);
  const lastChatRoot = useRef(state.workspace?.root || '');

  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        persistState(stateRef.current);
      } catch (err) {
        console.warn('[cortex] 持久化失败', err);
      }
    }, 350);
    return () => clearTimeout(saveTimer.current);
  }, [state]);

  /* 工作区多会话 → `.cortex/sessions/store.json`（防抖） */
  useEffect(() => {
    const root = state.workspace?.root;
    if (!root || !state.workspace?.connected) return;
    clearTimeout(chatFileTimer.current);
    chatFileTimer.current = setTimeout(() => {
      const sealed = sealChatForPersist(stateRef.current);
      saveChatStoreToWorkspace(root, {
        version: 2,
        root,
        activeSessionId: sealed.activeSessionId,
        sessions: sealed.chatSessions,
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(chatFileTimer.current);
  }, [state.messages, state.chatSessions, state.activeSessionId, state.workspace?.root, state.workspace?.connected]);

  /* 公网鉴权令牌 + 用户身份：任何 /api 请求（含 fetch 包装）都带上 */
  useEffect(() => {
    const s = state.settings;
    setApiAuth({
      token: s.accessToken || '',
      user: s.userId || 'local',
      workspace: state.workspace?.root || '',
    });
  }, [state.settings.accessToken, state.settings.userId, state.workspace?.root]);

  /* ---- 供 Agent / UI 调用的副作用封装（需要返回值，因此在这里构造） ---- */
  const approvalResolvers = useRef(new Map());
  const watchSender = useRef(null);
  const treeTimer = useRef(null);

  const ops = useMemo(
    () =>
      createOps({
        stateRef,
        dispatch,
        approvalResolvers,
        watchSender,
        treeTimer,
        lastChatRoot,
        hashOf,
      }),
    [],
  );

  const value = useMemo(() => ({ state, dispatch, ops, stateRef }), [state, ops]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp 必须在 StoreProvider 内使用');
  return ctx;
}

export { DEFAULT_SETTINGS, STORAGE_KEY };

/** 生成一段会话摘要，作为情节记忆落库 */
export function summarizeSession(messages, files) {
  const userMsgs = messages.filter((m) => m.role === 'user');
  if (!userMsgs.length) return null;
  const touched = new Set();
  for (const m of messages) {
    for (const s of m.steps || []) {
      const match = /"([^"]+\.\w{1,5})"/.exec(s.title || '');
      if (match) touched.add(match[1]);
    }
  }
  const topics = userMsgs
    .slice(-6)
    .map((m) => m.content.replace(/\s+/g, ' ').slice(0, 40))
    .join('；');
  return {
    text: `会话回顾（${new Date().toLocaleString('zh-CN')}，${userMsgs.length} 轮）：${topics}${touched.size ? `；涉及文件 ${[...touched].join(', ')}` : ''}`,
    kind: 'episode',
    importance: 3,
    tags: [],
    source: 'session',
    meta: { files: [...touched], turns: userMsgs.length, fileCount: files.length },
  };
}

/** 供 UI 使用的派生数据 */
export function useDerived() {
  const { state } = useApp();
  return useMemo(() => {
    const tabs = state.openTabs.map((id) => state.files.find((f) => f.id === id)).filter(Boolean);
    // 仅当 active 仍在打开标签里才视为当前文件（避免关完标签仍显示缓存正文）
    const active =
      state.activeFileId && state.openTabs.includes(state.activeFileId)
        ? state.files.find((f) => f.id === state.activeFileId) || null
        : null;
    return {
      active,
      tabs,
      dirtyCount: state.files.filter((f) => f.dirty).length,
      langs: [...new Set(state.files.map((f) => langOf(f.path)))],
      activeName: active ? baseName(active.path) : '—',
    };
  }, [state.files, state.activeFileId, state.openTabs]);
}
