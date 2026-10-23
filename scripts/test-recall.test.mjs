/**
 * 客户端 recall：lexical / fuseRrf 命中字段是 sim，不能假定只有 score
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recall, makeMemory } from '../src/lib/memory.js';
import { fuseRrf } from '../src/lib/bm25.js';

describe('recall', () => {
  it('lexical 路径：短中文查询能召回含关键词的记忆，且相关条排在前面', async () => {
    const mems = [
      makeMemory({ text: '所有新页面都要用 React.lazy 做代码分割', kind: 'fact', importance: 4 }),
      makeMemory({ text: '数据库用 Postgres', kind: 'fact', importance: 5 }),
    ];
    const r = await recall('代码分割', mems, { k: 5, provider: 'lexical' });
    assert.ok(r.results.length >= 1, `expected hits, got ${r.results.length}`);
    assert.ok(/React\.lazy/.test(r.results[0].text), `top hit should be lazy mem, got ${r.results[0].text}`);
    assert.equal(typeof r.results[0].score, 'number');
    assert.equal(typeof r.results[0].sim, 'number');
    assert.ok(r.results[0].sim > 0, 'sim must reflect lexical match, not stay at 0');
  });

  it('fuseRrf 命中无 score 字段时 recall 不抛 toFixed', async () => {
    const mem = makeMemory({ text: 'smoke 用 React.lazy', kind: 'fact', importance: 4 });
    const fused = fuseRrf([{ id: mem.id, score: 0.9 }], [{ id: mem.id, score: 2.1 }], { limit: 5 });
    assert.ok(fused.length);
    assert.equal(typeof fused[0].sim, 'number');
    assert.equal(typeof fused[0].score, 'number');
    const r = await recall('React.lazy', [mem], { k: 3, provider: 'lexical' });
    assert.ok(r.results.length >= 1);
    assert.ok(r.results[0].sim > 0);
  });
});
