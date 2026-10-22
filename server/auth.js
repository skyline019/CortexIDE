/**
 * 公网暴露前的访问鉴权。
 *
 * 本地默认关闭（不设环境变量）。一旦设置了令牌：
 *  - 所有 /api/* 必须带 Authorization: Bearer <token> 或 x-cortex-token
 *  - 禁止「只靠 x-cortex-user 冒充身份」：未通过令牌一律 401
 *  - 多用户：CORTEX_AUTH_TOKENS=alice:tok1,bob:tok2 → 令牌直接绑定用户，覆盖客户端伪造的头
 *  - 单共享令牌：CORTEX_AUTH_TOKEN=secret；默认忽略客户端的 x-cortex-user
 *    （除非 CORTEX_AUTH_TRUST_USER_HEADER=1），改用 CORTEX_AUTH_DEFAULT_USER（默认 local）
 */

function parseTokenMap() {
  const raw = String(process.env.CORTEX_AUTH_TOKENS || '').trim();
  const map = new Map();
  if (!raw) return map;
  for (const part of raw.split(/[,;]+/)) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const user = s.slice(0, i).trim().slice(0, 64);
    const token = s.slice(i + 1).trim();
    if (user && token) map.set(token, user);
  }
  return map;
}

export function authEnabled() {
  return Boolean(String(process.env.CORTEX_AUTH_TOKEN || '').trim() || parseTokenMap().size);
}

function extractToken(req) {
  const h = req.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  if (m) return m[1];
  const alt = h['x-cortex-token'] || h['X-Cortex-Token'];
  if (alt) return String(alt).trim();
  // 也允许 ?access_token=（EventSource / 部分 WS 探针不好带头时）
  try {
    const u = new URL(req.url || '/', 'http://local');
    const q = u.searchParams.get('access_token');
    if (q) return q.trim();
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * @returns {{ ok: true, userId: string|null } | { ok: false, error: string }}
 * userId 非空时调用方应覆盖 req 上的 x-cortex-user
 */
export function checkAuth(req) {
  if (!authEnabled()) return { ok: true, userId: null };

  const presented = extractToken(req);
  if (!presented) {
    return { ok: false, error: '需要鉴权：请在 Authorization: Bearer <token> 或 x-cortex-token 里带访问令牌' };
  }

  const map = parseTokenMap();
  if (map.has(presented)) {
    return { ok: true, userId: map.get(presented) };
  }

  const shared = String(process.env.CORTEX_AUTH_TOKEN || '').trim();
  if (shared && presented === shared) {
    const trust = String(process.env.CORTEX_AUTH_TRUST_USER_HEADER || '') === '1';
    if (trust) return { ok: true, userId: null }; // 保留客户端头
    const forced = String(process.env.CORTEX_AUTH_DEFAULT_USER || 'local').slice(0, 64);
    return { ok: true, userId: forced };
  }

  return { ok: false, error: '访问令牌无效' };
}

function sendUnauthorized(res, error) {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.end(JSON.stringify({ error, code: 'UNAUTHORIZED' }));
}

function attach(server) {
  // 必须挂在其它 /api 插件之前：先到先鉴权
  server.middlewares.use((req, res, next) => {
    const url = req.url || '';
    if (!url.startsWith('/api/')) return next();
    const result = checkAuth(req);
    if (!result.ok) return sendUnauthorized(res, result.error);
    if (result.userId) {
      req.headers['x-cortex-user'] = result.userId;
    }
    return next();
  });
}

/** Vite 插件：dev + preview 都生效 */
export function authApiPlugin() {
  return {
    name: 'cortex-auth',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
