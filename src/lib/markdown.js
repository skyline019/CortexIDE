/**
 * 内置 Markdown 解析器（零依赖，产出一棵可测试的 AST）
 *
 * 为什么自己写而不引 marked / markdown-it：
 *  - 应用要在离线 iframe 里跑，外部依赖一律进构建产物；marked 打包约 40KB、markdown-it 约 90KB，
 *    而真正需要的能力（标题/列表/表格/代码/引用/任务列表/图片）用 ~300 行就够；
 *  - 更重要的：**原始 HTML 一律转义**，不解析、不注入。AI 回答和仓库里的 README 都可能含
 *    `<script>` / `<img onerror>`，用现成库就得记得关掉 html 选项，自己写则默认安全。
 *
 * 设计：先 parse() 成 AST（纯数据，好测），再由 <Markdown /> 渲染成 React 元素，全程不用 innerHTML。
 * 支持的语法见 README「内置 Markdown 渲染器」一节，未支持的（脚注、公式、HTML 块）会原样显示。
 */

const ESCAPABLE = '\\\\`*_{}[]()#+-.!|~<>$';

/* ------------------------------------------------------------------ */
/* 行内解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 行内解析：`code`、**粗**、*斜*、~~删~~、[链接](url "title")、![图](src)、<自动链接>、硬换行、转义。
 * 返回 `[{type, ...}]`，type ∈ text|code|strong|em|del|link|image|br
 */
export function parseInline(text) {
  const src = String(text ?? '');
  const out = [];
  let buf = '';
  let i = 0;

  const pushText = () => {
    if (buf) {
      out.push({ type: 'text', value: buf });
      buf = '';
    }
  };
  const pushNode = (node) => {
    pushText();
    out.push(node);
  };

  while (i < src.length) {
    const ch = src[i];

    // 转义：\$ \* \\ 等都按字面量处理
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    // 行内代码：支持 `code` 与 ``co`de``
    if (ch === '`') {
      const m = /^(`+)([\s\S]*?)\1/.exec(src.slice(i));
      if (m) {
        pushNode({ type: 'code', value: m[2].replace(/^ | $/g, '') });
        i += m[0].length;
        continue;
      }
    }

    // 图片 ![alt](src "title")
    if (ch === '!' && src[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/.exec(src.slice(i));
      if (m) {
        pushNode({ type: 'image', alt: m[1], src: m[2], title: m[3] || '' });
        i += m[0].length;
        continue;
      }
    }

    // 链接 [text](href "title")
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"([^"]*)")?\s*\)/.exec(src.slice(i));
      if (m) {
        pushNode({ type: 'link', href: m[2], title: m[3] || '', children: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    // 自动链接 <https://…>
    if (ch === '<') {
      const m = /^<((?:https?|mailto):[^>\s]+)>/.exec(src.slice(i));
      if (m) {
        pushNode({ type: 'link', href: m[1], title: '', children: [{ type: 'text', value: m[1] }] });
        i += m[0].length;
        continue;
      }
    }

    // 粗体 / 斜体 / 删除线
    if (ch === '*' || ch === '_' || ch === '~') {
      const strong = src.startsWith(ch + ch, i) && !(ch === '~' && !src.startsWith('~~', i));
      const marker = strong ? ch + ch : ch;
      if (ch !== '~' || strong) {
        const close = src.indexOf(marker, i + marker.length);
        if (close > i + marker.length) {
          const inner = src.slice(i + marker.length, close);
          // `* 列表` 这种被误判成斜体的场景：标记后紧跟空格一律不算强调
          if (!/^\s/.test(inner) && !/\s$/.test(inner)) {
            const children = parseInline(inner);
            const type = ch === '~' ? 'del' : strong ? 'strong' : 'em';
            pushNode({ type, children });
            i = close + marker.length;
            continue;
          }
        }
      }
    }

    // 硬换行：行尾两个空格
    if (ch === '\n') {
      if (/ {2}$/.test(buf)) {
        buf = buf.replace(/ +$/, '');
        pushNode({ type: 'br' });
      } else {
        buf += ch;
      }
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  pushText();
  return out;
}

/* ------------------------------------------------------------------ */
/* 块级解析                                                            */
/* ------------------------------------------------------------------ */

const RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const splitRow = (line) =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

/**
 * @param {string} text Markdown 原文
 * @returns {{type:string, ...}[]} 块级 AST
 */
export function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 围栏代码块（``` 或 ~~~，语言写在信息串里）
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const [, indent, marker, lang] = fence;
      const closeRe = new RegExp(`^${indent}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const buf = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) buf.push(lines[i++]);
      i += 1; // 跳过收尾围栏
      blocks.push({ type: 'code', lang: lang || '', value: buf.join('\n') });
      continue;
    }

    // 缩进 4 格的代码块（不用围栏的老写法）
    if (/^ {4}\S/.test(line) && !blocks.length) {
      const buf = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) buf.push(lines[i++].replace(/^ {4}/, ''));
      blocks.push({ type: 'code', lang: '', value: buf.join('\n').replace(/\n+$/, '') });
      continue;
    }

    // 标题
    const h = RE_HEADING.exec(line);
    if (h) {
      blocks.push({ type: 'heading', depth: h[1].length, children: parseInline(h[2]) });
      i += 1;
      continue;
    }

    // 分隔线
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 表格：表头行 + 分隔行
    if (/\|/.test(line) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map((c) => parseInline(c)));
        i += 1;
      }
      blocks.push({ type: 'table', head: head.map((c) => parseInline(c)), aligns, rows });
      continue;
    }

    // 引用块（可嵌套、可含列表/代码）
    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || (buf.length && lines[i].trim()))) {
        buf.push(lines[i].replace(RE_QUOTE, ''));
        i += 1;
      }
      // GitHub 风格提示：> [!NOTE] / > [!WARNING] 之类
      let kind = 'quote';
      let rest = buf;
      const alert = /^\[!(note|tip|important|warning|caution)\]\s*$/i.exec((buf[0] || '').trim());
      if (alert) {
        kind = alert[1].toLowerCase();
        rest = buf.slice(1);
      }
      blocks.push({ type: 'quote', kind, children: parseBlocks(rest.join('\n')) });
      continue;
    }

    // 列表（支持嵌套、任务列表、松散/紧凑）
    if (RE_LIST.test(line)) {
      const items = [];
      const ordered = /^\s*\d/.test(line);
      const start = ordered ? parseInt(line.trim(), 10) : 1;
      let baseIndent = null;

      while (i < lines.length) {
        const m = RE_LIST.exec(lines[i]);
        if (!m) {
          // 空行后如果还是**同一类**列表的内容，继续吃（松散列表，CommonMark 行为）；
          // 换成另一类标记（`-` 变 `1.`）就必须断开，否则「无序列表 + 有序列表」
          // 会被揉成一个 list，编号全丢，渲染出来完全不对。
          if (!lines[i].trim() && i + 1 < lines.length && RE_LIST.test(lines[i + 1])) {
            const nm = RE_LIST.exec(lines[i + 1]);
            const nextOrdered = /^\s*\d/.test(lines[i + 1]);
            if (nm && nm[1].length <= (baseIndent ?? nm[1].length) && nextOrdered !== ordered) break;
            i += 1;
            continue;
          }
          // 嵌套内容（缩进 ≥ 标记宽度）
          if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
            items[items.length - 1].lines.push(lines[i]);
            i += 1;
            continue;
          }
          break;
        }
        const indent = m[1].length;
        if (baseIndent === null) baseIndent = indent;
        if (indent > baseIndent) {
          // 更深缩进 → 交给上一项做嵌套解析
          items[items.length - 1].lines.push(lines[i]);
          i += 1;
          continue;
        }
        if (indent < baseIndent) break;
        // 同一缩进但标记类型变了 → 这是另一个列表（见上面的说明）
        if (indent === baseIndent && /^\s*\d/.test(lines[i]) !== ordered) break;
        const raw = m[3];
        const task = /^\[([ xX])\]\s+(.*)$/.exec(raw);
        items.push({
          task: task ? task[1].toLowerCase() === 'x' : null,
          lines: [task ? task[2] : raw],
        });
        i += 1;
        // 续行：缩进大于标记宽度的后续行
        const pad = m[2].length + 1;
        while (i < lines.length && lines[i].trim() && !RE_LIST.test(lines[i]) && !/^\s{0,3}(>|#{1,6}\s|`{3})/.test(lines[i])) {
          const contIndent = (lines[i].match(/^\s*/) || [''])[0].length;
          if (contIndent >= Math.min(pad, baseIndent + 2) || !RE_LIST.test(lines[i])) {
            items[items.length - 1].lines.push(lines[i]);
            i += 1;
          } else break;
        }
      }

      blocks.push({
        type: 'list',
        ordered,
        start,
        items: items.map((it) => {
          const body = it.lines.join('\n');
          // 第一行是行内内容，其余缩进 ≥2 的块按嵌套块解析
          const [first, ...rest] = body.split('\n');
          const nested = rest.join('\n').trim();
          return {
            task: it.task,
            children: parseInline(first),
            blocks: nested ? parseBlocks(nested) : [],
          };
        }),
      });
      continue;
    }

    // 段落：连续非空行（标题/围栏等会打断）
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !RE_FENCE.test(lines[i]) &&
      !RE_HEADING.test(lines[i]) &&
      !RE_HR.test(lines[i]) &&
      !RE_QUOTE.test(lines[i]) &&
      !RE_LIST.test(lines[i]) &&
      !(/\|/.test(lines[i]) && RE_TABLE_SEP.test(lines[i + 1] || ''))
    ) {
      buf.push(lines[i++]);
    }
    if (buf.length) blocks.push({ type: 'paragraph', children: parseInline(buf.join('\n')) });
    else i += 1;
  }

  return blocks;
}

/** 便捷函数：一段 Markdown → AST */
export const parseMarkdown = (text) => parseBlocks(text);

/** 把 AST 还原成纯文本（测试和「复制为纯文本」用） */
export function astToPlain(nodes) {
  const walk = (n) => {
    if (!n) return '';
    switch (n.type) {
      case 'text':
      case 'code':
        return n.value;
      case 'br':
        return '\n';
      case 'hr':
        return '\n---\n';
      case 'heading':
      case 'paragraph':
        return `${walk(n.children)}\n`;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        return walk(n.children);
      case 'image':
        return n.alt || '';
      case 'codeblock':
        return `${n.value}\n`;
      case 'quote':
        return walk(n.children);
      case 'list':
        return n.items.map((it) => `${it.task === null ? '' : it.task ? '[x] ' : '[ ] '}${walk(it.children)}${it.blocks?.length ? `\n${walk(it.blocks)}` : ''}\n`).join('');
      case 'table': {
        const head = n.head.map(walk).join(' | ');
        const rows = n.rows.map((r) => r.map(walk).join(' | ')).join('\n');
        return `${head}\n${rows}\n`;
      }
      default:
        return Array.isArray(n) ? n.map(walk).join('') : Array.isArray(n.children) ? walk(n.children) : '';
    }
  };
  return (Array.isArray(nodes) ? nodes : [nodes]).map(walk).join('');
}

/** 统计 AST（测试用：确认各种语法都被识别了） */
export function astStats(blocks) {
  const counts = {};
  const walk = (list) => {
    for (const b of list || []) {
      counts[b.type] = (counts[b.type] || 0) + 1;
      if (b.children && Array.isArray(b.children) && b.children[0]?.type) walk(b.children);
      if (b.type === 'quote') walk(b.children);
      if (b.type === 'list') for (const it of b.items) walk(it.blocks);
    }
  };
  walk(blocks);
  return counts;
}

/** 从 Markdown 里抽出目录（标题树），给预览页的侧边栏用 */
export function outlineOf(blocks) {
  return (blocks || [])
    .filter((b) => b.type === 'heading')
    .map((b) => ({ depth: b.depth, text: astToPlain(b.children).trim() }));
}
