/**
 * 前端请求头：访问令牌 + 用户身份。
 * 服务端开了 CORTEX_AUTH_* 时，没有 Bearer 会 401；开了多用户令牌表时，用户由令牌决定。
 */

let accessToken = '';
let userId = 'local';
let workspace = '';

export function setApiAuth({ token, user, workspace: ws } = {}) {
  if (token !== undefined) accessToken = String(token || '');
  if (user !== undefined) userId = String(user || 'local').slice(0, 64);
  if (ws !== undefined) workspace = String(ws || '');
}

export function getAccessToken() {
  return accessToken;
}

/** 合并到任意 fetch headers；不会覆盖调用方已显式设置的同名键 */
export function apiHeaders(extra = {}) {
  const h = {
    Accept: 'application/json',
    'x-cortex-user': userId,
    ...extra,
  };
  if (workspace && h['x-cortex-workspace'] === undefined) h['x-cortex-workspace'] = workspace;
  if (accessToken && !h.Authorization && !h.authorization) {
    h.Authorization = `Bearer ${accessToken}`;
  }
  return h;
}

export async function apiFetch(url, opts = {}) {
  const headers = apiHeaders(opts.headers || {});
  return fetch(url, { ...opts, headers });
}

/** WebSocket 无法带头时，把令牌塞进 ?access_token=（服务端 auth.js 已认） */
export function wsAuthUrl(url) {
  if (!accessToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}access_token=${encodeURIComponent(accessToken)}`;
}

/**
 * 一次性包装 window.fetch：凡是本站 /api/* 都自动带鉴权头。
 * 避免每个组件各自漏传 Authorization；自定义 Authorization（如直连上游 Key）保持不动。
 */
export function installFetchAuth() {
  if (typeof window === 'undefined' || window.__cortexFetchAuth) return;
  window.__cortexFetchAuth = true;
  const orig = window.fetch.bind(window);

  const isApi = (u) => {
    try {
      if (typeof u === 'string') {
        if (u.startsWith('/api/')) return true;
        if (u.startsWith('http')) return new URL(u).pathname.startsWith('/api/');
        return false;
      }
      if (u && typeof u.url === 'string') return isApi(u.url);
    } catch {
      /* ignore */
    }
    return false;
  };

  window.fetch = (input, init = {}) => {
    if (!isApi(input)) return orig(input, init);
    const base = {};
    if (input instanceof Request) {
      input.headers.forEach((v, k) => {
        base[k] = v;
      });
    }
    const merged = apiHeaders({ ...base, ...(init.headers || {}) });
    // 调用方已带 Authorization（例如浏览器直连上游）时不要覆盖
    const hasAuth =
      (init.headers && (init.headers.Authorization || init.headers.authorization)) ||
      (input instanceof Request && input.headers.has('Authorization'));
    if (hasAuth && accessToken) {
      // apiHeaders 不会覆盖已有 Authorization；此处保持 init 优先
    }
    return orig(input, { ...init, headers: merged });
  };
}
