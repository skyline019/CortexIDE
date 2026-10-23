/**
 * createOps 可纯测辅助：无 fetch / 无 React。
 */
import { sealChatForPersist } from './reducers/chat.js';

/** 是否已连接真实工作区 */
export function isRealConnected(workspace) {
  return workspace?.mode === 'real' && Boolean(workspace?.connected);
}

/**
 * 内存文件全文搜索（非真实磁盘模式）
 * @param {Array<{path:string, content?:string}>} files
 * @param {string} query
 * @param {number} [limit=30]
 */
export function searchInMemoryFiles(files, query, limit = 30) {
  const q = String(query || '').toLowerCase();
  const hits = [];
  for (const f of files || []) {
    String(f.content || '')
      .split('\n')
      .forEach((line, i) => {
        if (line.toLowerCase().includes(q)) {
          hits.push({ path: f.path, line: i + 1, text: line.trim().slice(0, 160) });
        }
      });
  }
  return { hits: hits.slice(0, limit), total: hits.length };
}

/** 切换工作区前落盘用的会话 payload */
export function buildChatPersistPayload(state, root) {
  const sealed = sealChatForPersist(state);
  return {
    version: 2,
    root: root || '',
    activeSessionId: sealed.activeSessionId,
    sessions: sealed.chatSessions,
  };
}

/**
 * 校验写入路径：禁止空路径、禁止绝对盘符穿越式奇怪路径（轻量）
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function normalizeWritePath(path) {
  const p = String(path || '').trim().replace(/\\/g, '/');
  if (!p) return { ok: false, error: '路径为空' };
  if (p.includes('\0')) return { ok: false, error: '路径含非法字符' };
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    return { ok: false, error: '请使用工作区相对路径' };
  }
  if (p.split('/').some((seg) => seg === '..')) {
    return { ok: false, error: '路径不得包含 ..' };
  }
  return { ok: true, path: p.replace(/^\.\//, '') };
}
