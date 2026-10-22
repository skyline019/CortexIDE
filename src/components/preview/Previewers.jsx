import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseOffice, parseCsv } from '../../lib/office.js';

/* ------------------------------------------------------------------ */
/* 通用：加载 / 出错 / 空态                                             */
/* ------------------------------------------------------------------ */

function Loading({ text = '解析中…' }) {
  return (
    <div className="pv-center">
      <div className="pv-spinner" />
      <div>{text}</div>
    </div>
  );
}

function Failure({ message, onDownload, hint }) {
  return (
    <div className="pv-center pv-fail">
      <div className="pv-fail-icon">⚠</div>
      <div className="pv-fail-title">这个文件没法在这里预览</div>
      <div className="pv-fail-msg">{message}</div>
      {hint ? <div className="pv-fail-hint">{hint}</div> : null}
      <button type="button" className="btn" onClick={onDownload}>
        下载原文件
      </button>
    </div>
  );
}

/** 用 /api/fs/raw 取原始字节（二进制预览统一入口） */
function useFileBytes(path, enabled = true) {
  // forPath 对齐后才展示，换 path 时派生 loading，避免 effect 里同步 setState
  const [result, setResult] = useState({ forPath: null, bytes: null, error: null });
  useEffect(() => {
    if (!enabled || !path) return undefined;
    let alive = true;
    fetch(`/api/fs/raw?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      })
      .then((bytes) => alive && setResult({ forPath: path, bytes, error: null }))
      .catch((err) => alive && setResult({ forPath: path, bytes: null, error: err.message }));
    return () => {
      alive = false;
    };
  }, [path, enabled]);

  if (!enabled || !path) return { loading: false, bytes: null, error: null };
  const stale = result.forPath !== path;
  return {
    loading: stale,
    bytes: stale ? null : result.bytes,
    error: stale ? null : result.error,
  };
}

const download = (path) => {
  const a = document.createElement('a');
  a.href = `/api/fs/raw?path=${encodeURIComponent(path)}&download=1`;
  a.download = path.split('/').pop();
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/* ------------------------------------------------------------------ */
/* 表格渲染（xlsx / csv 共用）                                          */
/* ------------------------------------------------------------------ */

function DataTable({ rows, caption, firstRowHeader = true, formulaCells = null }) {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const head = firstRowHeader ? rows[0] || [] : null;
  const body = firstRowHeader ? rows.slice(1) : rows;
  return (
    <div className="pv-sheet">
      {caption ? <div className="pv-sheet-cap">{caption}</div> : null}
      <div className="pv-sheet-scroll">
        <table className="pv-table">
          {head && (
            <thead>
              <tr>
                <th className="pv-rownum" />
                {Array.from({ length: cols }, (_, i) => (
                  <th key={i}>{head[i] || ''}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                <td className="pv-rownum">{ri + 1}</td>
                {Array.from({ length: cols }, (_, ci) => {
                  const v = r[ci] ?? '';
                  // 公式格由解析器给出（有缓存值的公式也算），不靠「看起来像 =」去猜
                  const isFormula = formulaCells ? formulaCells.has(`${ri + firstRowHeader},${ci}`) : false;
                  const numeric = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(String(v));
                  return (
                    <td key={ci} className={`${numeric ? 'num' : ''} ${isFormula ? 'formula' : ''}`} title={isFormula ? '公式单元格，显示的是公式原文（没有缓存的计算结果）' : undefined}>
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pv-sheet-foot">
        {body.length} 行 × {cols} 列
        {formulaCells?.size ? ` · ${formulaCells.size} 个公式格（琥珀色：显示缓存值或公式原文，此处不计算）` : ''}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Excel                                                              */
/* ------------------------------------------------------------------ */

export function XlsxPreview({ path }) {
  const { loading, bytes, error } = useFileBytes(path);
  const [doc, setDoc] = useState(null);
  const [failed, setFailed] = useState(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    parseOffice(bytes, 'xlsx')
      .then((d) => alive && setDoc(d))
      .catch((e) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [bytes]);

  if (error || failed) return <Failure message={error || failed} onDownload={() => download(path)} />;
  if (loading || !doc) return <Loading text="解包 Excel…" />;

  const sheet = doc.sheets[active] || { rows: [], cols: 0 };
  return (
    <div className="pv">
      <div className="pv-bar">
        <span className="pv-badge xlsx">XLSX</span>
        <div className="pv-tabs">
          {doc.sheets.map((s, i) => (
            <button key={s.name} type="button" className={`pv-tab ${i === active ? 'on' : ''}`} onClick={() => setActive(i)}>
              {s.name}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="pv-meta">
          {doc.stats.sheets} 个工作表 · {doc.stats.rows} 行
          {doc.stats.engine === 'sheetjs' ? ' · SheetJS' : ''}
          {doc.stats.truncated ? ' · 已截断超长表' : ''}
        </span>
        <button type="button" className="btn sm" onClick={() => download(path)}>
          下载
        </button>
      </div>
      <DataTable
        rows={sheet.rows}
        caption={`${sheet.name}（${sheet.rows.length} 行）`}
        formulaCells={new Set((sheet.formulas || []).map(([r, c]) => `${r},${c}`))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Word —— docx-preview 版面还原（对齐 PDF 成熟引擎路线）              */
/* ------------------------------------------------------------------ */

export function DocxPreview({ path }) {
  const { loading, bytes, error } = useFileBytes(path);
  const [failed, setFailed] = useState(null);
  const [rendering, setRendering] = useState(false);
  const bodyRef = useRef(null);
  const styleRef = useRef(null);

  useEffect(() => {
    if (!bytes || !bodyRef.current) return undefined;
    let alive = true;
    setFailed(null);
    setRendering(true);
    bodyRef.current.innerHTML = '';
    if (styleRef.current) styleRef.current.innerHTML = '';

    (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (!alive || !bodyRef.current) return;
        await renderAsync(bytes, bodyRef.current, styleRef.current || bodyRef.current, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,
          experimental: true,
        });
        if (alive) setRendering(false);
      } catch (e) {
        if (alive) {
          setFailed(e?.message || String(e));
          setRendering(false);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [bytes]);

  if (error || failed) {
    return <Failure message={error || failed} onDownload={() => download(path)} hint="可下载后用 Word / WPS 打开。" />;
  }

  return (
    <div className="pv pv-docx">
      <div className="pv-bar">
        <span className="pv-badge docx">DOCX</span>
        <span className="pv-meta">{path.split(/[/\\]/).pop()}</span>
        <span className="spacer" />
        <span className="pv-hint">docx-preview 版面还原 · 页眉页脚/分页/表格</span>
        <button type="button" className="btn sm" onClick={() => download(path)}>
          下载
        </button>
      </div>
      <div className="pv-docx-scroll">
        {(loading || rendering) && (
          <div className="pv-docx-loading">
            <Loading text={loading ? '读取 Word…' : '还原版面…'} />
          </div>
        )}
        <div ref={styleRef} className="pv-docx-styles" hidden />
        <div ref={bodyRef} className="pv-docx-body" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PPT                                                                */
/* ------------------------------------------------------------------ */

export function PptxPreview({ path }) {
  const { loading, bytes, error } = useFileBytes(path);
  const [doc, setDoc] = useState(null);
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    parseOffice(bytes, 'pptx')
      .then((d) => alive && setDoc(d))
      .catch((e) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [bytes]);

  if (error || failed) return <Failure message={error || failed} onDownload={() => download(path)} />;
  if (loading || !doc) return <Loading text="解包 PPT…" />;

  return (
    <div className="pv">
      <div className="pv-bar">
        <span className="pv-badge pptx">PPTX</span>
        <span className="pv-meta">{doc.stats.slides} 页</span>
        <span className="spacer" />
        <span className="pv-hint" title="不还原版式、图片、动画与 SmartArt；仅抽取正文与备注供阅读与 Agent 上下文">
          文本抽取预览（非版式还原）
          {doc.stats.withNotes ? ` · ${doc.stats.withNotes} 页含备注` : ''}
        </span>
        <button type="button" className="btn sm" onClick={() => download(path)}>
          下载
        </button>
      </div>
      <div className="pv-slides">
        {doc.slides.map((s) => (
          <div key={s.index} className="pv-slide">
            <div className="pv-slide-no">{s.index}</div>
            <div className="pv-slide-body">
              <div className="pv-slide-title">{s.paragraphs[0] || `第 ${s.index} 页`}</div>
              {(s.tables || []).map((rows, ti) => (
                <div key={`t${ti}`} className="pv-table-wrap">
                  <table className="pv-table doc">
                    <tbody>
                      {rows.map((r, ri) => (
                        <tr key={ri}>
                          {r.map((c, ci) => (ri === 0 ? <th key={ci}>{c}</th> : <td key={ci}>{c}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {s.paragraphs.slice(1).map((p, i) => (
                <div key={i} className="pv-slide-item">
                  <span className="pv-slide-dot" />
                  {p}
                </div>
              ))}
              {s.notes?.length > 0 && (
                <div className="pv-slide-notes">
                  <div className="pv-slide-notes-label">备注</div>
                  {s.notes.map((n, i) => (
                    <div key={i}>{n}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CSV                                                                */
/* ------------------------------------------------------------------ */

export function CsvPreview({ text }) {
  // 注意用 parseCsv 这个同步函数：parseOffice 是 async，返回 Promise，
  // 拿 Promise 当结果用会把整个页面炸成白屏（踩过一次）。
  const table = useMemo(() => parseCsv(text || ''), [text]);
  return (
    <div className="pv">
      <div className="pv-bar">
        <span className="pv-badge csv">CSV</span>
        <span className="pv-meta">
          {table.rows.length} 行（含表头）× {table.cols} 列 · 分隔符 {table.delimiter === '\t' ? 'Tab' : '逗号'}
        </span>
        <span className="spacer" />
        <span className="pv-hint">首个非空行当作表头</span>
      </div>
      <DataTable rows={table.rows} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 图片 / PDF                                                          */
/* ------------------------------------------------------------------ */

export function ImagePreview({ path }) {
  const src = `/api/fs/raw?path=${encodeURIComponent(path)}`;
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dims, setDims] = useState(null); // {w,h} 真实像素尺寸
  const [err, setErr] = useState(false);
  const [fit, setFit] = useState(true); // 是否处于「适应窗口」
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef(null);

  // 换文件时由外层 key={path} 整树复位；此处不再 sync setState

  const clampZoom = (z) => Math.min(8, Math.max(0.1, +z.toFixed(2)));
  const zoomBy = (delta) => {
    setFit(false);
    setZoom((z) => clampZoom(z + delta));
  };

  // 滚轮缩放：Ctrl/⌘ + 滚轮或直接滚轮都行；要求焦点在预览里，别劫持整页滚动
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setFit(false);
    setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.12 : 0.9)));
  };

  const onPointerDown = (e) => {
    if (fit) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragOrigin.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    setDragging(true);
  };
  const onPointerMove = (e) => {
    if (!dragOrigin.current) return;
    setOffset({ x: e.clientX - dragOrigin.current.x, y: e.clientY - dragOrigin.current.y });
  };
  const onPointerUp = (e) => {
    dragOrigin.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const reset = () => {
    setZoom(1);
    setRotate(0);
    setOffset({ x: 0, y: 0 });
    setFit(true);
  };

  return (
    <div className="pv pv-image">
      <div className="pv-bar">
        <span className="pv-badge img">图片</span>
        <span className="pv-meta">{path.split('/').pop()}</span>
        <span className="pv-meta dim">
          {dims ? `${dims.w}×${dims.h}` : '读取中…'}
          {dims ? ` · ${(dims.w * dims.h / 1e6).toFixed(2)} MP` : ''}
          {rotate % 360 ? ` · 旋转 ${rotate % 360}°` : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => zoomBy(-0.25)} title="缩小（Ctrl + 滚轮）">
          −
        </button>
        <span className="pv-meta zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn sm" onClick={() => zoomBy(0.25)} title="放大（Ctrl + 滚轮）">
          +
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            setFit(true);
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
          title="缩放到适应窗口"
        >
          适应
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            setFit(false);
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
          title="按原尺寸查看（1:1）"
        >
          1:1
        </button>
        <button type="button" className="btn sm" onClick={() => setRotate((r) => r + 90)} title="顺时针旋转 90°">
          旋转
        </button>
        <button type="button" className="btn sm" onClick={reset} title="复位">
          复位
        </button>
        <button type="button" className="btn sm" onClick={() => download(path)}>
          下载
        </button>
      </div>

      <div
        className={`pv-image-stage ${fit ? 'fit' : 'free'} ${dragging ? 'dragging' : ''}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => (fit ? (setFit(false), setZoom(2)) : reset())}
        tabIndex={0}
      >
        {err ? (
          <div className="pv-center pv-fail">
            <div className="pv-fail-icon">⚠</div>
            <div className="pv-fail-title">这张图片读不出来</div>
            <div className="pv-fail-msg">文件存在，但浏览器解码失败（可能扩展名和真实内容不一致，或文件已损坏）。</div>
            <button type="button" className="btn" onClick={() => download(path)}>
              下载原文件
            </button>
          </div>
        ) : (
          <img
            src={src}
            alt={path}
            draggable={false}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setErr(true)}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotate}deg)`,
              transition: dragging ? 'none' : 'transform 0.14s ease',
              cursor: fit ? 'zoom-in' : 'grab',
            }}
          />
        )}
      </div>
      <div className="pv-image-foot">
        双击放大/复位 · 按住拖动平移 · Ctrl(⌘)+滚轮缩放 · 支持 PNG / JPEG / GIF / WebP / SVG / AVIF / BMP / ICO
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 未知二进制                                                          */
/* ------------------------------------------------------------------ */

export function BinaryPreview({ path, size, message }) {
  return (
    <Failure
      message={
        message ||
        `${path.split('/').pop()} 是二进制文件${size ? `（${Math.round(size / 1024)} KB）` : ''}，暂不支持预览。`
      }
      onDownload={() => download(path)}
      hint="已支持预览：Markdown / 代码 / CSV / 图片 / 视频 / 音频 / PDF / Word(docx) / Excel(xlsx·SheetJS) / PPT(pptx·仅文本)"
    />
  );
}

