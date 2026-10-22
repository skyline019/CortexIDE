/**
 * Plan 模式：从模型输出里取出「可执行的计划」，并真的把它构建出来。
 *
 * 两个纯函数 + 一个执行器：
 *   extractPlan(text)  解析 ```plan JSON 块，做严格校验（不合法就说哪里不合法，不猜）
 *   planSummary(plan)  统计（步数、读文件/查询/写/执行各几步、风险步骤）
 *   buildPlan(...)     按顺序调真实工具；每步都有 onStep 回调，UI 能看到进度
 *
 * 为什么要校验：模型偶尔会把 plan 包在代码块外面、写成单引号、或者把 write_file 的内容写成
 * 「同上」。这些如果直接执行，要么报错要么写坏文件 —— 宁可在这里拒绝，也不要「尽力执行」。
 */

export const PLAN_TOOLS = ['read_file', 'write_file', 'list_files', 'search_files', 'run_command', 'recall'];

const RISKY = new Set(['write_file', 'run_command']);
const WRITE_LIKE = new Set(['write_file']);
const QUERY_TOOLS = new Set(['list_files', 'search_files', 'recall']);
/** 工具 args 只允许这些键，防止模型塞入额外字段被展开注入 */
const ARG_KEYS = ['path', 'content', 'cmd', 'query', 'offset', 'limit'];

const isPlainObject = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function pickArgs(raw) {
  const args = {};
  for (const k of ARG_KEYS) {
    if (raw[k] !== undefined) args[k] = raw[k];
  }
  return args;
}

/** 用 ```plan 围栏取出 JSON；没有围栏才退一步找看起来像 plan 的 JSON 对象 */
export function extractPlan(text) {
  const raw = String(text || '');
  const fences = [...raw.matchAll(/```(?:plan|json)?\s*\n([\s\S]*?)```/gi)];
  const candidates = fences.map((m) => m[1].trim());

  // 兜底：只在没有围栏时启用，避免正文里的伪 JSON 干扰围栏候选的诊断信息
  if (!candidates.length) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const slice = raw.slice(first, last + 1);
      if (/"steps"/.test(slice)) candidates.push(slice);
    }
  }

  const errs = [];
  for (const c of candidates) {
    if (!c.includes('steps')) continue;
    let obj;
    let repaired = false;
    try {
      obj = JSON.parse(c);
    } catch (err) {
      // 输出被 max_tokens 截断是常事（长计划尤其容易）。先试着把「最后一个完整的 step」
      // 截出来补上括号 —— 但必须**如实告诉用户这是恢复的**，不能假装计划是完整的。
      const rec = repairTruncatedJson(c);
      if (rec) {
        obj = rec;
        repaired = true;
      } else {
        errs.push(`JSON 解析失败：${err.message}`);
        continue;
      }
    }
    const checked = validatePlan(obj);
    if (checked.ok) {
      return {
        ok: true,
        plan: checked.plan,
        raw: c,
        repaired,
        note: repaired
          ? `计划是从被截断的模型输出里恢复的：只保留了前 ${checked.plan.steps.length} 个完整步骤`
          : null,
      };
    }
    errs.push(checked.errors.join('；'));
  }
  return {
    ok: false,
    error: errs.length ? errs.join(' ｜ ') : '回答里没有找到 ```plan 代码块',
    plan: null,
  };
}

/**
 * 修复被截断的 plan JSON：从头扫描，记录「step 对象完整结束」的位置，
 * 截断到最后一个完整 step，再补 `]}` 收尾。
 * 只处理「steps 数组被截断」这一种情况；其它损坏一律返回 null（不猜）。
 */
export function repairTruncatedJson(text) {
  const src = String(text || '');
  const stepsAt = src.indexOf('"steps"');
  if (stepsAt < 0) return null;
  const arrStart = src.indexOf('[', stepsAt);
  if (arrStart < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastComplete = -1;
  for (let i = arrStart; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      // 回到数组层级（depth === 1）说明刚闭合的是一个 step 对象
      if (depth === 1 && ch === '}') lastComplete = i;
      if (depth === 0) return null; // 数组已经完整闭合，不是截断问题
    }
  }
  if (lastComplete < 0) return null;
  const head = src.slice(0, lastComplete + 1);
  const withArr = `${head}]}`;
  // 前面的 goal 字段必须完整，否则补出来的东西没有意义
  const goalEnd = head.indexOf('"steps"');
  if (!goalEnd || !/"goal"\s*:/.test(head.slice(0, goalEnd))) return null;
  try {
    return JSON.parse(withArr);
  } catch {
    return null;
  }
}

export function validatePlan(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['不是对象'] };
  const goal = typeof obj.goal === 'string' ? obj.goal.trim() : '';
  if (!goal) errors.push('缺少 goal');
  if (!Array.isArray(obj.steps) || !obj.steps.length) errors.push('steps 必须是非空数组');

  const steps = [];
  for (const [i, s] of (obj.steps || []).entries()) {
    const idx = i + 1;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`第 ${idx} 步不是对象`);
      continue;
    }
    const tool = String(s.tool || '').trim();
    if (!PLAN_TOOLS.includes(tool)) {
      errors.push(`第 ${idx} 步的 tool「${tool}」不支持（可用：${PLAN_TOOLS.join(' / ')}）`);
      continue;
    }
    if (s.args !== undefined && !isPlainObject(s.args)) {
      errors.push(`第 ${idx} 步的 args 必须是普通对象`);
      continue;
    }
    const args = pickArgs(s.args || {});
    if (tool === 'read_file' && !args.path) errors.push(`第 ${idx} 步 read_file 缺少 path`);
    if (tool === 'write_file') {
      if (!args.path) errors.push(`第 ${idx} 步 write_file 缺少 path`);
      if (typeof args.content !== 'string' || !args.content.trim()) errors.push(`第 ${idx} 步 write_file 的 content 是空的`);
      // 「同上」「见上一步」这类占位如果真被执行，会写坏文件
      if (typeof args.content === 'string' && /^(同上|见上|略|\.\.\.|…)$/.test(args.content.trim())) {
        errors.push(`第 ${idx} 步 write_file 的 content 是占位文本，必须给完整内容`);
      }
    }
    if (tool === 'run_command' && !args.cmd) errors.push(`第 ${idx} 步 run_command 缺少 cmd`);
    if (tool === 'search_files' && !args.query) errors.push(`第 ${idx} 步 search_files 缺少 query`);
    if (tool === 'recall' && !args.query) errors.push(`第 ${idx} 步 recall 缺少 query`);

    steps.push({
      id: Number(s.id) || idx,
      title: String(s.title || `${tool} #${idx}`).slice(0, 160),
      tool,
      args,
      why: String(s.why || '').slice(0, 400),
      expect: String(s.expect || '').slice(0, 300),
      risky: RISKY.has(tool),
    });
  }
  return { ok: errors.length === 0, errors, plan: { goal, steps } };
}

export function planSummary(plan) {
  const steps = plan?.steps || [];
  const count = (t) => steps.filter((s) => s.tool === t).length;
  return {
    steps: steps.length,
    reads: count('read_file'),
    queries: steps.filter((s) => QUERY_TOOLS.has(s.tool)).length,
    writes: count('write_file'),
    commands: count('run_command'),
    risky: steps.filter((s) => s.risky).length,
    files: [...new Set(steps.filter((s) => WRITE_LIKE.has(s.tool)).map((s) => s.args?.path).filter(Boolean))],
  };
}

/**
 * 真正构建计划：按顺序调用工具。
 *
 * @param {object} opts
 * @param {Array} opts.steps 校验过的步骤
 * @param {Record<string, Function>} opts.tools createTools() 的产物
 * @param {(ev:object)=>void} [opts.onStep] 每步开始/结束的回调
 * @param {(cmd:string, reason:string)=>Promise<string>} [opts.approval] 命令确认（工具内部用）
 * @param {(path:string, content:string)=>void} [opts.onWrite] 写文件成功后的回调（UI 刷新标签页）
 * @param {boolean} [opts.stopOnError] 默认 true：一步失败就停，不带着半成品继续跑
 * @param {AbortSignal} [opts.signal]
 */
export async function buildPlan({ steps, tools, onStep = () => {}, onWrite, stopOnError = true, signal }) {
  const list = steps || [];
  const results = [];
  let aborted = false;

  for (const step of list) {
    if (signal?.aborted) {
      aborted = true;
      onStep({ phase: 'abort', step });
      break;
    }
    onStep({ phase: 'start', step });
    const t0 = performance.now();
    const fn = tools?.[step.tool];

    let r;
    if (!fn) {
      r = { id: step.id, ok: false, ms: 0, detail: `没有这个工具：${step.tool}` };
    } else {
      try {
        const out = await fn(step.args || {});
        const ms = Math.round(performance.now() - t0);
        if (step.tool === 'write_file' && out?.path && onWrite) onWrite(out.path, step.args?.content);
        r = { id: step.id, ok: true, ms, detail: describe(step.tool, out), out };
      } catch (err) {
        r = { id: step.id, ok: false, ms: Math.round(performance.now() - t0), detail: err?.message ?? String(err) };
      }
    }

    results.push(r);
    onStep({ phase: 'done', step, result: r });
    if (!r.ok && stopOnError) break;
  }

  // 空计划视为成功；有步骤则要求全部成功且未被中断
  const ok = !aborted && results.every((r) => r.ok);
  return {
    ok,
    results,
    ran: results.length,
    total: list.length,
    aborted,
    // 兼容旧调用方：因失败提前停、或被 abort，都算 stopped
    stopped: aborted || results.length < list.length,
  };
}

function describe(tool, out) {
  if (!out || typeof out !== 'object') return '完成';
  switch (tool) {
    case 'read_file':
      return out.to ? `${out.from}-${out.to} 行` : `${out.totalLines ?? '?'} 行`;
    case 'write_file':
      return out.created ? `新建 ${out.path}` : `覆盖 ${out.path}`;
    case 'search_files':
      return `${out.total ?? out.matches?.length ?? 0} 处匹配`;
    case 'list_files':
      return `${out.files?.length ?? out.total ?? 0} 个文件`;
    case 'run_command':
      return out.denied ? '用户拒绝执行' : `退出码 ${out.code}`;
    case 'recall':
      return `命中 ${out.memories?.length ?? 0} 条`;
    default:
      return '完成';
  }
}

/** 把计划导出成 markdown（可以存进仓库、贴进 issue） */
export function planToMarkdown(plan, { mode = 'plan', at = Date.now() } = {}) {
  const s = planSummary(plan);
  const head = [
    `# 计划：${plan.goal}`,
    '',
    `> 由 Cortex 在 ${mode} 模式生成 · ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`,
    `> ${s.steps} 步（读文件 ${s.reads} · 查询 ${s.queries} · 写文件 ${s.writes} · 执行命令 ${s.commands}）`,
    '',
    '| # | 动作 | 工具 | 目标 | 为什么 | 预期 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const step of plan.steps) {
    const target = step.args?.path || step.args?.cmd || step.args?.query || '—';
    const esc = (v) => String(v || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    head.push(`| ${step.id} | ${esc(step.title)} | \`${step.tool}\` | \`${esc(target)}\` | ${esc(step.why)} | ${esc(step.expect)} |`);
  }
  head.push('', '```plan', JSON.stringify(plan, null, 2), '```', '');
  return head.join('\n');
}
