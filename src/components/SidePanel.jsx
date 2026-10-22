import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store.jsx';
import { fileIcon, dirOf, baseName, newFileTemplate } from '../lib/vfs.js';
import { KINDS, KIND_LIST } from '../lib/memory.js';
import { IconPlus, IconTrash, IconBrain, IconChevronLeft } from './Icons.jsx';
import FileTree from './FileTree.jsx';
import { useToast } from '../state/toast.jsx';

function groupFiles(files) {
  const groups = new Map();
  for (const f of files) {
    const dir = dirOf(f.path) || '.';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return [...groups.entries()].sort((a, b) => (a[0] === '.' ? -1 : b[0] === '.' ? 1 : a[0].localeCompare(b[0])));
}

export function FilesView() {
  const { state, dispatch, ops } = useApp();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [path, setPath] = useState('');
  const groups = useMemo(() => groupFiles(state.files), [state.files]);
  // 真实磁盘模式下直接交给 FileTree（hooks 必须全部在条件返回之前调用）
  if (state.workspace.mode === 'real') return <FileTree />;

  const create = () => {
    const clean = path.trim().replace(/^\/+/, '');
    if (!clean) return setCreating(false);
    if (state.files.some((f) => f.path === clean)) {
      toast('同名文件已存在', 'err');
      return;
    }
    const file = ops.writeFile(clean, newFileTemplate(clean));
    ops.openFile(file.id);
    toast(`已创建 ${clean}`);
    setPath('');
    setCreating(false);
  };

  return (
    <>
      <div className="side-head">
        资源管理器
        <div className="spacer" />
        <button onClick={() => setCreating((v) => !v)} title="新建文件">
          <IconPlus size={13} />
        </button>
      </div>
      <div className="side-body">
        {creating && (
          <div style={{ display: 'flex', gap: 4, padding: '4px 6px 8px' }}>
            <input
              autoFocus
              placeholder="src/components/Foo.jsx"
              value={path}
              style={{ fontSize: 11.5, padding: '4px 7px' }}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
                if (e.key === 'Escape') setCreating(false);
              }}
            />
            <button className="btn sm primary" onClick={create}>
              建
            </button>
          </div>
        )}
        {groups.map(([dir, files]) => (
          <div className="file-group" key={dir}>
            <div className="file-group-title">{dir === '.' ? '根目录' : dir}</div>
            {files.map((f) => {
              const icon = fileIcon(f.path);
              return (
                <div
                  key={f.id}
                  className={`file-row ${state.activeFileId === f.id ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'file/open', id: f.id })}
                >
                  <span className="glyph" style={{ color: icon.color }}>
                    {icon.glyph}
                  </span>
                  <span className="name">{baseName(f.path)}</span>
                  {f.dirty && <span className="dirty" />}
                  <button
                    className="icon-btn"
                    style={{ width: 20, height: 18 }}
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: 'file/delete', id: f.id });
                      toast(`已删除 ${baseName(f.path)}`);
                    }}
                  >
                    <IconTrash size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {!state.files.length && <div className="ins-empty" style={{ padding: 12 }}>工作区是空的，点右上角 + 建个文件。</div>}
      </div>
    </>
  );
}

export function SearchView() {
  const { dispatch, ops } = useApp();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits([]);
      return undefined;
    }
    let alive = true;
    setBusy(true);
    const timer = setTimeout(() => {
      ops
        .searchFiles(query)
        .then((res) => alive && setHits((res.hits || []).map((h) => ({ ...h, id: undefined }))))
        .catch(() => alive && setHits([]))
        .finally(() => alive && setBusy(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, ops]);

  const openHit = async (h) => {
    try {
      const f = await ops.openPath(h.path);
      dispatch({ type: 'file/open', id: f.id });
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <div className="side-head">
        全文搜索
        <div className="spacer" />
        <span>{busy ? '…' : hits.length}</span>
      </div>
      <div className="side-body">
        <div style={{ padding: '2px 6px 8px' }}>
          <input
            autoFocus
            placeholder="在工作区中搜索…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: '100%', fontSize: 11.5, padding: '5px 8px' }}
          />
        </div>
        {hits.map((h, i) => (
          <div
            key={i}
            className="file-row"
            style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
            onClick={() => openHit(h)}
          >
            <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>
              {h.path}:{h.line}
            </span>
            <span style={{ fontSize: 11, color: 'var(--fg-mute)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
              {h.text}
            </span>
          </div>
        ))}
        {q && !hits.length && <div className="ins-empty" style={{ padding: 12 }}>没有匹配。</div>}
      </div>
    </>
  );
}

export function MemorySideView({ onOpenMemory }) {
  const { state, dispatch } = useApp();
  const [kind, setKind] = useState('all');
  const list = state.memories
    .filter((m) => kind === 'all' || m.kind === kind)
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);

  return (
    <>
      <div className="side-head">
        记忆库
        <div className="spacer" />
        <button onClick={onOpenMemory} title="打开完整记忆库">
          <IconBrain size={13} />
        </button>
      </div>
      <div className="side-body">
        <div className="mem-tabs" style={{ padding: '2px 4px 8px', flexWrap: 'wrap' }}>
          <button className={`mem-tab ${kind === 'all' ? 'active' : ''}`} onClick={() => setKind('all')}>
            全部 {state.memories.length}
          </button>
          {KIND_LIST.map((k) => (
            <button key={k} className={`mem-tab ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
              <span className="dot" style={{ background: KINDS[k].color }} />
              {KINDS[k].label}
            </button>
          ))}
        </div>
        {list.map((m) => (
          <div
            key={m.id}
            className="mem-card"
            style={{ padding: '7px 9px', marginBottom: 6 }}
            onClick={onOpenMemory}
          >
            <span className="bar" style={{ background: KINDS[m.kind].color }} />
            <div className="top">
              <span className="mem-kind" style={{ color: KINDS[m.kind].color }}>
                {KINDS[m.kind].label}
              </span>
              {m.pinned && <span style={{ fontSize: 10 }}>📌</span>}
              <span className="stars" style={{ marginLeft: 'auto' }}>
                {'★'.repeat(m.importance)}
                <span className="off">{'★'.repeat(5 - m.importance)}</span>
              </span>
            </div>
            <div className="text" style={{ fontSize: 11.5 }}>
              {m.text}
            </div>
            <div className="meta">
              <span>用过 {m.uses} 次</span>
              <button
                className="btn sm danger"
                style={{ marginLeft: 'auto', padding: '1px 5px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'mem/delete', id: m.id });
                }}
              >
                删
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function SessionsView() {
  const { state, ops } = useApp();
  const toast = useToast();
  const sessions = [...(state.chatSessions || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const episodes = state.memories.filter((m) => m.kind === 'episode');
  return (
    <>
      <div className="side-head">
        会话历史
        <div className="spacer" />
        <button
          type="button"
          title="新建会话"
          onClick={() => {
            ops.newChatSession();
            toast('已新建会话', 'ok');
          }}
        >
          <IconPlus size={13} />
        </button>
        <span>{sessions.length}</span>
      </div>
      <div className="side-body">
        <div className="ins-empty" style={{ padding: '4px 8px 12px' }}>
          可新建 / 切换 / 重命名 / 删除会话；对话保存在工作区 <code>.cortex/sessions</code>。
        </div>
        {sessions.map((s) => {
          const tok = (s.tokenUsage?.prompt || 0) + (s.tokenUsage?.completion || 0);
          const active = s.id === state.activeSessionId;
          return (
            <div key={s.id} className={`sessions-item ${active ? 'active' : ''}`}>
              <button type="button" className="sessions-item-main" onClick={() => ops.switchChatSession(s.id)}>
                <b>{s.title || '未命名'}</b>
                <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--fg-mute)' }}>
                  {new Date(s.updatedAt || s.createdAt).toLocaleString('zh-CN')}
                  {tok ? ` · ${tok.toLocaleString()} tok` : ''}
                  {` · ${(s.messages || []).length} 条`}
                </div>
              </button>
              <div className="sessions-item-actions">
                <button
                  type="button"
                  title="重命名"
                  onClick={() => {
                    const name = prompt('会话名称', s.title || '');
                    if (name == null) return;
                    ops.renameChatSession(s.id, name.trim() || '未命名会话');
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => {
                    if (!confirm(`删除会话「${s.title || '未命名'}」？`)) return;
                    ops.deleteChatSession(s.id);
                  }}
                >
                  <IconTrash size={11} />
                </button>
              </div>
            </div>
          );
        })}
        {!sessions.length && <div className="ins-empty" style={{ padding: 12 }}>还没有会话。</div>}

        <div className="side-head" style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          情节记忆归档
          <div className="spacer" />
          <span>{episodes.length}</span>
        </div>
        <div className="ins-empty" style={{ padding: '4px 8px 12px' }}>
          点对话面板 ✦ 可将当前会话压缩为情节记忆。
        </div>
        {episodes
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((m) => (
            <div key={m.id} className="sessions-item">
              <b>{new Date(m.createdAt).toLocaleString('zh-CN')}</b>
              <div style={{ marginTop: 4 }}>{m.text}</div>
            </div>
          ))}
      </div>
    </>
  );
}

export default function SidePanel({ view, onOpenMemory, onCollapse }) {
  return (
    <div className="sidebar">
      {onCollapse && (
        <button type="button" className="side-fold" title="收起侧栏 (Ctrl+B)" onClick={onCollapse}>
          <IconChevronLeft size={14} />
        </button>
      )}
      {view === 'files' && <FilesView />}
      {view === 'search' && <SearchView />}
      {view === 'memory' && <MemorySideView onOpenMemory={onOpenMemory} />}
      {view === 'sessions' && <SessionsView />}
      {view === 'none' && null}
    </div>
  );
}
