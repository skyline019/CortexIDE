/**
 * 上下文引用（@提及 / 附件 / 拖拽 / 预算拼装）的单元测试。
 *
 * 这些都是纯函数，所以可以把「真机上踩过的坑」一条条钉死：
 *   - `a@b.com` 不能弹出补全面板
 *   - 候选排序要让 `plan.js` 排在 `plan-v2-backup.js` 前面
 *   - 同一个文件拖两次只能带一份
 *   - 截断/超预算/读不到，必须在**发给模型的文本里**写清楚，不能只在界面上标一下
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mentionQueryAt,
  parseMentions,
  replaceMention,
  scoreCandidate,
  rankCandidates,
  refKey,
  makeRef,
  dedupeRefs,
  upsertRef,
  refMeta,
  originLabel,
  estimateTokens,
  formatSize,
  shortPath,
  fenceLang,
  buildContextBlock,
  refsSummary,
} from '../src/lib/context-refs.js';
import { slugFilename } from '../server/attach-api.js';

/* ---------------- 输入框里的 @ ---------------- */

test('@ 补全：只在行首/空白/标点之后触发，邮箱不弹面板', () => {
  assert.deepEqual(mentionQueryAt('@pla', 4), { start: 0, end: 4, query: 'pla', quoted: false });
  assert.equal(mentionQueryAt('看下 @src/lib/plan.js', 20).query, 'src/lib/plan.js');
  assert.equal(mentionQueryAt('mail me at a@b.com', 18), null, '邮箱不该触发');
  assert.equal(mentionQueryAt('@plan 后面有空格', 12), null, '空格之后这个 @ 已经结束了');
  assert.equal(mentionQueryAt('没有 at 符号', 6), null);
});

test('@ 补全：支持 @"带 空格 的 路径"', () => {
  const hit = mentionQueryAt('@"docs/a b', 10);
  assert.equal(hit.query, 'docs/a b');
  assert.equal(hit.quoted, true);
  // 引号闭合了就不再是候选查询
  assert.equal(mentionQueryAt('@"docs/a b" 后面', 14), null);
});

test('@ 补全：选中候选后替换成 @path，带空格的自动加引号', () => {
  const text = '看下 @pl 这三行';
  const range = mentionQueryAt(text, 6);
  assert.equal(replaceMention(text, range, 'src/lib/plan.js'), '看下 @src/lib/plan.js 这三行');
  // 行尾也要补一个空格，否则用户接着打字会被粘进路径（真机上真的粘过）
  assert.equal(replaceMention('@a', mentionQueryAt('@a', 2), 'docs/接口 约定.md'), '@"docs/接口 约定.md" ');
});

test('解析正文里的 @引用：多个、去重、去掉句末标点、识别带引号的', () => {
  const text = '对比 @src/lib/plan.js 和 @docs/plan-demo.md，还有 @src/lib/plan.js 再说 @".env 示例" 与 @README.md。';
  const got = parseMentions(text).map((m) => m.path);
  assert.deepEqual(got, ['src/lib/plan.js', 'docs/plan-demo.md', '.env 示例', 'README.md']);
  assert.equal(parseMentions('@./src/a.js')[0].path, 'src/a.js', './ 前缀应被规范掉');
  assert.equal(parseMentions('单纯 a@b.com 不算')[0], undefined);
});

/* ---------------- 候选排序 ---------------- */

test('候选排序：同名优先、路径短的优先、跳读能命中但排后面', () => {
  const items = [
    { path: 'src/components/PlanCard.jsx', name: 'PlanCard.jsx' },
    { path: 'src/lib/plan.js', name: 'plan.js' },
    { path: 'docs/plan-demo.md', name: 'plan-demo.md' },
    { path: 'src/lib/backup/plan.js', name: 'plan.js' },
    { path: 'README.md', name: 'README.md' },
  ];
  const ranked = rankCandidates(items, 'plan').map((x) => x.path);
  assert.equal(ranked[0], 'src/lib/plan.js', '同名的两个 plan.js 里路径短的应该在前');
  assert.ok(ranked.includes('docs/plan-demo.md'));
  assert.ok(!ranked.includes('README.md'), 'README.md 不该匹配 plan');
  // 空查询：全都要，但不能崩
  assert.equal(rankCandidates(items, '').length, 5);
  assert.deepEqual(rankCandidates(items, 'zzzz'), []);
});

test('候选排序：中文路径与大小写都能命中', () => {
  const items = [{ path: 'docs/接口约定.md', name: '接口约定.md' }, { path: 'docs/review.md', name: 'review.md' }];
  assert.equal(rankCandidates(items, '接口')[0].path, 'docs/接口约定.md');
  assert.equal(rankCandidates(items, 'REVIEW')[0].path, 'docs/review.md');
  assert.ok(scoreCandidate(items[0], '接口') > 700);
});

/* ---------------- ref 增删 ---------------- */

test('ref：同一路径只留一份，后加的覆盖内容但保留位置', () => {
  const a = makeRef({ path: 'a.js', content: 'x' });
  const b = makeRef({ path: 'b.js', content: 'y' });
  const a2 = makeRef({ path: 'a.js', content: 'x'.repeat(50) });
  assert.equal(refKey(a), 'file:a.js');
  const list = upsertRef(upsertRef([a], b), a2);
  assert.equal(list.length, 2);
  assert.equal(list[0].path, 'a.js', '顺序不该被打乱');
  assert.equal(list[0].chars, 50, '内容应该是新的那份');
  assert.equal(dedupeRefs([a, b, a2]).length, 2);
});

test('ref：二进制不带正文，副标题如实写「二进制」', () => {
  const bin = makeRef({ path: 'a.pdf', binary: true, size: 2286, content: '不该出现' });
  assert.equal(bin.content, '');
  assert.equal(bin.chars, 0);
  assert.match(refMeta(bin), /二进制/);
  assert.equal(originLabel({ origin: 'drag' }), '拖入');
  assert.equal(originLabel({ origin: 'upload' }), '附件');
});

test('ref：记忆 / 技能是标签型引用，不占正文预算', () => {
  const mem = makeRef({ type: 'memory', path: 'memory:1', name: '约定用 pnpm' });
  assert.equal(refMeta(mem), '记忆');
  const r = buildContextBlock([mem]);
  assert.equal(r.text.includes('约定用 pnpm'), false, '记忆正文不该被当成文件塞进去');
});

/* ---------------- 拼上下文 ---------------- */

test('上下文块：带标题、语言围栏与真实路径', () => {
  const ref = makeRef({ path: 'src/lib/plan.js', content: 'export const a = 1;\nexport const b = 2;\n' });
  const r = buildContextBlock([ref]);
  assert.match(r.text, /## 用户这轮附上的上下文/);
  assert.match(r.text, /### 引用：src\/lib\/plan\.js（2 行）/);
  assert.match(r.text, /```js\n/);
  assert.equal(r.included.length, 1);
  assert.equal(r.dropped.length, 0);
  assert.ok(r.estTokens > 0);
  assert.equal(fenceLang('a.md'), 'md');
  assert.equal(fenceLang('a.unknown'), '');
});

test('上下文块：单份超长要截断，并且**在正文里**写明截了多少', () => {
  const content = Array.from({ length: 500 }, (_, i) => `line ${i} 一些内容`).join('\n');
  const r = buildContextBlock([makeRef({ path: 'big.js', content })], { perRef: 2000, budget: 24000 });
  assert.match(r.text, /原文 \d+ 字符，这里只附了前 \d+ 字符/);
  assert.ok(r.text.length < content.length);
  assert.equal(r.clipped.length, 1);
});

test('上下文块：总预算不够时，没带上的引用必须列出来（不许假装都带了）', () => {
  const a = makeRef({ path: 'a.js', content: 'x'.repeat(3000) });
  const b = makeRef({ path: 'b.js', content: 'y'.repeat(3000) });
  const c = makeRef({ path: 'c.js', content: 'z'.repeat(3000) });
  const r = buildContextBlock([a, b, c], { perRef: 3000, budget: 4200 });
  // 第二份会被裁到剩下的预算，第三份整份丢掉 —— 但**一份都不能悄悄消失**
  assert.equal(r.included.length + r.dropped.length, 3);
  assert.ok(r.dropped.length >= 1, '总预算装不下时必须有被丢掉的');
  assert.match(r.text, /超出上下文预算/);
  for (const d of r.dropped) assert.ok(r.text.includes(d.path), `没列出未附上的 ${d.path}`);
  assert.ok(r.text.length <= 4200 + 400, `实际正文超过预算太多：${r.text.length}`);
});

test('上下文块：读不到的文件要写明失败原因，不伪造内容', () => {
  const bad = makeRef({ path: 'nope.js', extra: { error: '文件不存在：nope.js' } });
  const r = buildContextBlock([bad]);
  assert.match(r.text, /读取失败：文件不存在/);
  assert.equal(r.included.length, 1, '仍然要出现，只是内容为失败说明');
});

test('上下文块：二进制只给路径与大小，不塞乱码', () => {
  const r = buildContextBlock([makeRef({ path: 'demo/sample.pdf', binary: true, size: 2286 })]);
  assert.match(r.text, /二进制文件，未附正文/);
  assert.match(r.text, /2\.2 KB/);
  assert.equal(r.text.includes('\u0000'), false);
});

test('上下文块：同一个文件拖两次只出现一次；空引用返回空串', () => {
  const one = makeRef({ path: 'a.js', content: 'const a = 1;' });
  const two = makeRef({ path: 'a.js', content: 'const a = 1;' });
  const r = buildContextBlock([one, two]);
  assert.equal(r.text.split('### 引用：a.js').length - 1, 1);
  assert.equal(buildContextBlock([]).text, '');
  assert.equal(buildContextBlock([]).estTokens, 0);
});

test('上下文块：汇总数字（字符 / 估算 token）与输入对得上', () => {
  const refs = [makeRef({ path: 'a.js', content: 'x'.repeat(1000) }), makeRef({ path: 'b.pdf', binary: true, size: 2048 })];
  const sum = refsSummary(refs);
  assert.equal(sum.count, 2);
  assert.equal(sum.chars, 1000, '二进制不算字符');
  assert.equal(sum.estTokens, estimateTokens(1000));
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(512), '512 B');
  assert.equal(shortPath('src/components/deep/PlanCard.jsx'), '…/deep/PlanCard.jsx');
});

/* ---------------- 附件落盘的文件名清洗 ---------------- */

test('附件文件名：中文保留、空格折成短横、路径穿越被剥掉', () => {
  assert.equal(slugFilename('接口 约定 v2.md'), '接口-约定-v2.md');
  assert.equal(slugFilename('../../etc/passwd'), 'passwd');
  assert.equal(slugFilename('a/b/c.txt'), 'c.txt');
  assert.equal(slugFilename('...hidden'), 'hidden');
  assert.equal(slugFilename(''), slugFilename('').replace(/^file-\d+$/, 'file-0') === 'file-0' ? slugFilename('') : 'x');
  assert.match(slugFilename(''), /^file-\d+$/);
  assert.ok(slugFilename('a'.repeat(200)).length <= 80);
  assert.equal(slugFilename('截图 2026-10-22 下午.png'), '截图-2026-10-22-下午.png');
});
