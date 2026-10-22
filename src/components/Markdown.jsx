import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseMarkdown, outlineOf } from '../lib/markdown.js';
import { tokenizeCode, normalizeLang } from '../lib/highlight.js';
import { resolveAssetSrc, dirOf, shortAlt } from '../lib/md-assets.js';

/**
 * 文档所在目录：图片的相对路径要相对「这份文档」解析，而不是相对应用地址。
 * 用 context 传，免得每个 Block / Inline 都多一个参数（真加过，漏了三处）。
 */
const BaseDirCtx = React.createContext('');
const useBaseDir = () => React.useContext(BaseDirCtx);

/* ------------------------------------------------------------------ */
/* 代码块：语言标签 + 行号 + 复制 + 折叠                                       */
/* ------------------------------------------------------------------ */

const LANG_LABEL = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  xml: 'XML',
  svg: 'SVG',
  vue: 'Vue',
  py: 'Python',
  python: 'Python',
  sh: 'Shell',
  bash: 'Shell',
  shell: 'Shell',
  zsh: 'Shell',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  sql: 'SQL',
  diff: 'Diff',
  patch: 'Diff',
  md: 'Markdown',
  markdown: 'Markdown',
  text: '纯文本',
};

const labelOf = (lang) => LANG_LABEL[String(lang || '').toLowerCase()] || (lang ? String(lang) : '纯文本');

/** 直接把高亮 token 渲染成 span（不用 innerHTML，天然安全） */
export function Highlighted({ code, lang }) {
  const tokens = useMemo(() => tokenizeCode(code, lang), [code, lang]);
  return tokens.map((t, i) =>
    t.t === 'text' ? (
      <React.Fragment key={i}>{t.v}</React.Fragment>
    ) : (
      <span key={i} className={`tok-${t.t}`}>
        {t.v}
      </span>
    ),
  );
}

function CodeBlock({ code, lang, showLineNumbers = true, maxHeight }) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const lines = useMemo(() => String(code).split('\n'), [code]);
  const long = lines.length > 28;

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, [code]);

  const shown = collapsed ? lines.slice(0, 12).join('\n') : code;

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{labelOf(lang)}</span>
        <span className="code-meta">{lines.length} 行</span>
        <span className="spacer" />
        {long && (
          <button type="button" className="code-btn" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? `展开全部 ${lines.length} 行` : '折叠'}
          </button>
        )}
        <button type="button" className={`code-btn ${copied ? 'done' : ''}`} onClick={copy}>
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <pre className="code-pre" style={maxHeight ? { maxHeight } : undefined}>
        {showLineNumbers ? (
          <code className="code-grid">
            {shown.split('\n').map((line, i) => (
              <React.Fragment key={i}>
                <span className="code-ln" aria-hidden>
                  {i + 1}
                </span>
                <span className="code-line">
                  {line ? <Highlighted code={line} lang={lang} /> : ' '}
                </span>
              </React.Fragment>
            ))}
          </code>
        ) : (
          <code>
            <Highlighted code={shown} lang={lang} />
          </code>
        )}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 行内节点 / 块节点                                                  */
/* ------------------------------------------------------------------ */

/**
 * 文档里的图片。
 *
 * 三个真机问题都在这里收口：
 *  1. 相对路径必须按「文档所在目录」解析，并走 /api/fs/raw（构建后 /shots/... 是不存在的）；
 *  2. `loading="lazy"` 在滚动容器里经常永远不触发（README 19 张图只加载出 2 张），
 *     文档预览是本地文件、数量有限，直接 eager；
 *  3. 图片不存在时浏览器只给一个破图标 —— 现在显示「图片没找到 + 解析到的路径」，一眼能改对。
 */
function MdImage({ node }) {
  const baseDir = useBaseDir();
  const src = resolveAssetSrc(node.src, baseDir);
  const [state, setState] = useState('loading'); // loading | ok | error
  const [full, setFull] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => {
    setState('loading');
    setFull(false);
  }, [src]);

  // 缓存命中时 onLoad 可能早于 effect 执行，挂载后再兜一次底
  useEffect(() => {
    const el = imgRef.current;
    if (el?.complete && el.naturalWidth > 0) setState('ok');
  }, [src]);

  const caption = node.alt || '';

  if (state === 'error') {
    return (
      <span className="md-img-missing" title={src}>
        <span className="md-img-missing-icon">▦</span>
        <span className="md-img-missing-text">
          图片没找到：<code>{decodeURIComponent(src.replace('/api/fs/raw?path=', ''))}</code>
          <span className="md-img-missing-hint">（相对路径按文档所在目录 {baseDir || '根目录'} 解析）</span>
        </span>
      </span>
    );
  }

  return (
    <span className={`md-img-wrap ${full ? 'full' : ''}`}>
      <a href={src} target="_blank" rel="noreferrer noopener" title={node.title || caption || src}>
        <img
          ref={imgRef}
          className={`md-img ${state === 'ok' ? 'ready' : 'loading'}`}
          src={src}
          alt={shortAlt(caption, 60)}
          loading="eager"
          decoding="async"
          onLoad={() => setState('ok')}
          onError={() => setState('error')}
        />
      </a>
      <span className="md-img-bar">
        {caption ? <span className="md-img-cap">{caption}</span> : null}
        <button type="button" className="md-img-zoom" onClick={() => setFull((v) => !v)} title={full ? '缩小' : '放大到整宽'}>
          {full ? '缩小' : '放大'}
        </button>
      </span>
    </span>
  );
}

function Inline({ nodes }) {
  return (nodes || []).map((n, i) => {
    switch (n.type) {
      case 'text':
        return <React.Fragment key={i}>{n.value}</React.Fragment>;
      case 'code':
        return (
          <code key={i} className="inline-code">
            {n.value}
          </code>
        );
      case 'strong':
        return (
          <strong key={i}>
            <Inline nodes={n.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <Inline nodes={n.children} />
          </em>
        );
      case 'del':
        return (
          <del key={i}>
            <Inline nodes={n.children} />
          </del>
        );
      case 'br':
        return <br key={i} />;
      case 'link':
        return (
          <a key={i} href={n.href} title={n.title || undefined} target="_blank" rel="noreferrer noopener">
            <Inline nodes={n.children} />
            {/^https?:/.test(n.href) ? <span className="link-mark">↗</span> : null}
          </a>
        );
      case 'image':
        return <MdImage key={i} node={n} />;
      default:
        return null;
    }
  });
}

const QUOTE_ICON = { note: 'ℹ', tip: '✦', important: '❗', warning: '⚠', caution: '🛑' };

function Block({ b, depth = 0 }) {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${Math.min(6, b.depth + 1)}`; // 回答里从 h2 起，别压过页面标题
      return (
        <Tag className={`md-h md-h${b.depth}`}>
          <Inline nodes={b.children} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="md-p">
          <Inline nodes={b.children} />
        </p>
      );
    case 'code':
      return <CodeBlock code={b.value} lang={b.lang} />;
    case 'hr':
      return <hr className="md-hr" />;
    case 'quote':
      return (
        <blockquote className={`md-quote ${b.kind !== 'quote' ? `md-callout md-callout-${b.kind}` : ''}`}>
          {b.kind !== 'quote' && (
            <span className="md-callout-tag">
              {QUOTE_ICON[b.kind]} {b.kind}
            </span>
          )}
          {b.children.map((c, i) => (
            <Block key={i} b={c} depth={depth + 1} />
          ))}
        </blockquote>
      );
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag className={`md-list ${b.items.some((it) => it.task !== null) ? 'md-tasklist' : ''}`} start={b.ordered ? b.start : undefined}>
          {b.items.map((it, i) => (
            <li key={i} className={it.task !== null ? 'md-task' : undefined}>
              {it.task !== null && (
                <span className={`md-check ${it.task ? 'on' : ''}`} aria-hidden>
                  {it.task ? '✓' : ''}
                </span>
              )}
              <span>
                <Inline nodes={it.children} />
                {it.blocks?.length ? it.blocks.map((c, j) => <Block key={j} b={c} depth={depth + 1} />) : null}
              </span>
            </li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} style={b.aligns?.[i] ? { textAlign: b.aligns[i] } : undefined}>
                    <Inline nodes={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={b.aligns?.[ci] ? { textAlign: b.aligns[ci] } : undefined}>
                      <Inline nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* 对外组件                                                            */
/* ------------------------------------------------------------------ */

/** AI 回答 / 聊天里的 Markdown（baseDir 默认工作区根：回答里写 `shots/a.png` 就按根解析） */
export default function Markdown({ text, baseDir = '' }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <BaseDirCtx.Provider value={baseDir}>
      <div className="md">
        {blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>
    </BaseDirCtx.Provider>
  );
}

/** 文件预览：带大纲侧栏 + 复制全文的 Markdown 阅读视图 */
export function MarkdownDocument({ text, title, basePath = '' }) {
  // 图片的相对路径要相对**这份文档**，不是相对应用地址
  const baseDir = dirOf(basePath || title || '');
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const outline = useMemo(() => outlineOf(blocks), [blocks]);
  const bodyRef = useRef(null);
  const [copied, setCopied] = useState(false);

  const jump = (idx) => {
    const el = bodyRef.current?.querySelectorAll('.md-h')[idx];
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    setCopied(false);
  }, [text]);

  return (
    <BaseDirCtx.Provider value={baseDir}>
    <div className="md-doc">
      {outline.length > 1 && (
        <aside className="md-toc">
          <div className="md-toc-head">大纲 · {outline.length} 节</div>
          {outline.map((h, i) => (
            <button
              key={i}
              type="button"
              className={`md-toc-item d${Math.min(4, h.depth)}`}
              onClick={() => jump(i)}
              title={h.text}
            >
              {h.text || '（无标题）'}
            </button>
          ))}
        </aside>
      )}
      <div className="md-doc-body" ref={bodyRef}>
        {title ? <div className="md-doc-file">{title}</div> : null}
        {blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>
      <button
        type="button"
        className="md-doc-copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* 忽略 */
          }
        }}
      >
        {copied ? '已复制全文 ✓' : '复制全文'}
      </button>
    </div>
    </BaseDirCtx.Provider>
  );
}

export { CodeBlock, labelOf, normalizeLang };
