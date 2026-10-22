/**
 * ANN / BitIndex 纯逻辑单测（不联网、不碰 sqlite）。
 * 盯：增量 upsert / 墓碑删除 / 乱序插入必须回退重建 / 签名打包可逆。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BitIndex, packSign, asWords } from '../server/ann.js';

const dim = 512;

function randVec(seed = 1) {
  const v = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i += 1) {
    s = (s * 1103515245 + 12345) >>> 0;
    v[i] = (s / 0xffffffff) * 2 - 1;
  }
  return v;
}

test('ANN：packSign 按符号位压成 64 字节，asWords 不拷贝', () => {
  const v = new Float32Array(dim);
  v[0] = 1;
  v[31] = -1;
  v[32] = 0.5;
  const buf = packSign(v);
  assert.equal(buf.length, 64);
  const words = asWords(buf);
  assert.equal(words.length, 16);
  assert.equal(words[0] & 1, 1, '第 0 维为正 → bit0');
  assert.equal((words[0] >>> 31) & 1, 0, '第 31 维为负 → bit31=0');
  assert.equal(words[1] & 1, 1, '第 32 维为正 → 第 2 个字的 bit0');
});

test('ANN：BitIndex 增量 upsert / remove；乱序插入返回 false', () => {
  const idx = new BitIndex(dim);
  const a = packSign(randVec(1));
  const b = packSign(randVec(2));
  const c = packSign(randVec(3));

  assert.equal(idx.upsert(10, a), true);
  assert.equal(idx.upsert(20, b), true);
  assert.equal(idx.size, 2);

  // 原地改向量
  assert.equal(idx.upsert(10, c), true);
  assert.equal(idx.size, 2);
  assert.ok(idx.upserts >= 3);

  // 乱序 id（比尾部小且不存在）→ 必须拒绝，交给调用方整库重建
  assert.equal(idx.upsert(15, a), false);

  assert.equal(idx.remove(20), true);
  assert.equal(idx.dead, 1);
  assert.ok(idx.staleRatio > 0);
  // 墓碑行再 upsert 同一 id 应复活
  assert.equal(idx.upsert(20, b), true);
  assert.equal(idx.dead, 0);
});

test('ANN：搜索能命中自身；删掉的 id 不再出现', () => {
  const idx = new BitIndex(dim);
  const vectors = [];
  for (let i = 1; i <= 64; i += 1) {
    const v = randVec(i * 17);
    vectors.push(v);
    idx.upsert(i, packSign(v));
  }
  // search 吃 float 向量（内部再 packSign），不是已打包的字
  const hits = idx.search(vectors[0], 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 1, '完全相同的签名应排第一');
  assert.equal(hits[0].ham, 0);

  idx.remove(1);
  const after = idx.search(vectors[0], 5);
  assert.ok(after.every((h) => h.id !== 1), '墓碑条目不得被召回');
});
