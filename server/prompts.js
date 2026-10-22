/**
 * 提示词与技能中枢（服务端唯一事实来源）。
 *
 * 为什么要放在服务端而不是前端某一个常量里：
 *  1) 系统提示词、（可选的）覆盖稿、当前工作区提示词、启用的技能，要能被**同一个合成函数**
 *     拼成最终发给模型的那段文本 —— 工作流里的 AI 节点和聊天里的 Agent 用的必须是同一份，
 *     否则「我在设置里改了提示词，工作流却没变」这种坑迟早出现；
 *  2) 组装结果要能被 UI 预览、被测试断言（chars / tokens / 段落顺序），放服务端才好测。
 *
 * 落盘位置（都在工作区里，可 git 管理、可 diff）：
 *   .cortex/prompt/system.md     系统提示词的覆盖稿（不存在 = 用内置原文）
 *   .cortex/prompt/workspace.md  当前提示词（这个工作区特有的约定）
 *   .cortex/skills/<id>.md       当前技能（带 frontmatter）
 *   .cortex/skills-state.json    系统技能的开关状态 + 禁用的内置技能
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 内置：系统提示词                                                     */
/* ------------------------------------------------------------------ */

/**
 * 内置系统提示词（只读基线）。改这里等于改产品行为，所以它有一个版本号，
 * 覆盖稿里会记「基于哪一版改的」，避免以后内置升级了、覆盖稿悄悄把新规则顶掉。
 */
export const BASE_PROMPT_VERSION = 3;

export const BASE_SYSTEM_PROMPT = `你是 Cortex，一个运行在浏览器 IDE 里的编程 Agent。

## 行为准则
1. 用中文回答，先给结论，再给细节；代码块必须标注语言。
2. 需要看代码就先调用 read_file / search_files，不要凭空假设文件内容。文件超过 300 行时用 offset/limit 分段读，不要臆测没读到的部分。
3. 用户表达偏好、项目约定、技术决策时，主动调用 remember 记录，并在回答里一句话说明记了什么。
4. 需要改代码时用 write_file 写入完整文件内容，然后在回答里说明改了哪几处。
5. 改完代码后主动用 run_command 跑测试或构建（例如 pnpm test / pnpm build），看到失败就继续修，直到通过或说明原因。
6. 不要臆造不存在的文件；不确定时先 list_files。
7. 命令必须简短、可预期，不要用 ; | && 拼接，不要做删除类操作。
8. 涉及求和、计数、均值、排序、日期差这类计算时，不要心算：用 run_command 跑一小段 node 代码核对，并把结果贴出来；心算出来的数字要标明是估算。`;

/* ------------------------------------------------------------------ */
/* 内置：三种 Agent 模式                                                */
/* ------------------------------------------------------------------ */

export const MODES = {
  agent: {
    id: 'agent',
    name: 'Agent',
    tagline: '能读能写能跑命令，干完自己验证',
    hint: '全工具：读文件 / 写文件 / 跑白名单命令 / 记忆读写',
    tools: ['read_file', 'write_file', 'list_files', 'search_files', 'run_command', 'remember', 'recall'],
    readonly: false,
    prompt: `## 当前模式：Agent（执行）
你可以直接改文件、跑命令。动手前先说一句要做什么；改完自己跑测试或构建验证，失败了继续修，别把「应该能过」当结论。
不要在没读过的文件上做修改。命令走白名单，危险操作会被拦下来 —— 被拦了就换方案，不要试图绕过。`,
  },
  ask: {
    id: 'ask',
    name: 'Ask',
    tagline: '只读问答，不改你的代码',
    hint: '只读工具：读文件 / 列举 / 搜索 / 记忆检索',
    tools: ['read_file', 'list_files', 'search_files', 'recall'],
    readonly: true,
    prompt: `## 当前模式：Ask（只读问答）
你**只能读**（read_file / list_files / search_files / recall），不能写文件、不能执行命令。
用户要的是答案，不是改动：回答里不要出现「我已经把它改了」这类表述；需要改动时给出可以直接粘贴的代码或明确步骤，并说明「切到 Agent 模式我可以直接改」。
如果答案依赖磁盘上的真实内容，先读再答，不要靠印象。`,
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    tagline: '先只读探索，产出可一键构建的计划',
    hint: '只读探索 + 必须输出可执行的 JSON 计划',
    tools: ['read_file', 'list_files', 'search_files', 'recall'],
    readonly: true,
    prompt: `## 当前模式：Plan（先规划，后执行）
你**只能读**，不能写文件、不能执行命令。任务是：把用户的需求变成一份**可以被机器直接执行**的计划。

工作方式（**注意探索预算，别把轮次花在读同一个文件上**）：
0. 预算：最多读 3 个文件，每个文件最多读 1 次（read_file 的 limit 直接给 400，一次读完）。**信息不够也要出计划** —— 把「读某个文件确认」写成计划里的第一步，而不是自己反复读。
1. 先用 read_file / list_files / search_files 把关键事实摸清楚（涉及哪些文件、现状是什么）。不许在没有依据的情况下编造文件路径。
2. 回答分两部分：先用 3~6 行说清楚方案与风险；然后**必须**输出一个 \`\`\`plan 代码块，里面是**严格合法的 JSON**。
3. plan 的格式：
{"goal":"一句话目标","steps":[{"id":1,"title":"步骤标题","tool":"read_file|write_file|run_command|search_files|list_files|recall","args":{"path":"src/App.jsx"},"why":"为什么要这一步","expect":"这一步做完应该看到什么"}]}
4. 规则：
   - 步骤要能直接执行：write_file 的 args 里给 \`path\` 与 \`content\`（完整文件内容，不要写「同上」）；run_command 的 args 里给 \`cmd\`。
   - 只读步骤（read_file / search_files / list_files / recall）放前面，写和跑放后面。
   - 每步只做一件事，别把「改三个文件」塞进一步。
   - **控制篇幅**：总步数 ≤ 8；每步的 \`title\` ≤ 24 字、\`why\` ≤ 20 字、\`expect\` ≤ 20 字。写不下就说明该拆成多次对话，而不是把 JSON 撑爆（输出被截断的计划是没法执行的）。
   - 不要放删除、清库、改系统配置这类不可逆步骤；确实需要就写进正文当「人工步骤」，不进 plan。
   - 如果任务根本不需要改代码（只是回答问题），plan 里可以只放只读步骤。
5. plan 块之外不要再出现第二段 JSON。`,
  },
};

export const MODE_ORDER = ['agent', 'ask', 'plan'];

/* ------------------------------------------------------------------ */
/* 内置：系统技能                                                       */
/* ------------------------------------------------------------------ */

/**
 * 系统技能：随产品发布，正文只读，但可以在「设置 → 技能」里关掉。
 * 每个技能都写清 whenToUse —— 这段会进提示词，模型靠它判断要不要按这个套路走。
 */
export const SYSTEM_SKILLS = [
  {
    id: 'sys.code-review',
    name: '代码审查',
    description: '按固定清单审一段代码，输出可执行的修改项',
    whenToUse: '用户要求 review / 审查 / 挑毛病，或让你看某段实现有没有坑时',
    body: `1. 先读完整文件，不要只看片段就下结论。
2. 按这个顺序查：正确性（边界、空值、并发、错误处理）→ 资源（泄漏、未关闭、无上限增长）→ 可读性（命名、重复、过长函数）→ 性能（N+1、重复计算、不必要的拷贝）。
3. 每条问题给出：位置（文件:行）、为什么是问题、怎么改（能直接粘贴的代码）。
4. 分「必须改」和「建议改」两档；没有问题的项不要凑数。
5. 不要顺手改文件，除非用户明确要求修。`,
  },
  {
    id: 'sys.root-cause',
    name: '报错定位',
    description: '从一段报错逆推到根因，并给出验证方法',
    whenToUse: '用户贴了报错、堆栈，或说「跑不起来 / 测试挂了」时',
    body: `1. 先把报错里最关键的一行抄出来（异常类型 + 消息），不要一上来就解释全文。
2. 找到指向自己的那一帧栈（不是 node_modules 里的），读那个文件的上下文。
3. 区分「症状」和「根因」：症状是抛错的位置，根因通常在上游（空值、类型不符、时序）。
4. 给出验证方法：一条能复现的最小命令，或一段能打印关键变量的代码。
5. 修完必须重跑那条命令证明好了；没验证就说「还没验证」。`,
  },
  {
    id: 'sys.refactor-safe',
    name: '安全重构',
    description: '行为不变的前提下改结构，改完必须仍然通过测试',
    whenToUse: '用户要求重构 / 抽取公共函数 / 拆分文件时',
    body: `1. 重构前先跑一遍现有测试，记下基线（通过几项、哪些本来就失败）。
2. 一次只做一种变换（提取函数 / 改名 / 移动文件），不要混在一起。
3. 改完重跑同一套测试，结果必须与基线一致（本来就失败的仍失败，不能多）。
4. 对外导出（export）的签名不变；真要改就在回答里单独列出破坏性变更。
5. 不允许「顺手改逻辑」，发现 bug 单独说，不要夹在重构里。`,
  },
  {
    id: 'sys.test-first',
    name: '写测试',
    description: '先写会失败的测试，再实现到通过',
    whenToUse: '用户要求加测试 / 保证覆盖 / 修 bug 需要回归时',
    body: `1. 先明确被测行为，一条断言只测一件事。
2. 覆盖：正常路径、边界（空 / 0 / 超大）、错误路径（抛错、非法输入）。
3. 断言要能真的失败：不要写 expect(x).toBeTruthy() 这种永远为真的断言。
4. 用项目已有的测试框架与脚本（先看 package.json 的 scripts 与现有 test 文件风格）。
5. 跑通后贴出通过数量；失败就修到通过，不要改断言来迁就实现。`,
  },
  {
    id: 'sys.docs-sync',
    name: '文档同步',
    description: '改完代码顺手把 README / 注释对齐',
    whenToUse: '用户改了对外行为（命令、接口、配置项）并希望文档跟上时',
    body: `1. 找出文档里描述这块行为的地方（README、docs/、函数头注释），全部列出来。
2. 只改与本次行为变化相关的段落，不要整篇重写。
3. 数字（项数、文件数、耗时）必须是真跑出来的，不许估。
4. 改完把命令贴出来，证明文档里写的命令能跑通。`,
  },
];

/* ------------------------------------------------------------------ */
/* 落盘：读写                                                          */
/* ------------------------------------------------------------------ */

const FILES = {
  systemOverride: path.join('.cortex', 'prompt', 'system.md'),
  workspace: path.join('.cortex', 'prompt', 'workspace.md'),
  skillsState: path.join('.cortex', 'skills-state.json'),
  skillsDir: path.join('.cortex', 'skills'),
};

function rootOf(root) {
  return root || process.env.CORTEX_WORKSPACE || process.cwd();
}

async function readMaybe(abs) {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeEnsure(abs, text) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

/** 极简 frontmatter：`---` 包起来的 key: value，够用且不用引依赖 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text.trim() };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: text.trim() };
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, '').trim();
  const meta = {};
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[m[1]] = v;
  }
  return { meta, body };
}

export function toFrontmatter(meta, body) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body || '').trim()}\n`;
}

/** 当前工作区技能：`.cortex/skills/*.md` */
export async function listWorkspaceSkills(root) {
  const dir = path.join(rootOf(root), FILES.skillsDir);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const abs = path.join(dir, name);
    const raw = await readMaybe(abs);
    if (raw == null) continue;
    const { meta, body } = parseFrontmatter(raw);
    const id = name.replace(/\.md$/, '');
    out.push({
      id: `ws.${id}`,
      fileId: id,
      source: 'workspace',
      name: meta.name || id,
      description: meta.description || '',
      whenToUse: meta.whenToUse || meta.when || '',
      enabled: meta.enabled !== 'false',
      chars: body.length,
      body,
      file: `.cortex/skills/${name}`,
      updatedAt: meta.updatedAt ? Number(meta.updatedAt) : null,
    });
  }
  return out;
}

async function readSkillsState(root) {
  const raw = await readMaybe(path.join(rootOf(root), FILES.skillsState));
  if (!raw) return { disabled: [], workspaceDisabled: [] };
  try {
    const j = JSON.parse(raw);
    return {
      disabled: Array.isArray(j.disabled) ? j.disabled : [],
      workspaceDisabled: Array.isArray(j.workspaceDisabled) ? j.workspaceDisabled : [],
    };
  } catch {
    return { disabled: [], workspaceDisabled: [] };
  }
}

/** 全部技能：系统（内置 + 开关状态）与当前（工作区文件） */
export async function listSkills(root) {
  const state = await readSkillsState(root);
  const system = SYSTEM_SKILLS.map((s) => ({
    ...s,
    source: 'system',
    enabled: !state.disabled.includes(s.id),
    chars: s.body.length,
    readonly: true,
  }));
  const workspace = (await listWorkspaceSkills(root)).map((s) => ({
    ...s,
    enabled: s.enabled && !state.workspaceDisabled.includes(s.id),
    readonly: false,
  }));
  return { system, workspace, state };
}

/** 只取「启用中的技能」，用于合成提示词 */
export async function enabledSkills(root) {
  const { system, workspace } = await listSkills(root);
  return [...system, ...workspace].filter((s) => s.enabled);
}

export async function setSkillEnabled(root, id, enabled) {
  const abs = path.join(rootOf(root), FILES.skillsState);
  const state = await readSkillsState(root);
  if (id.startsWith('ws.')) {
    // 工作区技能的开关写回它自己的 frontmatter，跟着文件走（换台机器也一致）
    const fileId = id.slice(3);
    const file = path.join(rootOf(root), FILES.skillsDir, `${fileId}.md`);
    const raw = await readMaybe(file);
    if (raw == null) throw new Error(`技能不存在：${id}`);
    const { meta, body } = parseFrontmatter(raw);
    meta.enabled = enabled ? 'true' : 'false';
    meta.updatedAt = String(Date.now());
    await writeEnsure(file, toFrontmatter(meta, body));
    return;
  }
  const set = new Set(state.disabled);
  if (enabled) set.delete(id);
  else set.add(id);
  await writeEnsure(abs, `${JSON.stringify({ ...state, disabled: [...set].sort() }, null, 2)}\n`);
}

export async function upsertWorkspaceSkill(root, { id, name, description, whenToUse, body, enabled = true }) {
  const fileId = String(id || '')
    .replace(/^ws\./, '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!fileId) throw new Error('技能 id 不能为空（允许字母、数字、-、_）');
  const text = String(body || '').trim();
  if (!text) throw new Error('技能正文不能为空');
  const file = path.join(rootOf(root), FILES.skillsDir, `${fileId}.md`);
  const prev = await readMaybe(file);
  const { meta } = prev ? parseFrontmatter(prev) : { meta: {} };
  const next = toFrontmatter(
    {
      ...meta,
      name: name || meta.name || fileId,
      description: description ?? meta.description ?? '',
      whenToUse: whenToUse ?? meta.whenToUse ?? '',
      enabled: enabled ? 'true' : 'false',
      createdAt: meta.createdAt || String(Date.now()),
      updatedAt: String(Date.now()),
    },
    text,
  );
  await writeEnsure(file, next);
  return { id: `ws.${fileId}`, file: `.cortex/skills/${fileId}.md`, bytes: Buffer.byteLength(next) };
}

export async function deleteWorkspaceSkill(root, id) {
  const fileId = String(id || '').replace(/^ws\./, '');
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) throw new Error('非法技能 id');
  const file = path.join(rootOf(root), FILES.skillsDir, `${fileId}.md`);
  try {
    await fs.unlink(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`技能不存在：${id}`);
    throw err;
  }
  return { deleted: `.cortex/skills/${fileId}.md` };
}

/* ------------------------------------------------------------------ */
/* 落盘：提示词                                                        */
/* ------------------------------------------------------------------ */

export async function readPrompts(root) {
  const base = rootOf(root);
  const override = await readMaybe(path.join(base, FILES.systemOverride));
  const workspace = (await readMaybe(path.join(base, FILES.workspace))) || '';
  return {
    system: {
      base: BASE_SYSTEM_PROMPT,
      version: BASE_PROMPT_VERSION,
      override,
      effective: override ?? BASE_SYSTEM_PROMPT,
      overridden: override != null,
      path: FILES.systemOverride,
      readonlyBase: true,
    },
    workspace: {
      text: workspace,
      path: FILES.workspace,
      exists: workspace.length > 0,
    },
    mode: MODES,
    order: MODE_ORDER,
  };
}

export async function writePrompt(root, scope, text) {
  const base = rootOf(root);
  if (scope === 'system') {
    const file = path.join(base, FILES.systemOverride);
    if (text == null || !String(text).trim()) {
      // 传空 = 恢复内置原文（删掉覆盖稿）
      try {
        await fs.unlink(file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return { scope, reset: true, path: FILES.systemOverride };
    }
    await writeEnsure(file, `${String(text).trimEnd()}\n`);
    return { scope, path: FILES.systemOverride, chars: String(text).length };
  }
  if (scope === 'workspace') {
    const file = path.join(base, FILES.workspace);
    if (text == null || !String(text).trim()) {
      try {
        await fs.unlink(file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return { scope, reset: true, path: FILES.workspace };
    }
    await writeEnsure(file, `${String(text).trimEnd()}\n`);
    return { scope, path: FILES.workspace, chars: String(text).length };
  }
  throw new Error(`未知的提示词范围：${scope}`);
}

/* ------------------------------------------------------------------ */
/* 合成                                                                */
/* ------------------------------------------------------------------ */

/**
 * 合成最终系统提示词。
 *
 * 顺序是有讲究的：基座 → 模式 → 系统技能 → 当前技能 → 当前提示词。
 * 越靠后越「具体」，模型对后出现的具体约定更敏感；
 * 而工作区自己的约定放在最后，就是为了压过通用规则。
 *
 * @param {object} opts
 * @param {string} [opts.root] 工作区根
 * @param {'agent'|'ask'|'plan'} [opts.mode]
 * @param {string[]} [opts.skills] 只启用这些 id（不传 = 用落盘的开关状态）
 * @param {boolean} [opts.withSkills] 是否附加技能正文（默认 true）
 */
export async function composeSystemPrompt({ root, mode = 'agent', skills, withSkills = true } = {}) {
  const prompts = await readPrompts(root);
  const m = MODES[mode] || MODES.agent;
  let list = withSkills ? await enabledSkills(root) : [];
  if (Array.isArray(skills)) {
    const want = new Set(skills);
    const all = await listSkills(root);
    list = [...all.system, ...all.workspace].filter((s) => want.has(s.id));
  }

  const parts = [
    { key: 'base', title: '系统提示词', text: prompts.system.effective },
    { key: 'mode', title: `模式 · ${m.name}`, text: m.prompt },
  ];
  for (const s of list) {
    parts.push({
      key: `skill:${s.id}`,
      title: `技能 · ${s.name}`,
      text: `### ${s.name}${s.whenToUse ? `（适用：${s.whenToUse}）` : ''}\n${s.body}`,
    });
  }
  if (prompts.workspace.text.trim()) {
    parts.push({ key: 'workspace', title: '当前工作区约定', text: prompts.workspace.text.trim() });
  }

  const composed = parts
    .filter((p) => p.text && p.text.trim())
    .map((p) => p.text.trim())
    .join('\n\n');

  return {
    composed,
    mode: m.id,
    chars: composed.length,
    // 粗估：中文按 1 字 ≈ 1 token、其余按 4 字符 ≈ 1 token（与 server/tokenizer.js 的口径一致）
    estTokens: estimateTokens(composed),
    sections: parts.map((p) => ({
      key: p.key,
      title: p.title,
      chars: p.text ? p.text.length : 0,
    })),
    skillIds: list.map((s) => s.id),
    skillNames: list.map((s) => s.name),
    systemOverridden: prompts.system.overridden,
    workspacePrompt: Boolean(prompts.workspace.text.trim()),
  };
}

export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk * 1.0 + other * 0.27);
}

/** 给测试与脚本用：直接拿到全部内置技能 id */
export const SYSTEM_SKILL_IDS = SYSTEM_SKILLS.map((s) => s.id);

export { FILES as PROMPT_FILES };
