import React, { useMemo, useState } from 'react';
import { DiffBlock } from './DiffView.jsx';
import { diffLines } from '../lib/diff.js';
import { IconClose, IconSync } from './Icons.jsx';

/**
 * 外部改动合并预览
 *
 * 一秒钟内多个文件被外部修改（git pull / 另一个编辑器保存 / 脚本生成）时，
 * 聚合成一个「本次外部改动」弹窗：左侧文件列表，右侧逐行 diff，可逐个回退。
 */
export default function ExternalChanges({ items = [], onClose, onRevert, onOpenFile }) {
  const [active, setActive] = useState(0);
  const list = useMemo(
    () =>
      items.map((it) => {
        const s = diffLines(it.before || '', it.after || '').stats;
        return { ...it, added: s.added, removed: s.removed };
      }),
    [items],
  );
  if (!list.length) return null;
  const cur = list[Math.min(active, list.length - 1)];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal change-set">
        <div className="modal-head">
          <IconSync size={14} />
          <h2>本次外部改动 · {list.length} 个文件</h2>
          <div className="spacer" />
          <button className="btn sm" onClick={() => list.forEach((it) => onRevert?.(it))}>
            全部回退
          </button>
          <button className="icon-btn" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>
        <div className="change-set-body">
          <div className="change-set-list">
            {list.map((it, i) => (
              <button
                key={it.path}
                className={`cs-item ${i === active ? 'on' : ''}`}
                onClick={() => setActive(i)}
                title={it.path}
              >
                <span className="cs-path">{it.path}</span>
                <span className="cs-stat">
                  <i className="add">+{it.added}</i>
                  <i className="del">−{it.removed}</i>
                </span>
              </button>
            ))}
          </div>
          <div className="change-set-diff">
            <div className="cs-diff-head">
              <span>{cur.path}</span>
              <div className="spacer" />
              {cur.fileId && (
                <button className="link-btn" onClick={() => onOpenFile?.(cur.fileId)}>
                  打开文件
                </button>
              )}
              <button className="link-btn" onClick={() => onRevert?.(cur)}>
                回退此文件
              </button>
            </div>
            <div className="cs-diff-body">
              <DiffBlock before={cur.before || ''} after={cur.after || ''} path={cur.path} compact />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
