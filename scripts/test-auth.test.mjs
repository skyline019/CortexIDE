/**
 * 公网鉴权：禁止只靠 x-cortex-user；令牌绑定用户；共享令牌默认强制 DEFAULT_USER。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authEnabled, checkAuth } from '../server/auth.js';

function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const prev = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('鉴权关闭：无令牌环境，任意请求放行', () => {
  withEnv({ CORTEX_AUTH_TOKEN: undefined, CORTEX_AUTH_TOKENS: undefined }, () => {
    assert.equal(authEnabled(), false);
    const r = checkAuth({ headers: {}, url: '/api/fs/info' });
    assert.equal(r.ok, true);
    assert.equal(r.userId, null);
  });
});

test('鉴权开启：只有 x-cortex-user、没有令牌 → 拒绝', () => {
  withEnv({ CORTEX_AUTH_TOKEN: 'secret-shared', CORTEX_AUTH_TOKENS: undefined }, () => {
    assert.equal(authEnabled(), true);
    const r = checkAuth({
      headers: { 'x-cortex-user': 'attacker' },
      url: '/api/mem/status',
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /鉴权|令牌/);
  });
});

test('共享令牌：默认忽略客户端 user 头，强制 DEFAULT_USER', () => {
  withEnv(
    {
      CORTEX_AUTH_TOKEN: 'secret-shared',
      CORTEX_AUTH_TOKENS: undefined,
      CORTEX_AUTH_DEFAULT_USER: 'alice',
      CORTEX_AUTH_TRUST_USER_HEADER: undefined,
    },
    () => {
      const r = checkAuth({
        headers: {
          authorization: 'Bearer secret-shared',
          'x-cortex-user': 'bob',
        },
        url: '/api/fs/info',
      });
      assert.equal(r.ok, true);
      assert.equal(r.userId, 'alice');
    },
  );
});

test('共享令牌 + TRUST_USER_HEADER=1：保留客户端 user', () => {
  withEnv(
    {
      CORTEX_AUTH_TOKEN: 'secret-shared',
      CORTEX_AUTH_TOKENS: undefined,
      CORTEX_AUTH_TRUST_USER_HEADER: '1',
    },
    () => {
      const r = checkAuth({
        headers: {
          authorization: 'Bearer secret-shared',
          'x-cortex-user': 'bob',
        },
        url: '/api/fs/info',
      });
      assert.equal(r.ok, true);
      assert.equal(r.userId, null);
    },
  );
});

test('多用户令牌表：令牌决定身份，覆盖伪造头', () => {
  withEnv(
    {
      CORTEX_AUTH_TOKEN: undefined,
      CORTEX_AUTH_TOKENS: 'alice:tok-a,bob:tok-b',
    },
    () => {
      const ok = checkAuth({
        headers: { 'x-cortex-token': 'tok-b', 'x-cortex-user': 'alice' },
        url: '/api/mem/list',
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.userId, 'bob');

      const bad = checkAuth({
        headers: { authorization: 'Bearer wrong', 'x-cortex-user': 'alice' },
        url: '/api/mem/list',
      });
      assert.equal(bad.ok, false);
    },
  );
});

test('query access_token 亦可（WebSocket / EventSource）', () => {
  withEnv({ CORTEX_AUTH_TOKEN: 'ws-secret', CORTEX_AUTH_TOKENS: undefined }, () => {
    const r = checkAuth({
      headers: {},
      url: '/api/term?access_token=ws-secret',
    });
    assert.equal(r.ok, true);
  });
});

test('负向：伪造 Bearer 失败，即使带 x-cortex-user', () => {
  withEnv(
    {
      CORTEX_AUTH_TOKEN: 'real-secret',
      CORTEX_AUTH_TOKENS: undefined,
      CORTEX_AUTH_TRUST_USER_HEADER: undefined,
    },
    () => {
      const r = checkAuth({
        headers: {
          authorization: 'Bearer fake-token',
          'x-cortex-user': 'admin',
        },
        url: '/api/fs/info',
      });
      assert.equal(r.ok, false);
    },
  );
});

test('负向：多用户表错误令牌拒绝', () => {
  withEnv({ CORTEX_AUTH_TOKEN: undefined, CORTEX_AUTH_TOKENS: 'alice:tok-a' }, () => {
    const r = checkAuth({
      headers: { 'x-cortex-token': 'tok-wrong', 'x-cortex-user': 'alice' },
      url: '/api/mem/list',
    });
    assert.equal(r.ok, false);
  });
});
