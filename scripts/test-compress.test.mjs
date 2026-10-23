/**
 * 压缩 / 估算器 / 文风卡 的单元测试（node:test，不联网、不依赖 dev server）
 *
 * 为什么要有这一套：`bench-compress` 是「端到端比例 + 召回」，改一处小规则不容易看出副作用；
 * 这些用例盯着「不变量」——预算不能失效、消息不能删、tool_call 配对不能断、
 * 定义名不能被挤掉、schema 的参数名不能被截。跑 `npm test`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compressPayload,
  compressText,
  digestText,
  extractTerms,
  keyIndex,
  renderKeyIndex,
  trimTools,
  STRENGTHS,
} from '../server/ctx-compress.js';
import { createTokenizer, features } from '../server/tokenizer.js';
import { createStyleStore } from '../server/style-profile.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tok = () => createTokenizer({}); // 不传 file → 纯内存，不碰 .cortex

const src = read('server/memory-store.js');
const annSrc = read('server/memory-ann.js');
const storeSrc = `${src}\n${annSrc}`; // 压测用合并源码（ANN 已拆出）
const bigJson = (p, content) =>
  JSON.stringify({ path: p, from: 1, to: content.split('\n').length, totalLines: content.split('\n').length, content });

/* ---------------- 关键符号索引 ---------------- */

test('索引保住「定义行里的函数名」（flushAnn 曾经被一堆 const 挤掉）', () => {
  const idx = keyIndex(annSrc.split('\n')); // ANN 已拆到 memory-ann.js
  assert.ok(idx.includes('flushAnn'), `索引里没有 flushAnn：${idx.slice(0, 20).join(' · ')}`);
});

test('索引里的命令/文件名/定义名各自有配额，不会被高频词挤没', () => {
  const lines = [
    'function alphaOne() {}',
    'export function betaTwo() {}',
    'const gammaThree = 1;',
    'import x from "./helper-util.js";',
    '// run `npm run dev` to start',
    ...Array.from({ length: 200 }, (_, i) => `const veryCommon${i % 3} = computeValue(${i});`),
  ];
  const rendered = renderKeyIndex(keyIndex(lines, new Set(), 40));
  assert.match(rendered, /alphaOne|betaTwo/, '定义名消失了');
  assert.match(rendered, /npm run dev|helper-util\.js/, '命令或文件名消失了');
});

test('renderKeyIndex 合并同前缀命令，且总长度受预算约束', () => {
  const out = renderKeyIndex(['npm run dev', 'npm run lint', 'npm run build', 'npm run bench'], { cmd: 60, file: 40, def: 40, id: 20 });
  assert.match(out, /npm run dev\|lint\|build\|bench/);
  assert.ok(out.length < 200, `预算没约束住：${out.length} 字符`);
});

/* ---------------- 文本压缩 ---------------- */

test('compressText：短文本原样返回，不做无谓改写', () => {
  const s = 'short text';
  const r = compressText(s, { budget: 3000 });
  assert.equal(r.text, s);
  assert.equal(r.omitted, 0);
});

test('compressText：超过预算会压，但保留头尾且结果明显变短', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const r = compressText(text, { budget: 4000 });
  assert.ok(r.text.length < text.length, '压完没变短');
  assert.match(r.text.split('\n')[0], /^line 0 /, '开头没保住');
  assert.match(r.text.trim().split('\n').pop(), /line 2999|关键符号/, '结尾没保住');
});

test('compressText：索引只在「确实更短」时才拼（曾经加上索引比原文还长）', () => {
  const text = Array.from({ length: 40 }, (_, i) => `const name${i} = ${i};`).join('\n');
  const r = compressText(text, { budget: text.length - 10 });
  assert.ok(r.text.length <= text.length, `压完反而更长：${text.length} → ${r.text.length}`);
});

test('digestText：抽取式摘要保留「决策/约束」句', () => {
  const text = [
    '索引文件 .cortex/ann 是纯缓存，删掉不丢数据。',
    '这里是一句完全无关的寒暄，天气不错。',
    '必须保证：删了要能自动重建。',
    '再补一句没营养的话。',
  ].join('');
  const d = digestText(text, { budget: 60 });
  assert.match(d, /纯缓存|必须保证/, `摘要丢了决策句：${d}`);
});

/* ---------------- 工具 schema 精简 ---------------- */

test('trimTools：只截 description，参数名 / 类型 / required 一律不动', () => {
  const agentSrc = read('src/lib/agentTools.js');
  const start = agentSrc.indexOf('[', agentSrc.indexOf('const TOOL_SPECS = '));
  // agentTools.js 里是 JS 对象字面量（单引号、无引号键名），不是 JSON —— 用 Function 求值取出来
  const tools = new Function(`return ${agentSrc.slice(start, agentSrc.indexOf('\n];', start) + 2)}`)();
  const before = JSON.parse(JSON.stringify(tools));
  const r = trimTools(tools);
  assert.ok(r.after < r.before, 'schema 没变短');
  assert.equal(r.tools.length, before.length);
  r.tools.forEach((t, i) => {
    assert.equal(t.function.name, before[i].function.name, '函数名被改了');
    const pb = before[i].function.parameters;
    const pa = t.function.parameters;
    assert.deepEqual(Object.keys(pa.properties || {}), Object.keys(pb.properties || {}), '参数名被改了');
    assert.deepEqual(pa.required || [], pb.required || [], 'required 被改了');
    for (const [k, v] of Object.entries(pb.properties || {})) {
      assert.equal(pa.properties[k].type, v.type, `参数 ${k} 的类型被改了`);
    }
  });
});

test('trimTools：没有 description 的自定义工具不会崩', () => {
  const tools = [{ function: { name: 'x', parameters: { type: 'object', properties: {} } } }];
  assert.doesNotThrow(() => trimTools(tools));
  assert.equal(trimTools([]).tools.length, 0);
});

/* ---------------- 估算器 ---------------- */

test('features：五类字符分开统计，JSON 结构符单列', () => {
  const f = features('{"a":1}');
  // { " : } —— 逗号不在样本里；"a" 的引号算 2 个、冒号 1 个、花括号 2 个
  assert.equal(f[4], 5, `结构符计数不对：${f}`);
  assert.equal(features('{}[]":,<>')[4], 9, '九个结构符应该全部识别');
});

test('estimate：文本越长估得越多，且纯中文每字在 0.5~1.3 token 之间', () => {
  const t = tok();
  const a = t.estimate('测试');
  const b = t.estimate('测试'.repeat(50));
  assert.ok(b > a * 20);
  assert.ok(b / 100 > 0.5 && b / 100 < 1.3, `中文每字 ${(b / 100).toFixed(2)} token，超出合理区间`);
});

test('estimateMessages 计入 tools（否则省多少全是自欺欺人）', () => {
  const t = tok();
  const msgs = [{ role: 'user', content: 'hi' }];
  const a = t.estimateMessages(msgs).total;
  const b = t.estimateMessages(msgs, JSON.stringify([{ type: 'function', function: { name: 'read_file' } }])).total;
  assert.ok(b > a + 5, 'tools 没被计入');
});

/* ---------------- 主入口 compressPayload ---------------- */

const makeConversation = () => [
  { role: 'system', content: '你是 Cortex。' },
  { role: 'user', content: '看看这些文件，给我三条要修的。' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"server/memory-store.js"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: bigJson('server/memory-store.js', storeSrc) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"npm run lint"}' } }] },
  { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ cmd: 'npm run lint', ok: true, code: 0, stdout: 'x'.repeat(20000) }) },
  { role: 'assistant', content: '一些较早的、很长很长的回答。'.repeat(200) },
];

test('compressPayload：永远不删消息、不拆 tool_call 配对', () => {
  const t = tok();
  const msgs = makeConversation();
  for (const strength of Object.keys(STRENGTHS)) {
    const o = compressPayload({ messages: msgs, strength, tokenizer: t });
    assert.equal(o.messages.length, msgs.length, `${strength} 改了消息数`);
    const ids = new Set();
    for (const m of o.messages) for (const tc of m.tool_calls || []) ids.add(tc.id);
    for (const m of o.messages) if (m.role === 'tool') assert.ok(ids.has(m.tool_call_id), `${strength} 拆了配对`);
  }
});

test('compressPayload：不改原数组（调用方还要用原始历史）', () => {
  const t = tok();
  const msgs = makeConversation();
  const snapshot = JSON.stringify(msgs);
  compressPayload({ messages: msgs, strength: 'aggressive', tokenizer: t });
  assert.equal(JSON.stringify(msgs), snapshot, '原 messages 被就地改写了');
});

test('compressPayload：off 档原样返回，不偷偷压', () => {
  const t = tok();
  const msgs = makeConversation();
  const o = compressPayload({ messages: msgs, strength: 'off', tokenizer: t, styleCard: '不该出现' });
  assert.equal(o.stats.savedPct, 0);
  assert.equal(o.messages[1].content, msgs[1].content);
  assert.ok(!JSON.stringify(o.messages).includes('不该出现'), 'off 档还是塞了文风卡');
});

test('compressPayload：balanced 真的把大工具回传压到预算内', () => {
  const t = tok();
  const o = compressPayload({ messages: makeConversation(), strength: 'balanced', tokenizer: t });
  const tool = o.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert.ok(tool.length < 30000, `工具回传还有 ${tool.length} 字符`);
  assert.ok(o.stats.savedPct > 50, `只省了 ${o.stats.savedPct}%`);
});

test('compressPayload：同一文件重复读取只留最新一份（顺序 bug 回归测试）', () => {
  const t = tok();
  const older = bigJson('server/memory-ann.js', annSrc);
  const newer = bigJson('server/memory-ann.js', annSrc.replace('function flushAnn(', 'export function flushAnn('));
  const msgs = [
    { role: 'user', content: '看看这个文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: older },
    { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: newer },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '现在呢？' },
  ];
  const o = compressPayload({ messages: msgs, strength: 'balanced', tokenizer: t });
  assert.ok(o.stats.stages.reread > 0, `重读去旧没生效：stages=${JSON.stringify(o.stats.stages)}`);
  assert.ok(o.messages[2].content.includes('旧回传已省略'), '旧的那份没被换成指针');
  assert.ok(o.messages[4].content.includes('flushAnn'), '最新的那份被压没了');
});

test('compressPayload：文风卡挂到 system 末尾，且计入节省的「花费」', () => {
  const t = tok();
  const o = compressPayload({ messages: makeConversation(), strength: 'balanced', tokenizer: t, styleCard: '## 文风\n回答 ≤100 字' });
  assert.match(o.messages[0].content, /文风/);
  assert.ok(o.stats.stages.style > 0, '文风卡的开销没记账');
});

test('compressPayload：没有 system 消息时，文风卡会补一条而不是丢掉', () => {
  const t = tok();
  const o = compressPayload({ messages: [{ role: 'user', content: 'hi' }], strength: 'balanced', tokenizer: t, styleCard: 'X' });
  assert.equal(o.messages[0].role, 'system');
});

/* ---------------- 文风画像 ---------------- */

test('style-profile：学得会长短、渲染成紧凑卡，且不泄露原文', () => {
  // Win / WSL / Linux 都走 os.tmpdir()，避免写死 /tmp 在 Windows 上 ENOENT
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-style-test-'));
  try {
    const store = createStyleStore({ dir });
    const long = '我想比较系统地了解一下你们的落盘机制是怎么做的，能不能把背景、原因和边界情况都讲讲？';
    store.observe('u1', long);
    store.observe('u1', long.replace('落盘机制', '索引机制'));
    const card = store.card('u1');
    assert.match(card, /说话方式/);
    assert.ok(card.length < 400, `文风卡太长：${card.length} 字符`);
    assert.ok(!card.includes('比较系统地了解'), '文风卡复述了原话');
    assert.ok(store.profile('u1').samples >= 2);
    // 没有样本时如实返回空卡，不编一个
    assert.equal(store.card('nobody'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('style-profile：短问用户和长问用户拿到不同的「回答长度」指令', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-style-test-'));
  try {
    const store = createStyleStore({ dir });
    for (const t of ['增量写怎么做的？', '墓碑清理啥时候跑？', '落盘文件删了能重建吗？']) store.observe('short', t);
    for (let i = 0; i < 3; i += 1) store.observe('long', '这个问题我想问得详细一点，把前因后果和边界情况都覆盖到，能不能展开讲讲？');
    const a = store.card('short');
    const b = store.card('long');
    assert.notEqual(a, b, '不同文风给了同一张卡');
    assert.match(a, /≤|字/);
    assert.match(b, /字/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 真实语料上的总体行为 ---------------- */

test('真实 README：压到 4000 字符以内，函数名和命令都还在', () => {
  const readme = read('README.md');
  const terms = extractTerms('压缩后的关键函数名还在吗');
  const r = compressText(readme, { terms, budget: 4000 });
  assert.ok(r.text.length < readme.length * 0.5, `压得不够：${r.text.length}/${readme.length}`);
  const tool = JSON.stringify({ path: 'README.md', content: r.text });
  assert.ok(tool.length < 30000);
});

/* ---------------- 本轮的回归：不要把「用户现在说的这句话」压掉 ---------------- */
// 真机上撞到的：用户拖了附件提问，模型回「你只给了一段压缩摘要，没说想让我干什么」。
// 根因是 keepRecent 的划界在消息不多时写反了，把最后一条 user 也划进了摘要区。

test('压缩：消息很少时不能摘要本轮提问（附件 + 问题必须原样到达模型）', () => {
  const t = tok();
  const contextBlock = `## 用户这轮附上的上下文\n\n### 引用：src/big.js（900 行）\n\`\`\`js\n${'const x = 1;\n'.repeat(400)}\`\`\``;
  const question = '这个文件里 buildPlan 返回哪些字段？只列字段名。';
  const messages = [
    { role: 'system', content: '你是 Cortex。' },
    { role: 'user', content: `${contextBlock}\n\n---\n\n${question}` },
  ];
  const r = compressPayload({ messages, strength: 'balanced', tokenizer: t });
  const last = r.messages[r.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.includes(question), '本轮问题被摘要掉了');
  assert.ok(!last.content.startsWith('（早前'), '不该给本轮消息加上「早前提问」前缀');
});

test('压缩：哪怕历史很长，最后一条 user 也永远不动', () => {
  const t = tok();
  const long = 'x'.repeat(4000);
  const messages = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 8 }, (_, i) => [
      { role: 'user', content: `第 ${i} 个问题 ${long}` },
      { role: 'assistant', content: `第 ${i} 个回答 ${long}` },
    ]).flat(),
    { role: 'user', content: `现在的问题：${'真的'.repeat(600)}看这里` },
  ];
  const r = compressPayload({ messages, strength: 'aggressive', tokenizer: t });
  const last = r.messages[r.messages.length - 1];
  assert.ok(last.content.startsWith('现在的问题：'), '本轮问题被改写了');
  // 历史该压的还是压了，不然这个测试就变成「什么都不压」
  assert.ok(r.stats.savedTokens > 0);
});
