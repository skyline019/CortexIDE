/**
 * Agent 运行时
 *  - local 模式：内置规则引擎 + 记忆检索 + 文件工具，零配置即可运行
 *  - api   模式：任意 OpenAI 兼容端点，带 function calling 的完整 agent loop
 *
 * 两种模式共享同一套工具（读/写文件、搜索、记忆读写），工具调用过程会以
 * "步骤时间线" 的形式流式回放到 UI。
 */
import { recall, extractMemories, KINDS } from './memory.js';
import { langOf, uid } from './vfs.js';
import { hasCJK } from './tokenize.js';
import { createTools } from './agentTools.js';
import { runRemoteAgent } from './agentLoop.js';

export {
  createTools,
  MODE_TOOLS,
  READONLY_TOOLS,
  MODE_META,
  toolsForMode,
  pickToolArgs,
  canParallelTools,
} from './agentTools.js';
export { runRemoteAgent } from './agentLoop.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 本地规则引擎                                                         */
/* ------------------------------------------------------------------ */

export function summarizeFile(file) {
  const lines = file.content.split('\n');
  const headings = lines.filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, ''));
  const exports = [...file.content.matchAll(/export\s+(?:default\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/g)].map(
    (m) => m[1],
  );
  const todos = (file.content.match(/TODO|FIXME|待办/g) || []).length;
  const imports = [...file.content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return { lines: lines.length, headings, exports, todos, imports };
}

const INTENT = [
  { id: 'help', re: /^\/(help|帮助)$/i },
  { id: 'mem_list', re: /^\/(mem|记忆)(\s|$)/i },
  { id: 'remember', re: /^\/(remember|记住)\s+/i },
  { id: 'remember', re: /^(?:请|帮我)?(?:记住|记一下|记下|记录一下)[:：,，\s]*(.+)$/i },
  { id: 'forget', re: /^(?:请|帮我)?(?:忘记|忘掉|删除记忆)[:：,，\s]*(.+)$/i },
  { id: 'forget', re: /^\/(forget|忘记)\s+/i },
  { id: 'files', re: /^\/(files|文件)$/i },
  { id: 'read', re: /^\/(read|打开|读取)\s+/i },
  { id: 'newfile', re: /^\/(new|新建)\s+/i },
  { id: 'memory_question', re: /(记得|记忆|记忆里|你知道我|你还记得|recall|memory)/i },
  { id: 'list_files_q', re: /(有哪些文件|列出文件|文件列表|工作区里|项目结构|list files)/i },
  { id: 'search', re: /(搜索|查找|在哪(里|儿)定义|grep|find|search)\s*[:：]?\s*(.+)/i },
  { id: 'create_component', re: /(新建|创建|生成)(一个|个)?\s*(组件|component|文件|file|页面)/i },
  { id: 'summarize', re: /(总结|概括|说明|解释|分析|这个文件|当前文件|代码review|review)/i },
  { id: 'refactor', re: /(重构|优化|改一下|修改|修复|fix|refactor)/i },
  { id: 'greeting', re: /^(你好|hi|hello|嗨|在吗)/i },
];

function detectIntent(input) {
  for (const it of INTENT) {
    const m = it.re.exec(input.trim());
    if (m) return { id: it.id, match: m };
  }
  return { id: 'chat', match: null };
}

function md(items) {
  return items.join('\n');
}

/**
 * 运行一次本地 agent 回合。
 * @param {{input:string, data:object, ops:object, emit:Function, signal?:AbortSignal}} args
 */
export async function runLocalAgent({ input, data, ops, emit, signal, settings }) {
  // 本地规则引擎不认识 @路径，但用户附带的内容不该被吞掉：
  // 有引用时先说一句「这轮带了多少上下文」，避免本地模式看起来像没接上。
  const attached = data.refs?.length || 0;
  const provider = settings?.embedProvider || 'auto';
  const tools = createTools({ data, ops, provider });
  const intent = detectIntent(input);
  const t0 = performance.now();

  const step = (title, detail, kind = 'thought', status = 'done') =>
    emit({ type: 'step', step: { id: uid('st'), kind, title, detail, status, at: Date.now() } });
  const stream = async (text) => {
    const chunks = text.match(/[\s\S]{1,4}/g) || [text];
    for (const c of chunks) {
      if (signal?.aborted) return;
      emit({ type: 'delta', text: c });
      await sleep(hasCJK(c) ? 16 : 9);
    }
  };

  step('解析请求', `意图识别 → ${intent.id}`);
  if (attached) {
    // 本地引擎不做「读正文再推理」，但至少让用户看见引用进来了、有多少字符
    step(
      '上下文引用',
      `${attached} 个：${data.refs.map((r) => r.name).join('、')} · ${(data.contextBlock || '').length} 字符`,
      'tool',
    );
  }

  /* ---------- 1. 记忆检索（几乎每个回合都会做） ---------- */
  const queryText =
    intent.id === 'memory_question' || intent.id === 'forget'
      ? input.replace(/^\/(forget|忘记)\s+/i, '')
      : input;
  const { results: hits, tookMs, engine, dim, mode } = await recall(queryText, data.memories, {
    k: 6,
    provider,
    mode: settings.retrievalMode || 'hybrid',
  });
  emit({ type: 'memories', items: hits, tookMs, query: queryText, engine, dim, mode });
  step(
    '检索长期记忆',
    `${data.memories.length} 条记忆库 · 召回 ${hits.length} 条 · ${tookMs}ms`,
    'memory',
  );
  if (hits.length) ops.touchMemories(hits.map((h) => h.id));

  /* ---------- 2. 按意图执行 ---------- */
  let answer = '';

  if (intent.id === 'help') {
    answer = md([
      '### 可用命令',
      '- `/mem [关键词]` 查看或检索长期记忆',
      '- `/remember 内容` 写入一条长期记忆',
      '- `/forget 关键词` 遗忘匹配的记忆',
      '- `/files` 列出工作区文件',
      '- `/read 路径` 读取并总结文件',
      '- `/new 路径` 新建文件',
      '',
      '不写斜杠也可以，直接说“记住我喜欢用 TypeScript”“总结当前文件”“搜一下 dnd-kit 在哪用过”。',
      '',
      '> 记忆写进浏览器 IndexedDB/localStorage 之后**跨会话保留**，关掉页面再回来它还记得。',
    ]);
  } else if (intent.id === 'mem_list') {
    const q = input.replace(/^\/(mem|记忆)/i, '').trim();
    const list = q ? (await recall(q, data.memories, { k: 10, provider })).results : [...data.memories].sort((a, b) => b.importance - a.importance).slice(0, 12);
    step('读取记忆库', `${list.length} 条`, 'memory');
    answer = md([
      `### ${q ? `与「${q}」相关的记忆` : '长期记忆库'}（${data.memories.length} 条）`,
      '',
      ...list.map(
        (m) => `- ${m.pinned ? '📌 ' : ''}**${KINDS[m.kind].label}** ${m.text}${m.score ? `  \`${m.score.toFixed(2)}\`` : ''}`,
      ),
      '',
      '需要修改可以直接在右侧「记忆」面板里编辑，或者对我说 `/forget 关键词`。',
    ]);
  } else if (intent.id === 'remember') {
    const text = (intent.match?.[1] || input.replace(/^\/(remember|记住)\s+/i, '')).trim();
    const res = await tools.remember({ text });
    const items = res.items;
    for (const it of items) emit({ type: 'memoryWrite', memory: it });
    step('写入长期记忆', items.map((i) => i.text).join(' / '), 'memory');
    answer = md([
      '已记住：',
      '',
      ...items.map((i) => `- **${KINDS[i.kind].label}**（重要度 ${i.importance}）${i.text}`),
      '',
      '之后在任何会话里我都会带上这条记忆。',
    ]);
  } else if (intent.id === 'forget') {
    const q = (intent.match?.[1] || input.replace(/^\/(forget|忘记)\s+/i, '')).trim();
    const target = (await recall(q, data.memories, { k: 1, provider })).results[0];
    if (!target) {
      answer = `记忆库里没有找到与「${q}」足够接近的内容，什么都没删。`;
    } else {
      ops.deleteMemory(target.id);
      step('删除记忆', target.text, 'memory');
      answer = md([`已遗忘：~~${target.text}~~`, '', '如果误删，可以在「记忆」面板底部的导入功能用导出备份恢复。']);
    }
  } else if (intent.id === 'files' || intent.id === 'list_files_q') {
    step('list_files()', `${data.files.length} 个文件`, 'tool');
    answer = md([
      `### 工作区文件（${data.files.length}）`,
      '',
      ...data.files.map((f) => `- \`${f.path}\` · ${f.content.split('\n').length} 行`),
    ]);
  } else if (intent.id === 'read') {
    const path = input.replace(/^\/(read|打开|读取)\s+/i, '').trim();
    let f = tools.findFile(path);
    if (!f && ops.isReal?.()) {
      try {
        const disk = await ops.readFile(path);
        f = { id: path, path: disk.path, content: disk.content };
      } catch {
        f = null;
      }
    }
    if (!f) {
      answer = `没找到 \`${path}\`。当前工作区有：\n\n${data.files.map((x) => `- \`${x.path}\``).join('\n')}`;
    } else {
      ops.openFile(f.id);
      step(`read_file("${f.path}")`, `${f.content.split('\n').length} 行`, 'tool');
      const s = summarizeFile(f);
      answer = md([
        `### ${f.path}`,
        '',
        `- 语言：${langOf(f.path)} · ${s.lines} 行`,
        s.exports.length ? `- 导出：${s.exports.map((e) => `\`${e}\``).join(', ')}` : '',
        s.imports.length ? `- 依赖：${[...new Set(s.imports)].map((i) => `\`${i}\``).join(', ')}` : '',
        s.headings.length ? `- 章节：${s.headings.join(' / ')}` : '',
        s.todos ? `- ⚠ 有 ${s.todos} 处 TODO/FIXME` : '',
        '',
        '已经帮你在编辑器里打开了。需要我改点什么吗？',
      ]);
    }
  } else if (intent.id === 'newfile') {
    const path = input.replace(/^\/(new|新建)\s+/i, '').trim();
    const res = await tools.create_file({ path });
    ops.openFileByPath(res.path);
    step(`create_file("${res.path}")`, res.existed ? '文件已存在' : '已创建并载入模板', 'tool');
    answer = `已新建 \`${res.path}\`，并填好了模板。直接编辑或让我继续写内容。`;
  } else if (intent.id === 'search') {
    const q = intent.match[2] || '';
    const res = await tools.search_files({ query: q });
    step(`search_files("${q}")`, `${res.total || 0} 处匹配`, 'tool');
    answer = !res.hits.length
      ? `工作区里没有搜到「${q}」。`
      : md([
          `### 「${q}」搜索结果（${res.total} 处，展示前 ${res.hits.length}）`,
          '',
          ...res.hits.map((h) => `- \`${h.path}:${h.line}\` — \`${h.text}\``),
        ]);
  } else if (intent.id === 'summarize') {
    let active = data.files.find((f) => f.id === data.activeFileId) || data.files[0];
    if (!active && ops.isReal?.()) {
      // 真实模式下可能还没打开任何文件：自动挑一个工作区里的代码文件来总结
      const listed = await ops.listFiles();
      const candidate = (listed.files || []).find((f) => /\.(jsx?|tsx?|md|css)$/.test(f)) || (listed.files || [])[0];
      if (candidate) {
        try {
          const disk = await ops.readFile(candidate);
          active = { id: candidate, path: candidate, content: disk.content };
        } catch {
          /* ignore */
        }
      }
    }
    if (active?.path && ops.isReal?.() && !active.content) {
      try {
        const disk = await ops.readFile(active.path);
        active = { ...active, content: disk.content };
      } catch {
        /* 保留原样 */
      }
    }
    if (!active) {
      answer = '当前没有打开文件，工作区里也没读到可总结的文件。先在左侧点开一个文件，或者用 `/read 路径` 指定。';
    } else {
      const s = summarizeFile(active);
      step(`read_file("${active.path}")`, `${s.lines} 行`, 'tool');
      const rel = hits.filter((h) => active.content.toLowerCase().includes('react') && h.tags.includes('react'));
      answer = md([
        `### ${active.path} 概览`,
        '',
        `- 规模：${s.lines} 行 ${langOf(active.path)}`,
        s.exports.length ? `- 导出符号：${s.exports.map((e) => `\`${e}\``).join(', ')}` : '- 没有命名导出',
        s.headings.length ? `- 结构：${s.headings.join(' / ')}` : '',
        '',
        '**观察**',
        `- 文件里出现了 ${s.imports.length} 处 import${s.imports.length > 1 ? '，依赖关系比较集中' : ''}。`,
        s.todos ? `- 有 ${s.todos} 处 TODO/FIXME 值得排期。` : '- 没有遗留 TODO。',
        rel.length ? `- 结合记忆：${rel.map((r) => r.text).join('；')}` : '',
        '',
        '**建议下一步**',
        '1. 抽一个纯展示组件，把数据和渲染分开；',
        '2. 补齐 loading / empty / error 三态（记忆里的项目约定）；',
        '3. 加一条记忆记录这次重构的结论，下次我就能直接复用。',
      ]);
    }
  } else if (intent.id === 'create_component') {
    const nameMatch = /([A-Z][A-Za-z0-9_]{2,})|([a-z][a-z0-9-]{2,})(?=组件|页面)/.exec(input);
    const raw = (nameMatch?.[1] || nameMatch?.[2] || 'NewWidget').replace(/[^A-Za-z0-9_]/g, '');
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const path = `src/components/${name}.jsx`;
    if (tools.findFile(path)) {
      answer = `\`${path}\` 已经存在，我没有覆盖它。要我基于现有内容改造吗？`;
    } else {
      const content = `import { useEffect, useState } from 'react';

/**
 * ${name}
 * 遵循项目约定：提供 loading / empty / error 三态
 */
export default function ${name}({ items }) {
  const [state, setState] = useState('loading');

  useEffect(() => {
    // TODO: 接入 src/lib/api.js 的 request()
    const timer = setTimeout(() => setState('ready'), 120);
    return () => clearTimeout(timer);
  }, []);

  if (state === 'loading') return <p className="muted">加载中…</p>;
  if (state === 'error') return <p className="error">加载失败，请重试</p>;
  if (!items?.length) return <p className="muted">暂无数据</p>;

  return (
    <section className="${name.toLowerCase()}">
      {items.map((item) => (
        <article key={item.id}>{item.title}</article>
      ))}
    </section>
  );
}
`;
    const file = ops.writeFile(path, content);
    ops.openFile(file.id);
    step(`write_file("${path}")`, `${content.split('\n').length} 行`, 'tool');
    step('应用项目约定', '三态 + 中文注释 + 复用 api 封装', 'thought');
    const rel = hits.filter((h) => h.kind === 'pref' || h.tags.includes('react'));
    answer = md([
      `已在 \`${path}\` 生成组件骨架，并按记忆里的约定处理：`,
      '',
      '- loading / empty / error 三态齐全',
      rel.length ? `- 参考记忆：${rel.slice(0, 2).map((r) => `「${r.text}」`).join('、')}` : '- 使用函数组件 + hooks',
      '',
      '本地引擎只能生成骨架。**在设置里切回「真实模型（DeepSeek）」**，同一个对话就会交给模型补全实现。',
    ]);
    }
  } else if (intent.id === 'memory_question') {
    answer = md([
      '我记得这些：',
      '',
      ...(hits.length
        ? hits.slice(0, 6).map((m) => `- **${KINDS[m.kind].label}** ${m.text} \`${m.score.toFixed(2)}\``)
        : ['- （没有召回到相关记忆，你可以用 `/remember 内容` 教我）']),
      '',
      `记忆库共 ${data.memories.length} 条，检索耗时 ${tookMs}ms。`,
    ]);
  } else if (intent.id === 'refactor') {
    const active = data.files.find((f) => f.id === data.activeFileId) || data.files[0];
    answer = md([
      `### 关于「${input.slice(0, 40)}」`,
      '',
      active ? `当前打开的是 \`${active.path}\`（${active.content.split('\n').length} 行）。` : '',
      '',
      '本地引擎不会直接改你的代码，但可以给你一个可靠的执行路径：',
      '1. 先用 `/read` 把相关文件读进来；',
      '2. 我按记忆里的项目约定列出改动点；',
      '3. 你确认后我用 `write_file` 落地（或者你在设置里接上真实模型，让它直接改）。',
      '',
      hits.length ? `> 相关记忆：${hits.slice(0, 3).map((h) => h.text).join('；')}` : '',
    ]);
  } else if (intent.id === 'greeting') {
    answer = md([
      '在。这是一个把**长期记忆**当作一等公民的 Agent IDE —— 关掉页面再回来，我仍然记得你的项目约定。',
      '',
      `现在记忆库里躺着 ${data.memories.length} 条记忆，工作区有 ${data.files.length} 个文件。`,
      '',
      '试试：',
      '- `/mem 接口` 看看我记住了哪些后端约定',
      '- `记住：我偏好用 TypeScript 严格模式` 写一条新记忆',
      '- `总结当前文件` 让我读一遍你正在写的代码',
    ]);
  } else {
    /* 通用回合：记忆 + 工作区文件的 RAG 回答 */
    const active = data.files.find((f) => f.id === data.activeFileId);
    const search = await tools.search_files({ query: input.split(/\s+/)[0] });
    if (active) step(`read_file("${active.path}")`, '作为上下文', 'tool');
    if (search.hits.length) step(`search_files("${input.slice(0, 12)}")`, `${search.total} 处匹配`, 'tool');

    const memLine = hits.length
      ? hits.slice(0, 3).map((h) => `- ${h.text} \`${h.score.toFixed(2)}\``).join('\n')
      : '- 暂无直接相关的记忆';

    const distilled = data.autoMemory === false ? [] : extractMemories(input, { source: 'chat' });

    answer = md([
      `### 收到：${input.length > 48 ? input.slice(0, 48) + '…' : input}`,
      '',
      ...(distilled.length
        ? [
            `我已经把这条记下来了：${distilled.map((d) => `「${d.text}」`).join('、')}`,
            '下次开新会话、甚至在别的文件里，都会带上它。',
            '',
          ]
        : []),
      '我先把记忆里和这件事相关的部分调出来了：',
      '',
      memLine,
      '',
      active ? `当前上下文文件是 \`${active.path}\`（${active.content.split('\n').length} 行）。` : '',
      search.hits.length ? `工作区里「${input.split(/\s+/)[0]}」有 ${search.total} 处匹配，例如 \`${search.hits[0].path}:${search.hits[0].line}\`。` : '',
      '',
      '**接下来可以这样推进**',
      '1. 需要我落地代码的话，说“新建组件 Xxx”或 `/new path/to/file`，我会按约定生成；',
      '2. 想让我长期记住某个决定，说“记住：……”；',
      '3. 想要完整的推理能力，在右上角设置里切回「真实模型（DeepSeek）」，工具和记忆都会沿用。',
      '',
      `> 本轮耗时 ${Math.round(performance.now() - t0)}ms，纯本地完成。`,
    ]);
  }

  step('整理回答', `${answer.length} 字符`, 'thought');
  await stream(answer);
  emit({ type: 'done' });
}

/** 检查服务端代理是否可用（是否配置了 Key） */
export async function checkServerLLM() {
  try {
    const res = await fetch('/api/llm/status', { headers: { Accept: 'application/json' } });
    if (!res.ok) return { available: false };
    const json = await res.json();
    return { available: Boolean(json.configured), ...json };
  } catch {
    return { available: false };
  }
}

/** 本机保存上游 API Key（写入 CORTEX_ENV_DIR/.env，桌面版默认 %APPDATA%\Cortex\.env） */
export async function saveServerCredentials({ apiKey, baseUrl, provider } = {}) {
  const res = await fetch('/api/llm/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey, baseUrl, provider }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/** 拉取上游可用模型列表 */
export async function listServerModels() {
  const res = await fetch('/api/llm/models');
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data || [];
}

export async function runAgentTurn(args) {
  const { settings } = args;
  if (settings.mode === 'api') return runRemoteAgent(args);
  return runLocalAgent(args);
}
