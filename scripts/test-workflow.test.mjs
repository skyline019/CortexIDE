/**
 * 十四：提示词合成 / 技能管理 / 工作流引擎 / Plan 解析 的单测。
 *
 * 这几块最容易出「假成功」：技能关掉了却还在提示词里、计划被截断却当完整执行、
 * 工作流有环却照样跑。每条断言都盯这类问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  composeSystemPrompt,
  listSkills,
  setSkillEnabled,
  upsertWorkspaceSkill,
  deleteWorkspaceSkill,
  readPrompts,
  writePrompt,
  parseFrontmatter,
  toFrontmatter,
  estimateTokens,
  SYSTEM_SKILL_IDS,
  MODE_ORDER,
  MODES,
} from '../server/prompts.js';
import { validateGraph, topoOrder, fillTemplate, runWorkflow, pickReadyWave, NODE_TYPES, starterWorkflows } from '../server/workflow.js';
import { extractPlan, validatePlan, repairTruncatedJson, planToMarkdown, buildPlan, planSummary } from '../src/lib/plan.js';
import { MODE_TOOLS, toolsForMode, canParallelTools, pickToolArgs, READONLY_TOOLS } from '../src/lib/agent.js';

/* 每个测试用自己的临时工作区，别污染仓库里的 .cortex */
const tmpRoot = async () => fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-test-'));
const cleanup = (dir) => fsp.rm(dir, { recursive: true, force: true });

/* ------------------------------ 提示词合成 ------------------------------ */

test('提示词：合成顺序是 基座 → 模式 → 技能 → 工作区约定', async () => {
  const root = await tmpRoot();
  try {
    await writePrompt(root, 'workspace', '本仓库一律用 pnpm，不许用 npm。');
    const c = await composeSystemPrompt({ root, mode: 'plan' });
    assert.equal(c.mode, 'plan');
    assert.ok(c.composed.includes('你是 Cortex'), '基座要在');
    assert.ok(c.composed.includes('当前模式：Plan'), '模式段要在');
    assert.ok(c.composed.includes('pnpm'), '工作区约定要在');
    // 顺序：基座 < 模式 < 技能 < 工作区
    const iBase = c.composed.indexOf('你是 Cortex');
    const iMode = c.composed.indexOf('当前模式：Plan');
    const iWs = c.composed.indexOf('仓库一律用 pnpm');
    assert.ok(iBase < iMode && iMode < iWs, `顺序不对：${iBase}/${iMode}/${iWs}`);
    assert.equal(c.sections[0].key, 'base');
    assert.equal(c.sections.at(-1).key, 'workspace', '工作区约定必须排在最后（压过通用规则）');
    assert.ok(c.estTokens > 0);
  } finally {
    await cleanup(root);
  }
});

test('提示词：三种模式的合成结果互不相同，且 ask/plan 不含写操作', async () => {
  const root = await tmpRoot();
  try {
    const out = {};
    for (const m of MODE_ORDER) out[m] = (await composeSystemPrompt({ root, mode: m })).composed;
    assert.notEqual(out.agent, out.ask);
    assert.notEqual(out.ask, out.plan);
    assert.ok(out.agent.includes('执行'));
    assert.ok(out.ask.includes('只读'));
    assert.ok(out.plan.includes('```plan') || out.plan.includes('plan 的格式'), 'plan 模式必须给出 plan 格式');
  } finally {
    await cleanup(root);
  }
});

test('提示词：系统提示词可以被覆盖，也能恢复内置', async () => {
  const root = await tmpRoot();
  try {
    const before = await readPrompts(root);
    assert.equal(before.system.overridden, false);
    assert.equal(before.system.effective, before.system.base);

    await writePrompt(root, 'system', '你是测试用的助手，只说一句话。');
    const after = await readPrompts(root);
    assert.equal(after.system.overridden, true);
    assert.ok(after.system.effective.includes('测试用的助手'));
    const c = await composeSystemPrompt({ root });
    assert.ok(!c.composed.includes('## 行为准则'), '覆盖之后内置准则不该再出现');

    await writePrompt(root, 'system', '');
    const reset = await readPrompts(root);
    assert.equal(reset.system.overridden, false);
    assert.ok(reset.system.effective.includes('## 行为准则'));
  } finally {
    await cleanup(root);
  }
});

/* ------------------------------ 技能 ------------------------------ */

test('技能：系统技能默认全开；关掉之后立刻从合成结果里消失', async () => {
  const root = await tmpRoot();
  try {
    const s0 = await listSkills(root);
    assert.equal(s0.system.length, SYSTEM_SKILL_IDS.length);
    assert.ok(s0.system.every((s) => s.enabled));
    assert.ok(s0.system.every((s) => s.readonly));

    const before = await composeSystemPrompt({ root, mode: 'agent' });
    assert.ok(before.composed.includes('### 代码审查'));

    await setSkillEnabled(root, 'sys.code-review', false);
    const after = await composeSystemPrompt({ root, mode: 'agent' });
    assert.ok(!after.composed.includes('### 代码审查'), '关掉的技能不能还在提示词里');
    assert.ok(after.chars < before.chars, '关掉技能后提示词必须变短');
    assert.ok(!after.skillIds.includes('sys.code-review'));

    const list = await listSkills(root);
    assert.equal(list.system.find((s) => s.id === 'sys.code-review').enabled, false);
  } finally {
    await cleanup(root);
  }
});

test('技能：当前技能是 .cortex/skills 下的真实文件，可增删改', async () => {
  const root = await tmpRoot();
  try {
    const saved = await upsertWorkspaceSkill(root, {
      id: 'release-check',
      name: '发布检查',
      description: '发版前跑一遍',
      whenToUse: '用户说「发版 / 上线」时',
      body: '1. 跑 npm test\n2. 看 git status\n3. 写 CHANGELOG',
    });
    const abs = path.join(root, '.cortex', 'skills', 'release-check.md');
    assert.ok(fs.existsSync(abs), '必须真的写进磁盘');
    const raw = fs.readFileSync(abs, 'utf8');
    assert.ok(raw.startsWith('---\n'), '要有 frontmatter');
    const { meta, body } = parseFrontmatter(raw);
    assert.equal(meta.name, '发布检查');
    assert.ok(body.includes('CHANGELOG'));

    const list = await listSkills(root);
    const ws = list.workspace.find((s) => s.id === 'ws.release-check');
    assert.ok(ws, '列表里要能看到');
    assert.equal(ws.source, 'workspace');

    const c = await composeSystemPrompt({ root });
    assert.ok(c.composed.includes('### 发布检查'), '当前技能要进提示词');
    assert.ok(c.composed.includes('发版前跑一遍') === false, '描述不进正文（只有 whenToUse 与 body 进）');
    assert.ok(c.composed.includes('CHANGELOG'));

    // 开关写回 frontmatter，跟着文件走
    await setSkillEnabled(root, 'ws.release-check', false);
    assert.equal(parseFrontmatter(fs.readFileSync(abs, 'utf8')).meta.enabled, 'false');
    assert.ok(!(await composeSystemPrompt({ root })).composed.includes('### 发布检查'));

    await deleteWorkspaceSkill(root, 'ws.release-check');
    assert.equal(fs.existsSync(abs), false);
    assert.equal((await listSkills(root)).workspace.length, 0);
    assert.deepEqual(saved.id, 'ws.release-check');
  } finally {
    await cleanup(root);
  }
});

test('技能：非法输入要拒绝（空正文 / 非法 id）', async () => {
  const root = await tmpRoot();
  try {
    await assert.rejects(() => upsertWorkspaceSkill(root, { id: 'x', body: '   ' }), /正文不能为空/);
    await assert.rejects(() => upsertWorkspaceSkill(root, { id: '!!!', body: 'hi' }), /id 不能为空/);
    // id 合法但文件不存在 → 明确说「不存在」；id 本身非法 → 说「非法 id」（两种都要分得清）
    await assert.rejects(() => deleteWorkspaceSkill(root, 'ghost'), /技能不存在/);
    await assert.rejects(() => deleteWorkspaceSkill(root, '不是合法的'), /非法技能 id/);
  } finally {
    await cleanup(root);
  }
});

test('frontmatter：解析与生成能对得上', () => {
  const text = toFrontmatter({ name: '甲', enabled: 'true' }, '正文一\n正文二');
  const { meta, body } = parseFrontmatter(text);
  assert.equal(meta.name, '甲');
  assert.equal(meta.enabled, 'true');
  assert.equal(body, '正文一\n正文二');
  // 没有 frontmatter 也不能崩
  assert.deepEqual(parseFrontmatter('裸文本'), { meta: {}, body: '裸文本' });
});

test('token 估算：中文比等长英文贵得多', () => {
  const zh = estimateTokens('这是一个中文句子用来估算 token');
  const en = estimateTokens('this is an english sentence for token estimate');
  assert.ok(zh > en, `中文 ${zh} 应大于英文 ${en}`);
});

/* ------------------------------ 模式与工具 ------------------------------ */

test('模式：工具白名单与服务端提示词描述一致（只读模式不能有写/执行）', () => {
  assert.deepEqual(MODE_ORDER, ['agent', 'ask', 'plan']);
  for (const m of MODE_ORDER) assert.ok(MODES[m].prompt.length > 40, `${m} 模式缺提示词`);
  const ask = MODE_TOOLS.ask;
  const plan = MODE_TOOLS.plan;
  for (const t of ['write_file', 'run_command', 'remember']) {
    assert.ok(!ask.includes(t), `ask 模式不应有 ${t}`);
    assert.ok(!plan.includes(t), `plan 模式不应有 ${t}`);
  }
  assert.ok(MODE_TOOLS.agent.includes('write_file') && MODE_TOOLS.agent.includes('run_command'));
  // 真正发出去的 specs 也要跟着过滤
  assert.equal(toolsForMode('ask').length, 4);
  assert.equal(toolsForMode('agent').length, 7);
  assert.ok(toolsForMode('ask').every((t) => !['write_file', 'run_command'].includes(t.function.name)));
});

/* ------------------------------ 工作流图 ------------------------------ */

const wfOf = (nodes, edges) => ({ id: 't', name: 't', nodes, edges });

test('工作流：校验能挑出缺输入/缺产物/断连/成环', () => {
  assert.equal(validateGraph(wfOf([{ id: 'a', type: 'input', x: 0, y: 0, data: {} }], [])).ok, false);
  const noStart = validateGraph(wfOf([{ id: 'b', type: 'output', x: 0, y: 0, data: {} }], []));
  assert.ok(noStart.errors.some((e) => e.includes('缺少「输入」')));

  const dangling = validateGraph(
    wfOf(
      [
        { id: 'a', type: 'input', x: 0, y: 0, data: {} },
        { id: 'b', type: 'output', x: 1, y: 0, data: {} },
      ],
      [],
    ),
  );
  assert.ok(dangling.errors.some((e) => e.includes('没有输入连线')));

  const cyc = validateGraph(
    wfOf(
      [
        { id: 'a', type: 'input', x: 0, y: 0, data: {} },
        { id: 'b', type: 'ai', x: 1, y: 0, data: {} },
        { id: 'c', type: 'output', x: 2, y: 0, data: {} },
      ],
      [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'c' },
        { id: 'e3', from: 'c', to: 'b' },
      ],
    ),
  );
  assert.ok(cyc.errors.some((e) => e.includes('环')));
});

test('工作流：拓扑序稳定，线性链按顺序', () => {
  const wf = wfOf(
    [
      { id: 'n1', type: 'input', x: 0, y: 0, data: {} },
      { id: 'n2', type: 'read', x: 1, y: 0, data: { path: 'a' } },
      { id: 'n3', type: 'output', x: 2, y: 0, data: {} },
    ],
    [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
    ],
  );
  assert.deepEqual(topoOrder(wf), ['n1', 'n2', 'n3']);
});

test('工作流：模板占位符 {{input}} / {{prev}} / {{nodes.x}}', () => {
  assert.equal(
    fillTemplate('前 {{input}} 中 {{prev}} 后 {{nodes.n2}} 缺 {{nope}}', { input: 'A', prev: 'B', 'nodes.n2': 'C' }),
    '前 A 中 B 后 C 缺 ',
  );
});

test('工作流：分支只走一条路，另一条被跳过（不是失败）', async () => {
  const root = await tmpRoot();
  try {
    const wf = wfOf(
      [
        { id: 'n1', type: 'input', x: 0, y: 0, data: {} },
        { id: 'n2', type: 'branch', x: 1, y: 0, data: { op: 'contains', value: '命中' } },
        { id: 'n3', type: 'write', x: 2, y: 0, data: { path: 'yes.txt', content: '{{prev}}' } },
        { id: 'n4', type: 'write', x: 2, y: 1, data: { path: 'no.txt', content: '{{prev}}' } },
        { id: 'n5', type: 'output', x: 3, y: 0, data: { title: 'yes' } },
        { id: 'n6', type: 'output', x: 3, y: 1, data: { title: 'no' } },
      ],
      [
        { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
        { id: 'e2', from: 'n2', to: 'n3', fromPort: 'true' },
        { id: 'e3', from: 'n2', to: 'n4', fromPort: 'false' },
        { id: 'e4', from: 'n3', to: 'n5', fromPort: 'default' },
        { id: 'e5', from: 'n4', to: 'n6', fromPort: 'default' },
      ],
    );
    const events = [];
    const r = await runWorkflow({ root, workflow: wf, input: '这里命中了一次', emit: (e) => events.push(e) });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(path.join(root, 'yes.txt')), 'true 分支要真的写文件');
    assert.equal(fs.existsSync(path.join(root, 'no.txt')), false, 'false 分支不该执行');
    const skipped = events.filter((e) => e.type === 'node-skip').map((e) => e.id);
    assert.ok(skipped.includes('n4') && skipped.includes('n6'), `跳过的节点：${skipped}`);
    assert.ok(events.some((e) => e.type === 'run-done'));
  } finally {
    await cleanup(root);
  }
});

test('工作流：写文件越界（../）必须被拒绝，不能写到工作区外面', async () => {
  const root = await tmpRoot();
  try {
    const wf = wfOf(
      [
        { id: 'n1', type: 'input', x: 0, y: 0, data: {} },
        { id: 'n2', type: 'write', x: 1, y: 0, data: { path: '../../evil.txt', content: 'x' } },
        { id: 'n3', type: 'output', x: 2, y: 0, data: {} },
      ],
      [
        { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
        { id: 'e2', from: 'n2', to: 'n3', fromPort: 'default' },
      ],
    );
    const r = await runWorkflow({ root, workflow: wf, input: '', emit: () => {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /越界/);
  } finally {
    await cleanup(root);
  }
});

test('工作流：白名单外的命令直接失败（和终端同一条闸门）', async () => {
  const root = await tmpRoot();
  try {
    const wf = wfOf(
      [
        { id: 'n1', type: 'input', x: 0, y: 0, data: {} },
        { id: 'n2', type: 'shell', x: 1, y: 0, data: { cmd: 'rm -rf /' } },
        { id: 'n3', type: 'output', x: 2, y: 0, data: {} },
      ],
      [
        { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
        { id: 'e2', from: 'n2', to: 'n3', fromPort: 'default' },
      ],
    );
    const r = await runWorkflow({ root, workflow: wf, input: '', emit: () => {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /白名单|危险/);
  } finally {
    await cleanup(root);
  }
});

/* ------------------------------ Plan 解析 ------------------------------ */

test('Plan：能解析标准 ```plan 块', () => {
  const text = `先做这些：\n\n\`\`\`plan\n{"goal":"加一个字段","steps":[{"id":1,"title":"读文件","tool":"read_file","args":{"path":"a.js"},"why":"确认现状","expect":"看到字段"}]}\n\`\`\``;
  const r = extractPlan(text);
  assert.equal(r.ok, true);
  assert.equal(r.plan.steps.length, 1);
  assert.equal(r.plan.steps[0].tool, 'read_file');
  assert.equal(r.repaired, false);
});

test('Plan：写文件必须有完整内容，占位文本要被拒', () => {
  const bad = validatePlan({ goal: 'g', steps: [{ tool: 'write_file', args: { path: 'a.js', content: '同上' } }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('占位')));
  const empty = validatePlan({ goal: 'g', steps: [{ tool: 'write_file', args: { path: 'a.js', content: '   ' } }] });
  assert.equal(empty.ok, false);
  const good = validatePlan({ goal: 'g', steps: [{ tool: 'write_file', args: { path: 'a.js', content: 'export const a = 1;' } }] });
  assert.equal(good.ok, true);
});

test('Plan：不认识的工具要明确报错，而不是静默忽略', () => {
  const r = validatePlan({ goal: 'g', steps: [{ tool: 'delete_everything', args: {} }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('不支持'));
});

test('Plan：被截断的 JSON 能恢复完整步骤，并标记 repaired', () => {
  const truncated = '{"goal":"测试","steps":[{"id":1,"tool":"read_file","args":{"path":"x"}},{"id":2,"tool":"read_file","args":{"path":"y"}},{"id":3,"tool":"read_file","args":{"pa';
  const rec = repairTruncatedJson(truncated);
  assert.ok(rec, '应该能恢复');
  assert.equal(rec.steps.length, 2, '只保留两个完整步骤');

  const r = extractPlan('```plan\n' + truncated + '```');
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.match(r.note, /截断/);
});

test('Plan：没有 plan 块 / JSON 全坏时如实失败', () => {
  assert.equal(extractPlan('我建议你先读一下文件。').ok, false);
  assert.equal(extractPlan('```plan\n{不是 json}\n```').ok, false);
});

test('Plan：构建按顺序执行；中途失败不算成功', async () => {
  const calls = [];
  const tools = {
    read_file: async (a) => {
      calls.push(`read:${a.path}`);
      return { totalLines: 3 };
    },
    write_file: async (a) => {
      calls.push(`write:${a.path}`);
      if (a.path === 'boom.js') throw new Error('磁盘满');
      return { path: a.path, created: true };
    },
  };
  const ok = await buildPlan({
    steps: [
      { id: 1, tool: 'read_file', args: { path: 'a' } },
      { id: 2, tool: 'write_file', args: { path: 'b', content: 'x' } },
    ],
    tools,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, ['read:a', 'write:b']);
  assert.equal(ok.ran, 2);
  assert.equal(ok.aborted, false);

  const fail = await buildPlan({
    steps: [
      { id: 1, tool: 'read_file', args: { path: 'a' } },
      { id: 2, tool: 'write_file', args: { path: 'boom.js', content: 'x' } },
      { id: 3, tool: 'read_file', args: { path: 'c' } },
    ],
    tools,
  });
  assert.equal(fail.ok, false, '中途失败不能报成功');
  assert.equal(fail.ran, 2);
  assert.equal(fail.stopped, true);
  assert.equal(fail.aborted, false);
});

test('Plan：空计划算成功；缺工具与抛错共用 stopOnError', async () => {
  const empty = await buildPlan({ steps: [], tools: {} });
  assert.equal(empty.ok, true, '空计划 = 无事可做 = 成功');
  assert.equal(empty.ran, 0);
  assert.equal(empty.total, 0);
  assert.equal(empty.aborted, false);

  const missing = await buildPlan({
    steps: [
      { id: 1, tool: 'read_file', args: { path: 'a' } },
      { id: 2, tool: 'write_file', args: { path: 'b', content: 'x' } },
      { id: 3, tool: 'read_file', args: { path: 'c' } },
    ],
    tools: { read_file: async () => ({ totalLines: 1 }) },
    stopOnError: true,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ran, 2, '缺工具与抛错一样：失败后不再跑后面的步');
  assert.equal(missing.results[1].ok, false);
  assert.match(missing.results[1].detail, /没有这个工具/);
  assert.equal(missing.stopped, true);
});

test('Plan：args 必须是普通对象，且只保留白名单字段', () => {
  const arr = validatePlan({ goal: 'g', steps: [{ tool: 'run_command', args: ['rm -rf /'] }] });
  assert.equal(arr.ok, false);
  assert.ok(arr.errors.some((e) => e.includes('普通对象')));

  // 用 JSON.parse 构造带 __proto__ 键的普通对象（对象字面量会改原型，测的就不是「模型输出」了）
  const dirty = validatePlan({
    goal: 'g',
    steps: [{ tool: 'read_file', args: JSON.parse('{"path":"a.js","__proto__":{"polluted":1},"evil":true,"offset":2}') }],
  });
  assert.equal(dirty.ok, true);
  assert.deepEqual(Object.keys(dirty.plan.steps[0].args).sort(), ['offset', 'path']);
  assert.equal(dirty.plan.steps[0].args.path, 'a.js');
  assert.equal(dirty.plan.steps[0].args.offset, 2);
  assert.equal(Object.prototype.polluted, undefined, '不能污染原型');
});

test('Plan：有围栏时正文 JSON 不干扰；错误全部累积', () => {
  const text = [
    '示例：{"steps":[{"tool":"bad"}]}',
    '',
    '```plan',
    '{"goal":"真计划","steps":[{"id":1,"tool":"delete_everything","args":{}}]}',
    '```',
  ].join('\n');
  const r = extractPlan(text);
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持/);
  assert.ok(!r.error.includes('JSON 解析失败') || r.error.includes('不支持'), '应以围栏内校验错误为主');
});

test('Plan：导出的 markdown 含每一步与可复制的 JSON', () => {
  const plan = {
    goal: '目标',
    steps: [
      { id: 1, title: '读', tool: 'read_file', args: { path: 'a.js' }, why: '因为', expect: '看到' },
      { id: 2, title: '搜', tool: 'search_files', args: { query: 'foo' }, why: '', expect: '' },
      { id: 3, title: '写 | 管道', tool: 'write_file', args: { path: 'b.js', content: 'x' }, why: '', expect: '' },
    ],
  };
  const md = planToMarkdown(plan, { mode: 'plan', at: 0 });
  assert.ok(md.includes('# 计划：目标'));
  assert.ok(md.includes('`read_file`'));
  assert.ok(md.includes('```plan'));
  assert.ok(md.includes('写 \\| 管道'), '表格里的竖线要转义，否则表格会错列');
  assert.ok(md.includes('读文件 1'), '文案要区分读文件与查询');
  assert.ok(md.includes('查询 1'));
  const s = planSummary(plan);
  assert.equal(s.reads, 1);
  assert.equal(s.queries, 1);
  assert.equal(s.writes, 1);
});

test('工作流：八种节点都有中文名与说明；内置模板全部能通过校验', () => {
  const ids = Object.keys(NODE_TYPES);
  for (const id of ['input', 'read', 'search', 'ai', 'shell', 'write', 'branch', 'output']) {
    assert.ok(ids.includes(id), `缺节点类型 ${id}`);
    assert.ok(NODE_TYPES[id].label && NODE_TYPES[id].desc, `${id} 缺中文名/说明`);
  }
  const starters = starterWorkflows();
  assert.ok(starters.length >= 3);
  for (const wf of starters) {
    const v = validateGraph({ ...wf, nodes: wf.nodes, edges: wf.edges });
    assert.equal(v.ok, true, `${wf.id} 不合法：${v.errors.join('；')}`);
  }
});

test('工作流：同层兄弟节点可并行；产物都落盘', async () => {
  const root = await tmpRoot();
  try {
    const wf = wfOf(
      [
        { id: 'n1', type: 'input', x: 0, y: 0, data: {} },
        { id: 'n2', type: 'write', x: 1, y: 0, data: { path: 'a.txt', content: 'AAA-{{input}}' } },
        { id: 'n3', type: 'write', x: 1, y: 1, data: { path: 'b.txt', content: 'BBB-{{input}}' } },
        { id: 'n4', type: 'output', x: 2, y: 0, data: { title: 'out' } },
      ],
      [
        { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
        { id: 'e2', from: 'n1', to: 'n3', fromPort: 'default' },
        { id: 'e3', from: 'n2', to: 'n4', fromPort: 'default' },
        { id: 'e4', from: 'n3', to: 'n4', fromPort: 'default' },
      ],
    );
    const events = [];
    const r = await runWorkflow({ root, workflow: wf, input: 'X', emit: (e) => events.push(e) });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'AAA-X');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'BBB-X');
    assert.ok(r.parallelNodes >= 2, `应并行跑兄弟写节点，parallelNodes=${r.parallelNodes}`);
    assert.ok(events.some((e) => e.type === 'wave-start' && e.parallel), '应发出 wave-start');
  } finally {
    await cleanup(root);
  }
});

test('工作流：pickReadyWave 在上游未完成时不提前放行', () => {
  const order = ['n1', 'n2', 'n3'];
  const pending = new Set(order);
  const done = new Set();
  const edges = [
    { from: 'n1', to: 'n2', fromPort: 'default' },
    { from: 'n2', to: 'n3', fromPort: 'default' },
  ];
  const active = new Set();
  let w = pickReadyWave({ order, pending, done, edges, active });
  assert.deepEqual(w.ready, ['n1']);
  assert.deepEqual(w.skip, []);

  done.add('n1');
  pending.delete('n1');
  active.add('n1|default');
  w = pickReadyWave({ order, pending, done, edges, active });
  assert.deepEqual(w.ready, ['n2']);
});

test('Agent：只读工具可并行；含写/执行则串行', () => {
  assert.equal(
    canParallelTools([
      { function: { name: 'read_file' } },
      { function: { name: 'search_files' } },
    ]),
    true,
  );
  assert.equal(
    canParallelTools([
      { function: { name: 'read_file' } },
      { function: { name: 'write_file' } },
    ]),
    false,
  );
  assert.equal(canParallelTools([{ function: { name: 'read_file' } }]), false, '单个不必并行');
  for (const t of READONLY_TOOLS) assert.ok(MODE_TOOLS.ask.includes(t) || MODE_TOOLS.plan.includes(t));
});

test('Agent：pickToolArgs 只保留白名单字段', () => {
  assert.deepEqual(pickToolArgs({ path: 'a.js', evil: 1, offset: 2 }), { path: 'a.js', offset: 2 });
  assert.deepEqual(pickToolArgs(['x']), {});
  assert.deepEqual(pickToolArgs(null), {});
});
