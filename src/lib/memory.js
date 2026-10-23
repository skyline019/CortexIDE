/**
 * 记忆系统
 *
 * 四层记忆模型：
 *  - fact      长期事实（项目、环境、路径、接口约定…）
 *  - pref      用户偏好（风格、语言、禁忌…）
 *  - episode   情节记忆（某次会话都干了什么，会话结束时自动生成）
 *  - task      进行中的任务 / TODO
 *
 * 每条记忆都有 importance(1-5)、uses、lastUsedAt，检索采用
 * score = 0.62*相似度 + 0.18*重要度 + 0.12*时间衰减 + 0.08*使用频次
 */
import { textSimilarity, buildIndex, rankByQuery, rankFuzzy } from './tokenize.js';
import { vectorSearch } from './retrieval.js';
import { uid } from './vfs.js';

export const KINDS = {
  fact: { label: '事实', color: '#38bdf8', glyph: '◆' },
  pref: { label: '偏好', color: '#a78bfa', glyph: '✦' },
  episode: { label: '情节', color: '#34d399', glyph: '◷' },
  task: { label: '任务', color: '#fbbf24', glyph: '✓' },
};

export const KIND_LIST = Object.keys(KINDS);

export function makeMemory({ text, kind = 'fact', tags = [], importance = 3, source = 'user', pinned = false }) {
  const t = Date.now();
  return {
    id: uid('mem'),
    kind,
    text: String(text).trim(),
    tags,
    importance,
    source,
    pinned,
    createdAt: t,
    updatedAt: t,
    lastUsedAt: 0,
    uses: 0,
  };
}

const TAG_RULES = [
  [/react|jsx|tsx|组件|hook/i, 'react'],
  [/vite|build|打包/i, 'vite'],
  [/typescript|\.ts\b|tsconfig|类型/i, 'typescript'],
  [/api|接口|后端|endpoint|rest|graphql/i, 'api'],
  [/\bdb\b|数据库|sql|postgres|mysql|mongo/i, 'database'],
  [/测试|test|vitest|jest/i, 'testing'],
  [/样式|css|tailwind|scss|设计/i, 'ui'],
  [/部署|docker|ci|k8s|上线/i, 'devops'],
  [/中文|英文|语言/i, 'language'],
  [/提交|commit|git|分支|branch/i, 'git'],
];

function deriveTags(text) {
  const tags = new Set();
  for (const [re, tag] of TAG_RULES) if (re.test(text)) tags.add(tag);
  return [...tags];
}

/**
 * 从一段自然语言里蒸馏出值得长期保留的记忆。
 * 这里是本地规则引擎；接入真实模型后可以替换为 LLM 抽取。
 */
const EXTRACT_RULES = [
  { re: /^(?:请|帮我)?记住[:：,，\s]*(.+)$/i, kind: 'fact', importance: 4, group: 1 },
  { re: /^(?:请|帮我)?记一下[:：,，\s]*(.+)$/i, kind: 'fact', importance: 3, group: 1 },
  { re: /(?:别忘了|不要忘了|注意|切记)[:：,，\s]*(.+)$/i, kind: 'pref', importance: 4, group: 1 },
  { re: /(?:以后都|以后请|请始终|始终|一律|每次都要)(.+)$/i, kind: 'pref', importance: 4, group: 0 },
  { re: /(?:我喜欢|我偏好|我倾向于|我习惯|我更愿意)(.+)$/i, kind: 'pref', importance: 3, group: 0 },
  { re: /(?:我不喜欢|别用|不要用|禁止|避免)(.+)$/i, kind: 'pref', importance: 4, group: 0 },
  { re: /(?:我的名字|我叫|我是)\s*([^\s，,。]{2,20})/, kind: 'fact', importance: 4, group: 0 },
  { re: /(?:我们|这个项目|本项目|项目)(?:使用|采用|用的是|技术栈是)(.+)$/i, kind: 'fact', importance: 4, group: 0 },
  { re: /(?:决定|拍板|定下来)(?:使用|采用|用)?(.+)$/i, kind: 'fact', importance: 4, group: 0 },
  { re: /(?:待办|todo|下次要|需要)(.+)$/i, kind: 'task', importance: 3, group: 0 },
  { re: /^(?:remember|note)(?:\s+that)?[:：\s]+(.+)$/i, kind: 'fact', importance: 4, group: 1 },
  { re: /\b(?:i (?:prefer|like|always want|never want))\b(.+)$/i, kind: 'pref', importance: 3, group: 0 },
];

export function extractMemories(input, { source = 'chat' } = {}) {
  if (!input || input.length > 2000) return [];
  const sentences = String(input)
    .split(/[。！？\n;；!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && s.length <= 240);

  const found = [];
  for (const s of sentences) {
    for (const rule of EXTRACT_RULES) {
      const m = rule.re.exec(s);
      if (!m) continue;
      const captured = rule.group === 1 ? m[1] : s;
      const text = captured.trim().replace(/^[:：,，\s]+/, '');
      if (!text || text.length < 2) continue;
      found.push({
        text: text.slice(0, 240),
        kind: rule.kind,
        importance: Math.min(5, rule.importance),
        tags: deriveTags(s),
        source,
      });
      break;
    }
  }

  // 去重 + 抑制过短片段
  const out = [];
  for (const f of found) {
    if (out.some((o) => o.text === f.text)) continue;
    out.push(f);
  }
  return out.slice(0, 4);
}

/** 把新记忆合入已有记忆集合，返回 { memories, added, merged } */
export function mergeMemories(memories, candidates) {
  const next = [...memories];
  const added = [];
  const merged = [];
  for (const c of candidates) {
    const dup = next.find((m) => m.text === c.text || textSimilarity(m.text, c.text) > 0.82);
    if (dup) {
      dup.importance = Math.max(dup.importance, c.importance ?? dup.importance);
      dup.uses += 1;
      dup.updatedAt = Date.now();
      dup.mergedCount = (dup.mergedCount || 1) + 1;
      merged.push(dup);
    } else {
      const mem = makeMemory(c);
      next.push(mem);
      added.push(mem);
    }
  }
  return { memories: next, added, merged };
}

/**
 * 记忆召回：向量近邻（余弦）+ 重要性/新鲜度/频次 的混合打分
 * 向量不可用时自动回落到词频（TF-IDF）检索。
 */
export async function recall(query, memories, { k = 5, minScore = 0.12, provider = 'auto', mode = 'hybrid' } = {}) {
  const started = performance.now();
  // 去重：服务端历史数据里可能存在同一句话的多个版本，这里按 id / 文本各保留一份
  const seen = new Set();
  const seenText = new Set();
  const uniq = [];
  for (const m of memories) {
    if (!m || seen.has(m.id)) continue;
    const key = String(m.text || '').trim();
    if (seenText.has(key)) continue;
    seen.add(m.id);
    seenText.add(key);
    uniq.push(m);
  }
  memories = uniq;
  const byId = new Map(memories.map((m) => [m.id, m]));
  const now = Date.now();

  let ranked = [];
  let engine = 'vector';
  let vEngine = null;
  let vectorMode = 'hybrid';
  let dim = 0;
  let tookMs = 0;
  if (String(query || '').trim() && memories.length) {
    try {
      const res = await vectorSearch(query, memories, { k: Math.max(k * 2, 8), provider, mode });
      ranked = res.hits;
      dim = res.dim;
      tookMs = res.tookMs;
      vEngine = res.engine === 'local' ? 'browser' : res.engine;
      vectorMode = res.mode || 'hybrid';
    } catch (err) {
      console.warn('[cortex] 向量检索失败，回落到词频检索：', err.message);
      engine = 'lexical';
    }
  }
  if (!ranked.length) {
    const docs = memories.map((m) => ({ id: m.id, text: `${m.text} ${m.tags.join(' ')} ${KINDS[m.kind]?.label || ''}` }));
    const idx = buildIndex(docs);
    ranked = rankByQuery(query, idx);
    if (!ranked.length) ranked = rankFuzzy(query, docs);
    if (engine === 'vector') engine = 'lexical';
  }

  // 向量余弦值通常挤在 0.4~0.9 的窄区间，直接线性加权会被重要度/频次盖过。
  // 这里先做候选集内 min-max 归一化，让"语义最接近"真正占主导。
  // 各引擎字段不统一：vector/searchServer 用 score，lexical/fuseRrf 用 sim（+ rrf）
  const hitSim = (r) => {
    if (typeof r?.score === 'number' && Number.isFinite(r.score)) return r.score;
    if (typeof r?.sim === 'number' && Number.isFinite(r.sim)) return r.sim;
    if (typeof r?.rrf === 'number' && Number.isFinite(r.rrf)) return r.rrf;
    return 0;
  };
  const best = new Map();
  for (const r of ranked) {
    if (!best.has(r.id) || hitSim(best.get(r.id)) < hitSim(r)) best.set(r.id, r);
  }
  ranked = [...best.values()];
  if (!ranked.length) {
    return {
      results: [],
      tookMs: tookMs || Math.round((performance.now() - started) * 100) / 100,
      engine: engine === 'vector' ? vEngine || 'vector' : engine,
      mode: engine === 'vector' ? vectorMode : 'bm25',
      dim,
    };
  }

  // 混合检索时用 RRF 融合分做"匹配度"信号；纯向量模式下用余弦
  const useRrf = ranked.every((r) => typeof r.rrf === 'number');
  const sig = ranked.map((r) => (useRrf ? r.rrf : hitSim(r)));
  const lo = Math.min(...sig);
  const hi = Math.max(...sig);
  const span = hi - lo;
  const norm = (v) => (span > 1e-9 ? (v - lo) / span : 1);

  const results = ranked
    .map((hit) => {
      const { id, rrf, vRank, bRank, bm25 } = hit;
      const sim = hitSim(hit);
      const m = byId.get(id);
      if (!m) return null;
      const ageDays = (now - m.updatedAt) / 86400000;
      const recency = 1 / (1 + ageDays / 7);
      const imp = m.importance / 5;
      const freq = Math.min(1, Math.log(1 + m.uses) / Math.log(11));
      const match = norm(useRrf ? rrf : sim);
      // 62% 语义匹配度 + 38% 记忆元信息（重要度/新鲜度/频次）
      const s = 0.62 * match + 0.18 * imp + 0.12 * recency + 0.08 * freq;
      return {
        ...m,
        score: Number(s.toFixed(4)),
        sim: Number(sim.toFixed(4)),
        match: Number(match.toFixed(4)),
        recency: Number(recency.toFixed(3)),
        freq: Number(freq.toFixed(3)),
        rrf: typeof rrf === 'number' ? Number(rrf.toFixed(6)) : null,
        vRank: vRank || null,
        bRank: bRank || null,
        bm25: typeof bm25 === 'number' ? bm25 : null,
      };
    })
    .filter((x) => x && x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return {
    results,
    tookMs: tookMs || Math.round((performance.now() - started) * 100) / 100,
    engine: engine === 'vector' ? vEngine || 'vector' : engine,
    mode: engine === 'vector' ? vectorMode : 'bm25',
    dim,
  };
}

export function memoryStats(memories) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const byKind = {};
  for (const k of KIND_LIST) byKind[k] = 0;
  let importanceSum = 0;
  let todayCount = 0;
  let uses = 0;
  for (const m of memories) {
    byKind[m.kind] = (byKind[m.kind] || 0) + 1;
    importanceSum += m.importance || 0;
    uses += m.uses || 0;
    if (m.createdAt >= today.getTime()) todayCount++;
  }
  return {
    total: memories.length,
    todayCount,
    byKind,
    avgImportance: memories.length ? Math.round((importanceSum / memories.length) * 10) / 10 : 0,
    uses,
    pinned: memories.filter((m) => m.pinned).length,
  };
}

export function exportMemories(memories) {
  const lines = [
    '# Cortex 长期记忆导出',
    `> 导出时间：${new Date().toLocaleString('zh-CN')} · 共 ${memories.length} 条`,
    '',
  ];
  for (const k of KIND_LIST) {
    const group = memories.filter((m) => m.kind === k);
    if (!group.length) continue;
    lines.push(`## ${KINDS[k].label}（${group.length}）`, '');
    for (const m of group.sort((a, b) => b.importance - a.importance)) {
      lines.push(`- ${m.pinned ? '📌 ' : ''}${m.text}  \`重要度 ${m.importance}\` \`${m.tags.join(', ') || '无标签'}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function seedMemories() {
  const seed = [
    { text: '项目 Nimbus 任务看板使用 React 19 + Vite 构建，不使用状态管理库', kind: 'fact', tags: ['react', 'vite'], importance: 5, pinned: true },
    { text: '用户偏好用中文交流，代码注释也使用中文', kind: 'pref', tags: ['language'], importance: 5, pinned: true },
    { text: '不要使用 emoji 作为提交信息前缀', kind: 'pref', tags: ['git'], importance: 4 },
    { text: '所有组件必须提供 loading / empty / error 三种状态', kind: 'pref', tags: ['react', 'ui'], importance: 4 },
    { text: '后端 API 基础路径是 /api/v2，鉴权使用 Bearer Token', kind: 'fact', tags: ['api'], importance: 5 },
    { text: '任务表主键为 uuid，使用 deleted_at 做软删除', kind: 'fact', tags: ['database', 'api'], importance: 4 },
    { text: '2026-04-18 决定拖拽排序选用 dnd-kit，放弃 react-beautiful-dnd', kind: 'fact', tags: ['react'], importance: 4 },
    { text: '用户在美国太平洋时区工作，会议尽量安排在下午', kind: 'fact', tags: [], importance: 3 },
    { text: '看板拖拽排序功能尚未完成，下一步要做任务详情抽屉', kind: 'task', tags: ['react'], importance: 4 },
    { text: '上一轮会话中重构了 api.js 的 request 封装，统一了错误处理', kind: 'episode', tags: ['api'], importance: 3 },
  ];
  return seed.map((s, i) => {
    const m = makeMemory({ ...s, source: 'seed' });
    m.id = `seed-${String(i + 1).padStart(2, '0')}`; // 稳定 id：刷新/多标签页不会重复入库
    m.createdAt = Date.now() - (i + 1) * 3600000 * 7;
    m.updatedAt = m.createdAt;
    m.uses = Math.max(0, 6 - i);
    m.lastUsedAt = Date.now() - i * 3600000;
    return m;
  });
}
