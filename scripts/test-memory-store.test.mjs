/**
 * memory-store CRUD / 用户隔离 / FTS·向量检索（临时库，stub 向量，不联网）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-memstore-'));
process.env.CORTEX_DB = path.join(tmp, 'memory.db');
process.env.CORTEX_ANN_MIN = '99999999';
process.env.CORTEX_ANN_PERSIST = '0';

const {
  syncMemories,
  listMemories,
  deleteMemory,
  searchMemories,
  closeDb,
  touchUser,
  listUsers,
  stats,
} = await import('../server/memory-store.js');

const DIM = Number(process.env.EMBED_DIM || 512);

function unitVec(seed = 1) {
  const v = new Array(DIM).fill(0);
  v[seed % DIM] = 1;
  v[(seed * 3) % DIM] = 0.5;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

test.after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('memory：touchUser + listUsers', () => {
  touchUser('alice', 'Alice');
  touchUser('bob', 'Bob');
  const users = listUsers();
  assert.ok(users.some((u) => u.id === 'alice'));
  assert.ok(users.some((u) => u.id === 'bob'));
});

test('memory：sync CRUD 与 list', () => {
  const r = syncMemories({
    userId: 'alice',
    workspace: 'ws1',
    items: [
      {
        uid: 'm1',
        text: '喜欢用 pnpm',
        kind: 'pref',
        tags: ['tool'],
        importance: 4,
        vector: unitVec(1),
      },
      {
        uid: 'm2',
        text: '项目用 React 19',
        kind: 'fact',
        tags: ['stack'],
        importance: 3,
        vector: unitVec(2),
      },
    ],
  });
  assert.equal(r.saved.length, 2);
  assert.ok(r.vectorized >= 1);
  const list = listMemories('alice', 'ws1');
  assert.equal(list.length, 2);
  assert.ok(list.some((x) => x.uid === 'm1' && x.text.includes('pnpm')));
});

test('memory：用户隔离 — bob 看不到 alice', () => {
  syncMemories({
    userId: 'bob',
    workspace: 'ws1',
    items: [{ uid: 'b1', text: 'bob only secret', kind: 'fact', tags: [], importance: 2, vector: unitVec(7) }],
  });
  const alice = listMemories('alice', 'ws1');
  const bob = listMemories('bob', 'ws1');
  assert.ok(!alice.some((x) => x.text.includes('bob only')));
  assert.ok(bob.some((x) => x.uid === 'b1'));
  assert.ok(!bob.some((x) => x.text.includes('pnpm')));
});

test('memory：工作区隔离', () => {
  syncMemories({
    userId: 'alice',
    workspace: 'ws2',
    items: [{ uid: 'w2', text: 'only in ws2', kind: 'fact', tags: [], importance: 2, vector: unitVec(9) }],
  });
  assert.ok(!listMemories('alice', 'ws1').some((x) => x.uid === 'w2'));
  assert.ok(listMemories('alice', 'ws2').some((x) => x.uid === 'w2'));
});

test('memory：deleteMemory 后 list 为空项', () => {
  assert.equal(deleteMemory('alice', 'm2'), true);
  assert.equal(deleteMemory('alice', 'nope'), false);
  assert.ok(!listMemories('alice', 'ws1').some((x) => x.uid === 'm2'));
});

test('memory：sync deleted 批量删', () => {
  syncMemories({
    userId: 'alice',
    workspace: 'ws1',
    items: [{ uid: 'm3', text: '临时', kind: 'fact', tags: [], vector: unitVec(3) }],
  });
  const r = syncMemories({ userId: 'alice', workspace: 'ws1', items: [], deleted: ['m3'] });
  assert.ok(r.removed.includes('m3'));
  assert.ok(!listMemories('alice', 'ws1').some((x) => x.uid === 'm3'));
});

test('memory：FTS/BM25 检索命中', () => {
  const res = searchMemories({
    userId: 'alice',
    workspace: 'ws1',
    query: 'pnpm',
    k: 5,
    mode: 'bm25',
  });
  assert.ok(Array.isArray(res.hits));
  assert.ok(res.hits.length >= 1, `bmHits=${res.bmHits} backend=${res.backend}`);
  assert.ok(res.tookMs >= 0);
  const list = listMemories('alice', 'ws1');
  const texts = res.hits
    .map((h) => list.find((x) => x.uid === h.uid)?.text || '')
    .join(' ');
  assert.match(texts, /pnpm/);
});

test('memory：向量检索 topK 非空', () => {
  const res = searchMemories({
    userId: 'alice',
    workspace: 'ws1',
    vector: unitVec(1),
    query: 'pnpm',
    k: 3,
    mode: 'hybrid',
    ann: 'off',
  });
  assert.ok(Array.isArray(res.hits));
  assert.ok(res.hits.length >= 1, `期望命中，got ${JSON.stringify(res).slice(0, 200)}`);
});

test('memory：stats 有总数', () => {
  const s = stats();
  assert.ok(s.total >= 1);
  assert.ok(s.users >= 1);
});

test('memory：upsert 同 uid 更新文本', () => {
  syncMemories({
    userId: 'alice',
    workspace: 'ws1',
    items: [{ uid: 'm1', text: '改成 yarn', kind: 'pref', tags: ['tool'], importance: 5, vector: unitVec(1) }],
  });
  const row = listMemories('alice', 'ws1').find((x) => x.uid === 'm1');
  assert.equal(row.text, '改成 yarn');
  assert.equal(row.importance, 5);
});

test('memory：空 items sync 不炸', () => {
  const r = syncMemories({ userId: 'alice', workspace: 'ws1', items: [] });
  assert.equal(r.saved.length, 0);
});

test('memory：bind 后 search 返回结构含 took/backend 类字段', () => {
  const res = searchMemories({
    userId: 'alice',
    workspace: 'ws1',
    query: 'React',
    k: 4,
    mode: 'bm25',
  });
  assert.ok(res && typeof res === 'object');
  assert.ok('tookMs' in res);
  assert.ok('backend' in res);
  assert.ok(Array.isArray(res.hits));
});
