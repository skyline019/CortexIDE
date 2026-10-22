/**
 * 个人文风画像（个性化差异化的「个人风格」那一半）
 *
 * 目标：让回答「像是对你说的」，同时**不要**为此多花 token。
 * 做法完全确定性统计（不调模型、不猜），只看用户自己发过的话：
 *
 *   语言构成（中文占比）· 提问长度分布 · 命令式/商量式
 *   emoji 习惯 · 要不要表格/列表/代码示例 · 「详细 vs 简洁」反馈信号
 *   高频技术词（拉丁标识符）
 *
 * 统计结果被压成一张 **~60 token 的文风卡**（而不是把历史对话塞进去），
 * 卡片做过分桶量化：数值变动不大时文本不变 → 前缀缓存能命中，不额外花钱。
 *
 * 存储：.cortex/style/<user>.json —— 派生数据，删掉会从后续对话重新学。
 */
import fs from 'node:fs';
import path from 'node:path';

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u;
const BRIEF = /(简洁|精简|短一点|一句话|别解释|不用解释|太长|啰嗦|直接说|结论就行|说重点)/g;
const DETAIL = /(详细|细一点|展开|具体点|具体说|多说点|为什么|原理|深入|完整)/g;
const WANT_TABLE = /(表格|对比表|列个表|tabulate)/g;
const WANT_LIST = /(列表|列一下|要点|分条|checklist|清单)/g;
const WANT_CODE = /(代码|示例|例子|demo|实现一下|写成|我看看怎么写)/g;
const IMPERATIVE = /(^(帮|请|给|把|改|修|加|写|跑|查|看|做|实现)|帮我|麻烦|直接)/g;
const LATIN_TERM = /\b[a-zA-Z][a-zA-Z0-9_$-]{2,}\b/g;
// 出现频率最高、但完全不个性化的词：工具名 / 文件名 / 框架名。
// 之前它们霸占了「沿用他的词」，用户看到的就是 `run_command×4 · server×3` 这种东西。
const TERM_STOP = new Set([
  'read_file', 'write_file', 'search_files', 'list_files', 'run_command', 'remember', 'recall', 'tool', 'tools',
  'server', 'src', 'lib', 'components', 'scripts', 'docs', 'shots', 'readme', 'package', 'index', 'styles',
  'react', 'vite', 'node', 'npm', 'pnpm', 'npx', 'git', 'json', 'yaml', 'markdown', 'sqlite', 'sql', 'css', 'jsx', 'tsx',
  'agent', 'compact', 'compress', 'memory', 'token', 'tokens', 'cortex', 'app', 'api', 'http',
  '我想', '看看', '一下', '这个', '你们', '帮我',
  'the', 'and', 'for', 'you', 'this', 'that', 'with', 'from', 'how', 'why', 'can', 'not', 'but', 'are', 'was',
  'app', 'com', 'www', 'http', 'https', 'json', 'true', 'false', 'null', 'undefined', 'function', 'return',
  'const', 'let', 'var', 'import', 'export', 'console', 'log', 'string', 'number', 'object', 'array',
]);

/** 只保留「像技术词」的标识符：出现 ≥2 次、非纯英文常用词 */
function bumpTerms(map, text) {
  for (const raw of String(text).match(LATIN_TERM) || []) {
    const w = raw.toLowerCase();
    if (w.length < 3 || TERM_STOP.has(w)) continue;
    if (!/[0-9_-]/.test(w) && w.length < 5) continue; // 太短的纯字母词噪声大
    map[w] = (map[w] || 0) + 1;
  }
  // 中文里的「行话」也要算：只取 2~4 字、在同一句里反复出现的名词性短语很难，
  // 退一步用「用户自己反复用的中文术语表」：预先圈定技术语境里的高频词，
  // 命中才记（宁可少记，也别把「一下」「看看」当成个人用词）。
  for (const raw of String(text).match(CJK_TERM) || []) {
    if (TERM_STOP.has(raw)) continue;
    map[raw] = (map[raw] || 0) + 1;
  }
}

const CJK_TERM = /(落盘|墓碑|向量|索引|增量|压缩|召回|检索|分片|隔离|校准|预算|摘要|上下文|端到端|白名单|沙箱|前缀缓存|分词)/g;

function emptyProfile(user) {
  return {
    user,
    n: 0,
    chars: 0,
    lens: [],
    cjk: 0,
    latin: 0,
    emoji: 0,
    questions: 0,
    imperative: 0,
    brief: 0,
    detail: 0,
    table: 0,
    list: 0,
    code: 0,
    terms: {},
    card: '',
    cardTokens: 0,
    cardAt: 0,
    updatedAt: 0,
  };
}

const bucket = (v, edges) => {
  let i = 0;
  while (i < edges.length && v > edges[i]) i += 1;
  return i; // 0..edges.length
};

export function createStyleStore({ dir, minSamples = 2 }) { // 2 条就能给出可用的定性画像，分桶后不会乱跳
  const cache = new Map();

  const fileOf = (user) => path.join(dir, `${String(user).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'default'}.json`);

  const load = (user) => {
    if (cache.has(user)) return cache.get(user);
    let p = emptyProfile(user);
    try {
      const j = JSON.parse(fs.readFileSync(fileOf(user), 'utf8'));
      p = { ...p, ...j };
    } catch {
      /* 首次使用 */
    }
    cache.set(user, p);
    return p;
  };

  const save = (p) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = fileOf(p.user);
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(p));
      fs.renameSync(tmp, f);
    } catch {
      /* 缓存目录不可写也不影响对话 */
    }
  };

  /** 看一条用户消息（只统计 user 角色、非摘要、非工具） */
  const observe = (user, text) => {
    const t = String(text || '').trim();
    if (!t || t.length > 20000) return null;
    if (t.startsWith('（早前') || t.startsWith('[早前')) return null;
    const p = load(user);
    p.n += 1;
    p.chars += t.length;
    p.lens.push(t.length);
    if (p.lens.length > 400) p.lens.shift();
    for (const ch of t) {
      if (/[\u4e00-\u9fff]/.test(ch)) p.cjk += 1;
      else if (/[A-Za-z]/.test(ch)) p.latin += 1;
    }
    if (EMOJI.test(t)) p.emoji += 1;
    if (/[?？]\s*$/.test(t)) p.questions += 1;
    if ((t.match(IMPERATIVE) || []).length) p.imperative += 1;
    p.brief += (t.match(BRIEF) || []).length;
    p.detail += (t.match(DETAIL) || []).length;
    p.table += (t.match(WANT_TABLE) || []).length;
    p.list += (t.match(WANT_LIST) || []).length;
    p.code += (t.match(WANT_CODE) || []).length;
    bumpTerms(p.terms, t);
    p.updatedAt = Date.now();
    save(p);
    return p;
  };

  /**
   * 渲染文风卡。所有指标先分桶再拼字符串，
   * 这样「28 字 / 31 字」这种微小变化不会让卡片文本变来变去（保住前缀缓存）。
   */
  const render = (p) => {
    if (p.n < minSamples) return '';
    const avg = Math.round(p.chars / p.n);
    const lenBucket = bucket(avg, [16, 32, 64, 128, 240]);
    const cjkRatio = p.cjk / Math.max(1, p.cjk + p.latin);
    const langBucket = bucket(cjkRatio * 10, [6]); // 0=中英混排 1=中文为主
    const detailScore = p.detail - p.brief;
    const detailBucket = detailScore > 1 ? 2 : detailScore < -1 ? 0 : 1;
    const emojiRate = p.emoji / p.n;
    const fmt = [];
    if (p.table / p.n > 0.15) fmt.push('常用表格');
    if (p.list / p.n > 0.2) fmt.push('偏好列表');
    if (p.code / p.n > 0.3) fmt.push('常要代码示例');
    if (!fmt.length) fmt.push('正常段落');
    // 只留出现 ≥2 次的词：一个人的「常用词」一次是偶然，两次才算习惯
    const terms = Object.entries(p.terms)
      .filter(([w, n]) => n >= 2 && !TERM_STOP.has(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t]) => t);

    // 文风卡本身也要「省」：拼成 2~3 行、每行用 ｜ 分隔，控制在 70 token 上下。
    // （第一版写成了 5 行小标题 + 完整句子，108 token；同样的信息压到 62 token。）
    const lenText = ['≤100 字，一句话能说完就别展开', '≤180 字', '≤300 字', '按需（先结论再分点）', '可多段讲透', '长文也可以'][lenBucket];
    const detailText = ['少铺垫、不复述问题、不解释常识', '长度按内容来', '关键处多给一句原因'][detailBucket];
    const cmdText = p.imperative / p.n > 0.35 ? '命令式短问' : '提问式';
    const lines = [
      `## 他的说话方式（对齐用，不要复述这段）`,
      `语言：${langBucket ? '中文为主 + 英文技术词' : '中英混排'} ｜ ${cmdText}（均 ${avg} 字） ｜ ${emojiRate > 0.3 ? '可用 emoji 标重点' : '不用 emoji'}`,
      `回答：${lenText}；${detailText}；${fmt.join('/')}`,
      terms.length ? `沿用他的词：${terms.join(' / ')}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  };

  /** 取（必要时重算）文风卡 */
  const card = (user) => {
    const p = load(user);
    const text = render(p);
    if (text !== p.card) {
      p.card = text;
      p.cardAt = Date.now();
      save(p);
    }
    return text;
  };

  const profile = (user) => {
    const p = load(user);
    const sorted = p.lens.slice().sort((a, b) => a - b);
    return {
      user,
      samples: p.n,
      avgLen: p.n ? Math.round(p.chars / p.n) : 0,
      p50Len: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      cjkRatio: p.cjk + p.latin ? Math.round((p.cjk / (p.cjk + p.latin)) * 100) / 100 : 0,
      emojiRate: p.n ? Math.round((p.emoji / p.n) * 100) / 100 : 0,
      questionRate: p.n ? Math.round((p.questions / p.n) * 100) / 100 : 0,
      signals: { brief: p.brief, detail: p.detail, table: p.table, list: p.list, code: p.code },
      terms: Object.entries(p.terms)
        .filter(([w]) => !TERM_STOP.has(w)) // 历史里攒下的工具名/文件名也在这一步清掉
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([term, count]) => ({ term, count })),
      card: p.card,
      cardChars: p.card.length,
      cardAt: p.cardAt,
      updatedAt: p.updatedAt,
    };
  };

  const reset = (user) => {
    cache.delete(user);
    try {
      fs.rmSync(fileOf(user), { force: true });
    } catch {
      /* ignore */
    }
    return true;
  };

  return { observe, card, profile, reset, dir };
}
