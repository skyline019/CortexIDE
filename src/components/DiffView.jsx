import React, { useMemo, useState } from 'react';
import { diffLines } from '../lib/diff.js';
import { IconClose } from './Icons.jsx';

/** 行内高亮：找出两行公共前缀/后缀，中间标黄 */
function inlineMark(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { aPre: a.slice(0, p), aMid: a.slice(p, a.length - s), aSuf: a.slice(a.length - s), bPre: b.slice(0, p), bMid: b.slice(p, b.length - s), bSuf: b.slice(b.length - s) };
}

export function DiffBlock({ before = '', after = '', path = '', compact = false }) {
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  const [mode, setMode] = useState('unified');

  if (!diff.stats.added && !diff.stats.removed) {
    return <div className="diff-empty">内容没有变化</div>;
  }

  return (
    <div className={`diff-wrap ${compact ? 'compact' : ''}`}>
      <div className="diff-head">
        <span className="diff-path">{path || '变更'}</span>
        <span className="diff-stat add">+{diff.stats.added}</span>
        <span className="diff-stat del">−{diff.stats.removed}</span>
        {diff.stats.coarse && <span className="diff-stat">大文件粗略模式</span>}
        <button className={`diff-btn ${mode === 'unified' ? 'on' : ''}`} onClick={() => setMode('unified')}>
          统一
        </button>
        <button className={`diff-btn ${mode === 'split' ? 'on' : ''}`} onClick={() => setMode('split')}>
          分栏
        </button>
      </div>

      {mode === 'unified' ? (
        <div className="diff-body">
          {diff.hunks.map((h, hi) => (
            <React.Fragment key={hi}>
              {h.folded && <div className="diff-fold">⋯ {h.foldedCount} 行未变更</div>}
              {h.lines.map((l, li) => (
                <div key={li} className={`diff-line ${l.type}`}>
                  <span className="ln">{l.aLine ?? ''}</span>
                  <span className="ln">{l.bLine ?? ''}</span>
                  <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                  <span className="code">{l.text || ' '}</span>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <div className="diff-split">
          <div className="diff-col">
            <div className="diff-col-head">修改前</div>
            {diff.hunks.map((h, hi) =>
              h.type === 'add' ? (
                <div key={hi} className="diff-line ghost">
                  <span className="ln" />
                  <span className="code">{' '}</span>
                </div>
              ) : (
                h.lines.map((l, li) => (
                  <div key={`${hi}-${li}`} className={`diff-line ${l.type}`}>
                    <span className="ln">{l.aLine ?? ''}</span>
                    <span className="code">{l.text || ' '}</span>
                  </div>
                ))
              ),
            )}
          </div>
          <div className="diff-col">
            <div className="diff-col-head">修改后</div>
            {diff.hunks.map((h, hi) =>
              h.type === 'del' ? (
                <div key={hi} className="diff-line ghost">
                  <span className="ln" />
                  <span className="code">{' '}</span>
                </div>
              ) : (
                h.lines.map((l, li) => (
                  <div key={`${hi}-${li}`} className={`diff-line ${l.type}`}>
                    <span className="ln">{l.bLine ?? ''}</span>
                    <span className="code">{l.text || ' '}</span>
                  </div>
                ))
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DiffModal({ title, before, after, path, onClose, actions }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal diff-modal">
        <div className="modal-head">
          <h2>差异对比 · {title || path || '文件'}</h2>
          <div className="spacer" />
          {actions}
          <button className="icon-btn" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          <DiffBlock before={before} after={after} path={path} />
        </div>
      </div>
    </div>
  );
}

export { inlineMark };
