/**
 * 多会话 = 唯一数据源。
 * messages 始终是 activeSession.messages 的投影，禁止再单独改 messages。
 */

import { makeSession, titleFromMessages } from '../../lib/chatSession.js';

const MAX_MSG = 200;
const MAX_SES = 40;

function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_MSG).map((m) => (m?.pending ? { ...m, pending: false } : m));
}

/** 保证有 active 会话，返回 { sessions, activeId, active } */
function ensureActive(state) {
  let sessions = Array.isArray(state.chatSessions) ? [...state.chatSessions] : [];
  let activeId = state.activeSessionId;
  if (!sessions.length) {
    const s = makeSession({ messages: sanitize(state.messages) });
    return { sessions: [s], activeId: s.id, active: s };
  }
  if (!activeId || !sessions.some((s) => s.id === activeId)) {
    activeId = sessions[sessions.length - 1].id;
  }
  const active = sessions.find((s) => s.id === activeId) || sessions[0];
  return { sessions, activeId: active.id, active };
}

/** 在活动会话上改 messages，并同步投影到 state.messages */
function withActiveMessages(state, mapFn, { touchTitle = false } = {}) {
  const { sessions, activeId, active } = ensureActive(state);
  const prev = Array.isArray(active.messages) ? active.messages : [];
  const nextMessages = sanitize(mapFn(prev));
  let title = active.title;
  if (touchTitle && (!title || title === '新会话')) {
    title = titleFromMessages(nextMessages) || title || '新会话';
  }
  const nextActive = {
    ...active,
    messages: nextMessages,
    title,
    updatedAt: Date.now(),
  };
  const chatSessions = sessions.map((s) => (s.id === activeId ? nextActive : s));
  return {
    ...state,
    chatSessions,
    activeSessionId: activeId,
    messages: nextMessages,
  };
}

export function selectActiveMessages(state) {
  const { active } = ensureActive(state);
  return Array.isArray(active.messages) ? active.messages : [];
}

export function reduceChat(state, action) {
  switch (action.type) {
    case 'msg/add':
      return withActiveMessages(state, (msgs) => [...msgs, action.message], { touchTitle: true });
    case 'msg/delta':
      return withActiveMessages(state, (msgs) =>
        msgs.map((m) => (m.id === action.id ? { ...m, content: m.content + action.text } : m)),
      );
    case 'msg/patch':
      return withActiveMessages(state, (msgs) =>
        msgs.map((m) => (m.id === action.id ? { ...m, ...action.patch } : m)),
      );
    case 'msg/step':
      return withActiveMessages(state, (msgs) =>
        msgs.map((m) => (m.id === action.id ? { ...m, steps: [...(m.steps || []), action.step] } : m)),
      );
    case 'msg/stepResult':
      return withActiveMessages(state, (msgs) =>
        msgs.map((m) =>
          m.id === action.id
            ? {
                ...m,
                steps: (m.steps || []).map((s) =>
                  s.id === action.stepId
                    ? { ...s, status: action.ok ? 'done' : 'error', ok: action.ok, detail: action.detail ?? s.detail }
                    : s,
                ),
              }
            : m,
        ),
      );
    case 'msg/stepUpdate':
      return withActiveMessages(state, (msgs) =>
        msgs.map((m) =>
          m.id === action.id
            ? { ...m, steps: (m.steps || []).map((s) => (s.status === 'running' ? { ...s, status: action.status } : s)) }
            : m,
        ),
      );
    case 'msg/remove':
      return withActiveMessages(state, (msgs) => msgs.filter((m) => m.id !== action.id));
    case 'msg/clear':
      return withActiveMessages(state, () => []);
    case 'msg/set':
      return withActiveMessages(state, () => (Array.isArray(action.messages) ? action.messages : []), {
        touchTitle: true,
      });

    case 'chat/hydrate': {
      let sessions = Array.isArray(action.sessions) && action.sessions.length ? action.sessions : [makeSession()];
      sessions = sessions.map((s) => ({ ...s, messages: sanitize(s.messages) })).slice(-MAX_SES);
      const activeSessionId =
        action.activeSessionId && sessions.some((s) => s.id === action.activeSessionId)
          ? action.activeSessionId
          : sessions[sessions.length - 1].id;
      const cur = sessions.find((s) => s.id === activeSessionId) || sessions[0];
      return {
        ...state,
        chatSessions: sessions,
        activeSessionId,
        messages: Array.isArray(cur.messages) ? cur.messages : [],
      };
    }
    case 'chat/new': {
      const { sessions, activeId, active } = ensureActive(state);
      // 先把当前投影写回（已在 session 内，再 scrub pending）
      const sealed = sessions.map((s) =>
        s.id === activeId ? { ...s, messages: sanitize(active.messages || state.messages) } : s,
      );
      const neu = makeSession({ title: action.title || '新会话' });
      return {
        ...state,
        chatSessions: [...sealed, neu].slice(-MAX_SES),
        activeSessionId: neu.id,
        messages: [],
      };
    }
    case 'chat/switch': {
      if (!action.id || action.id === state.activeSessionId) return state;
      const { sessions, activeId, active } = ensureActive(state);
      const sealed = sessions.map((s) =>
        s.id === activeId ? { ...s, messages: sanitize(active.messages || state.messages), updatedAt: Date.now() } : s,
      );
      const target = sealed.find((s) => s.id === action.id);
      if (!target) return state;
      return {
        ...state,
        chatSessions: sealed,
        activeSessionId: target.id,
        messages: Array.isArray(target.messages) ? [...target.messages] : [],
      };
    }
    case 'chat/rename': {
      if (!action.id) return state;
      const title = String(action.title || '').trim() || '未命名会话';
      return {
        ...state,
        chatSessions: (state.chatSessions || []).map((s) =>
          s.id === action.id ? { ...s, title, updatedAt: Date.now() } : s,
        ),
      };
    }
    case 'chat/delete': {
      const list = state.chatSessions || [];
      if (list.length <= 1) {
        const neu = makeSession();
        return { ...state, chatSessions: [neu], activeSessionId: neu.id, messages: [] };
      }
      const next = list.filter((s) => s.id !== action.id);
      if (!next.length) {
        const neu = makeSession();
        return { ...state, chatSessions: [neu], activeSessionId: neu.id, messages: [] };
      }
      const switching = state.activeSessionId === action.id;
      const activeSessionId = switching ? next[next.length - 1].id : state.activeSessionId;
      const cur = next.find((s) => s.id === activeSessionId) || next[0];
      return {
        ...state,
        chatSessions: next,
        activeSessionId: cur.id,
        messages: switching ? [...(cur.messages || [])] : selectActiveMessages({ ...state, chatSessions: next, activeSessionId: cur.id }),
      };
    }
    case 'chat/bumpTokens': {
      const prompt = Number(action.prompt) || 0;
      const completion = Number(action.completion) || 0;
      if (!prompt && !completion) return state;
      const { sessions, activeId } = ensureActive(state);
      const chatSessions = sessions.map((s) => {
        if (s.id !== activeId) return s;
        const tu = s.tokenUsage || { prompt: 0, completion: 0, turns: 0 };
        return {
          ...s,
          tokenUsage: {
            prompt: tu.prompt + prompt,
            completion: tu.completion + completion,
            turns: tu.turns + 1,
          },
          updatedAt: Date.now(),
        };
      });
      return {
        ...state,
        chatSessions,
        activeSessionId: activeId,
        messages: selectActiveMessages({ ...state, chatSessions, activeSessionId: activeId }),
        stats: {
          ...state.stats,
          promptTokens: (state.stats.promptTokens || 0) + prompt,
          completionTokens: (state.stats.completionTokens || 0) + completion,
          turns: (state.stats.turns || 0) + (action.bumpTurn ? 1 : 0),
        },
      };
    }
    default:
      return null;
  }
}

/** 持久化前：把投影 pending 清掉并写回活动会话 */
export function sealChatForPersist(state) {
  const { sessions, activeId, active } = ensureActive(state);
  const cleaned = sanitize(active.messages || state.messages);
  const title =
    !active.title || active.title === '新会话' ? titleFromMessages(cleaned) || active.title : active.title;
  const chatSessions = sessions
    .map((s) => (s.id === activeId ? { ...s, messages: cleaned, title, updatedAt: Date.now() } : s))
    .slice(-MAX_SES);
  return {
    chatSessions,
    activeSessionId: activeId,
    messages: cleaned,
  };
}
