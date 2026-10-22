import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pageItemsToText, resolvePdfAssets } from '../../lib/pdf-text.js';

/**
 * PDF 渲染器：真·把页面画到 canvas 上。
 *
 * 文字条与 Agent 共用 pageItemsToText（CJK 不插空、视觉分栏），
 * 并挂上本地 cmaps，避免中文乱码。
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

function pdfDocOptions(extra = {}) {
  const assets = resolvePdfAssets(pdfjs);
  return {
    useSystemFonts: true,
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: assets.standardFontDataUrl,
    isEvalSupported: false,
    ...extra,
  };
}

export default function PdfPreview({ path }) {
  const [state, setState] = useState({ loading: true, error: null, pages: 0 });
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1.15);
  const [text, setText] = useState('');
  const canvasRef = useRef(null);
  const docRef = useRef(null);
  const renderRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, pages: 0 });
    setText('');
    const task = pdfjs.getDocument(
      pdfDocOptions({ url: `/api/fs/raw?path=${encodeURIComponent(path)}` }),
    );
    task.promise.then(
      (doc) => {
        if (!alive) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setState({ loading: false, error: null, pages: doc.numPages });
        setPage(1);
      },
      (err) => alive && setState({ loading: false, error: err?.message || String(err), pages: 0 }),
    );
    return () => {
      alive = false;
      task.destroy?.();
      docRef.current?.destroy?.();
      docRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    const doc = docRef.current;
    if (!doc || state.loading || !state.pages) return;
    let cancelled = false;
    (async () => {
      try {
        renderRef.current?.cancel?.();
        const pg = await doc.getPage(page);
        if (cancelled) return;
        const viewport = pg.getViewport({ scale: zoom * (window.devicePixelRatio || 1) });
        const cssViewport = pg.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(cssViewport.width)}px`;
        canvas.style.height = `${Math.floor(cssViewport.height)}px`;
        const task = pg.render({ canvasContext: canvas.getContext('2d'), viewport });
        renderRef.current = task;
        await task.promise;
        if (cancelled) return;
        const baseVp = pg.getViewport({ scale: 1 });
        const tc = await pg.getTextContent({ disableCombineTextItems: false });
        const rebuilt = pageItemsToText(tc.items || [], {
          width: baseVp.width,
          height: baseVp.height,
        });
        setText(rebuilt);
        wrapRef.current?.scrollTo({ top: 0 });
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') setState((s) => ({ ...s, error: err.message }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, zoom, state.loading, state.pages]);

  const download = useCallback(() => {
    const a = document.createElement('a');
    a.href = `/api/fs/raw?path=${encodeURIComponent(path)}&download=1`;
    a.download = path.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [path]);

  if (state.error) {
    return (
      <div className="pv">
        <div className="pv-bar">
          <span className="pv-badge pdf">PDF</span>
          <span className="pv-meta">{path.split('/').pop()}</span>
        </div>
        <div className="pv-center pv-fail">
          <div className="pv-fail-icon">⚠</div>
          <div className="pv-fail-title">这个 PDF 打不开</div>
          <div className="pv-fail-msg">{state.error}</div>
          <div className="pv-fail-hint">文件可能已损坏，或者是加密 / 不支持的特性。可以下载后用系统阅读器再试。</div>
          <button type="button" className="btn" onClick={download}>
            下载原文件
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pv pv-pdf">
      <div className="pv-bar">
        <span className="pv-badge pdf">PDF</span>
        <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          ←
        </button>
        <span className="pv-meta">
          {state.loading ? '载入中…' : `${page} / ${state.pages} 页`}
        </span>
        <button type="button" className="btn sm" disabled={page >= state.pages} onClick={() => setPage((p) => Math.min(state.pages, p + 1))}>
          →
        </button>
        <span className="pv-sep" />
        <button type="button" className="btn sm" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))}>
          −
        </button>
        <span className="pv-meta">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn sm" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}>
          +
        </button>
        <button type="button" className="btn sm" onClick={() => setZoom(1.15)}>
          适应
        </button>
        <span className="spacer" />
        <span className="pv-hint">Canvas · 视觉序抽字</span>
        <button type="button" className="btn sm" onClick={download}>
          下载
        </button>
      </div>
      <div className="pv-pdf-stage" ref={wrapRef}>
        {state.loading ? (
          <div className="pv-center">
            <div className="pv-spinner" />
            <div>解析 PDF…</div>
          </div>
        ) : null}
        <canvas ref={canvasRef} className="pv-pdf-canvas" />
      </div>
      {text ? (
        <div className="pv-pdf-text" title="本页视觉序文本（与 Agent 同源算法）">
          {text.slice(0, 600)}
          {text.length > 600 ? ' …' : ''}
        </div>
      ) : null}
    </div>
  );
}
