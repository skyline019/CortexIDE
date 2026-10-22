/** 真实文件系统客户端：把 /api/fs/* 包装成 Promise */

import { apiFetch, apiHeaders } from './apiAuth.js';

const json = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

async function get(url) {
  return json(await apiFetch(url, { headers: { Accept: 'application/json' } }));
}

async function post(url, body) {
  return json(
    await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  );
}

export const fsClient = {
  available: false,
  info: () => get('/api/fs/info'),
  setRoot: (root) => post('/api/fs/root', { root }),
  tree: ({ path = '.', depth = 2, limit = 800 } = {}) =>
    get(`/api/fs/tree?path=${encodeURIComponent(path)}&depth=${depth}&limit=${limit}`),
  read: (path) => get(`/api/fs/read?path=${encodeURIComponent(path)}`),
  search: (q, limit = 60) => get(`/api/fs/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  write: (path, content) => post('/api/fs/write', { path, content }),
  mkdir: (path) => post('/api/fs/mkdir', { path }),
  rename: (from, to) => post('/api/fs/rename', { from, to }),
  remove: (path) => post('/api/fs/delete', { path }),
  rawUrl: (path) => `/api/fs/raw?path=${encodeURIComponent(path)}`,
  terminalInfo: async () => {
    try {
      return await get('/api/fs/terminal-info');
    } catch {
      return null;
    }
  },
};

/** 探测后端是否可用 */
export async function probeServer() {
  try {
    const res = await apiFetch('/api/fs/info', { headers: apiHeaders({ Accept: 'application/json' }) });
    if (!res.ok) return null;
    const info = await res.json();
    fsClient.available = true;
    return info;
  } catch {
    return null;
  }
}

/** 把扁平条目整理成树 */
export function buildTree(entries, base = '') {
  const nodes = new Map();
  const roots = [];
  const sorted = [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  for (const e of sorted) {
    const node = { ...e, children: [] };
    nodes.set(e.path, node);
    const parentPath = e.path.split('/').slice(0, -1).join('/');
    if (parentPath && nodes.has(parentPath)) nodes.get(parentPath).children.push(node);
    else roots.push(node);
  }
  return base ? roots : roots;
}

export const fsUtils = {
  dirname: (p) => p.split('/').slice(0, -1).join('/'),
  basename: (p) => p.split('/').pop() || p,
  ext: (p) => (/\.([a-zA-Z0-9]+)$/.exec(p) || [])[1]?.toLowerCase() || '',
};
