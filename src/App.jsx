import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadIndex, ensureIndex, warmup } from './lib/retrieval.js';
import { useApp, summarizeSession, persistState } from './state/store.jsx';
import { useToast } from './state/toast.jsx';
import SidePanel from './components/SidePanel.jsx';
import EditorArea from './components/EditorArea.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import MemoryModal from './components/MemoryModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import RemoteModal from './components/RemoteModal.jsx';
import CommandApproval from './components/CommandApproval.jsx';
import ExternalChanges from './components/ExternalChanges.jsx';
import SkillsModal from './components/SkillsModal.jsx';
import WorkflowStudio from './components/WorkflowStudio.jsx';
import WelcomeScreen from './components/WelcomeScreen.jsx';
import { connectWatch } from './lib/watchClient.js';
import { loadRecentWorkspaces, rememberWorkspace } from './lib/recentWorkspaces.js';
import {
  IconFiles,
  IconSearch,
  IconBrain,
  IconHistory,
  IconGear,
  IconCmd,
  IconChat,
  IconFlow,
  IconBook,
  IconPanelLeft,
  IconPanelRight,
  IconMore,
  IconChevronRight,
  IconPlug,
} from './components/Icons.jsx';
import { uid } from './lib/vfs.js';
import { loadLayoutPrefs, saveLayoutPrefs } from './lib/layoutPrefs.js';

function ActivityBar({ view, onSelect, onOpenMemory, memoryCount }) {
  const items = [
    ['files', '资源管理器', IconFiles],
    ['search', '搜索', IconSearch],
    ['memory', '记忆库', IconBrain],
    ['sessions', '会话', IconHistory],
    // 这两项不是侧栏视图，点开是全屏面板（画布和长文本都需要空间）
    ['workflow', '工作流', IconFlow],
    ['skills', '技能 · 提示词', IconBook],
  ];
  return (
    <div className="activitybar">
      {items.map(([id, label, Icon]) => (
        <button
          key={id}
          className={`ab-btn ${view === id ? 'active' : ''}`}
          title={label}
          onClick={() => onSelect(id)}
        >
          <Icon size={17} />
          {id === 'memory' && memoryCount ? <span className="badge">{memoryCount > 99 ? '99' : memoryCount}</span> : null}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button className="ab-btn" title="打开完整记忆库" onClick={onOpenMemory}>
        <IconCmd size={17} />
      </button>
      <button className="ab-btn" title="设置" onClick={() => onSelect('settings')}>
        <IconGear size={17} />
      </button>
    </div>
  );
}

/** 用户切换：不同用户记忆互相隔离（服务端按 x-cortex-user 过滤） */
function UserSwitch() {
  const { state, ops } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const users = (state.backend.users.length ? state.backend.users : [{ id: 'local', memories: state.memories.length }]).filter(
    (u) => !String(u.id).startsWith('__'), // 压测用户不进 UI
  );

  const pick = async (id) => {
    if (id === state.settings.userId) return setOpen(false);
    setBusy(true);
    try {
      const n = await ops.switchUser(id);
      toast(`已切换到「${id}」，载入 ${n} 条记忆`, 'mem');
    } catch (err) {
      toast(`切换失败：${err.message}`, 'err');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="user-switch">
      <button className="tb-btn" onClick={() => setOpen((v) => !v)} title="切换用户（记忆隔离）">
        <span className="user-avatar">{(state.settings.userId || 'l')[0].toUpperCase()}</span>
        {state.settings.userId}
      </button>
      {open && (
        <>
          <div className="user-backdrop" onClick={() => setOpen(false)} />
          <div className="user-menu">
            <div className="user-menu-head">切换用户</div>
            {users.map((u) => (
              <button
                key={u.id}
                className={`user-item ${u.id === state.settings.userId ? 'on' : ''}`}
                disabled={busy}
                onClick={() => pick(u.id)}
              >
                <span className="user-avatar sm">{u.id[0].toUpperCase()}</span>
                <span>{u.id}</span>
                <span className="user-count">{u.memories ?? 0}</span>
              </button>
            ))}
            <div className="user-menu-tip">
              每个用户的记忆独立存放在 <code>.cortex/memory.db</code>，服务端 SQL 层强制隔离。
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MoreMenu({ open, onClose, items }) {
  if (!open) return null;
  return (
    <>
      <div className="chrome-backdrop" onClick={onClose} />
      <div className="chrome-menu" role="menu">
        {items.map((it) =>
          it.sep ? (
            <div key={it.id} className="chrome-menu-sep" />
          ) : (
            <button
              key={it.id}
              type="button"
              className="chrome-menu-item"
              role="menuitem"
              onClick={() => {
                onClose();
                it.run?.();
              }}
            >
              {it.icon ? <it.icon size={14} /> : null}
              <span>{it.label}</span>
              {it.hint ? <kbd>{it.hint}</kbd> : null}
            </button>
          ),
        )}
      </div>
    </>
  );
}

export default function App() {
  const { state, dispatch, ops, stateRef } = useApp();
  const toast = useToast();
  const layout0 = useRef(loadLayoutPrefs()).current;
  const [view, setView] = useState('files');
  const [sidebarOpen, setSidebarOpen] = useState(layout0.sidebarOpen !== false);
  const [chatOpen, setChatOpen] = useState(layout0.chatOpen !== false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, setBackend] = useState(null);
  const [extChanges, setExtChanges] = useState([]); // 外部改动合并预览
  const isDesktop = typeof document !== 'undefined' && document.documentElement.classList.contains('is-desktop');
  const [showWelcome, setShowWelcome] = useState(() => isDesktop || loadRecentWorkspaces().length === 0);
  const watchStop = useRef(null);
  const extBuf = useRef([]);
  const extTimer = useRef(null);

  const toggleSidebar = useCallback((next) => {
    setSidebarOpen((v) => {
      const n = typeof next === 'boolean' ? next : !v;
      saveLayoutPrefs({ sidebarOpen: n });
      return n;
    });
  }, []);
  const toggleChat = useCallback((next) => {
    setChatOpen((v) => {
      const n = typeof next === 'boolean' ? next : !v;
      saveLayoutPrefs({ chatOpen: n });
      return n;
    });
  }, []);

  /** 连接成功后：记忆库 + 文件监听 + 尝试打开入口文件 */
  const afterWorkspaceReady = useCallback(async () => {
    const ws = stateRef.current.workspace.root;
    if (ws) rememberWorkspace(ws);
    ops.hydrateExecLog();
    const memo = await ops.connectMemory({ user: stateRef.current.settings.userId, workspace: ws });
    if (!memo) dispatch({ type: 'backend/set', patch: { available: false } });

    watchStop.current?.();
    watchStop.current = connectWatch({
      onEvents: (events) => {
        ops.applyDiskEvents(events, {
          onDiff: (d) => {
            if (!d.auto) return;
            extBuf.current = [...extBuf.current.filter((x) => x.path !== d.path), d];
            clearTimeout(extTimer.current);
            extTimer.current = setTimeout(() => {
              const items = extBuf.current;
              extBuf.current = [];
              if (items.length === 1) toast(`外部改动已同步：${items[0].path}`, 'ok');
              else if (items.length > 1) {
                toast(`外部改动已同步 ${items.length} 个文件`, 'ok');
                setExtChanges(items);
              }
            }, 700);
          },
        });
      },
      onHello: (msg) => {
        dispatch({ type: 'ws/set', patch: { watchRoot: msg.root, watchMode: msg.mode } });
        ops.bindWatchSender((dirs) => watchStop.current?.send({ type: 'sub', dirs }));
        watchStop.current?.send({ type: 'sub', dirs: stateRef.current.workspace.subDirs || [] });
      },
      onMode: (msg) => dispatch({ type: 'ws/set', patch: { watchMode: msg.mode } }),
      onStatus: (st) => dispatch({ type: 'ws/set', patch: { watch: st } }),
    });

    const entries = stateRef.current.workspace.entries || [];
    const first = ['README.md', 'src/App.jsx', 'package.json', 'index.html'].find((p) => entries.some((e) => e.path === p));
    const hasRealTab = stateRef.current.files.some((f) => f.real);
    if (first && !hasRealTab) {
      try {
        await ops.openPath(first);
      } catch {
        /* ignore */
      }
    }
  }, [dispatch, ops, stateRef, toast]);

  /* 启动：索引预热；桌面版等欢迎页选目录，浏览器版自动连当前目录 */
  useEffect(() => {
    let alive = true;
    (async () => {
      loadIndex();
      warmup(stateRef.current.settings.embedProvider).then(() =>
        ensureIndex(stateRef.current.memories, { provider: stateRef.current.settings.embedProvider }),
      );
      if (showWelcome) {
        setBackend('ok');
        return;
      }
      const snap = stateRef.current;
      const ok = await ops.connect({ root: snap.workspace.root || undefined });
      if (!alive) return;
      setBackend(ok ? 'ok' : 'down');
      if (ok) await afterWorkspaceReady();
    })();
    return () => {
      alive = false;
      watchStop.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const archive = useCallback(() => {
    const summary = summarizeSession(state.messages, state.files);
    if (!summary) {
      toast('还没有可归档的对话', 'err');
      return;
    }
    ops.addSession({ id: uid('ses'), ...summary, at: Date.now() });
    const res = ops.addMemories([summary]);
    toast(res.added.length ? '会话已归档为情节记忆' : '会话已归档', 'mem');
  }, [state.messages, state.files, ops, toast]);

  const backup = useCallback(() => {
    const payload = persistState(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cortex-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出工作区备份');
  }, [state, toast]);

  const select = (v) => {
    if (v === 'settings') {
      setSettingsOpen(true);
      return;
    }
    if (v === 'workflow') {
      setWorkflowOpen(true);
      return;
    }
    if (v === 'skills') {
      setSkillsOpen(true);
      return;
    }
    if (view === v && sidebarOpen) {
      toggleSidebar(false);
      return;
    }
    setView(v);
    toggleSidebar(true);
  };

  const openRecentWorkspace = useCallback(
    async (root) => {
      if (!root) return;
      setShowWelcome(false);
      const ok = await ops.connect({ root, mode: 'real' });
      if (!ok) {
        toast('无法打开该工作区', 'err');
        setShowWelcome(true);
        return;
      }
      rememberWorkspace(root);
      await afterWorkspaceReady();
      toast(`已打开 ${String(root).split(/[/\\]/).pop()}`, 'ok');
    },
    [ops, toast, afterWorkspaceReady],
  );

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const recent = loadRecentWorkspaces();
        const item = recent[Number(e.key) - 1];
        if (item?.path) {
          e.preventDefault();
          openRecentWorkspace(item.path);
          return;
        }
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setShowWelcome(true);
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (state.activeFileId) {
          dispatch({ type: 'file/save', id: state.activeFileId });
          toast('已保存');
        }
      } else if (mod && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMemoryOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggleChat();
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (memoryOpen) setMemoryOpen(false);
        else if (remoteOpen) setRemoteOpen(false);
        else if (skillsOpen) setSkillsOpen(false);
        else if (workflowOpen) setWorkflowOpen(false);
        else if (showWelcome && state.workspace.connected) setShowWelcome(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    dispatch,
    state.activeFileId,
    state.workspace.connected,
    toast,
    paletteOpen,
    settingsOpen,
    memoryOpen,
    remoteOpen,
    skillsOpen,
    workflowOpen,
    showWelcome,
    toggleChat,
    toggleSidebar,
    openRecentWorkspace,
  ]);

  const activeFile = state.files.find((f) => f.id === state.activeFileId);
  const pathLabel =
    state.workspace.mode === 'real'
      ? `${state.workspace.name || '工作区'}${activeFile ? ` / ${activeFile.path}` : ''}`
      : activeFile?.path || '无文件';
  const modelLabel =
    state.settings.mode === 'api' ? `API · ${state.settings.model}` : '本地引擎';
  const watchOk = state.workspace.watch === 'connected';

  const moreItems = [
    {
      id: 'workspace',
      label: '切换工作区…',
      icon: IconFiles,
      hint: 'Ctrl+O',
      run: () => setShowWelcome(true),
    },
    {
      id: 'recent1',
      label: '打开最近工作区 1…9',
      icon: IconHistory,
      hint: 'Ctrl+1…9',
      run: () => {
        const recent = loadRecentWorkspaces();
        if (!recent[0]) {
          toast('还没有最近工作区', 'err');
          setShowWelcome(true);
          return;
        }
        openRecentWorkspace(recent[0].path);
      },
    },
    {
      id: 'newchat',
      label: '新建 Agent 会话',
      icon: IconChat,
      run: () => {
        ops.newChatSession();
        toggleChat(true);
        toast('已新建会话', 'ok');
      },
    },
    { id: 'workflow', label: '工作流', icon: IconFlow, run: () => setWorkflowOpen(true) },
    { id: 'skills', label: '技能与提示词', icon: IconBook, run: () => setSkillsOpen(true) },
    { id: 'remote', label: 'SSH 远程', icon: IconPlug, run: () => setRemoteOpen(true) },
    { id: 'sep1', sep: true },
    { id: 'archive', label: '归档当前会话', icon: IconHistory, run: archive },
    { id: 'backup', label: '导出工作区备份', run: backup },
    { id: 'sep2', sep: true },
    { id: 'settings', label: '设置', icon: IconGear, run: () => setSettingsOpen(true) },
  ];

  return (
    <div className="app">
      {showWelcome && (
        <WelcomeScreen
          onOpenSettings={() => setSettingsOpen(true)}
          onEntered={async () => {
            setShowWelcome(false);
            setBackend('ok');
            await afterWorkspaceReady();
          }}
        />
      )}
      <header className="titlebar">
        <div className="brand" title="Cortex Agent IDE">
          <img className="brand-logo-img" src="/brand.svg" width={20} height={20} alt="" />
          <span className="brand-name">Cortex</span>
        </div>
        <button
          type="button"
          className={`path-chip ${state.workspace.connected ? '' : 'warn'}`}
          title="点击查看状态"
          onClick={() => setStatusOpen((v) => !v)}
        >
          <span className="dot" />
          <span className="path-text">{pathLabel}</span>
        </button>
        <div className="titlebar-spacer" />
        <div className="chrome-actions">
          <button type="button" className="tb-icon" onClick={() => setPaletteOpen(true)} title="命令面板 (Ctrl+K)">
            <IconCmd size={14} />
          </button>
          <button
            type="button"
            className={`tb-icon ${memoryOpen ? 'on' : ''}`}
            onClick={() => setMemoryOpen(true)}
            title="记忆库 (Ctrl+M)"
          >
            <IconBrain size={14} />
            {state.memories.length ? <span className="tb-count">{state.memories.length > 99 ? '99+' : state.memories.length}</span> : null}
          </button>
          <button
            type="button"
            className={`tb-icon ${sidebarOpen ? 'on' : ''}`}
            onClick={() => toggleSidebar()}
            title="侧栏 (Ctrl+B)"
          >
            <IconPanelLeft size={14} />
          </button>
          <button
            type="button"
            className={`tb-icon ${chatOpen ? 'on' : ''}`}
            onClick={() => toggleChat()}
            title="Agent (Ctrl+J)"
          >
            <IconPanelRight size={14} />
          </button>
          <div className="chrome-more-wrap">
            <button type="button" className={`tb-icon ${moreOpen ? 'on' : ''}`} onClick={() => setMoreOpen((v) => !v)} title="更多">
              <IconMore size={14} />
            </button>
            <MoreMenu open={moreOpen} onClose={() => setMoreOpen(false)} items={moreItems} />
          </div>
          <UserSwitch />
        </div>
      </header>

      {statusOpen && (
        <div className="status-strip">
          <span className={`pill ${watchOk ? '' : 'warn'}`}>
            <span className="dot" />
            监听 {watchOk ? (state.workspace.watchMode === 'poll' ? '轮询' : '开') : '关'}
          </span>
          <span className="pill">
            记忆库{' '}
            {state.backend.status?.backend === 'sqlite-vec'
              ? 'sqlite-vec'
              : state.backend.available
                ? '服务端'
                : '本地'}
            {state.backend.status?.total != null ? ` · ${state.backend.status.total}` : ''}
          </span>
          <span className={`pill ${state.settings.mode === 'api' ? '' : 'warn'}`}>
            <span className="dot" />
            {modelLabel}
          </span>
          <span className="pill muted">用户 {state.settings.userId}</span>
          <button type="button" className="status-close" onClick={() => setStatusOpen(false)}>
            收起
          </button>
        </div>
      )}

      <div className="main">
        <ActivityBar
          view={sidebarOpen ? view : 'none'}
          onSelect={select}
          onOpenMemory={() => setMemoryOpen(true)}
          memoryCount={state.memories.length}
        />
        {sidebarOpen && (
          <SidePanel view={view} onOpenMemory={() => setMemoryOpen(true)} onCollapse={() => toggleSidebar(false)} />
        )}
        {!sidebarOpen && (
          <button type="button" className="edge-rail left" title="展开侧栏 (Ctrl+B)" onClick={() => toggleSidebar(true)}>
            <IconChevronRight size={12} />
          </button>
        )}
        <EditorArea
          onOpenWelcome={() => setShowWelcome(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleChat={() => toggleChat(true)}
          onOpenMemory={() => setMemoryOpen(true)}
        />
        {!chatOpen && (
          <button type="button" className="edge-rail right" title="展开 Agent (Ctrl+J)" onClick={() => toggleChat(true)}>
            <IconChat size={13} />
          </button>
        )}
        {chatOpen && (
          <>
            <div
              className="splitter"
              title="拖动调整对话面板宽度"
              onPointerDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = state.settings.chatWidth || 424;
                const move = (ev) => {
                  const w = Math.min(760, Math.max(320, startW - (ev.clientX - startX)));
                  dispatch({ type: 'settings/set', patch: { chatWidth: w } });
                };
                const up = () => {
                  window.removeEventListener('pointermove', move);
                  window.removeEventListener('pointerup', up);
                  document.body.style.cursor = '';
                  document.body.style.userSelect = '';
                };
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
              }}
            />
            <ChatPanel
              width={state.settings.chatWidth || 380}
              onOpenMemory={() => setMemoryOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              onCollapse={() => toggleChat(false)}
            />
          </>
        )}
      </div>

      <CommandApproval />
      {extChanges.length > 0 && (
        <ExternalChanges
          items={extChanges}
          onClose={() => setExtChanges([])}
          onOpenFile={(id) => {
            dispatch({ type: 'file/open', id });
            setExtChanges([]);
          }}
          onRevert={async (it) => {
            const file = state.files.find((f) => f.path === it.path);
            if (!file) return;
            dispatch({ type: 'file/diskSync', id: file.id, content: it.before, before: it.before });
            await ops.writeFile(it.path, it.before, file.id);
            toast(`已回退 ${it.path}`, 'ok');
            setExtChanges((prev) => prev.filter((x) => x.path !== it.path));
          }}
        />
      )}
      {memoryOpen && <MemoryModal onClose={() => setMemoryOpen(false)} />}
      {remoteOpen && <RemoteModal onClose={() => setRemoteOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {skillsOpen && <SkillsModal onClose={() => setSkillsOpen(false)} />}
      {workflowOpen && <WorkflowStudio onClose={() => setWorkflowOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          actions={{
            openMemory: () => setMemoryOpen(true),
            openRemote: () => setRemoteOpen(true),
            openSettings: () => setSettingsOpen(true),
            openWelcome: () => setShowWelcome(true),
            openSessions: () => {
              setView('sessions');
              toggleSidebar(true);
            },
            newChat: () => {
              ops.newChatSession();
              toggleChat(true);
              toast('已新建会话', 'ok');
            },
            switchChat: (id) => {
              ops.switchChatSession(id);
              toggleChat(true);
            },
            recentWorkspaces: loadRecentWorkspaces(),
            openRecentWorkspace,
            archive,
            backup,
            toggleChat: () => toggleChat(),
            toggleSidebar: () => toggleSidebar(),
            runCommand: async () => {
              const cmd = window.prompt('要执行的命令（必须命中白名单，例如 npm run lint）：', 'npm run lint');
              if (!cmd) return;
              const decision = await ops.requestApproval({ cmd, reason: '你在命令面板里手动发起的执行' });
              if (decision === 'deny') return;
              const res = await ops.execCommand(cmd);
              if (res.blocked || res.error) toast(`已拒绝：${res.error}`, 'err');
              else toast(`执行完成，退出码 ${res.code}`, res.code === 0 ? 'ok' : 'err');
            },
            switchUser: () => {
              const id = window.prompt(`当前用户：${state.settings.userId}\n切换到（或新建）用户 ID：`, state.settings.userId === 'local' ? 'alice' : 'local');
              if (id) ops.switchUser(id.trim()).then((n) => toast(`已切换到 ${id}，${n} 条记忆`, 'mem'));
            },
            syncMemory: async () => {
              await ops.syncMemories(state.memories);
              toast('已同步到服务端记忆库', 'mem');
            },
          }}
        />
      )}
    </div>
  );
}
