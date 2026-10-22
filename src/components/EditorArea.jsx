import React, { useMemo, useState } from 'react';
import { useApp, useDerived } from '../state/store.jsx';
import { LANG_LABEL, langOf } from '../lib/vfs.js';
import CodeEditor from './CodeEditor.jsx';
import PreviewPane from './preview/PreviewPane.jsx';
import { previewKind, KIND_LABEL } from '../lib/preview-kind.js';
import TerminalTabs from './TerminalTabs.jsx';
import { IconTerminal, IconSave, IconPlus, IconSync } from './Icons.jsx';
import DiffModal from './DiffView.jsx';
import ExecPanel from './ExecPanel.jsx';
import EmptyHome from './EmptyHome.jsx';
import { diffLines } from '../lib/diff.js';
import { useToast } from '../state/toast.jsx';

function Tabs() {
  const { state, dispatch, ops } = useApp();
  const { tabs } = useDerived();
  return (
    <div className="tabbar">
      {tabs.map((f) => (
        <div
          key={f.id}
          className={`tab ${state.activeFileId === f.id ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'file/open', id: f.id })}
          onAuxClick={(e) => {
            if (e.button === 1) dispatch({ type: 'file/close', id: f.id });
          }}
        >
          <span>{f.path.split('/').pop()}</span>
          {(f.ext || f.stale) && <span className="tab-ext" title={f.stale ? '磁盘有冲突' : '已同步外部改动'} />}
          {f.dirty && <span className="dirty" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)' }} />}
          <button
            className="close"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'file/close', id: f.id });
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="icon-btn"
        style={{ alignSelf: 'center', marginLeft: 4 }}
        title="新建文件"
        onClick={() => {
          const name = prompt('新文件路径，例如 src/utils/format.js');
          if (!name) return;
          if (state.files.some((f) => f.path === name)) return;
          const file = ops.writeFile(name.trim(), '');
          ops.openFile(file.id);
        }}
      >
        <IconPlus size={13} />
      </button>
    </div>
  );
}

function BottomPanel() {
  const { state } = useApp();
  const [tab, setTab] = useState('terminal');
  // 桌面版默认收起底部面板，给编辑器留白；一键展开功能不减
  const [open, setOpen] = useState(() => !document.documentElement.classList.contains('is-desktop'));
  const logs = useMemo(() => {
    const out = [];
    for (const m of state.messages) {
      for (const s of m.steps || []) out.push({ kind: s.kind, title: s.title, detail: s.detail, ts: s.at });
    }
    return out.slice(-60).reverse();
  }, [state.messages]);

  const memLogs = useMemo(() => [...state.memories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40), [state.memories]);

  if (!open) {
    return (
      <div className="bottom-panel">
        <div className="bp-head">
          <button className="bp-tab" onClick={() => setOpen(true)}>
            ▴ 展开面板
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bottom-panel">
      <div className="bp-head">
        <IconTerminal size={12} />
        <button className={`bp-tab ${tab === 'terminal' ? 'active' : ''}`} onClick={() => setTab('terminal')}>
          终端
        </button>
        <button className={`bp-tab ${tab === 'timeline' ? 'active' : ''}`} onClick={() => setTab('timeline')}>
          Agent 时间线
        </button>
        <button className={`bp-tab ${tab === 'memory' ? 'active' : ''}`} onClick={() => setTab('memory')}>
          记忆写入
        </button>
        <button className={`bp-tab ${tab === 'exec' ? 'active' : ''}`} onClick={() => setTab('exec')}>
          命令执行 {state.execLog.length ? `(${state.execLog.length})` : ''}
        </button>
        <button className={`bp-tab ${tab === 'tokens' ? 'active' : ''}`} onClick={() => setTab('tokens')}>
          Token
        </button>
        <button className={`bp-tab ${tab === 'stats' ? 'active' : ''}`} onClick={() => setTab('stats')}>
          统计
        </button>
        <div style={{ flex: 1 }} />
        <button className="bp-tab" onClick={() => setOpen(false)}>
          ▾ 收起
        </button>
      </div>
      <div style={{ display: tab === 'terminal' ? 'block' : 'none' }}>
        <TerminalTabs />
      </div>
      <div className="bp-body" style={{ display: tab === 'terminal' ? 'none' : 'block' }}>
        {tab === 'timeline' &&
          (logs.length ? (
            logs.map((l, i) => (
              <div key={i} className={`log-line ${l.kind}`}>
                <span className="t">{new Date(l.ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span style={{ minWidth: 58, color: 'var(--fg-mute)' }}>{String(l.kind).toUpperCase()}</span>
                <span>{l.title}</span>
                {l.detail && <span style={{ color: 'var(--fg-mute)' }}>— {l.detail}</span>}
              </div>
            ))
          ) : (
            <div className="log-line">等待 Agent 运行…</div>
          ))}
        {tab === 'memory' &&
          (memLogs.length ? (
            memLogs.map((m) => (
              <div key={m.id} className="log-line memory">
                <span className="t">{new Date(m.updatedAt).toLocaleDateString('zh-CN')}</span>
                <span style={{ minWidth: 58 }}>{m.kind.toUpperCase()}</span>
                <span style={{ color: 'var(--fg-dim)' }}>{m.text}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--fg-mute)' }}>★{m.importance} · 用{m.uses}次</span>
              </div>
            ))
          ) : (
            <div className="log-line">还没有记忆。</div>
          ))}
        {tab === 'exec' && <ExecPanel />}
        {tab === 'tokens' && (
          <>
            {(() => {
              const cur = (state.chatSessions || []).find((s) => s.id === state.activeSessionId);
              const sesIn = cur?.tokenUsage?.prompt || 0;
              const sesOut = cur?.tokenUsage?.completion || 0;
              const allIn = state.stats.promptTokens || 0;
              const allOut = state.stats.completionTokens || 0;
              return (
                <div className="tok-panel">
                  <div className="tok-card">
                    <div className="k">本会话 · 输入</div>
                    <div className="v">{sesIn.toLocaleString()}</div>
                  </div>
                  <div className="tok-card">
                    <div className="k">本会话 · 输出</div>
                    <div className="v">{sesOut.toLocaleString()}</div>
                  </div>
                  <div className="tok-card">
                    <div className="k">本会话 · 合计</div>
                    <div className="v">{(sesIn + sesOut).toLocaleString()}</div>
                  </div>
                  <div className="tok-card">
                    <div className="k">全局累计 · 输入</div>
                    <div className="v">{allIn.toLocaleString()}</div>
                  </div>
                  <div className="tok-card">
                    <div className="k">全局累计 · 输出</div>
                    <div className="v">{allOut.toLocaleString()}</div>
                  </div>
                  <div className="tok-card">
                    <div className="k">Agent 回合</div>
                    <div className="v">{state.stats.turns || 0}</div>
                  </div>
                </div>
              );
            })()}
            <div className="log-line">
              <span className="t">NOTE</span> 数字来自上游 usage（真实计费口径）；压缩徽标前的 ≈ 仍是估算。
            </div>
          </>
        )}
        {tab === 'stats' && (
          <>
            <div className="log-line">
              <span className="t">RETRIEVAL</span> 共 {state.stats.retrievals} 次检索 · 命中 {state.stats.hits} 条记忆
            </div>
            <div className="log-line">
              <span className="t">TURNS</span> {state.stats.turns} 个 Agent 回合 · 写入记忆 {state.stats.memoryWrites} 条
            </div>
            <div className="log-line">
              <span className="t">TOKENS</span> 入 {(state.stats.promptTokens || 0).toLocaleString()} · 出{' '}
              {(state.stats.completionTokens || 0).toLocaleString()}
            </div>
            <div className="log-line">
              <span className="t">EXEC</span> 执行 {state.execLog.filter((e) => !e.blocked).length} 条 ·
              拦截 {state.execLog.filter((e) => e.blocked).length} 条 · 用户 {state.settings.userId} ·
              记忆库 {state.backend.status?.backend || '离线'}
            </div>
            <div className="log-line">
              <span className="t">STORE</span> 记忆 {state.memories.length} 条 · 文件 {state.files.length} 个 · 会话{' '}
              {(state.chatSessions || []).length} / 归档 {state.sessions.length}
            </div>
            <div className="log-line">
              <span className="t">SIZE</span> {(new Blob([JSON.stringify({ f: state.files, m: state.memories, ms: state.messages })]).size / 1024).toFixed(1)} KB
              （已写入 localStorage）
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusBar({ active }) {
  const { state } = useApp();
  return (
    <div className="statusbar">
      <span className={`item ${state.workspace.mode === 'real' && state.workspace.connected ? 'ok' : ''}`}>
        ● {state.workspace.mode === 'real' ? (state.workspace.connected ? `${state.workspace.name}（磁盘）` : '未连接') : '浏览器沙盒'}
      </span>
      <span className="item">记忆 {state.memories.length}</span>
      <span className="item accent">向量 {state.backend.status?.dim || (state.settings.embedProvider === 'lexical' ? 256 : 512)}d</span>
      <span className="item">{state.backend.status?.backend === 'sqlite-vec' ? 'sqlite-vec' : '本地索引'} · {state.settings.userId}</span>
      <span className={`item ${state.workspace.watch === 'connected' ? 'ok' : ''}`}>
        {state.workspace.watch === 'connected' ? '监听中' : '未监听'}
      </span>
      <span className="grow" />
      {active && <span className="item">{active.content.split('\n').length} 行</span>}
      {active && <span className="item">{LANG_LABEL[langOf(active.path)] || 'text'}</span>}
      {active && <span className="item">{active.dirty ? '未保存' : active.real ? '已同步磁盘' : '已同步'}</span>}
      <span className="item" title="全局累计 token（上游 usage）">
        tok {((state.stats.promptTokens || 0) + (state.stats.completionTokens || 0)).toLocaleString()}
      </span>
      <span className="item">{state.settings.mode === 'api' ? `API · ${state.settings.model}` : '本地引擎'}</span>
    </div>
  );
}

/** 磁盘外部改动提示条 */
function ExtBanner({ file }) {
  const { dispatch, ops } = useApp();
  const toast = useToast();
  const [diffOpen, setDiffOpen] = useState(false);
  const ext = file.ext;
  const stat = ext ? diffLines(ext.before, ext.after).stats : null;

  if (file.stale) {
    return (
      <div className="ext-banner warn">
        <IconSync size={12} />
        <span>磁盘上的文件已被外部修改，但你有未保存的编辑，已保留你的版本。</span>
        <span className="spacer" />
        <button
          className="link-btn"
          onClick={async () => {
            const res = await ops.readFile(file.path);
            dispatch({ type: 'file/diskSync', id: file.id, content: res.content, before: file.content });
            toast('已载入磁盘版本');
          }}
        >
          载入磁盘版本
        </button>
        <button className="link-btn" onClick={() => dispatch({ type: 'file/extClear', id: file.id, stale: true })}>
          忽略
        </button>
      </div>
    );
  }
  if (!ext) return null;
  return (
    <>
      <div className="ext-banner">
        <IconSync size={12} />
        <span>
          已同步外部改动 · <code>{file.path}</code>
        </span>
        {stat && (
          <>
            <span className="diff-stat add">+{stat.added}</span>
            <span className="diff-stat del">−{stat.removed}</span>
          </>
        )}
        <span className="spacer" />
        <button className="link-btn" onClick={() => setDiffOpen(true)}>
          查看差异
        </button>
        <button className="link-btn" onClick={() => dispatch({ type: 'file/extClear', id: file.id })}>
          关闭
        </button>
      </div>
      {diffOpen && (
        <DiffModal
          title={file.path}
          path={file.path}
          before={ext.before}
          after={ext.after}
          onClose={() => setDiffOpen(false)}
          actions={
            <button
              className="btn sm"
              onClick={() => {
                dispatch({ type: 'file/diskSync', id: file.id, content: ext.before, before: ext.before });
                ops.writeFile(file.path, ext.before, file.id).then(() => toast('已回退到修改前的版本', 'ok'));
                setDiffOpen(false);
              }}
            >
              回退到此版本
            </button>
          }
        />
      )}
    </>
  );
}

export default function EditorArea({ onOpenWelcome, onOpenPalette, onToggleChat, onOpenMemory }) {
  const { state, dispatch, ops } = useApp();
  const { active } = useDerived();
  const toast = useToast();
  // 视图偏好按文件记：二进制文件默认「阅读」（源码视图对它没意义，内容是空的），
  // 文本文件默认「源码」；Markdown 用户随时可以切过去看渲染效果。
  const [views, setViews] = useState({});
  // 默认可预览类型（图/音视频/PDF/Office/Markdown/CSV）直接进阅读视图，走 /api/fs/raw 渲染，不吃体积上限
  const activeKind = active ? previewKind(active.path, active) : null;
  const naturalPreview = Boolean(activeKind) || Boolean(active?.binary);
  const view = views[active?.id] || (naturalPreview ? 'preview' : 'source');
  const setView = (v) => setViews((m) => ({ ...m, [active?.id]: v }));

  const save = async () => {
    if (!active) return;
    try {
      await ops.saveFile(active.path);
      toast(state.workspace.mode === 'real' ? `已写入磁盘 ${active.path}` : `已保存 ${active.path}`);
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    }
  };

  if (!active) {
    return (
      <div className="center">
        <Tabs />
        <EmptyHome
          onOpenWelcome={onOpenWelcome}
          onOpenPalette={onOpenPalette}
          onToggleChat={onToggleChat}
          onOpenMemory={onOpenMemory}
        />
        <BottomPanel />
        <StatusBar active={null} />
      </div>
    );
  }

  const parts = active.path.split('/');
  const kind = activeKind || previewKind(active.path, active);

  return (
    <div className="center">
      <Tabs />
      <div className="crumbs">
        {parts.map((p, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">›</span>}
            <span style={{ color: i === parts.length - 1 ? 'var(--fg-dim)' : undefined }}>{p}</span>
          </React.Fragment>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {active.real && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--green)' }}>磁盘</span>
          )}
          {active.truncated && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--amber)' }} title="仅加载了前缀以便编辑器可打开">
              已截断
            </span>
          )}
          {active.size > 1024 * 1024 && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--fg-mute)' }}>
              {(active.size / 1024 / 1024).toFixed(1)}MB
            </span>
          )}
          <span>{kind && KIND_LABEL[kind] ? KIND_LABEL[kind] : LANG_LABEL[langOf(active.path)] || '纯文本'}</span>
          {kind && !active.binary && (
            <div className="view-switch" role="group" aria-label="视图切换">
              <button
                type="button"
                className={`view-btn ${view === 'source' ? 'on' : ''}`}
                onClick={() => setView('source')}
                title="按源码编辑"
              >
                源码
              </button>
              <button
                type="button"
                className={`view-btn ${view === 'preview' ? 'on' : ''}`}
                onClick={() => setView('preview')}
                title="按渲染效果查看"
              >
                阅读
              </button>
            </div>
          )}
          {view === 'source' && !active.binary && (
            <button className="btn sm" onClick={save} title="保存（Ctrl/Cmd + S）">
              <IconSave size={11} /> 保存
            </button>
          )}
        </span>
      </div>
      <ExtBanner file={active} />
      <div className={`editor-wrap ${view === 'preview' && kind ? 'previewing' : ''}`}>
        {view === 'preview' && kind ? (
          <PreviewPane file={active} />
        ) : (
          <CodeEditor
            file={active}
            onChange={(content) => dispatch({ type: 'file/update', id: active.id, content })}
          />
        )}
      </div>
      <BottomPanel />
      <StatusBar active={active} />
    </div>
  );
}
