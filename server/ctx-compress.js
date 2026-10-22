/**
 * 主干压缩（main trunk compression）
 *
 * 一次 Agent 对话里，token 花在哪：真正的问题往往只有几十 token，
 * 剩下全是「工具回传的整个文件 / 整段命令输出 + 越滚越长的历史」。
 * 实测一次「写个速览」的对话：4 轮下来 prompt 14568 token，其中 92% 是工具回传。
 *
 * 所以这里不是简单截断，而是**结构感知**地压：
 *
 *  1. 工具结果（JSON）→ 逐字段处理：长文本按「相关行」挑选，短字段（路径/id/退出码/行数）原样保留；
 *     被省略的地方留下 …（省略 N 行）… 和「可用 read_file 重新读取」的提示，模型需要时可以再取。
 *  2. 较早的历史轮次 → 抽取式摘要：留下含决策/约束/报错/标识符的句子，其余压缩。
 *  3. 重复内容（同一个文件被读两次）→ 只留最新一份。
 *  4. 全局预算：按「系统提示 > 最后一条用户消息 > 最近工具结果 > 老历史」的优先级分配，
 *     超预算就继续加大压缩力度，**永远不删消息**（删了会破坏 tool_call 配对，上游直接 400）。
 *
 * 全部确定性规则，不调模型、不额外花钱；每次压缩产出可量化的 before/after。
 */

const ERROR_RE = /(error|fail|failed|exception|traceback|fatal|warn|断言|失败|错误|异常|超时|拒绝|denied|PASS|FAIL|ok\b|通过|退出码|exit)/i;
const CODE_RE = /(^\s*(import|export|from|const|let|var|function|class|async|def|return|if|for|while|type|interface)\b|=>|^\s*[})\]]|^\s*\/\/|^\s*#|^\s*\$ )/;
const DECISION_RE = /(决定|不要|不许|必须|约定|改成|偏好|记住|约束|禁止|规则|接口|字段|端口|路径|命令是|表名|函数名|版本|TODO|下一步)/;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$.-]{2,}|`[^`]+`/g;
const CJK_RE = /[\u4e00-\u9fff]/;

/** 从文本里提取检索词（拉丁标识符 + 中文 bigram），用于「相关行」打分 */
export function extractTerms(text, limit = 40) {
  const set = new Set();
  const s = String(text || '');
  for (const w of s.match(/[A-Za-z_$][A-Za-z0-9_$-]{2,}/g) || []) {
    const t = w.toLowerCase();
    if (t.length >= 3) set.add(t);
  }
  for (const block of s.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < block.length - 1; i += 1) set.add(block.slice(i, i + 2));
  }
  return new Set([...set].slice(0, limit * 4));
}

const scoreLine = (line, terms) => {
  let s = 0;
  if (ERROR_RE.test(line)) s += 5;
  if (CODE_RE.test(line)) s += 1.5;
  if (/\b(function|class|export|def|interface|type)\s+[A-Za-z_$]/.test(line)) s += 2.5; // 定义行优先留
  const low = line.toLowerCase();
  let hits = 0;
  for (const t of terms) if (low.includes(t)) hits += 1;
  s += Math.min(6, hits * 1.5);
  if (IDENT_RE.test(line)) s += 0.5;
  if (line.length > 400) s -= 1; // 超长行（压缩后的 json）信息密度低
  return s;
};

// ⚠️ 带 /g 的正则用 .test() 会推进 lastIndex，导致「同样的输入两次结果不同」。
// 打分用的判断一律走不带 /g 的副本。
const FILE_SRC = '[A-Za-z0-9_<>./\\-\\u4e00-\\u9fff]+\\.(?:js|jsx|mjs|json|md|db|bin|css|html|ts|tsx|yml|yaml|sh|env)\\b';
const FILE_RE = new RegExp(FILE_SRC, 'g');
const FILE_TEST = new RegExp(FILE_SRC);
const CMD_SRC = '\\b(?:npm|pnpm|npx|node|git)\\s+[a-z][\\w:.\\-]*(?:\\s+[a-z][\\w:.\\-]*){0,2}';
const CMD_RE = new RegExp(CMD_SRC, 'gi');
const CMD_TEST = new RegExp(CMD_SRC, 'i');
// 代码里出现频率极高、但对「回忆」毫无信息量的词：不进关键符号索引
const CODE_STOP = new Set([
  'const', 'value', 'return', 'function', 'string', 'number', 'object', 'length', 'default', 'content',
  'result', 'error', 'console', 'import', 'export', 'userId', 'index', 'prepare', 'memories', 'user_id',
  'where', 'vector', 'select', 'rowid', 'workspace', 'delete', 'insert', 'update', 'values', 'count',
  'catch', 'await', 'async', 'push', 'slice', 'filter', 'table', 'buffer', 'write', 'read', 'true',
  'false', 'null', 'undefined', 'JSON', 'Object', 'Array', 'Buffer', 'Promise', 'this', 'self', 'then',
]);

/**
 * 省略区「关键符号索引」。
 *
 * 只留头尾 + 高分行有个已知风险：某个函数名 / 文件名 / 命令恰好落在被省略的中间，
 * 模型就再也看不到它（实测会丢 u-local-512d.v3.bin、flushAnn、npm run dev）。
 * 这里把被省略行里的**高价值符号**（文件名、标识符、命令）抽出来压成一行附在末尾，
 * 成本几十 token，换回事实召回。
 */
export function keyIndex(droppedLines, terms = new Set(), limit = 22) {
  // 频次与「结构加分」分开记：频次做封顶（防常见词霸榜），结构加分不封顶
  // （定义出来的函数名必须是第一优先级，否则一压就没）。
  const freq = new Map();
  const bonus = new Map();
  const add = (tok, b = 0) => {
    const t = String(tok).trim();
    if (t.length < 4 || CODE_STOP.has(t) || CODE_STOP.has(t.toLowerCase())) return;
    freq.set(t, (freq.get(t) || 0) + 1);
    if (b) bonus.set(t, Math.max(bonus.get(t) || 0, b));
  };
  for (const line of droppedLines) {
    // 「定义出来的名字」最值钱。顶格（列 0）的定义是模块的公开面，权重最高；
    // 函数体内部的局部变量（缩进的）次之 —— 否则 dirtyRows 这种局部名会把 flushAnn 挤掉。
    const topLevel = !/^\s/.test(line);
    // 「函数名」比「变量名」值钱：变量名大多在文件头部就露过脸了，函数名才是
    // 「这个文件提供什么能力」的答案（flushAnn 就是被一堆 const 挤掉过的）。
    for (const m of line.match(/\b(function|class|def|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]{3,})/g) || []) {
      const isFn = /^(function|class|def|interface|type|enum)\b/.test(m);
      add(m.replace(/^\w+\s+/, ''), isFn ? (topLevel ? 14 : 8) : topLevel ? 10 : 6);
    }
    for (const m of line.match(FILE_RE) || []) add(m, 3);
    for (const m of line.match(CMD_RE) || []) add(m, 2);
    for (const m of line.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]{4,}\b/g) || []) add(m);
  }
  const scored = [...freq.entries()].map(([tok, w]) => {
    const low = tok.toLowerCase();
    let hit = 0;
    for (const t of terms) if (low.includes(t) || t.includes(low)) hit += 1;
    const isCmd = CMD_TEST.test(tok);
    const isFile = FILE_TEST.test(tok);
    const shape =
      (/^[A-Z][A-Z0-9_]{3,}$/.test(tok) ? 5 : 0) + // FLUSH_ANN 这类常量
      (/^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(tok) ? 4.5 : 0) + // camelCase 函数/变量名
      (/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(tok) ? 2.5 : 0) + // snake_case
      (isFile ? 4 : 0) +
      (isCmd ? 4 : 0);
    // 频次做**封顶**：不封顶的话「cortex / server」这种到处出现的词会把有辨识度的名字挤出去
    return {
      tok,
      // 「定义行里出现的名字」单独一类：它们最直接回答「这个文件里有什么」
      cat: isCmd ? 'cmd' : isFile ? 'file' : (bonus.get(tok) || 0) >= 6 ? 'def' : 'id',
      bonus: bonus.get(tok) || 0,
      score: Math.min(w, 8) * 0.55 + (bonus.get(tok) || 0) + shape + Math.min(9, hit * 3) + Math.min(3, tok.length / 10),
    };
  });
  // 分类配额：命令和文件名各有保底名额，不跟几百个普通标识符抢位置
  // def 必须单独占一档：定义行里的函数名是最值钱的信息，跟几百个普通标识符一起排队必被挤掉
  const quota = { cmd: 40, file: 14, def: 20, id: 12 }; // 命令全留（渲染时合并压缩，几乎不占地方）
  const out = [];
  for (const cat of ['cmd', 'file', 'def', 'id']) {
    out.push(
      ...scored
        .filter((x) => x.cat === cat)
        // def 档先按「值钱程度」（函数 > 变量）排，再按分数：否则一堆 const 会把函数名顶掉
        .sort((a, b) => (cat === 'def' ? b.bonus - a.bonus || b.score - a.score : b.score - a.score))
        .slice(0, Math.min(quota[cat], limit))
        .map((x) => x.tok),
    );
  }
  return out;
}

/**
 * 文本压缩：保留开头 + 结尾 + 高分行，中间用省略标记占位。
 * @returns {{text:string, omitted:number, kept:number, total:number}}
 */
/**
 * 把关键符号渲染成一行：同一命令前缀的合并成 `npm run dev|clean|bench`，
 * 这样索引里能塞下更多命令，而字符数几乎不涨。
 */
export function renderKeyIndex(tokens, budgets = { cmd: 260, file: 200, def: 240, id: 90 }) {
  const cmdGroups = new Map();
  const files = [];
  const defs = [];
  const ids = [];
  for (const t of tokens) {
    const str = String(t);
    const m = str.match(/^(npm run|npm|pnpm|npx|node|git)\s+(.+)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      if (!cmdGroups.has(key)) cmdGroups.set(key, []);
      cmdGroups.get(key).push(m[2].trim());
    } else if (FILE_TEST.test(str)) files.push(str);
    else if (defs.length < 24 && /^(?:[a-z]+[A-Z]\w*|[A-Z][A-Z0-9_]{3,}|[a-z]\w*_[a-z0-9_]+)$/.test(str)) defs.push(str);
    else ids.push(str);
  }

  const joinLimited = (items, budget) => {
    const out = [];
    let used = 0;
    for (const it of items) {
      if (used + it.length > budget) break;
      out.push(it);
      used += it.length + 3;
    }
    return out;
  };

  const parts = [];
  // ① 命令：同一前缀合并成 `npm run dev|lint|bench`，几乎不占地方又全都能照跑
  const cmdParts = [];
  for (const [prefix, subs] of cmdGroups) {
    const uniq = [...new Set(subs)];
    let line = `${prefix} `;
    const kept = [];
    for (const sub of uniq) {
      if (line.length + sub.length + 1 > budgets.cmd) break;
      kept.push(sub);
      line = `${prefix} ${kept.join('|')}`;
    }
    if (kept.length) cmdParts.push(line);
  }
  parts.push(...cmdParts);
  // ② 定义名排在最前：它最值钱（「这个文件里有哪些函数」），预算也最大，
  //    否则 flushAnn 这种排在第 14 位的函数名会被截断（真丢过）。
  parts.push(...joinLimited(defs, budgets.def));
  // ③ 文件名/路径 ④ 其他标识符：各有独立预算，不会互相挤掉
  parts.push(...joinLimited(files, budgets.file));
  parts.push(...joinLimited(ids, budgets.id));
  return parts.join(' · ');
}

export function compressText(text, { terms = new Set(), budget = 3000, head = 6, tail = 6, label = '' } = {}) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  const total = lines.length;
  if (s.length <= budget) return { text: s, omitted: 0, kept: total, total };
  if (total === 1) {
    // 单行大文本（压缩过的 json / 长日志）：按字符切头尾
    const headLen = Math.floor(budget * 0.6);
    const tailLen = budget - headLen;
    const out = `${s.slice(0, headLen)}\n…（${label ? `${label} ` : ''}省略 ${s.length - budget} 字符）…\n${s.slice(-tailLen)}`;
    return { text: out, omitted: 1, kept: 2, total: 1 };
  }

  const keep = new Set();
  for (let i = 0; i < Math.min(head, total); i += 1) keep.add(i);
  for (let i = Math.max(0, total - tail); i < total; i += 1) keep.add(i);

  const ranked = lines
    .map((line, i) => ({ i, s: keep.has(i) ? 99 : scoreLine(line, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  let used = 0;
  for (const idx of keep) used += lines[idx].length + 1;
  for (const { i } of ranked) {
    if (keep.has(i)) continue;
    const len = lines[i].length + 1;
    if (used + len > budget) continue;
    keep.add(i);
    used += len;
  }

  const out = [];
  const dropped = [];
  let omitted = 0;
  let run = 0;
  for (let i = 0; i < total; i += 1) {
    if (keep.has(i)) {
      if (run) {
        out.push(`…（${label ? `${label} ` : ''}省略 ${run} 行）…`);
        omitted += run;
        run = 0;
      }
      out.push(lines[i]);
    } else {
      dropped.push(lines[i]);
      run += 1;
    }
  }
  if (run) {
    out.push(`…（${label ? `${label} ` : ''}省略 ${run} 行）…`);
    omitted += run;
  }
  const idx = keyIndex(dropped, terms);
  const rendered = renderKeyIndex(idx);
  // 索引本身也占地方：只有「加上索引仍然明显更短」时才加，否则宁可不加
  // （踩过：长文件只压掉两行时，索引比省下来的还多）
  const withIdx = rendered ? [...out, `…（被省略部分的关键符号：${rendered}）`].join('\n') : '';
  if (rendered && withIdx.length < s.length * 0.92) out.push(`…（被省略部分的关键符号：${rendered}）`);
  return { text: out.join('\n'), omitted, kept: total - omitted, total };
}

/** 工具结果：优先按 JSON 逐字段压，短字段一律不动 */
function compressToolContent(content, { terms, budget, label, hint }) {
  const s = String(content ?? '');
  if (s.length <= budget) return { text: s, omitted: 0, kept: 0, total: 0, json: false };
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    const r = compressText(s, { terms, budget, label });
    return { ...r, json: false };
  }
  if (!obj || typeof obj !== 'object') {
    const r = compressText(s, { terms, budget, label });
    return { ...r, json: false };
  }

  let omitted = 0;
  let kept = 0;
  let total = 0;
  const longFields = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') continue;
    if (v.length < 300) continue;
    longFields.push({ k, len: v.length });
  }
  // 预算按长度比例分给各个长字段，每个至少给 600 字符（保证看得见开头）。
  //
  //   早先是 `len/total * budget * n * 0.9`：字段一多，各字段加起来能到预算的 1.8~2.7 倍，
  //   「压到 3000 字符」实际写出 8000 字符，等于预算没生效（踩过）。
  //   现在严格按比例切，只有「字段数 × 600」这个下限可能略微超预算。
  const totalLong = longFields.reduce((n, f) => n + f.len, 0) || 1;
  const floorPerField = Math.min(600, Math.floor(budget / Math.max(1, longFields.length)));
  for (const f of longFields) {
    const slice = Math.max(floorPerField, Math.round((f.len / totalLong) * budget));
    const key = /stdout|stderr|output|log/i.test(f.k) ? '输出' : /content|text|body/i.test(f.k) ? '文件内容' : f.k;
    const r = compressText(obj[f.k], { terms, budget: slice, label: key });
    obj[f.k] = r.text;
    omitted += r.omitted;
    kept += r.kept;
    total += r.total;
  }
  if (omitted) {
    obj._cortex = {
      压缩: `省略 ${omitted} 行 / 共 ${total} 行（原文 ${s.length} 字符）`,
      提示: hint || '被省略的部分没有被删除；需要时用 read_file（可带 offset/limit）或更精确的 search_files 重新取。',
    };
  }
  let out = JSON.stringify(obj);
  // 兜底：多字段 + 下限叠加后仍可能超预算，按比例再收一轮（只收长字段，短字段一律不动）
  if (out.length > budget * 1.2) {
    const excess = out.length / (budget * 1.1);
    for (const f of longFields) {
      const cur = obj[f.k];
      if (typeof cur !== 'string') continue;
      // 已经压过的字段按同样的比例继续收，头尾比例保持不变
      const target = Math.max(floorPerField, Math.floor(cur.length / excess));
      if (target < cur.length) obj[f.k] = compressText(cur, { terms, budget: target, label: f.k }).text;
    }
    out = JSON.stringify(obj);
  }
  return { text: out, omitted, kept, total, json: true };
}

/** 抽取式摘要：留决策/约束/报错/标识符句，其余丢 */
export function digestText(text, { terms = new Set(), budget = 400 } = {}) {
  const s = String(text ?? '').trim();
  if (s.length <= budget) return s;
  const parts = s
    .split(/(?<=[。！？；\n])|(?<=\.\s)/)
    .map((x) => x.trim())
    .filter(Boolean);
  const scored = parts.map((p, i) => {
    let sc = 0;
    if (DECISION_RE.test(p)) sc += 4;
    if (ERROR_RE.test(p)) sc += 3;
    if (IDENT_RE.test(p)) sc += 1.5;
    const low = p.toLowerCase();
    for (const t of terms) if (low.includes(t)) sc += 1;
    if (i === parts.length - 1) sc += 2; // 结尾通常是结论
    if (i === 0) sc += 1;
    return { p, sc, i };
  });
  scored.sort((a, b) => b.sc - a.sc);
  const picked = [];
  let used = 0;
  for (const it of scored) {
    if (used + it.p.length > budget) continue;
    picked.push(it);
    used += it.p.length;
  }
  picked.sort((a, b) => a.i - b.i);
  const text2 = picked.map((x) => x.p).join(' ');
  return text2 + (picked.length < parts.length ? ` …（压缩掉 ${parts.length - picked.length} 句）` : '');
}

/**
 * 工具 schema 精简。
 *
 * 每轮都要把 tools 重发一遍（7 个工具 ≈ 700~900 token），这部分在「短对话」里
 * 甚至比正文还大。这里只动 description 文本：保留第一句（≤40 字）、参数名/类型/required
 * 一律不动 —— 模型靠这些调用工具，动名字或类型就会调错。
 * 实测 smoke 里 read_file / write_file / run_command / remember / recall 全部照常工作。
 */
export function trimTools(tools, { maxDesc = 40, maxParamDesc = 16 } = {}) {
  if (!Array.isArray(tools) || !tools.length) return { tools, before: 0, after: 0 };
  const before = JSON.stringify(tools).length;
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && k === 'description' && v.length > maxDesc) {
        const first = v.split(/[。；;\n]/)[0].trim();
        obj[k] = first.length > maxDesc ? `${first.slice(0, maxDesc)}…` : first;
      } else if (typeof v === 'string' && k === 'description') {
        obj[k] = v.length > maxParamDesc ? `${v.slice(0, maxParamDesc)}…` : v;
      } else if (typeof v === 'object') walk(v);
    }
  };
  const copy = JSON.parse(JSON.stringify(tools));
  for (const t of copy) {
    if (t.function) {
      // 顶层函数的 description 按 maxDesc 压，参数里的 description 更短
      const keep = t.function.description;
      walk(t.function);
      if (keep) {
        const first = keep.split(/[。；;\n]/)[0].trim();
        t.function.description = first.length > maxDesc ? `${first.slice(0, maxDesc)}…` : first;
      }
    }
  }
  return { tools: copy, before, after: JSON.stringify(copy).length };
}

export const STRENGTHS = {
  off: { budget: 0, toolBudget: 0, historyBudget: 0, keepRecent: 99, label: '关闭' },
  // 预算是「发给上游的 prompt 上限」：原来的 12k 对多数对话根本不触发压缩（实测 6 轮里只有 1 轮超），
  // 省不下来什么。按实测调到 8k / 4.5k，并收紧「老工具结果相对截断」，让每轮都真的瘦下来。
  light: { budget: 16000, toolBudget: 6000, historyBudget: 800, keepRecent: 8, trimOlder: 8000, label: '轻' },
  balanced: { budget: 8000, toolBudget: 3000, historyBudget: 420, keepRecent: 4, trimOlder: 2500, label: '均衡' },
  aggressive: { budget: 4500, toolBudget: 1500, historyBudget: 260, keepRecent: 3, trimOlder: 1200, label: '激进' },
};

/**
 * 主入口：压缩一次要发给模型的 messages。
 * @param {object} p
 * @param {Array} p.messages OpenAI 格式消息（会被浅拷贝，不改原数组）
 * @param {string} p.strength off|light|balanced|aggressive
 * @param {object} p.tokenizer createTokenizer() 的实例（必须）
 * @param {string} p.styleCard 文风卡（追加到 system 末尾；空则不追加）
 * @param {string[]} p.focusTexts 当前问题的原文（用于「相关行」打分），默认取最后一条 user 消息
 */
export function compressPayload({ messages = [], strength = 'balanced', tokenizer, styleCard = '', focusTexts = [], tools = null }) {
  const cfg = STRENGTHS[strength] || STRENGTHS.balanced;
  // tools（函数 schema）每轮都要重发，也是实打实的 token —— 估算必须算进去，
  // 否则「压缩后 vs 上游真实 usage」会差出 30%~60%，省了多少就成了自欺欺人。
  const toolTrim = tools ? trimTools(tools) : null;
  const finalTools = toolTrim ? toolTrim.tools : tools;
  const extraText = finalTools ? JSON.stringify(finalTools) : '';
  // 「原始」用**未精简**的 tools 来算，这样工具 schema 的压缩也算进节省里
  const before = tokenizer.estimateMessages(messages, tools ? JSON.stringify(tools) : '');
  const working = messages.map((m) => ({ ...m }));
  const notes = [];
  const stages = { style: 0, tool: 0, history: 0, dedupe: 0, reread: 0, budget: 0 };
  if (strength === 'off' || !cfg.budget) {
    return {
      messages: working,
      stats: {
        strength,
        label: cfg.label,
        budget: 0,
        beforeTokens: Math.round(before.total),
        afterTokens: Math.round(before.total),
        toolsTokens: extraText ? Math.round(tokenizer.estimate(extraText)) : 0,
        savedTokens: 0,
        savedPct: 0,
        stages,
        notes: ['压缩已关闭'],
      },
    };
  }

  // ① 文风卡：追加到 system 末尾（system 本身通常很短，压缩它没有意义）
  if (styleCard) {
    const idx = working.findIndex((m) => m.role === 'system');
    if (idx >= 0) {
      const cur = working[idx].content;
      if (Array.isArray(cur)) {
        working[idx].content = [...cur, { type: 'text', text: styleCard }];
      } else {
        working[idx].content = `${cur}\n\n${styleCard}`;
      }
    } else {
      working.unshift({ role: 'system', content: styleCard });
    }
    stages.style = Math.round(tokenizer.estimate(styleCard));
  }

  // 本轮问题（用于相关性打分）；多模态 user.content 可能是 array
  const contentText = (c) => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n');
    return '';
  };
  const lastUser = [...working].reverse().find((m) => m.role === 'user');
  const focus = [contentText(lastUser?.content), ...focusTexts].join('\n');
  const terms = extractTerms(focus);

  // ② 历史摘要：只动「较早、且没有 tool_calls 的」普通消息
  const plainIdx = working.map((m, i) => ({ m, i })).filter(({ m }) => !m.tool_calls?.length && m.role !== 'system' && m.role !== 'tool');
  // 够 keepRecent 条时才按「留最近 N 条」划界；不够就该一条都不动。
  // 以前这里写的是 working.length —— 消息少的时候反而把**全部**消息都划进了压缩区，
  // 真机上的表现是：用户拖了附件提问，模型回「你只给了一段压缩摘要，没说想让我干什么」。
  const keepFrom = plainIdx.length > cfg.keepRecent ? plainIdx[plainIdx.length - cfg.keepRecent].i : 0;
  // 本轮问题（最后一条 user）永远不压：它是「用户现在说的话」，压掉就等于答错人。
  const lastUserIdx = working.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
  for (const { m, i } of plainIdx) {
    if (i >= keepFrom) continue;
    if (lastUserIdx >= 0 && i >= lastUserIdx) continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (text.length <= cfg.historyBudget) continue;
    const digest = digestText(text, { terms, budget: cfg.historyBudget });
    stages.history += tokenizer.estimate(text) - tokenizer.estimate(digest);
    m.content = `${m.role === 'user' ? '（早前我的提问，摘要）' : '（早前回答，摘要）'} ${digest}`;
  }

  // ③ 去重：同一份内容出现多次只留最后一次。
  //
  //    ⚠️ 这一步必须跑在「工具压缩」**之前**：压缩会改写内容（头尾 + 索引），
  //    压完再比对就不再相等了 —— 之前去重排在后面，命中的永远是 0 次，
  //    「同一个文件读两遍」这种最典型的浪费一直没被收掉。
  //
  //    另外光比字节还不够：同一个文件重新读一次，内容常常已经变了（编辑过），
  //    但「旧的这份」对新问题已经没有价值。所以再加一路「同路径重读」：
  //    靠 JSON 里的 path / cmd 识别，只留最新的一份，旧的换成一行指针。
  const dedupePass = () => {
    const seenExact = new Map();
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const c = working[i].content;
      if (typeof c !== 'string' || c.length < 200 || working[i].role === 'system') continue;
      const key = c.length + ':' + c.slice(0, 120) + c.slice(-120);
      if (seenExact.has(key)) {
        const first = seenExact.get(key);
        const t = tokenizer.estimate(c) - 40;
        stages.dedupe += t;
        working[i].content = JSON.stringify({ _cortex: `与第 ${first + 1} 条内容重复，已省略（原文 ${c.length} 字符）` });
        notes.push('去掉一份重复内容');
      } else seenExact.set(key, i);
    }

    // 同路径 / 同命令的多次回传：只保留最后一次（模型要的是最新状态）
    const byKey = new Map();
    working.forEach((m, i) => {
      if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length < 400) return;
      let obj;
      try {
        obj = JSON.parse(m.content);
      } catch {
        return;
      }
      if (!obj || typeof obj !== 'object') return;
      const id = obj.path || obj.cmd || obj.file;
      if (typeof id !== 'string' || id.length > 200) return;
      const kind = obj.path || obj.file ? 'file' : 'cmd';
      if (!byKey.has(`${kind}:${id}`)) byKey.set(`${kind}:${id}`, []);
      byKey.get(`${kind}:${id}`).push(i);
    });
    for (const [key, idxs] of byKey) {
      if (idxs.length < 2) continue;
      // 最后一条一定保留（完整内容）；其余换成指针
      for (const i of idxs.slice(0, -1)) {
        const c = working[i].content;
        const saved = tokenizer.estimate(c) - 40;
        if (saved <= 0) continue;
        stages.reread += saved;
        const what = key.startsWith('file:') ? key.slice(5) : `命令 ${key.slice(4)}`;
        working[i].content = JSON.stringify({
          _cortex: `${what} 的旧回传已省略（原文 ${c.length} 字符）；同一份内容后文有更新的回传，看后面那条即可；确需旧版本请重新读取`,
        });
        notes.push(`「${what}」重复读取只留最新一份`);
      }
    }
  };
  dedupePass();

  // ④ 工具结果：按预算**按比例分配**（不是每条都给个固定小额度）
  //
  //    早先的实现给每条工具回传一个固定小预算（1200 字符左右），结果总用量才 6k token、
  //    离 12k 预算还很远，却已经把关键信息压掉了 —— 典型的「过度压缩」。
  //    现在按「剩余预算 × 长度^0.5 × 新旧权重」分配，把预算真正用满：
  //    最新的工具结果权重最高（模型正要用它），老的次之。
  const toolIdx = working.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'tool');
  const nTools = toolIdx.length;
  if (nTools) {
    // 字符预算 ≈ token 预算 × 3（中英混排下 1 token 大约 2.5~3.5 字符）
    const budgetChars = Math.round(cfg.budget * 3);
    const fixedChars = working
      .filter((m) => m.role !== 'tool')
      .reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const pool = Math.max(2400, budgetChars - fixedChars);
    const weights = toolIdx.map(({ m }, k) => {
      const len = Math.max(1, typeof m.content === 'string' ? m.content.length : 1);
      const recency = k === nTools - 1 ? 3 : k === nTools - 2 ? 2 : 1;
      return Math.sqrt(len) * recency;
    });
    const sumW = weights.reduce((a, b) => a + b, 0) || 1;
    toolIdx.forEach(({ m }, k) => {
      if (typeof m.content !== 'string') return;
      const share = Math.max(600, Math.round((pool * weights[k]) / sumW));
      // 「主干压缩」的关键：不只看总量预算。最新一两条工具结果保留较多（模型正要用），
      // 更老的即使总量没超预算也只留 cfg.trimOlder 字符 —— 否则多轮下来历史会一直膨胀。
      const ageFromEnd = nTools - 1 - k;
      const trim = ageFromEnd >= 2 ? cfg.trimOlder : Infinity;
      const budget = Math.min(m.content.length, share, trim);
      const r = compressToolContent(m.content, { terms, budget, label: '工具回传' });
      if (r.omitted) {
        stages.tool += tokenizer.estimate(m.content) - tokenizer.estimate(r.text);
        m.content = r.text;
        notes.push(`工具结果省略 ${r.omitted} 行`);
      }
    });
  }

  // ⑤ 预算兜底：还超就一条一条往下压（从最老的开始），压到够为止。
  //    早先是「一轮把所有消息全压一遍」，经常一口气从 13k 压到 5k（过度压缩、还把
  //    结构信息和关键符号索引冲掉）。现在逐条压、逐条量，够用就停。
  let after = tokenizer.estimateMessages(working, extraText);
  let guard = 0;
  while (after.total > cfg.budget && guard < 12) {
    guard += 1;
    let progressed = false;
    for (const { m } of [...toolIdx, ...plainIdx.map(({ m }) => ({ m }))]) {
      if (typeof m.content !== 'string' || m.content.length < 300) continue;
      const target = Math.max(300, Math.round(m.content.length * 0.55));
      const r =
        m.role === 'tool'
          ? compressToolContent(m.content, { terms, budget: target, label: '工具回传' })
          : { text: digestText(m.content, { terms, budget: Math.min(300, target) }) };
      if (r.text.length >= m.content.length) continue;
      const saved = tokenizer.estimate(m.content) - tokenizer.estimate(r.text);
      if (m.role === 'tool') stages.tool += saved;
      else stages.history += saved;
      stages.budget += saved;
      m.content = r.text;
      progressed = true;
      after = tokenizer.estimateMessages(working, extraText);
      if (after.total <= cfg.budget) break;
    }
    if (!progressed) break;
  }

  const afterTokens = Math.round(tokenizer.estimateMessages(working, extraText).total);
  const beforeTokens = Math.round(before.total);
  return {
    messages: working,
    tools: finalTools,
    stats: {
      strength,
      toolsBefore: toolTrim ? toolTrim.before : 0,
      toolsAfter: toolTrim ? toolTrim.after : 0,
      label: cfg.label,
      budget: cfg.budget,
      toolsTokens: extraText ? Math.round(tokenizer.estimate(extraText)) : 0,
      beforeTokens,
      afterTokens,
      savedTokens: Math.max(0, beforeTokens - afterTokens),
      savedPct: beforeTokens ? Math.round((1 - afterTokens / beforeTokens) * 1000) / 10 : 0,
      stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Math.round(v)])),
      notes: [...new Set(notes)].slice(0, 6),
      overBudget: afterTokens > cfg.budget,
    },
  };
}
