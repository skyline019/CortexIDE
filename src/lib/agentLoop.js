/**
 * 远程模型 agent loop（OpenAI 兼容 + SSE 流式 + function calling）
 */
import { recall, KINDS } from './memory.js';
import { uid } from './vfs.js';
import {
  loadImagePart,
  buildUserContent,
  imagePathsFromRefs,
  resolveVisionModel,
} from './vision.js';
import {
  createTools,
  MODE_TOOLS,
  ALL_TOOL_NAMES,
  toolsForMode,
  pickToolArgs,
  canParallelTools,
  toolResultDetail,
  prettyArgs,
} from './agentTools.js';

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
