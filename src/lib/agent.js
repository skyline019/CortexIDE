/**
 * Agent 运行时
 *  - local 模式：内置规则引擎 + 记忆检索 + 文件工具，零配置即可运行
 *  - api   模式：任意 OpenAI 兼容端点，带 function calling 的完整 agent loop
 *
 * 两种模式共享同一套工具（读/写文件、搜索、记忆读写），工具调用过程会以
 * "步骤时间线" 的形式流式回放到 UI。
 */
import { recall, extractMemories, KINDS } from './memory.js';
import { baseName, langOf, uid } from './vfs.js';
import { hasCJK } from './tokenize.js';
import {
  loadImagePart,
  buildUserContent,
  imagePathsFromRefs,
  resolveVisionModel,
} from './vision.js';
import { readAnyFile } from './read-any.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 工具实现（两种模式共用）                                             */
/* ------------------------------------------------------------------ */

export function createTools({ data, ops, provider = 'auto', approval = async () => 'deny' }) {
  const findFile = (path) => {
    if (!path) return null;
    const clean = path.replace(/^\.?\//, '').trim();
    return (
      data.files.find((f) => f.path === clean) ||
      data.files.find((f) => f.path.endsWith('/' + clean)) ||
      data.files.find((f) => baseName(f.path).toLowerCase() === baseName(clean).toLowerCase()) ||
      null
    );
  };

  return {
    findFile,
    async read_file({ path, offset = 1, limit = 300 }) {
      return readAnyFile(path, { offset, limit, ops });
    },
    async list_files() {
      return ops.listFiles();
    },
    async search_files({ query }) {
      const res = await ops.searchFiles(query);
      return { hits: res.hits, total: res.total };
    },
    async write_file({ path, content }) {
      const existing = findFile(path);
      let before = existing?.content;
      if (before === undefined && existing?.real) {
        try {
          before = await ops.readFile(existing.id).then((f) => f?.content);
        } catch {
          before = '';
        }
      }
      const file = await ops.writeFile(path, content ?? '', existing?.id);
      return {
        path: file.path,
        bytes: (content || '').length,
        created: !existing,
        onDisk: Boolean(file.real),
        diff: { before: before ?? '', after: content ?? '' },
      };
    },
    async create_file({ path }) {
      const existing = findFile(path);
      if (existing) return { path: existing.path, existed: true };
      const file = await ops.createFile(path);
      return { path: file.path, created: true };
    },
    remember({ text, kind }) {
      const candidates = extractMemories(text, { source: 'agent' });
      const items = candidates.length
        ? candidates
        : [{ text: String(text).slice(0, 240), kind: kind || 'fact', importance: 4, tags: [], source: 'agent' }];
      const res = ops.addMemories(items);
      const all = [...res.added, ...res.merged].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
      return { added: res.added.length, merged: res.merged.length, items: all };
    },
    async run_command({ cmd, cwd = '.', reason = '' }) {
      const command = String(cmd || '').trim();
      if (!command) throw new Error('命令为空');
      const decision = await approval(command, reason);
      if (decision === 'deny') {
        return { denied: true, message: '用户拒绝执行这条命令，请换一个方案或先征求同意。' };
      }
      if (decision === 'always') await ops.allowCommand?.(command);
      const res = await fetch('/api/exec/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: command, cwd, timeout: 120000 }),
      });
      const json = await res.json();
      if (!res.ok) return { error: json.error, blocked: Boolean(json.blocked), cmd: command };
      return {
        cmd: command,
        code: json.code,
        ok: json.code === 0,
        ms: json.ms,
        stdout: (json.stdout || '').slice(-6000),
        stderr: (json.stderr || '').slice(-3000),
      };
    },
    async recall({ query }) {
      const { results, tookMs } = await recall(query, data.memories, { k: 5, provider });
      return {
        tookMs,
        memories: results.map((m) => ({ id: m.id, text: m.text, kind: m.kind, score: m.score })),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 本地规则引擎                                                         */
/* ------------------------------------------------------------------ */

function summarizeFile(file) {
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

/* ------------------------------------------------------------------ */
/* 远程模型（OpenAI 兼容 + SSE 流式 + function calling）                */
/* ------------------------------------------------------------------ */

const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取工作区文件。支持：代码/文本（分段）、图片（随后以多模态看图）、PDF/Word/Excel/PPT（抽取文本）、CSV、音视频（元数据）。修改代码前先读目标文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，例如 src/App.jsx 或 images/a.png' },
          offset: { type: 'number', description: '文本起始行号（从 1 开始），默认 1。长文本用它分段' },
          limit: { type: 'number', description: '文本最多读取多少行，默认 300，上限 1200' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入或整体覆盖工作区文件（会自动打开该文件）。必须提供完整内容，不要只给片段。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区所有文件路径与行数',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在工作区里做全文搜索，返回命中的文件、行号与内容片段',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在工作区执行一条命令（白名单内，如 pnpm test / pnpm build / git diff / ls / node xxx）。会先请求用户批准。用于改完代码后跑测试、看类型错误、查 git 状态。',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: '完整命令，例如 pnpm test 或 node -e "console.log(1)"' },
          cwd: { type: 'string', description: '相对工作区的目录，默认 .' },
          reason: { type: 'string', description: '为什么需要执行，给用户看的说明' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '把值得长期保留的事实 / 偏好 / 待办写进持久记忆（跨会话生效）。用户表达偏好、约定、决策时主动调用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一句话，完整自足，不要用"上面那个"之类指代' },
          kind: { type: 'string', enum: ['fact', 'pref', 'task'] },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: '在长期记忆里做语义检索，看看之前是否聊过相关约定',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
];

/**
 * 三种 Agent 模式各自能用哪些工具。
 *
 * 为什么客户端也要有一份：真正决定「模型能调什么」的是**发出去的 tools 列表**，
 * 只在提示词里写「你不能写文件」是拦不住的（模型照样会调）。服务端那份提示词负责「怎么说」，
 * 这里负责「能做什么」—— 两边同名、同义，改一处要同步改另一处（有单测盯着）。
 */
export const MODE_TOOLS = {
  agent: ['read_file', 'write_file', 'list_files', 'search_files', 'run_command', 'remember', 'recall'],
  ask: ['read_file', 'list_files', 'search_files', 'recall'],
  plan: ['read_file', 'list_files', 'search_files', 'recall'],
};

/** 无副作用工具：同一轮里可以并行调用（写文件 / 跑命令必须串行，避免竞态） */
export const READONLY_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'recall']);

export const MODE_META = {
  agent: { name: 'Agent', icon: '▶', hint: '能读能写能跑命令' },
  ask: { name: 'Ask', icon: '?', hint: '只读问答，不改代码' },
  plan: { name: 'Plan', icon: '☰', hint: '只读探索，产出可构建的计划' },
};

export function toolsForMode(mode) {
  const allow = new Set(MODE_TOOLS[mode] || MODE_TOOLS.agent);
  return TOOL_SPECS.filter((t) => allow.has(t.function.name));
}

const ALL_TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.function.name));

/** 模型 args 只保留已知字段，避免多余键被工具展开 */
const TOOL_ARG_KEYS = ['path', 'content', 'cmd', 'query', 'offset', 'limit', 'cwd', 'reason', 'text', 'kind'];

export function pickToolArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const k of TOOL_ARG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined) out[k] = raw[k];
  }
  return out;
}

function toolResultDetail(name, ok, result) {
  if (!ok) return result?.error || '失败';
  switch (name) {
    case 'recall':
      return `命中 ${result.memories?.length ?? 0} 条`;
    case 'write_file':
      return `已写入 ${result.path}`;
    case 'read_file':
      return `${result.to ? `${result.from}-${result.to}` : ''} / ${result.totalLines} 行${result.cached ? '（本轮缓存）' : ''}`;
    case 'search_files':
      return `${result.total || 0} 处匹配`;
    case 'remember':
      return `新增 ${result.added} 条`;
    case 'run_command':
      return result.denied ? '用户拒绝' : `退出码 ${result.code} · ${((result.ms || 0) / 1000).toFixed(1)}s`;
    case 'list_files':
      return `${result.files?.length ?? result.total ?? 0} 个文件`;
    default:
      return '完成';
  }
}

/** 同一轮里全是只读工具时才并行，否则按模型给出的顺序串行 */
export function canParallelTools(toolCalls) {
  return (
    Array.isArray(toolCalls) &&
    toolCalls.length > 1 &&
    toolCalls.every((c) => READONLY_TOOLS.has(c.function?.name))
  );
}

/** 本地兜底提示词（服务端合成不可用时用；内容与 server/prompts.js 的基座保持一致） */
const FALLBACK_BASE = [
  '你是 Cortex，一个运行在浏览器 IDE 里的编程 Agent。',
  '',
  '## 行为准则',
  '1. 用中文回答，先给结论，再给细节；代码块必须标注语言。',
  '2. 需要看文件就先调用 read_file / search_files，不要凭空假设内容。代码/文本用 offset/limit 分段；图片会随后以多模态发来，请直接看图；PDF/Office 会返回抽取文本；音视频只有元数据。不要对已读到的内容说「打不开」。',
  '3. 用户表达偏好、项目约定、技术决策时，主动调用 remember 记录，并在回答里一句话说明记了什么。',
  '4. 需要改代码时用 write_file 写入完整文件内容，然后在回答里说明改了哪几处。',
  '5. 改完代码后主动用 run_command 跑测试或构建（例如 pnpm test / pnpm build），看到失败就继续修，直到通过或说明原因。',
  '6. 不要臆造不存在的文件；不确定时先 list_files。',
  '7. 命令必须简短、可预期，不要用 ; | && 拼接，不要做删除类操作。',
  // 真机测试里发现：读 CSV 后心算总和会算错（81700 算成 71700，Top 类别也选错）。
  // 「涉及数字就算一遍」比「你应该更仔细」管用得多 —— 让它在机器上算，不靠脑算。
  '8. 涉及求和、计数、均值、排序、日期差这类计算时，不要心算：用 run_command 跑一小段 node 代码核对，并把结果贴出来；心算出来的数字要标明是估算。',
].join('\n');

function systemPrompt(data, hits, { prefix, mode: _mode = 'agent' } = {}) {
  const memBlock = hits.length
    ? hits.map((h) => `- [${KINDS[h.kind].label}·重要度${h.importance}] ${h.text}`).join('\n')
    : '（无相关记忆）';
  const active = data.files.find((f) => f.id === data.activeFileId);
  return [
    prefix && prefix.trim() ? prefix.trim() : FALLBACK_BASE,
    '',
    '## 当前工作区',
    '（下面是用户打开着的标签页，不是全部文件；要看完整目录请调用 list_files，它读的是真实磁盘。）',
    data.files.map((f) => `- ${f.path}（${f.content.split('\n').length} 行）`).join('\n') || '- （没有打开的文件）',
    active ? `\n用户正在看：${active.path}` : '',
    '',
    '## 检索到的长期记忆',
    memBlock,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 从 SSE 流里解析出 delta / tool_calls，并实时回调 */
async function consumeSSE(res, { onDelta, onReasoning, signal }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const toolAcc = new Map(); // index -> {id, name, args}
  let finish = null;
  let usage = null;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) throw new Error(json.error.message || '上游返回错误');
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onReasoning?.(delta.reasoning_content);
    }
    if (delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    for (const call of delta.tool_calls || []) {
      const idx = call.index ?? 0;
      const cur = toolAcc.get(idx) || { id: '', name: '', args: '' };
      if (call.id) cur.id = call.id;
      if (call.function?.name) cur.name = call.function.name;
      if (call.function?.arguments) cur.args += call.function.arguments;
      toolAcc.set(idx, cur);
    }
  };

  while (true) {
    if (signal?.aborted) {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) handleLine(line);
  }
  if (buffer) handleLine(buffer);

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({
      id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));

  return { content, reasoning, toolCalls, finish, usage };
}

function prettyArgs(name, args) {
  const map = {
    read_file: (a) => a.path,
    write_file: (a) => `${a.path} · ${(a.content || '').split('\n').length} 行`,
    search_files: (a) => a.query,
    recall: (a) => a.query,
    remember: (a) => a.text?.slice(0, 40),
    list_files: () => '全部文件',
  };
  const fn = map[name];
  const v = fn ? fn(args) : Object.values(args).join(', ');
  return v || '';
}

export async function runRemoteAgent({ input, data, settings, ops, emit, signal, approval, systemPrefix }) {
  const provider = settings.embedProvider || 'auto';
  const approve = approval || (async () => 'deny');
  const mode = settings.agentMode || 'agent';
  // 只读模式**根本不给**写/执行工具：模型拿不到就不会调，比提示词里写「别写」可靠
  const tools = createTools({ data, ops, provider, approval: approve });
  const allowed = new Set(MODE_TOOLS[mode] || MODE_TOOLS.agent);
  for (const name of Object.keys(tools)) {
    if (ALL_TOOL_NAMES.has(name) && !allowed.has(name)) delete tools[name];
  }
  const specs = toolsForMode(mode);
  const topK = settings.topK || 6;
  const t0 = performance.now();

  emit({ type: 'phase', phase: 'recall', label: '检索长期记忆' });
  // 注意别用 `mode` 这个名字：上面已经用它表示 Agent 模式（agent/ask/plan），重名会直接语法错误
  const { results: hits, tookMs, engine, dim, mode: recallMode } = await recall(input, data.memories, {
    k: topK,
    provider,
    mode: settings.retrievalMode || 'hybrid',
  });
  emit({ type: 'memories', items: hits, tookMs, query: input, engine, dim, mode: recallMode });
  ops.touchMemories(hits.map((h) => h.id));

  const history = (data.messages || [])
    .filter((m) => !m.pending && m.content && m.role !== 'system')
    .slice(-10)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 4000) : m.content,
    }));

  // 用户附上的图片：打成 image_url，与文本一起发给视觉模型
  const refImagePaths = imagePathsFromRefs(data.refs || []);
  const pendingVision = new Set(refImagePaths);
  const visionParts = [];
  for (const p of refImagePaths.slice(0, 8)) {
    const loaded = await loadImagePart(p);
    if (loaded.part) visionParts.push(loaded.part);
    else if (loaded.error) {
      emit({
        type: 'step',
        step: {
          id: uid('st'),
          kind: 'tool',
          title: `vision(${p})`,
          status: 'done',
          detail: `加载失败：${loaded.error}`,
          at: Date.now(),
        },
      });
    }
  }

  const textBody = data.contextBlock
    ? `${data.contextBlock}\n\n---\n\n${input || '（请根据上面的内容作答）'}`
    : input;
  const userContent = buildUserContent(textBody, visionParts);

  const messages = [
    { role: 'system', content: systemPrompt(data, hits, { prefix: systemPrefix, mode }) },
    ...history,
    { role: 'user', content: userContent },
  ];

  // 带图时：deepseek-chat 等纯文本模型自动切到 deepseek-flash
  let activeModel = settings.model || 'deepseek-chat';
  if (visionParts.length) {
    const picked = resolveVisionModel(activeModel);
    if (picked.switched) {
      emit({
        type: 'step',
        step: {
          id: uid('st'),
          kind: 'info',
          title: `视觉模型 ${picked.from} → ${picked.model}`,
          status: 'done',
          detail: `${visionParts.length} 张图已附上；${picked.from} 不支持看图，本轮改用 ${picked.model}`,
          at: Date.now(),
        },
      });
      activeModel = picked.model;
    }
  }

  const useProxy = settings.provider === 'server' || !settings.apiKey;
  const endpoint = useProxy ? '/api/llm/chat' : `${(settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (!useProxy) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  } else {
    headers['x-cortex-user'] = settings.userId || 'local';
    if (settings.accessToken) headers.Authorization = `Bearer ${settings.accessToken}`;
  }

  const pushVisionAfterTools = async (toolResults) => {
    const paths = [];
    for (const r of toolResults) {
      try {
        const body = typeof r.content === 'string' ? JSON.parse(r.content) : null;
        if (body?.image && body?.path && !pendingVision.has(body.path)) {
          paths.push(body.path);
          pendingVision.add(body.path);
        }
      } catch {
        /* ignore */
      }
    }
    if (!paths.length) return;
    const parts = [];
    for (const p of paths.slice(0, 6)) {
      const loaded = await loadImagePart(p);
      if (loaded.part) parts.push(loaded.part);
    }
    if (!parts.length) return;
    // 工具读图后补一条多模态 user，否则模型只看到「二进制」说明
    const picked = resolveVisionModel(activeModel);
    if (picked.switched) activeModel = picked.model;
    messages.push({
      role: 'user',
      content: buildUserContent(
        `（系统）以下是本轮工具刚读取的图片，请直接查看像素内容再回答，不要说看不到图。`,
        parts,
      ),
    });
  };

  // Plan 模式要留出探索 + 出计划的余量：真机上 8 轮全花在读文件上，计划一次都没输出。
  const maxRounds = Number(settings.maxToolRounds || (mode === 'plan' ? 12 : 8));
  let round = 0;
  let planNudged = false;
  const usageTotal = { prompt: 0, completion: 0 };
  // 服务端每次都会用响应头告诉我们「这次发出去的是压缩前多少、压缩后多少」
  const compressTotal = { before: 0, after: 0, rounds: 0 };
  /** 本回合已读过的文件区间：挡住「同一路径反复读」浪费轮次 */
  const readCache = new Map();
  const readCompressHeader = (res) => {
    const raw = res.headers.get('X-Cortex-Compress');
    if (!raw) return;
    const m = raw.match(/^(\d+)->(\d+)$/);
    if (!m) return;
    compressTotal.before += Number(m[1]);
    compressTotal.after += Number(m[2]);
    compressTotal.rounds += 1;
  };

  const runOneTool = async (call) => {
    const name = call.function?.name;
    let parsedOk = true;
    let args = {};
    try {
      args = pickToolArgs(JSON.parse(call.function?.arguments || '{}'));
    } catch {
      parsedOk = false;
      args = {};
    }
    const stepId = uid('st');
    emit({
      type: 'step',
      step: {
        id: stepId,
        kind: 'tool',
        title: `${name}(${prettyArgs(name, args)})`,
        status: 'running',
        at: Date.now(),
      },
    });

    let result;
    let ok = true;
    try {
      if (!parsedOk) throw new Error('工具参数不是合法 JSON，请重新调用并给出正确 arguments');
      if (!tools[name]) throw new Error(`模型请求了未知工具 ${name}`);
      if (name === 'read_file') {
        const key = `${args.path || ''}|${Number(args.offset) || 1}|${Number(args.limit) || 300}`;
        if (readCache.has(key)) {
          const hit = readCache.get(key);
          result = {
            ...hit,
            cached: true,
            note: '本轮已经读过这个文件的同一区间，内容与上次相同。请直接使用，不要再 read_file。',
          };
        } else {
          result = await tools[name](args);
          readCache.set(key, result);
        }
      } else {
        result = await tools[name](args);
      }
      if (name === 'remember') for (const it of result.items || []) emit({ type: 'memoryWrite', memory: it });
      if (name === 'write_file') {
        emit({ type: 'fileWritten', path: result.path, created: result.created, diff: result.diff });
      }
    } catch (err) {
      ok = false;
      result = { error: err.message };
    }
    if (name === 'run_command') {
      emit({
        type: 'execResult',
        id: stepId,
        cmd: result.cmd || args.cmd,
        code: result.code,
        ok: result.ok ?? ok,
        ms: result.ms,
        stdout: result.stdout || '',
        stderr: result.stderr || result.error || result.message || '',
        denied: Boolean(result.denied),
      });
    }
    emit({ type: 'toolResult', id: stepId, ok, detail: toolResultDetail(name, ok, result) });
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result).slice(0, 24000),
    };
  };

  while (round < maxRounds) {
    if (signal?.aborted) {
      emit({ type: 'done', note: '已被用户中断' });
      return;
    }
    round += 1;
    emit({ type: 'phase', phase: 'thinking', label: round === 1 ? '模型思考中' : `第 ${round} 轮工具调用` });

    // Plan：倒数第二轮提醒一次；最后一轮强制出文字（tool_choice=none），避免轮次耗尽却没有 ```plan
    if (mode === 'plan' && round >= maxRounds - 1 && !planNudged) {
      planNudged = true;
      messages.push({
        role: 'system',
        content:
          '【回合提醒】工具轮次将尽。请停止继续读文件，立刻输出合法的 ```plan 代码块（严格 JSON）。不要再调用工具。',
      });
    }
    const toolChoice = mode === 'plan' && round === maxRounds ? 'none' : 'auto';

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: activeModel,
          messages,
          tools: toolChoice === 'none' ? undefined : specs,
          tool_choice: toolChoice,
          temperature: Number(settings.temperature ?? 0.3),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      throw new Error(`网络请求失败：${err.message}`);
    }

    readCompressHeader(res);
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok || ctype.includes('application/json')) {
      let msg = `接口返回 ${res.status}`;
      let code = null;
      try {
        const j = await res.json();
        msg = j.error || msg;
        code = j.code;
      } catch {
        /* ignore */
      }
      if (code === 'NO_SERVER_KEY') {
        throw new Error('服务端没有配置 API Key。请在 .env 里设置 DEEPSEEK_API_KEY，或在设置 → 模型里填入你自己的 Key。');
      }
      throw new Error(msg);
    }

    let firstToken = true;
    const { content, reasoning, toolCalls, usage } = await consumeSSE(res, {
      signal,
      onDelta: (text) => {
        if (firstToken && text.trim()) {
          firstToken = false;
          emit({ type: 'phase', phase: 'streaming', label: '生成回答' });
        }
        emit({ type: 'delta', text });
      },
      onReasoning: (text) => emit({ type: 'reasoning', text }),
    });

    if (usage) {
      usageTotal.prompt += usage.prompt_tokens || 0;
      usageTotal.completion += usage.completion_tokens || 0;
    }

    // 模型调用了工具？
    if (toolCalls.length && toolChoice !== 'none') {
      messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });

      const toolMsgs = [];
      if (canParallelTools(toolCalls)) {
        emit({ type: 'phase', phase: 'tools', label: `并行 ${toolCalls.length} 个只读工具` });
        toolMsgs.push(...(await Promise.all(toolCalls.map((c) => runOneTool(c)))));
      } else {
        for (const call of toolCalls) {
          toolMsgs.push(await runOneTool(call));
        }
      }
      for (const m of toolMsgs) messages.push(m);
      await pushVisionAfterTools(toolMsgs);
      continue;
    }

    // 没有工具调用 -> 结束
    if (!content.trim()) {
      emit({ type: 'delta', text: '（模型没有返回内容，可能被上游截断，请重试或换个问法。）' });
    }
    emit({
      type: 'done',
      tookMs: Math.round(performance.now() - t0),
      reasoningChars: reasoning.length,
      rounds: round,
      usage: usageTotal,
      compress: compressTotal.rounds
        ? {
            before: compressTotal.before,
            after: compressTotal.after,
            savedPct: compressTotal.before
              ? Math.round((1 - compressTotal.after / compressTotal.before) * 100)
              : 0,
            rounds: compressTotal.rounds,
          }
        : null,
    });
    return;
  }

  emit({ type: 'done', note: `已达工具调用轮数上限（${maxRounds}），先停在这里。`, tookMs: Math.round(performance.now() - t0) });
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

export { summarizeFile };
