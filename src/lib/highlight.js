/**
 * 零依赖语法高亮（给 AI 回答里的代码块 + 文件预览用）
 *
 * 为什么不用 highlight.js / shiki：
 *  - 这个项目要在**离线的 iframe 预览**里也能跑，外链 CDN 一律不加载；
 *  - shiki 会把所有主题和 wasm 打进产物（几个 MB），为了高亮不值得；
 *  - 我们只需要「让代码一眼能读」：关键字/字符串/注释/数字/函数名五种颜色就够。
 *
 * 实现：每种语言一组**有序**规则，用 sticky 正则从光标处匹配，匹配不上就吞一个字符当普通文本。
 * 规则顺序很关键（注释必须在字符串之前，否则 `// 注释里的 "引号"` 会把后面全染成字符串）。
 */

const T = {
  COMMENT: 'cmt',
  STRING: 'str',
  NUMBER: 'num',
  KEYWORD: 'kw',
  LITERAL: 'lit',
  FUNC: 'fn',
  TYPE: 'type',
  PROP: 'prop',
  TAG: 'tag',
  ATTR: 'attr',
  OP: 'op',
  PUNCT: 'punct',
  META: 'meta',
  INSERT: 'ins',
  DELETE: 'del',
};

/** 把规则数组编译成 sticky 正则（每个语言只编译一次） */
function compile(rules) {
  return rules.map(([type, re]) => ({ type, re: new RegExp(re.source, `${re.flags.replace('g', '')}y`) }));
}

const JS_KEYWORDS =
  'break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|await|as|implements|interface|enum|declare|readonly|namespace|type|satisfies|keyof|infer|abstract|protected|private|public|override';
const JS_LITERALS = 'true|false|null|undefined|NaN|Infinity';

const jsRules = compile([
  [T.COMMENT, /\/\/[^\n]*/],
  [T.COMMENT, /\/\*[\s\S]*?\*\//],
  [T.STRING, /`(?:\\[\s\S]|\$\{[^}]*\}|[^\\`])*`/],
  [T.STRING, /"(?:\\[\s\S]|[^\\"\n])*"/],
  [T.STRING, /'(?:\\[\s\S]|[^\\'\n])*'/],
  [T.NUMBER, /\b0[xX][\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/],
  [T.KEYWORD, new RegExp(`\\b(?:${JS_KEYWORDS})\\b`)],
  [T.LITERAL, new RegExp(`\\b(?:${JS_LITERALS})\\b`)],
  [T.TYPE, /\b[A-Z][A-Za-z0-9_$]*\b/],
  [T.FUNC, /\b[A-Za-z_$][\w$]*(?=\s*\()/],
  [T.PROP, /(?<=\.)[A-Za-z_$][\w$]*/],
  [T.PUNCT, /[{}[\]();,.:]/],
  [T.OP, /[+\-*/%=<>!&|^~?]+/],
]);

const jsonRules = compile([
  [T.PROP, /"(?:\\[\s\S]|[^\\"\n])*"(?=\s*:)/],
  [T.STRING, /"(?:\\[\s\S]|[^\\"\n])*"/],
  [T.NUMBER, /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  [T.LITERAL, /\b(?:true|false|null)\b/],
  [T.PUNCT, /[{}[\],:]/],
]);

const cssRules = compile([
  [T.COMMENT, /\/\*[\s\S]*?\*\//],
  [T.ATTR, /@[\w-]+/],
  [T.STRING, /"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'/],
  [T.NUMBER, /-?\b\d*\.?\d+(?:px|em|rem|%|s|ms|vh|vw|fr|ch|deg|pt)?\b|#[0-9a-fA-F]{3,8}\b/],
  [T.PROP, /(--?[\w-]+)(?=\s*:)/],
  [T.TAG, /[.#][\w-]+/],
  [T.FUNC, /\b[\w-]+(?=\()/],
  [T.KEYWORD, /\b(?:important|inherit|initial|none|auto|flex|grid|block|inline|absolute|relative|fixed|sticky)\b/],
  [T.PUNCT, /[{}();:,]/],
]);

const htmlRules = compile([
  [T.COMMENT, /<!--[\s\S]*?-->/],
  [T.TAG, /<\/?[A-Za-z][\w:-]*/],
  [T.TAG, /\/?>/],
  [T.ATTR, /\b[A-Za-z_:][\w:.-]*(?==)/],
  [T.STRING, /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
  [T.PUNCT, /[=]/],
]);

const pyRules = compile([
  [T.COMMENT, /#[^\n]*/],
  [T.STRING, /"""[\s\S]*?"""|'''[\s\S]*?'''/],
  [T.STRING, /f?"(?:\\[\s\S]|[^\\"\n])*"|f?'(?:\\[\s\S]|[^\\'\n])*'/],
  [T.META, /@[\w.]+/],
  [
    T.KEYWORD,
    /\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|yield|lambda|pass|global|nonlocal|assert|del|in|is|not|and|or|async|await|match|case|None|True|False|self)\b/,
  ],
  [T.NUMBER, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  [T.FUNC, /\b[A-Za-z_]\w*(?=\s*\()/],
  [T.TYPE, /\b[A-Z][A-Za-z0-9_]*\b/],
  [T.PUNCT, /[{}[\]();,.:]/],
  [T.OP, /[+\-*/%=<>!&|^~]+/],
]);

const shRules = compile([
  [T.COMMENT, /(?:^|\s)#[^\n]*/],
  [T.STRING, /"(?:\\[\s\S]|[^\\"\n])*"|'[^'\n]*'/],
  [T.META, /\$\{[^}]*\}|\$[\w@#?$!*-]+/],
  [T.KEYWORD, /\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|export|local|source|shift|exit|set|trap)\b/],
  [T.FUNC, /\b(?:npm|npx|pnpm|yarn|node|git|docker|kubectl|curl|grep|sed|awk|cat|ls|cd|mkdir|rm|cp|mv|echo|chmod|find|tar|ssh|python3?|pip3?|make|cargo|go)\b/],
  [T.NUMBER, /\b\d+\b/],
  [T.OP, /[|&;<>]+/],
  [T.PUNCT, /[(){}[\]]/],
]);

const yamlRules = compile([
  [T.COMMENT, /#[^\n]*/],
  [T.PROP, /^[ \t-]*[\w.-]+(?=\s*:)/m],
  [T.STRING, /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
  [T.LITERAL, /\b(?:true|false|null|yes|no|on|off)\b/],
  [T.NUMBER, /\b\d+(?:\.\d+)?\b/],
  [T.PUNCT, /[:,[\]{}|-]/],
]);

const sqlRules = compile([
  [T.COMMENT, /--[^\n]*/],
  [T.COMMENT, /\/\*[\s\S]*?\*\//],
  [T.STRING, /'(?:''|[^'])*'/],
  [
    T.KEYWORD,
    /\b(?:select|from|where|insert|into|values|update|set|delete|create|table|index|on|join|left|right|inner|outer|group|by|order|having|limit|offset|as|and|or|not|null|primary|key|foreign|references|drop|alter|add|distinct|count|sum|avg|min|max|case|when|then|else|end|union|all|begin|commit|rollback)\b/i,
  ],
  [T.NUMBER, /\b\d+(?:\.\d+)?\b/],
  [T.FUNC, /\b\w+(?=\()/],
  [T.PUNCT, /[(),;.]/],
]);

const diffRules = compile([
  [T.META, /^(?:diff|index|---|\+\+\+)[^\n]*/m],
  [T.INSERT, /^\+[^\n]*/m],
  [T.DELETE, /^-[^\n]*/m],
  [T.META, /^@@[^\n]*/m],
]);

const mdRules = compile([
  [T.META, /^#{1,6}[^\n]*/m],
  [T.COMMENT, /^>[^\n]*/m],
  [T.STRING, /`[^`\n]+`|```[\s\S]*?```/],
  [T.KEYWORD, /\*\*[^*\n]+\*\*|__[^_\n]+__/],
  [T.LITERAL, /^\s*[-*+]\s|^\s*\d+\.\s/m],
  [T.PUNCT, /[[\](|)]/],
]);

const defaultRules = compile([
  [T.COMMENT, /(?:^|\s)(?:#|\/\/)[^\n]*/],
  [T.STRING, /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
  [T.NUMBER, /\b\d+(?:\.\d+)?\b/],
]);

const LANGS = {
  javascript: jsRules,
  js: jsRules,
  jsx: jsRules,
  typescript: jsRules,
  ts: jsRules,
  tsx: jsRules,
  mjs: jsRules,
  json: jsonRules,
  jsonc: jsonRules,
  css: cssRules,
  scss: cssRules,
  less: cssRules,
  html: htmlRules,
  xml: htmlRules,
  svg: htmlRules,
  vue: htmlRules,
  python: pyRules,
  py: pyRules,
  bash: shRules,
  sh: shRules,
  shell: shRules,
  zsh: shRules,
  console: shRules,
  yaml: yamlRules,
  yml: yamlRules,
  toml: yamlRules,
  sql: sqlRules,
  diff: diffRules,
  patch: diffRules,
  markdown: mdRules,
  md: mdRules,
};

/** 把语言别名归一化（```js、```JavaScript、```node 都能落到同一套规则） */
export function normalizeLang(lang) {
  const l = String(lang || '')
    .trim()
    .toLowerCase()
    .replace(/^language-/, '');
  if (!l) return 'text';
  if (LANGS[l]) return l;
  if (l === 'node' || l === 'npm' || l === 'terminal' || l === 'shellsession') return 'sh';
  return 'text';
}

/**
 * 高亮成 token 数组：`[{ t: 'kw'|'str'|...|'text', v: '源码片段' }]`
 * 返回数组而不是 HTML 字符串 —— 调用方用 React 渲染，天然免疫 XSS，也不会有 dangerouslySetInnerHTML。
 */
export function tokenizeCode(code, lang) {
  const name = normalizeLang(lang);
  const rules = LANGS[name] || defaultRules;
  const src = String(code ?? '');
  const out = [];
  let plain = '';
  let i = 0;
  const flush = () => {
    if (plain) {
      out.push({ t: 'text', v: plain });
      plain = '';
    }
  };
  while (i < src.length) {
    let matched = false;
    for (const { type, re } of rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (!m || !m[0]) continue;
      // 多行规则的 ^ 锚点：确保只在行首命中
      flush();
      out.push({ t: type, v: m[0] });
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      plain += src[i];
      i += 1;
    }
  }
  flush();
  return out;
}

/** 统计一下高亮结果（测试用：能确认「真的有颜色」而不是全灰） */
export function highlightStats(code, lang) {
  const toks = tokenizeCode(code, lang);
  const counts = {};
  for (const t of toks) counts[t.t] = (counts[t.t] || 0) + t.v.length;
  return { tokens: toks.length, counts };
}
