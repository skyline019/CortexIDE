/**
 * 上下文引用的纯逻辑（不碰 DOM、不发请求，全部可单测）
 *
 * 四个入口最终都收敛成同一个东西 —— 一个 ref 列表：
 *   @提及      → 打字时补全，选中即读取文件内容
 *   拖拽       → 从文件树拖（工作区路径）或从系统拖（真文件，先落盘成附件）
 *   附件按钮   → 选本地文件，走 /api/attach
 *   当前标签页 → 一键把正在看的文件加进来
 *
 * 发送时 buildContextBlock 把它们拼成一段有边界、有预算、**截断会明说**的上下文。
 */

/** 与 composePrompt 的 estTokens 保持同一口径（约 0.8 token / 字符） */
export function estimateTokens(chars) {
  return Math.ceil((Number(chars) || 0) * 0.8);
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 显示用的短名：太长只留后两段 */
export function shortPath(p = '') {
  const parts = String(p).split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || p;
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * 光标前正在输入的 @ 片段。
 *
 * 规则（真机上踩过的三条）：
 *  - `@` 前面必须是行首或空白/常见标点，否则 `a@b.com` 这种邮箱会误触发；
 *  - `@` 与光标之间不能有空白（有空白说明这个 @ 已经结束了）；
 *  - 支持 `@"带 空格 的 路径"`，此时要求引号没闭合。
 */
export function mentionQueryAt(text = '', caret = text.length) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const prev = at > 0 ? before[at - 1] : '';
  if (prev && !/[\s(（【[，,、:：]/.test(prev)) return null;
  const seg = before.slice(at + 1);
  if (seg.startsWith('"')) {
    if (seg.slice(1).includes('"')) return null;
    return { start: at, end: caret, query: seg.slice(1), quoted: true };
  }
  if (/\s/.test(seg)) return null;
  return { start: at, end: caret, query: seg, quoted: false };
}

/**
 * 从一段文本里找出所有 @引用。
 * 返回的是「用户写了什么」，不是「文件存在不存在」—— 存在性由调用方去查，
 * 查不到就在界面上标红，而不是悄悄丢掉。
 */
export function parseMentions(text = '') {
  const out = [];
  const seen = new Set();
  // 路径到空白或中英文标点为止（`@a.md，还有` 里的「，还有」不是路径的一部分）
  const re = /@(?:"([^"]+)"|([^\s@，。、；：！？（）【】《》「」“”"'`]+))/gu;
  let m;
  while ((m = re.exec(String(text)))) {
    const prev = m.index > 0 ? text[m.index - 1] : '';
    if (prev && !/[\s(（【[，,、:：]/.test(prev)) continue;
    const raw = (m[1] ?? m[2] ?? '').replace(/[。，、；：！？）】》,.!?;:)\]]+$/u, '');
    if (!raw) continue;
    const path = raw.replace(/^\.\//, '');
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, raw: m[0], quoted: Boolean(m[1]) });
  }
  return out;
}

/** 「把这段 @xxx 替换成 @path 」——补全时用，保留 @ 前缀和引号习惯 */
export function replaceMention(text, range, path) {
  const needQuote = /\s/.test(path);
  const token = needQuote ? `@"${path}"` : `@${path}`;
  const rest = text.slice(range.end);
  // 光标后面本来就有一个空格时不要再补一个（真机上补出来是「@a.js  这三行」）；
  // 但**行尾必须补**：不补的话用户接着打字就被粘进路径里了
  // （真机：选中 `@src/lib/plan.js` 后打「我附上的附件里…」，整句都被当成了文件名）。
  const joiner = /^\s/.test(rest) ? '' : ' ';
  return `${text.slice(0, range.start)}${token}${joiner}${rest}`;
}

/* ---------------- 候选排序 ---------------- */

/** 子序列匹配：`pln` 能命中 `src/lib/plan.js`（跳读，比纯 substr 更接近 VSCode 的手感） */
function subsequence(haystack = '', needle = '') {
  if (!needle) return 0;
  let i = 0;
  let gaps = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
    else if (i > 0) gaps += 1;
  }
  return i === needle.length ? gaps : -1;
}

/**
 * 给候选打分。经验值，不是真理：名字命中 > 路径命中 > 跳读命中，同分时路径短的靠前
 * （`plan.js` 应该排在 `src/lib/plan-v2-backup.js` 前面）。
 */
export function scoreCandidate(item, query = '') {
  const q = String(query).toLowerCase().trim();
  const name = String(item.name || '').toLowerCase();
  const p = String(item.path || '').toLowerCase();
  let score = 0;
  if (!q) score = 100;
  else if (name === q) score = 1000;
  else if (name.startsWith(q)) score = 900;
  else if (p.endsWith(`/${q}`) || p === q) score = 870;
  else if (p.startsWith(q)) score = 820;
  else if (name.includes(q)) score = 760;
  else if (p.includes(q)) score = 700;
  else {
    const gaps = subsequence(name, q);
    const pathGaps = gaps < 0 ? subsequence(p, q) : gaps;
    if (pathGaps >= 0) score = 420 - Math.min(200, pathGaps * 4);
  }
  if (score > 0) score += Math.max(0, 40 - String(item.path || '').length / 2);
  return score;
}

export function rankCandidates(items = [], query = '', limit = 12) {
  return items
    .map((item) => ({ item, score: scoreCandidate(item, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.item.path).length - String(b.item.path).length)
    .slice(0, limit)
    .map((x) => x.item);
}

/* ---------------- ref 的增删 ---------------- */

export function refKey(ref) {
  return `${ref.type}:${ref.key || ref.path || ref.id || ref.name || ''}`;
}

export function makeRef({ type = 'file', path = '', name = '', content = '', binary = false, size = 0, origin = 'mention', extra = {} } = {}) {
  // 文件末尾的换行不算一行（不然「8 行」的文件界面上会显示成 9 行）
  const clean = binary ? '' : String(content || '').replace(/\n+$/, '');
  content = clean;
  const lines = content ? content.split('\n').length : 0;
  return {
    type,
    path,
    key: path || name,
    name: name || String(path).split('/').pop() || path,
    content: binary ? '' : content,
    binary: Boolean(binary),
    size: Number(size) || (content ? content.length : 0),
    lines,
    chars: binary ? 0 : String(content || '').length,
    origin,
    at: Date.now(),
    ...extra,
  };
}

/** 同一路径只留一份（拖两次、又 @ 一次，只算一次上下文） */
export function dedupeRefs(refs = []) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function upsertRef(refs = [], ref) {
  const k = refKey(ref);
  const i = refs.findIndex((r) => refKey(r) === k);
  if (i < 0) return [...refs, ref];
  const next = refs.slice();
  // 新的覆盖旧的，但保留原来的「怎么加进来的」顺序
  next[i] = { ...refs[i], ...ref, at: refs[i].at || ref.at };
  return next;
}

/** 引用条上每个 chip 的副标题 */
export function refMeta(ref) {
  if (!ref) return '';
  if (ref.binary) return `${formatSize(ref.size)} · 二进制`;
  if (ref.type === 'memory') return '记忆';
  if (ref.type === 'skill') return '技能';
  if (ref.lines) return `${ref.lines} 行 · ${formatSize(ref.size || ref.chars)}`;
  return `${ref.chars} 字符`;
}

const ORIGIN_LABEL = { mention: '@提及', drag: '拖入', drop: '拖入', picker: '附件', upload: '附件', tab: '标签页', paste: '粘贴' };
export function originLabel(ref) {
  return ORIGIN_LABEL[ref.origin] || '引用';
}

/* ---------------- 拼上下文 ---------------- */

const LANG_BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', json: 'json', md: 'md', markdown: 'md',
  css: 'css', scss: 'css', html: 'html', svg: 'html', py: 'python', rs: 'rust', go: 'go', java: 'java',
  sh: 'sh', bash: 'sh', zsh: 'sh', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', txt: '', csv: 'csv',
};

export function fenceLang(path = '') {
  const ext = String(path).split('.').pop()?.toLowerCase() || '';
  return LANG_BY_EXT[ext] ?? '';
}

function clip(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, clipped: false, droppedChars: 0 };
  // 尽量在行边界断开，别把一行代码劈成两半
  const head = s.slice(0, maxChars);
  const cut = head.lastIndexOf('\n');
  const out = cut > maxChars * 0.6 ? head.slice(0, cut) : head;
  return { text: out, clipped: true, droppedChars: s.length - out.length };
}

/**
 * 把 refs 拼成一段可读、有边界、**预算内**的上下文。
 *
 * 三个诚实性要求（真被用户问过的东西）：
 *  1. 截断必须写在正文里，而不是只在界面上标一下 —— 模型看的是这段文本；
 *  2. 超出预算没带上的引用要列出来，不能让用户以为都带上了；
 *  3. 二进制文件不要伪造正文，只给路径和大小。
 */
export function buildContextBlock(refs = [], { budget = 24000, perRef = 8000, title = '用户这轮附上的上下文' } = {}) {
  const list = dedupeRefs(refs);
  if (!list.length) {
    return { text: '', chars: 0, estTokens: 0, included: [], dropped: [], clipped: [], budgetUsedPct: 0 };
  }
  const parts = [];
  const included = [];
  const dropped = [];
  const clipped = [];
  let used = 0;

  for (const ref of list) {
    if (ref.binary) {
      const ext = String(ref.path || '').split('.').pop()?.toLowerCase() || '';
      const isImg = /^(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(ext);
      const isMedia = /^(mp4|m4v|mov|webm|mkv|mp3|m4a|wav|flac|ogg|opus)$/i.test(ext);
      const hint = isImg
        ? `图片将以多模态方式发给视觉模型（大小 ${formatSize(ref.size)}）。请直接看图，不要说看不到。`
        : isMedia
          ? `音视频不能把原始流塞进对话；大小 ${formatSize(ref.size)}。请用 read_file 取元数据，或让用户在预览里说明。`
          : `二进制文件，未附正文；大小 ${formatSize(ref.size)}。请用 read_file（PDF/Office 会抽文本）。`;
      const block = `### ${ref.type === 'attach' ? '附件' : '文件'}：${ref.path}\n（${hint}）`;
      const cost = block.length + 2;
      if (used + cost > budget) {
        dropped.push(ref);
        continue;
      }
      used += cost;
      parts.push(block);
      included.push(ref);
      continue;
    }

    if (ref.error) {
      const block = `### 引用：${ref.path}\n（读取失败：${ref.error} —— 这个路径可能在正文里写错了，或者文件已经不在了）`;
      if (used + block.length > budget) {
        dropped.push(ref);
        continue;
      }
      used += block.length + 2;
      parts.push(block);
      included.push(ref);
      continue;
    }

    const body = String(ref.content || '');
    if (!body.trim()) {
      if (ref.type === 'memory' || ref.type === 'skill') continue; // 记忆/技能本来就只是标签，不算正文
      const block = `### 文件：${ref.path}\n（空文件或读不到内容）`;
      if (used + block.length > budget) {
        dropped.push(ref);
        continue;
      }
      used += block.length + 2;
      parts.push(block);
      included.push(ref);
      continue;
    }

    // 单份先限到 perRef，再看总预算够不够
    const first = clip(body, perRef);
    let text = first.text;
    let note = first.clipped ? `（原文 ${body.length} 字符，这里只附了前 ${text.length} 字符）` : '';
    const header = `### ${ref.type === 'attach' ? '附件' : '引用'}：${ref.path}${ref.lines ? `（${ref.lines} 行）` : ''}`;
    let block = `${header}\n${note ? `${note}\n` : ''}\`\`\`${fenceLang(ref.path)}\n${text}\n\`\`\``;

    if (used + block.length > budget) {
      const remain = budget - used;
      if (remain < 400) {
        dropped.push(ref);
        continue;
      }
      const second = clip(body, Math.max(200, remain - header.length - 200));
      text = second.text;
      note = `（总预算 ${budget} 字符不够，这里只附了前 ${text.length} 字符 / 原文 ${body.length} 字符）`;
      block = `${header}\n${note}\n\`\`\`${fenceLang(ref.path)}\n${text}\n\`\`\``;
    }
    used += block.length + 2;
    parts.push(block);
    included.push(ref);
    if (note) clipped.push({ path: ref.path, chars: text.length, total: body.length });
  }

  const head = `## ${title}\n> 这些是用户在本轮显式附上的内容（不是模型自己读的），路径都是工作区真实路径。`;
  const tail = dropped.length
    ? `\n> ⚠ 超出上下文预算，以下引用**没有**附上：${dropped.map((r) => r.path).join('、')}。如果确实需要，请调用 read_file。`
    : '';
  const text = [head, '', ...parts, tail].filter((x) => x !== undefined).join('\n\n').trim();
  return {
    text,
    chars: text.length,
    estTokens: estimateTokens(text.length),
    included,
    dropped,
    clipped,
    budgetUsedPct: Math.round((used / budget) * 100),
  };
}

/** 输入框上方引用条的汇总文案 */
export function refsSummary(refs = []) {
  const list = dedupeRefs(refs);
  const chars = list.reduce((n, r) => n + (r.binary ? 0 : r.chars || 0), 0);
  return { count: list.length, chars, estTokens: estimateTokens(chars) };
}
