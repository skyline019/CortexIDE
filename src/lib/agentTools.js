/**
 * Agent 工具定义与实现（local / remote 共用）
 */
import { recall, extractMemories } from './memory.js';
import { baseName } from './vfs.js';
import { readAnyFile } from './read-any.js';

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

export const ALL_TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.function.name));

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

export function toolResultDetail(name, ok, result) {
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

export function prettyArgs(name, args) {
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
