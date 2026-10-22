import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store.jsx';
import { KINDS } from '../lib/memory.js';

export default function CommandPalette({ onClose, actions }) {
  const { state, dispatch } = useApp();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef(null);

  const items = useMemo(() => {
    const sessions = state.chatSessions || [];
    const base = [
      { kind: 'cmd', label: '新建 Agent 会话', hint: 'session', run: actions.newChat },
      { kind: 'cmd', label: '打开会话侧栏', hint: 'sessions', run: actions.openSessions },
      { kind: 'cmd', label: '切换 / 打开工作区…', hint: 'Ctrl+O', run: actions.openWelcome },
      { kind: 'cmd', label: '打开记忆库', hint: '⌘M', run: actions.openMemory },
      { kind: 'cmd', label: '打开设置', hint: ',', run: actions.openSettings },
      { kind: 'cmd', label: 'SSH 远程工作区（连远端目录 / git）', hint: 'ssh', run: actions.openRemote },
      { kind: 'cmd', label: '归档当前会话为情节记忆', run: actions.archive },
      { kind: 'cmd', label: '导出全部状态（备份）', run: actions.backup },
      { kind: 'cmd', label: '切换对话面板', hint: '⌘J', run: actions.toggleChat },
      { kind: 'cmd', label: '切换侧边栏', hint: '⌘B', run: actions.toggleSidebar },
      { kind: 'cmd', label: `运行命令（白名单内，当前用户 ${state.settings.userId}）`, hint: 'exec', run: actions.runCommand },
      { kind: 'cmd', label: '切换用户（记忆隔离）', hint: 'user', run: actions.switchUser },
      { kind: 'cmd', label: '同步记忆到 sqlite-vec', hint: 'sync', run: actions.syncMemory },
      ...(actions.recentWorkspaces || []).map((r, i) => ({
        kind: 'workspace',
        label: r.path,
        hint: i < 9 ? `Ctrl+${i + 1}` : '最近',
        run: () => actions.openRecentWorkspace?.(r.path),
      })),
      ...sessions.map((s) => ({
        kind: 'session',
        label: s.title || '未命名会话',
        hint: s.id === state.activeSessionId ? '当前' : '切换',
        run: () => actions.switchChat?.(s.id),
      })),
      ...state.files.map((f) => ({
        kind: 'file',
        label: f.path,
        hint: '打开',
        run: () => dispatch({ type: 'file/open', id: f.id }),
      })),
      ...state.memories.slice(0, 60).map((m) => ({
        kind: 'memory',
        label: m.text,
        hint: KINDS[m.kind]?.label || m.kind,
        run: actions.openMemory,
      })),
    ];
    const query = q.trim().toLowerCase();
    if (!query) return base.slice(0, 28);
    return base.filter((i) => i.label.toLowerCase().includes(query)).slice(0, 40);
  }, [q, state.files, state.memories, state.chatSessions, state.activeSessionId, dispatch, actions]);

  useEffect(() => setIdx(0), [q]);

  const run = (item) => {
    item.run?.();
    onClose();
  };

  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          autoFocus
          placeholder="搜索命令、文件或记忆…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx((i) => Math.min(items.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter' && items[idx]) run(items[idx]);
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((item, i) => (
            <div
              key={`${item.kind}-${i}`}
              className={`palette-item ${i === idx ? 'active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(item)}
            >
              <span className="kind">{item.kind}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
              {item.hint && <span className="hint">{item.hint}</span>}
            </div>
          ))}
          {!items.length && <div className="palette-item">没有匹配项</div>}
        </div>
      </div>
    </div>
  );
}
