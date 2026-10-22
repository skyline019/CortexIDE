/**
 * 可视化工作流引擎（服务端）。
 *
 * 三类东西在这里：
 *  1) 存储：`.cortex/workflows/<id>.json`（可读、可 diff、可进 git）
 *  2) 执行：DAG 拓扑执行 + 分支（if 节点两个出口），SSE 把每个节点的事件实时推给画布
 *  3) 真实性：`read/write` 走真实磁盘，`shell` 走白名单（和终端同一条闸门），
 *     `ai` 走真实上游模型（服务端注入 Key，前端拿不到），并用与聊天同源的「系统提示词 + 技能」合成。
 *
 * 明确不做的事：不引第三方工作流引擎、不假装执行不可用的节点 ——
 * 没有 Key 时 AI 节点直接报「未配置 Key」，不会返回编造的结果。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runWhitelisted } from './exec-api.js';
import { composeSystemPrompt } from './prompts.js';

export const NODE_TYPES = {
  input: {
    label: '输入',
    color: '#38bdf8',
    desc: '工作流的起点：运行时的输入文本',
    inputs: 0,
    outputs: 1,
    fields: [{ key: 'placeholder', label: '提示占位文案', type: 'text' }],
  },
  read: {
    label: '读文件',
    color: '#a78bfa',
    desc: '读取工作区里的一个文件（真实磁盘）',
    inputs: 1,
    outputs: 1,
    fields: [{ key: 'path', label: '文件路径', type: 'text', placeholder: 'src/App.jsx' }],
  },
  search: {
    label: '搜索',
    color: '#a78bfa',
    desc: '在工作区里做全文搜索，把命中拼成文本',
    inputs: 1,
    outputs: 1,
    fields: [{ key: 'query', label: '搜索词', type: 'text' }],
  },
  ai: {
    label: 'AI 节点',
    color: '#2dd4bf',
    desc: '调真实模型（服务端 Key），自带系统提示词与已启用的技能',
    inputs: 1,
    outputs: 1,
    fields: [
      { key: 'prompt', label: '任务描述', type: 'textarea', placeholder: '审一下下面的改动，只列必须改的问题。' },
      { key: 'mode', label: '模式', type: 'select', options: ['agent', 'ask', 'plan'] },
    ],
  },
  shell: {
    label: '执行命令',
    color: '#fbbf24',
    desc: '白名单命令（与终端同一条闸门，越界直接拒绝）',
    inputs: 1,
    outputs: 1,
    fields: [{ key: 'cmd', label: '命令', type: 'text', placeholder: 'npm run lint' }],
  },
  write: {
    label: '写文件',
    color: '#34d399',
    desc: '把上游结果写进文件（支持 {{prev}} 占位）',
    inputs: 1,
    outputs: 1,
    fields: [
      { key: 'path', label: '目标路径', type: 'text', placeholder: 'docs/review.md' },
      { key: 'content', label: '内容模板', type: 'textarea', placeholder: '# 审查结果\n\n{{prev}}' },
    ],
  },
  branch: {
    label: '条件分支',
    color: '#f472b6',
    desc: '按上游文本决定走「是」还是「否」出口',
    inputs: 1,
    outputs: 2,
    fields: [
      { key: 'op', label: '判断', type: 'select', options: ['contains', 'not-contains', 'regex', 'non-empty'] },
      { key: 'value', label: '比较值', type: 'text' },
    ],
  },
  output: {
    label: '产物',
    color: '#94a3b8',
    desc: '汇总结果（运行结束后就是这次工作流的产物）',
    inputs: 1,
    outputs: 0,
    fields: [{ key: 'title', label: '标题', type: 'text' }],
  },
};

const OUT_KEYS = ['default', 'true', 'false'];

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

const dirOf = (root) => path.join(root, '.cortex', 'workflows');

async function readJson(abs) {
  const raw = await fs.readFile(abs, 'utf8');
  return JSON.parse(raw);
}

function normalize(wf) {
  const now = Date.now();
  const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []).map((n, i) => ({
    id: String(n.id || `n${i + 1}`),
    type: NODE_TYPES[n.type] ? n.type : 'ai',
    x: Number.isFinite(n.x) ? n.x : 40 + i * 180,
    y: Number.isFinite(n.y) ? n.y : 80,
    data: { ...(n.data || {}) },
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(wf.edges) ? wf.edges : [])
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e, i) => ({
      id: String(e.id || `e${i + 1}`),
      from: e.from,
      to: e.to,
      fromPort: OUT_KEYS.includes(e.fromPort) ? e.fromPort : 'default',
    }));
  return {
    id: String(wf.id || `wf-${now.toString(36)}`),
    name: String(wf.name || '未命名工作流').slice(0, 80),
    desc: String(wf.desc || '').slice(0, 400),
    nodes,
    edges,
    createdAt: wf.createdAt || now,
    updatedAt: now,
  };
}

export async function listWorkflows(root) {
  const dir = dirOf(root);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    try {
      const wf = await readJson(path.join(dir, name));
      out.push({
        id: wf.id,
        name: wf.name,
        desc: wf.desc,
        nodes: wf.nodes?.length || 0,
        edges: wf.edges?.length || 0,
        updatedAt: wf.updatedAt || null,
      });
    } catch {
      /* 坏文件跳过，不要让一个坏 json 把整个列表拖挂 */
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getWorkflow(root, id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('工作流 id 非法');
  const wf = await readJson(path.join(dirOf(root), `${safe}.json`));
  return normalize(wf);
}

export async function saveWorkflow(root, input) {
  const wf = normalize(input);
  const safe = wf.id.replace(/[^A-Za-z0-9_-]/g, '');
  const dir = dirOf(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${safe}.json`), `${JSON.stringify(wf, null, 2)}\n`, 'utf8');
  return wf;
}

export async function deleteWorkflow(root, id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  await fs.unlink(path.join(dirOf(root), `${safe}.json`));
  return { deleted: safe };
}

/* ------------------------------------------------------------------ */
/* 图：校验 + 拓扑                                                      */
/* ------------------------------------------------------------------ */

export function validateGraph(wf) {
  const errors = [];
  const ids = new Set(wf.nodes.map((n) => n.id));
  if (!ids.size) errors.push('工作流里没有节点');
  for (const e of wf.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`连线指向不存在的节点：${e.from} → ${e.to}`);
  }
  const inputs = wf.nodes.filter((n) => n.type === 'input');
  if (inputs.length === 0) errors.push('缺少「输入」节点（工作流至少要有一个起点）');
  if (inputs.length > 1) errors.push(`「输入」节点只能有一个，当前 ${inputs.length} 个`);
  const outputs = wf.nodes.filter((n) => n.type === 'output');
  if (!outputs.length) errors.push('缺少「产物」节点（否则不知道这次跑出了什么）');

  // 环检测（Kahn）
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  const adj = new Map(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) {
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    adj.get(e.from).push(e.to);
  }
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (q.length) {
    const id = q.shift();
    seen += 1;
    for (const to of adj.get(id) || []) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) q.push(to);
    }
  }
  if (seen !== wf.nodes.length) errors.push('工作流里有环（连线形成了回路），无法按顺序执行');

  for (const n of wf.nodes) {
    if (n.type !== 'input' && !wf.edges.some((e) => e.to === n.id)) {
      errors.push(`节点「${n.data.label || n.id}」没有输入连线，永远不会执行`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function topoOrder(wf) {
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  const adj = new Map(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) {
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    adj.get(e.from).push(e.to);
  }
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const to of adj.get(id) || []) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) {
        q.push(to);
        q.sort();
      }
    }
  }
  return order;
}

/* ------------------------------------------------------------------ */
/* 模板与检索                                                          */
/* ------------------------------------------------------------------ */

export function fillTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

async function walkFiles(root, list, limit = 2000) {
  if (list.length >= limit) return;
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (list.length >= limit) return;
    if (['node_modules', '.git', '.cortex', 'dist', '.cache'].includes(e.name)) continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) await walkFiles(abs, list, limit);
    else list.push(abs);
  }
}

/** 一次运行内共享：文件列表 / 按模式缓存的系统提示词，避免每个 search/ai 节点各扫一遍盘 */
function createRunCache() {
  return {
    files: null,
    prompts: new Map(),
    async listFiles(root, limit = 1500) {
      if (!this.files) {
        const list = [];
        await walkFiles(root, list, limit);
        this.files = list;
      }
      return this.files;
    },
    async systemPrompt(root, mode) {
      if (this.prompts.has(mode)) return this.prompts.get(mode);
      const sys = await composeSystemPrompt({ root, mode });
      this.prompts.set(mode, sys);
      return sys;
    },
  };
}

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel || '.');
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) throw new Error(`路径越界：${rel}`);
  return abs;
}

/* ------------------------------------------------------------------ */
/* 节点执行器                                                          */
/* ------------------------------------------------------------------ */

async function callModel({ system, user, model, temperature = 0.3 }) {
  const key = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  const base = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!key) throw new Error('服务端没有配置模型 Key（.env 里的 DEEPSEEK_API_KEY），AI 节点无法执行');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model || process.env.CORTEX_WORKFLOW_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      stream: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`模型返回 ${res.status}：${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`模型返回了非 JSON：${text.slice(0, 200)}`);
  }
  const content = json.choices?.[0]?.message?.content || '';
  if (!content.trim()) throw new Error('模型没有返回内容');
  return { content, usage: json.usage || null, model: json.model || model };
}

/**
 * 执行单个节点。返回值统一是 { text, meta, port }：
 *  text = 给下游看的文本，meta = 画布/日志要展示的结构化信息，port = 走哪个出口。
 */
async function execNode(node, { inputs, vars, root, runInput, emit, signal, cache }) {
  const d = node.data || {};
  switch (node.type) {
    case 'input': {
      const text = String(runInput ?? '').trim() || String(d.text || '').trim();
      return { text, meta: { chars: text.length } };
    }
    case 'read': {
      const rel = fillTemplate(d.path, { ...vars, input: runInput, ...inputs });
      if (!rel) throw new Error('「读文件」节点没有填路径');
      const abs = safeJoin(root, rel);
      const stat = await fs.stat(abs);
      const maxText = Number(process.env.CORTEX_MAX_TEXT_READ || 0);
      if (maxText > 0 && stat.size > maxText) {
        const fh = await fs.open(abs, 'r');
        try {
          const buf = Buffer.alloc(maxText);
          const { bytesRead } = await fh.read(buf, 0, maxText, 0);
          const text = buf.subarray(0, bytesRead).toString('utf8');
          return {
            text,
            meta: {
              path: rel,
              bytes: stat.size,
              lines: text.split('\n').length,
              truncated: true,
              note: `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB，已读前 ${Math.round(maxText / 1024 / 1024)}MB`,
            },
          };
        } finally {
          await fh.close().catch(() => {});
        }
      }
      const text = await fs.readFile(abs, 'utf8');
      return { text, meta: { path: rel, bytes: stat.size, lines: text.split('\n').length } };
    }
    case 'search': {
      const q = fillTemplate(d.query, { ...vars, input: runInput, ...inputs }).trim();
      if (!q) throw new Error('「搜索」节点没有填搜索词');
      const files = cache ? await cache.listFiles(root, 1500) : await (async () => {
        const list = [];
        await walkFiles(root, list, 1500);
        return list;
      })();
      const hits = [];
      const needle = q.toLowerCase();
      for (const abs of files) {
        if (signal?.aborted) throw new Error('已中止');
        let text;
        try {
          text = await fs.readFile(abs, 'utf8');
        } catch {
          continue;
        }
        const rel = path.relative(root, abs);
        text.split('\n').forEach((line, i) => {
          if (hits.length < 120 && line.toLowerCase().includes(needle)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
        if (hits.length >= 120) break;
      }
      return {
        text: hits.length ? hits.join('\n') : `（没有找到「${q}」）`,
        meta: { query: q, hits: hits.length },
      };
    }
    case 'ai': {
      const prompt = fillTemplate(d.prompt, { ...vars, input: runInput, ...inputs });
      const mode = ['agent', 'ask', 'plan'].includes(d.mode) ? d.mode : 'agent';
      const sys = cache ? await cache.systemPrompt(root, mode) : await composeSystemPrompt({ root, mode });
      const user = [prompt.trim(), '', '## 上游内容', inputs.prev ? String(inputs.prev) : '（无）'].join('\n');
      const r = await callModel({ system: sys.composed, user });
      emit({ type: 'node-log', id: node.id, text: `提示词 ${sys.chars} 字符 · 技能 ${sys.skillIds.length} 个 · 输出 ${r.content.length} 字符` });
      return {
        text: r.content,
        meta: {
          mode,
          model: r.model,
          promptChars: sys.chars,
          skills: sys.skillNames,
          usage: r.usage,
        },
      };
    }
    case 'shell': {
      const cmd = fillTemplate(d.cmd, { ...vars, input: runInput, ...inputs }).trim();
      if (!cmd) throw new Error('「执行命令」节点没有填命令');
      const r = await runWhitelisted(cmd, { root, timeoutMs: 120000 });
      emit({ type: 'node-log', id: node.id, text: `$ ${cmd} → 退出码 ${r.code} · ${r.ms}ms` });
      const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      return {
        text: text || `（退出码 ${r.code}，无输出）`,
        meta: { cmd, code: r.code, ms: r.ms, matched: r.matched },
        failed: r.code !== 0 ? `命令退出码 ${r.code}` : null,
      };
    }
    case 'write': {
      const rel = fillTemplate(d.path, { ...vars, input: runInput, ...inputs });
      if (!rel) throw new Error('「写文件」节点没有填目标路径');
      const content = fillTemplate(d.content || '{{prev}}', { ...vars, input: runInput, ...inputs });
      const abs = safeJoin(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return { text: content, meta: { path: rel, bytes: Buffer.byteLength(content) } };
    }
    case 'branch': {
      const prev = String(inputs.prev ?? '');
      const value = fillTemplate(d.value, { ...vars, input: runInput, ...inputs });
      let hit = false;
      if (d.op === 'non-empty') hit = prev.trim().length > 0;
      else if (d.op === 'regex') {
        try {
          hit = new RegExp(value).test(prev);
        } catch (err) {
          throw new Error(`正则写错了：${err.message}`);
        }
      } else if (d.op === 'not-contains') hit = !prev.includes(value);
      else hit = prev.includes(value);
      return { text: prev, meta: { op: d.op, value, hit }, port: hit ? 'true' : 'false' };
    }
    case 'output':
      return { text: String(inputs.prev ?? ''), meta: { title: d.title || '产物', chars: String(inputs.prev ?? '').length } };
    default:
      throw new Error(`未知节点类型：${node.type}`);
  }
}

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

/**
 * 选出当前可跳过 / 可并行执行的节点。
 * - 所有入边的上游都已结束（完成或跳过）后才决策
 * - 有入边但无一活跃 → 分支未选中，跳过
 * - 其余就绪节点同一波并行（互不依赖）
 */
export function pickReadyWave({ order, pending, done, edges, active }) {
  const skip = [];
  const ready = [];
  for (const id of order) {
    if (!pending.has(id)) continue;
    const inEdges = edges.filter((e) => e.to === id);
    const predsDone = inEdges.every((e) => done.has(e.from));
    if (!predsDone) continue;
    const live = inEdges.filter((e) => active.has(`${e.from}|${e.fromPort || 'default'}`));
    if (inEdges.length && !live.length) skip.push(id);
    else ready.push(id);
  }
  return { skip, ready };
}

export async function runWorkflow({ root, workflow, input, emit = () => {}, signal }) {
  const wf = normalize(workflow);
  const check = validateGraph(wf);
  if (!check.ok) throw new Error(`工作流不合法：${check.errors.join('；')}`);

  const order = topoOrder(wf);
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const outputs = new Map(); // nodeId → {text, meta}
  const active = new Set(); // 活跃的边：`from|port`
  const pending = new Set(order);
  const done = new Set(); // 已完成或已跳过
  const cache = createRunCache();
  const startedAt = performance.now();
  const events = [];
  let waves = 0;
  let parallelNodes = 0;

  emit({ type: 'run-start', runId: wf.id, order, nodes: wf.nodes.length, edges: wf.edges.length });
  const log = (ev) => {
    events.push({ at: Date.now(), ...ev });
    emit(ev);
  };

  const runOne = async (id) => {
    const node = byId.get(id);
    const inEdges = wf.edges.filter((e) => e.to === id);
    const live = inEdges.filter((e) => active.has(`${e.from}|${e.fromPort || 'default'}`));
    const prevText = live
      .map((e) => outputs.get(e.from)?.text || '')
      .filter(Boolean)
      .join('\n\n');
    const vars = { input: input || '', prev: prevText };
    for (const [nid, out] of outputs) vars[`nodes.${nid}`] = out.text;

    log({ type: 'node-start', id, nodeType: node.type, label: node.data?.label || NODE_TYPES[node.type].label });
    const t0 = performance.now();
    try {
      const r = await execNode(node, {
        inputs: { prev: prevText },
        vars,
        root,
        runInput: input,
        emit: log,
        signal,
        cache,
      });
      return { id, node, r, ms: Math.round(performance.now() - t0), error: null };
    } catch (err) {
      return { id, node, r: null, ms: Math.round(performance.now() - t0), error: err };
    }
  };

  while (pending.size) {
    if (signal?.aborted) {
      log({ type: 'run-error', error: '已中止' });
      return { ok: false, error: '已中止', events, outputs: {} };
    }

    const { skip, ready } = pickReadyWave({
      order,
      pending,
      done,
      edges: wf.edges,
      active,
    });

    for (const id of skip) {
      pending.delete(id);
      done.add(id);
      log({ type: 'node-skip', id, reason: '上游分支未选中' });
    }

    if (!ready.length) {
      if (skip.length) continue;
      log({ type: 'run-error', error: '工作流卡住了：没有可执行的节点（可能是连线或分支配置有误）' });
      return { ok: false, error: '工作流卡住了：没有可执行的节点', events, outputs: Object.fromEntries(outputs) };
    }

    waves += 1;
    if (ready.length > 1) {
      parallelNodes += ready.length;
      log({ type: 'wave-start', wave: waves, nodes: ready, parallel: true });
    }

    const settled = await Promise.all(ready.map((id) => runOne(id)));
    // 先落盘本波成功的节点，再处理失败：并行时别因为 A 挂了把 B 的产物也丢掉
    const failed = settled.filter((s) => s.error);
    for (const item of settled) {
      pending.delete(item.id);
      done.add(item.id);
      if (item.error) continue;
      const { r } = item;
      outputs.set(item.id, r);
      const port = r.port || 'default';
      active.add(`${item.id}|${port}`);
      log({
        type: 'node-done',
        id: item.id,
        port,
        ms: item.ms,
        meta: r.meta || {},
        preview: String(r.text || '').slice(0, 400),
        chars: String(r.text || '').length,
        failed: r.failed || null,
      });
    }
    if (failed.length) {
      const item = failed[0];
      log({ type: 'node-error', id: item.id, ms: item.ms, error: item.error.message });
      const result = {
        ok: false,
        error: `${item.node.data?.label || item.id}：${item.error.message}`,
        events,
        outputs: Object.fromEntries(outputs),
        waves,
        parallelNodes,
      };
      log({ type: 'run-error', error: result.error });
      return result;
    }
  }

  // 多产物：取「实际跑过」的那一个；都没跑到就退回第一个定义
  const outputNodes = wf.nodes.filter((n) => n.type === 'output');
  const ranOut = outputNodes.find((n) => outputs.has(n.id));
  const finalNode = ranOut || outputNodes[0];
  const finalText = finalNode ? outputs.get(finalNode.id)?.text || '' : '';
  const result = {
    ok: true,
    ms: Math.round(performance.now() - startedAt),
    output: finalText,
    outputs: Object.fromEntries([...outputs].map(([k, v]) => [k, v.text])),
    events,
    waves,
    parallelNodes,
  };
  log({
    type: 'run-done',
    ms: result.ms,
    output: finalText.slice(0, 2000),
    chars: finalText.length,
    waves,
    parallelNodes,
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* 运行历史                                                            */
/* ------------------------------------------------------------------ */

export async function appendRun(root, record) {
  const dir = dirOf(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'runs.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function listRuns(root, limit = 20) {
  try {
    const raw = await fs.readFile(path.join(dirOf(root), 'runs.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 内置模板                                                            */
/* ------------------------------------------------------------------ */

export function starterWorkflows() {
  return [
    {
      id: 'wf-review',
      name: '代码审查流水线',
      desc: '读一个文件 → AI 按「代码审查」技能挑问题 → 结果写进 docs/review-<时间>.md',
      nodes: [
        { id: 'n1', type: 'input', x: 40, y: 200, data: { label: '输入', placeholder: '要审查的文件路径，例如 src/App.jsx' } },
        { id: 'n2', type: 'read', x: 260, y: 200, data: { label: '读文件', path: '{{input}}' } },
        {
          id: 'n3',
          type: 'ai',
          x: 500,
          y: 200,
          data: { label: 'AI 审查', mode: 'ask', prompt: '按代码审查技能审下面这段代码：只列必须改的问题，每条给出文件行号级别的定位与改法。' },
        },
        { id: 'n4', type: 'write', x: 760, y: 200, data: { label: '写报告', path: 'docs/review-latest.md', content: '# 代码审查结果\n\n{{prev}}\n' } },
        { id: 'n5', type: 'output', x: 1000, y: 200, data: { label: '产物', title: '审查报告' } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
        { id: 'e2', from: 'n2', to: 'n3', fromPort: 'default' },
        { id: 'e3', from: 'n3', to: 'n4', fromPort: 'default' },
        { id: 'e4', from: 'n4', to: 'n5', fromPort: 'default' },
      ],
    },
    {
      id: 'wf-lint-triage',
      name: 'Lint 失败分流',
      desc: '跑 npm run lint → 有 warning 才让 AI 写修复建议 → 产物落盘（带条件分支）',
      nodes: [
        { id: 'n1', type: 'input', x: 40, y: 160, data: { label: '输入' } },
        { id: 'n2', type: 'shell', x: 240, y: 160, data: { label: '跑 lint', cmd: 'npm run lint' } },
        { id: 'n3', type: 'branch', x: 470, y: 160, data: { label: '有告警？', op: 'contains', value: 'warning' } },
        { id: 'n4', type: 'ai', x: 700, y: 80, data: { label: 'AI 归因', mode: 'ask', prompt: '下面是 lint 输出。按严重程度分组，给出每条告警的修法，不要泛泛而谈。' } },
        { id: 'n5', type: 'output', x: 940, y: 80, data: { label: '产物', title: 'Lint 分析' } },
        { id: 'n6', type: 'output', x: 940, y: 250, data: { label: '产物', title: '无告警' } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
        { id: 'e2', from: 'n2', to: 'n3', fromPort: 'default' },
        { id: 'e3', from: 'n3', to: 'n4', fromPort: 'true' },
        { id: 'e4', from: 'n4', to: 'n5', fromPort: 'default' },
        { id: 'e5', from: 'n3', to: 'n6', fromPort: 'false' },
      ],
    },
    {
      id: 'wf-todo',
      name: 'TODO 汇总',
      desc: '全仓搜索 TODO/FIXME → AI 按优先级整理成待办清单 → 写进 docs/todos.md',
      nodes: [
        { id: 'n1', type: 'input', x: 40, y: 180, data: { label: '输入' } },
        { id: 'n2', type: 'search', x: 240, y: 180, data: { label: '搜 TODO', query: 'TODO' } },
        { id: 'n3', type: 'ai', x: 470, y: 180, data: { label: '归类排序', mode: 'ask', prompt: '把下面这些 TODO/FIXME 按「影响正确性 > 影响可维护性 > 优化」排序，输出带文件与行号的清单。' } },
        { id: 'n4', type: 'write', x: 700, y: 180, data: { label: '写文件', path: 'docs/todos.md', content: '# 待办清单\n\n> 由工作流生成，来源：全仓搜索 TODO。\n\n{{prev}}\n' } },
        { id: 'n5', type: 'output', x: 940, y: 180, data: { label: '产物', title: '待办清单' } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
        { id: 'e2', from: 'n2', to: 'n3', fromPort: 'default' },
        { id: 'e3', from: 'n3', to: 'n4', fromPort: 'default' },
        { id: 'e4', from: 'n4', to: 'n5', fromPort: 'default' },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function workflowApiPlugin({ workspace }) {
  const root = () => workspace() || process.cwd();

  const middleware = async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/workflow')) return next();
    const route = url.pathname.replace(/^\/api\/workflow\/?/, '');

    try {
      if (route === '' && req.method === 'GET') {
        const list = await listWorkflows(root());
        return sendJson(res, 200, { workflows: list, types: NODE_TYPES, starters: list.length ? [] : starterWorkflows() });
      }
      if (route === 'types' && req.method === 'GET') return sendJson(res, 200, { types: NODE_TYPES });
      if (route === 'get' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (id) return sendJson(res, 200, await getWorkflow(root(), id));
        return sendJson(res, 200, { starters: starterWorkflows() });
      }
      if (route === 'validate' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, validateGraph(normalize(body.workflow || body)));
      }
      if (route === 'save' && req.method === 'POST') {
        const body = await readBody(req);
        const wf = await saveWorkflow(root(), body.workflow || body);
        return sendJson(res, 200, { ok: true, workflow: wf });
      }
      if (route === 'delete' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, { ok: true, ...(await deleteWorkflow(root(), body.id)) });
      }
      if (route === 'runs' && req.method === 'GET') {
        return sendJson(res, 200, { runs: await listRuns(root(), Number(url.searchParams.get('limit') || 20)) });
      }
      if (route === 'run' && req.method === 'POST') {
        const body = await readBody(req);
        const wf = body.workflow?.nodes ? body.workflow : await getWorkflow(root(), body.id);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const started = Date.now();
        const controller = new AbortController();
        req.on('close', () => controller.abort());
        const emit = (ev) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        };
        let result;
        try {
          result = await runWorkflow({
            root: root(),
            workflow: wf,
            input: body.input || '',
            emit,
            signal: controller.signal,
          });
          await appendRun(root(), {
            at: started,
            id: wf.id,
            name: wf.name,
            input: String(body.input || '').slice(0, 200),
            ok: result.ok,
            ms: result.ms ?? Date.now() - started,
            error: result.error || null,
            outputChars: (result.output || '').length,
          });
        } catch (err) {
          emit({ type: 'run-error', error: err.message });
          result = { ok: false, error: err.message };
          await appendRun(root(), { at: started, id: wf.id, name: wf.name, ok: false, error: err.message, ms: Date.now() - started });
        }
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'end', ok: result.ok })}\n\n`);
          res.end();
        }
        return undefined;
      }
      return sendJson(res, 404, { error: `未知路由 ${req.method} /api/workflow/${route}` });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
      else if (!res.writableEnded) res.end();
      return undefined;
    }
  };

  return {
    name: 'cortex-workflow-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default workflowApiPlugin;
