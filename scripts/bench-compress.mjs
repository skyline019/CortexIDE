/**
 * 主干压缩基准：真实素材（仓库里的 README / 源码 / 命令输出）+ 关键事实召回检验
 *
 * 只看「省了多少 token」是不够的 —— 压完把关键信息压没了，模型就会答错。
 * 所以这里同时量化两件事：
 *   ① 压缩率（用与线上同一套估算器，并给出上游真实 usage 的对照）
 *   ② 召回率：预先埋进去的「必须保留」的事实（报错原文、约定、端口、函数名…）压缩后还在不在
 *
 * 运行：node scripts/bench-compress.mjs [strength]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createTokenizer } from '../server/tokenizer.js';
import { compressPayload } from '../server/ctx-compress.js';
import { createStyleStore } from '../server/style-profile.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const strength = process.argv[2] || 'balanced';
const tokenizer = createTokenizer({});
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------- 造一份「真实形状」的对话 ---------- */

const readme = read('README.md');
const store = read('server/memory-store.js');
const annStore = read('server/ann-store.js');
const pkg = read('package.json');

const j = (o) => JSON.stringify(o);
const toolRead = (p, content) => j({ path: p, from: 1, to: content.split('\n').length, totalLines: content.split('\n').length, content });
const toolExec = (cmd, stdout) => j({ cmd, ok: true, code: 0, ms: 412, stdout, stderr: '' });

// 命令输出：真实跑一次 lint，拿到真 stdout
const { execSync } = await import('node:child_process');
let lintOut = '';
try {
  lintOut = execSync('npx oxlint --format=default src server scripts 2>&1 | sort | tail -40', { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
  lintOut = (e.stdout || '') + (e.stderr || '');
}

const messages = [
  { role: 'system', content: '你是 Cortex，一个运行在浏览器 IDE 里的编程 Agent。\n## 行为准则\n1. 用中文回答…\n## 当前工作区\n- README.md\n## 检索到的长期记忆\n- [偏好·重要度3] 提交前必须跑 pnpm lint 和 pnpm test' },
  { role: 'user', content: '这个项目的记忆落盘是怎么做的？顺便看看 lint 现在什么状态，给我一个要先修的三条清单。' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: toolRead('README.md', readme) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"server/memory-store.js"}' } }] },
  { role: 'tool', tool_call_id: 'c2', content: toolRead('server/memory-store.js', store) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read_file', arguments: '{"path":"server/ann-store.js"}' } }] },
  { role: 'tool', tool_call_id: 'c3', content: toolRead('server/ann-store.js', annStore) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"npx oxlint src server scripts"}' } }] },
  { role: 'tool', tool_call_id: 'c4', content: toolExec('npx oxlint src server scripts', lintOut) },
  // 同一份 package.json 被读两次（考验去重）
  { role: 'assistant', content: '', tool_calls: [{ id: 'c5', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
  { role: 'tool', tool_call_id: 'c5', content: toolRead('package.json', pkg) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c6', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
  { role: 'tool', tool_call_id: 'c6', content: toolRead('package.json', pkg) },
  // 老历史（应被抽成摘要）
  { role: 'user', content: '上次我们说好：落盘文件必须能删，删了要能自动重建；墓碑只留最近 2 万条。这些话你记一下，别弄丢了。'.repeat(6) },
  { role: 'assistant', content: '好的，我记下了：1) 索引文件 .cortex/ann 是纯缓存，删掉不丢数据；2) 加载时逐块 CRC 校验，任何一块不过就整库重建；3) 墓碑 vec_del 只保留最近 20000 条，更老的被认为已被所有索引水位越过。'.repeat(5) },
  // 同一个文件「改过之后再读一次」：内容不同，字节比对抓不到，只有按 path 识别才收得掉
  { role: 'assistant', content: '', tool_calls: [{ id: 'c8', type: 'function', function: { name: 'read_file', arguments: '{"path":"server/memory-store.js","offset":400}' } }] },
  { role: 'tool', tool_call_id: 'c8', content: toolRead('server/memory-store.js', store.replace('function flushAnn(', 'export function flushAnn(')) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c7', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
  { role: 'tool', tool_call_id: 'c7', content: toolRead('README.md', readme) },
];

/* ---------- 埋点事实：压缩后必须还能找到 ---------- */
const FACTS = [
  { name: '报错/失败信号（lint 输出里的）', text: 'Found' },
  { name: '落盘文件名格式', text: 'u-<用户>-512d.v3.bin' },
  { name: 'CRC 相关约定', text: 'CRC' },
  { name: '墓碑上限 20000', text: '20000' },
  { name: '关键函数名', text: 'flushAnn' },
  { name: '索引块大小', text: 'BLOCK_ROWS' },
  { name: '记忆表名', text: 'memories' },
  { name: '启动命令', text: 'npm run dev' },
  { name: '偏好约定（pnpm lint）', text: 'pnpm lint' },
  { name: '版本号', text: '0.6.3' },
];

/* ---------- 文风卡（用一段真实的中文提问喂出画像） ---------- */
const styleStore = createStyleStore({ dir: path.join(ROOT, '.cache/style-bench') });
const samples = [
  '这个项目的记忆落盘是怎么做的？顺便看看 lint 现在什么状态，给我一个要先修的三条清单。',
  '帮我把 ANN 的落盘改成增量写，别整份重写。',
  '为什么冒烟会超时？给我具体原因，别猜。',
  '简洁点，直接说结论。',
  '把这些数据用表格列一下：条数、体积、耗时。',
  'ANN 查询 p50 是多少？和精确 KNN 差多少？',
];
for (const s of samples) styleStore.observe('bench', s);
const styleCard = styleStore.card('bench');

fs.rmSync(path.join(ROOT, '.cache/style-bench'), { recursive: true, force: true });

/* ---------- 跑压缩 ---------- */
// 与线上一致：把 TOOL_SPECS 也算进 prompt（每轮都要重发，占 700+ token）
const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: '读取工作区里的文件内容，支持 offset/limit 分段读取长文件', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '把内容完整写入文件（覆盖），会返回 diff', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'search_files', description: '在工作区里按关键词搜索，返回匹配行与文件位置', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'list_files', description: '列出工作区文件树', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_command', description: '在白名单内执行命令，需要用户确认后才会真正运行', parameters: { type: 'object', properties: { cmd: { type: 'string' }, cwd: { type: 'string' }, reason: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'remember', description: '把值得长期保留的事实/偏好/待办写进持久记忆', parameters: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'recall', description: '在长期记忆里做语义检索', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];
const out = compressPayload({ messages, strength, tokenizer, styleCard, tools: TOOLS });
// 索引里的 `npm run lint|dev` 是合并写法，语义等价：校验前先展开，避免误判
const expandCommands = (text) =>
  text.replace(/\b(npm run|pnpm|npm)\s+([\w:.\-]+(?:\|[\w:.\-]+)+)/g, (_, p, subs) =>
    subs.split('|').map((x) => `${p} ${x}`).join(' / '),
  );
const all = expandCommands(out.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
const original = expandCommands(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
// 只考核「本来就在原文里」的事实 —— 原文里没有的东西压不压都不会出现
const survived = FACTS.map((f) => ({ ...f, present: original.includes(f.text), ok: all.includes(f.text) }));
const scored = survived.filter((f) => f.present);

const tok = out.stats;
const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
const mb = (n) => `${(n / 1024).toFixed(1)}K`;

console.log(`压缩强度：${tok.label}（预算 ${tok.budget} token）\n`);
console.log(`原始 prompt：${tok.beforeTokens.toLocaleString()} token（${mb(new TextEncoder().encode(JSON.stringify(messages)).length)} 字符）`);
console.log(`压缩后：      ${tok.afterTokens.toLocaleString()} token（${pct(tok.afterTokens, tok.beforeTokens)}）`);
console.log(`省下：        ${tok.savedTokens.toLocaleString()} token（${tok.savedPct}%）\n`);

const stageName = { style: '文风卡（+）', tool: '工具回传', history: '历史摘要', dedupe: '去重（字节相同）', reread: '重读去旧（同文件/同命令只留最新）', budget: '预算兜底' };
console.log(`预算 ${tok.budget.toLocaleString()} token · 压缩后 ${tok.afterTokens.toLocaleString()} · 超预算：${tok.overBudget ? '⚠️ 是' : '否（预算生效）'}`);
console.log('各阶段贡献：');
for (const [k, v] of Object.entries(tok.stages)) {
  if (!v) continue;
  console.log(`  ${stageName[k].padEnd(14)} ${v > 0 ? (k === 'style' ? '+' : '-') : ''}${Math.abs(v).toLocaleString()} token`);
}
console.log(`\n关键事实召回：${scored.filter((f) => f.ok).length}/${scored.length}`);
for (const f of survived) {
  if (!f.present) {
    console.log(`  – ${f.name}：${JSON.stringify(f.text)}（原文里就没有，不计分）`);
    continue;
  }
  console.log(`  ${f.ok ? '✓' : '✗'} ${f.name}：${JSON.stringify(f.text)}`);
}
if (scored.some((f) => !f.ok)) {
  console.log('\n⚠️ 有关键事实被压掉了，需要调高预算或加规则。');
}
console.log(`\n文风卡（${tokenizer.estimate(styleCard).toFixed(0)} token）：\n${styleCard}`);

// 三档一起跑，给出「省多少 ↔ 关键事实还在不在」的对照表 —— 省得多不多不该只看压缩比
const rows = [];
for (const str of ['light', 'balanced', 'aggressive']) {
  const o = compressPayload({ messages, strength: str, tokenizer, styleCard, tools: TOOLS });
  const text = expandCommands(o.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
  const ok = FACTS.filter((f) => original.includes(f.text) && text.includes(f.text)).length;
  const total = FACTS.filter((f) => original.includes(f.text)).length;
  rows.push({ str, saved: o.stats.savedPct, after: o.stats.afterTokens, facts: `${ok}/${total}` });
}
console.log('\n档位对照（同一份素材）：');
console.log('| 档位 | 压缩后 | 省 | 关键事实保留 |');
console.log('| --- | ---: | ---: | ---: |');
for (const r of rows) console.log(`| ${r.str} | ${r.after.toLocaleString()} tok | ${r.saved}% | ${r.facts} |`);

// 丢了哪条要指名道姓，否则「9/10」没法定位
for (const str of ['light', 'balanced', 'aggressive']) {
  const o = compressPayload({ messages, strength: str, tokenizer, styleCard, tools: TOOLS });
  const text = expandCommands(o.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
  const lost = FACTS.filter((f) => original.includes(f.text) && !text.includes(f.text));
  if (lost.length) console.log(`${str} 丢失的关键事实：${lost.map((f) => `「${f.text}」`).join('、')}`);
}

// 逐条看「关键事实」是被哪条消息弄丢的（排查召回失败用：node scripts/bench-compress.mjs --debug）
if (process.argv.includes('--debug')) {
  const o = compressPayload({ messages, strength: 'light', tokenizer, styleCard, tools: TOOLS });
  o.messages.forEach((m, i) => {
    const c = typeof m.content === 'string' ? m.content : '';
    console.log(`#${i} ${m.role} len=${c.length} flushAnn=${c.includes('flushAnn')} 首40=${JSON.stringify(c.slice(0, 40))}`);
  });
  console.log('stages', o.stats.stages, 'notes', o.stats.notes);
}

/* ---------- 门禁：把「省了」和「没丢事」变成可失败的断言 ---------- */
// 之前只打印数字，谁也不知道哪次改动把召回弄坏了；现在不合格就 exit 1，能挂到 CI 上。
const fails = [];
for (const str of ['light', 'balanced', 'aggressive']) {
  const o = compressPayload({ messages, strength: str, tokenizer, styleCard, tools: TOOLS });
  const text = expandCommands(o.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
  const lost = FACTS.filter((f) => original.includes(f.text) && !text.includes(f.text));
  if (lost.length) fails.push(`${str} 丢了关键事实：${lost.map((f) => f.text).join('、')}`);
  if (o.stats.savedPct < 60) fails.push(`${str} 只省了 ${o.stats.savedPct}%（低于 60% 门禁）`);
  if (o.stats.afterTokens > o.stats.budget * 1.15) {
    fails.push(`${str} 压缩后 ${o.stats.afterTokens} 超出预算 ${o.stats.budget} 的 15%`);
  }
  if (o.messages.length !== messages.length) fails.push(`${str} 删掉了消息（${messages.length} → ${o.messages.length}）`);
  // tool_call 配对不能断：每个 tool 消息都必须有对应的 assistant.tool_calls
  const ids = new Set();
  for (const m of o.messages) for (const tc of m.tool_calls || []) ids.add(tc.id);
  for (const m of o.messages) {
    if (m.role === 'tool' && m.tool_call_id && !ids.has(m.tool_call_id)) fails.push(`${str} 有 tool 消息失去了调用方（${m.tool_call_id}）`);
  }
}
if (fails.length) {
  console.log('\n❌ 门禁未通过：');
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
console.log('\n✅ 门禁通过：三档召回 10/10 · 预算生效 · 消息数与 tool_call 配对所有档位保持');

