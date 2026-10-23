/**
 * opsHelpers 纯逻辑 + createOps 失败路径（mock fetch / 假 workspace）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRealConnected,
  searchInMemoryFiles,
  buildChatPersistPayload,
  normalizeWritePath,
} from '../src/state/opsHelpers.js';
import { makeSession } from '../src/lib/chatSession.js';
import { createOps } from '../src/state/createOps.js';

test('isRealConnected', () => {
  assert.equal(isRealConnected({ mode: 'real', connected: true }), true);
  assert.equal(isRealConnected({ mode: 'real', connected: false }), false);
  assert.equal(isRealConnected({ mode: 'demo', connected: true }), false);
});

test('searchInMemoryFiles：命中与截断', () => {
  const files = [
    { path: 'a.js', content: 'hello\nworld\nhello again' },
    { path: 'b.js', content: 'nope' },
  ];
  const r = searchInMemoryFiles(files, 'hello', 1);
  assert.equal(r.total, 2);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].path, 'a.js');
});

test('normalizeWritePath：拒绝绝对路径与 ..', () => {
  assert.equal(normalizeWritePath('').ok, false);
  assert.equal(normalizeWritePath('/etc/passwd').ok, false);
  assert.equal(normalizeWritePath('C:\\Windows\\x').ok, false);
  assert.equal(normalizeWritePath('../secret').ok, false);
  const ok = normalizeWritePath('./src/foo.js');
  assert.equal(ok.ok, true);
  assert.equal(ok.path, 'src/foo.js');
});

test('buildChatPersistPayload：带上 seal 后的 sessions', () => {
  const s = makeSession({
    id: 's1',
    messages: [{ id: 'm', role: 'user', content: '记一下', pending: true }],
  });
  const payload = buildChatPersistPayload(
    { chatSessions: [s], activeSessionId: s.id, messages: s.messages },
    '/ws/root',
  );
  assert.equal(payload.version, 2);
  assert.equal(payload.root, '/ws/root');
  assert.equal(payload.sessions[0].messages[0].pending, false);
});

function makeCtx(state) {
  const stateRef = { current: state };
  const dispatched = [];
  const dispatch = (a) => {
    dispatched.push(a);
    if (a.type === 'file/write') {
      stateRef.current = {
        ...stateRef.current,
        files: [...stateRef.current.files.filter((f) => f.path !== a.file.path), a.file],
      };
    }
  };
  return {
    stateRef,
    dispatch,
    approvalResolvers: { current: new Map() },
    watchSender: { current: null },
    treeTimer: { current: null },
    lastChatRoot: { current: '' },
    hashOf: () => 1,
    dispatched,
  };
}

test('createOps.writeFile：非法路径抛错', async () => {
  const ctx = makeCtx({
    workspace: { mode: 'demo', connected: false },
    files: [],
    memories: [],
    settings: {},
    backend: {},
  });
  const ops = createOps(ctx);
  await assert.rejects(() => ops.writeFile('../x.js', 'hi'), /路径/);
});

test('createOps.searchFiles：内存模式走 helpers', async () => {
  const ctx = makeCtx({
    workspace: { mode: 'demo', connected: false },
    files: [{ path: 'n.js', content: 'findme\nok' }],
    memories: [],
    settings: {},
    backend: {},
  });
  const ops = createOps(ctx);
  const r = await ops.searchFiles('findme');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].path, 'n.js');
});

test('createOps.readFile：内存模式找不到文件则失败', async () => {
  const ctx = makeCtx({
    workspace: { mode: 'demo', connected: false },
    files: [],
    memories: [],
    settings: {},
    backend: {},
  });
  const ops = createOps(ctx);
  await assert.rejects(() => ops.readFile('missing.js'), /找不到文件/);
});
