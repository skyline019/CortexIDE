import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Terminal from './Terminal.jsx';
import { IconPlus, IconClose, IconPlug, IconSearch, IconTrash } from './Icons.jsx';
import { useToast } from '../state/toast.jsx';

const HISTORY_KEY = 'cortex-ide:term-history:v2';
const TABS_KEY = 'cortex-ide:term-tabs:v1';

const loadHistory = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    // 兼容 v1（纯字符串数组）
    return raw.map((x) => (typeof x === 'string' ? { c: x, t: Date.now(), s: '旧记录' } : x));
  } catch {
    return [];
  }
};

const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const fmtTime = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 多标签终端
 *
 * - 每个标签一个独立的 WebSocket + xterm 实例（切走只是 display:none，会话不中断）
 * - 命令历史三视图：本会话 / 按会话分组的会话时间轴 / 系统 ~/.bash_history
 * - 「SSH」标签：连到远端 shell（ssh user@host），日志同样落在历史里
 */
export default function TerminalTabs({ height = 208 }) {
  const toast = useToast();
  const [tabs, setTabs] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
      if (Array.isArray(saved) && saved.length) return saved;
    } catch {
      /* ignore */
    }
    return [{ id: uid(), title: '本地 shell', kind: 'local', status: 'connecting', born: Date.now() }];
  });
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [history, setHistory] = useState(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [view, setView] = useState('session'); // session | timeline | system
  const [hq, setHq] = useState('');
  const [sysHist, setSysHist] = useState(null);
  const pendingCmd = useRef({});

  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => ({ ...t, status: 'connecting' }))));
    } catch {
      /* ignore */
    }
  }, [tabs]);

  const persist = (next) => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next.slice(0, 500)));
    } catch {
      /* ignore */
    }
  };

  const commitHistory = useCallback((cmd) => {
    setHistory((prev) => {
      const tab = tabs.find((t) => t.id === activeId);
      const session = tab ? `${tab.title}${tab.born ? ` · ${fmtTime(tab.born)}` : ''}` : '未命名会话';
      const next = [{ c: cmd, t: Date.now(), s: session }, ...prev.filter((e) => e.c !== cmd)].slice(0, 500);
      persist(next);
      return next;
    });
  }, [tabs, activeId]);

  const addTab = (kind = 'local', extra = {}) => {
    const tab = {
      id: uid(),
      title: extra.title || (kind === 'ssh' ? 'SSH' : `shell ${tabs.length + 1}`),
      kind,
      status: 'connecting',
      initialCommand: extra.initialCommand,
      born: Date.now(),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    return tab;
  };

  const closeTab = (id) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      const safe = next.length ? next : [{ id: uid(), title: '本地 shell', kind: 'local', status: 'connecting', born: Date.now() }];
      if (id === activeId) setActiveId(safe[safe.length - 1].id);
      return safe;
    });
    delete pendingCmd.current[id];
  };

  const connectSsh = () => {
    const host = window.prompt('SSH 目标（例如 user@server 或 user@server -p 2222）：', '');
    if (!host || !host.trim()) return;
    const clean = host.trim();
    // 简单校验，避免注入别的命令
    if (!/^[\w.@:-]+(\s+-p\s+\d{1,5})?$/.test(clean)) {
      toast('主机名格式不对，只允许 user@host / IP，可选 -p 端口', 'err');
      return;
    }
    addTab('ssh', { title: `SSH ${clean.split(/\s+/)[0]}`, initialCommand: `ssh ${clean}` });
    toast(`正在连接 ${clean}`, 'ok');
  };

  // 远程工作区面板要求「在终端里打开」时，新开一个 ssh 标签
  useEffect(() => {
    const onSsh = (e) => {
      const { target, port, root } = e.detail || {};
      if (!target) return;
      const cmd = `ssh -p ${Number(port) || 22} ${target}${root ? ` -t 'cd ${root.replace(/'/g, "'\\''")} && exec $SHELL -l'` : ''}`;
      addTab('ssh', { title: `SSH ${target}`, initialCommand: cmd });
    };
    window.addEventListener('cortex:term-new-ssh', onSsh);
    return () => window.removeEventListener('cortex:term-new-ssh', onSsh);
  });

  const runFromHistory = (cmd) => {
    pendingCmd.current[activeId] = null;
    window.dispatchEvent(new CustomEvent('cortex:term-input', { detail: { tabId: activeId, data: cmd + '\r' } }));
    commitHistory(cmd);
    setShowHistory(false);
  };

  // 系统 shell 历史：打开面板时懒加载一次
  useEffect(() => {
    if (!showHistory || view !== 'system' || sysHist) return;
    fetch('/api/exec/shell-history?limit=300')
      .then((r) => r.json())
      .then((j) => setSysHist(j))
      .catch(() => setSysHist({ items: [], files: [] }));
  }, [showHistory, view, sysHist]);

  const filtered = useMemo(() => {
    const q = hq.trim().toLowerCase();
    const pool = view === 'system' ? (sysHist?.items || []).map((x) => ({ c: x.cmd, t: x.at, s: x.source })) : history;
    if (!q) return pool;
    return pool.filter((e) => e.c.toLowerCase().includes(q));
  }, [history, hq, view, sysHist]);

  // 时间轴：按会话分组（会话内按时间倒序）
  const groups = useMemo(() => {
    if (view !== 'timeline') return [];
    const map = new Map();
    for (const e of filtered) {
      if (!map.has(e.s)) map.set(e.s, []);
      map.get(e.s).push(e);
    }
    return [...map.entries()].map(([session, items]) => ({ session, items: items.slice(0, 40), at: items[0]?.t || 0 }));
  }, [filtered, view]);

  return (
    <div className="term-tabs">
      <div className="term-tabbar">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`term-tab ${t.id === activeId ? 'active' : ''} ${t.status}`}
            onClick={() => setActiveId(t.id)}
            title={`${t.title} · ${t.status}`}
          >
            <span className={`tdot ${t.status}`} />
            <span className="tt-name">{t.title}</span>
            {tabs.length > 1 && (
              <button
                className="tt-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <IconClose size={9} />
              </button>
            )}
          </div>
        ))}
        <button className="term-add" title="新建终端" onClick={() => addTab('local')}>
          <IconPlus size={11} />
        </button>
        <button className="term-add" title="SSH 远程会话" onClick={connectSsh}>
          <IconPlug size={11} />
        </button>
        <div className="spacer" />
        <button className={`term-btn ${showHistory ? 'on' : ''}`} onClick={() => setShowHistory((v) => !v)} title="命令历史">
          <IconSearch size={10} /> 历史 {history.length}
        </button>
        {history.length > 0 && (
          <button
            className="term-btn"
            title="清空本应用的历史（不动 ~/.bash_history）"
            onClick={() => {
              setHistory([]);
              try {
                localStorage.removeItem(HISTORY_KEY);
              } catch {
                /* ignore */
              }
            }}
          >
            <IconTrash size={10} />
          </button>
        )}
      </div>

      {showHistory && (
        <div className="term-history">
          <div className="th-views">
            {[
              ['session', '本会话'],
              ['timeline', '时间轴'],
              ['system', '系统'],
            ].map(([id, label]) => (
              <button key={id} className={`th-view ${view === id ? 'on' : ''}`} onClick={() => setView(id)}>
                {label}
              </button>
            ))}
            <span className="grow" />
            {view === 'system' && <span className="th-note">{sysHist ? sysHist.files?.join(' ') || '未找到历史文件' : '读取中…'}</span>}
          </div>
          <input autoFocus placeholder="搜索历史命令…" value={hq} onChange={(e) => setHq(e.target.value)} />
          <div className="th-list">
            {view === 'timeline' ? (
              groups.length ? (
                groups.map((g) => (
                  <div key={g.session} className="th-group">
                    <div className="th-group-head">
                      {g.session} · {g.items.length} 条
                    </div>
                    {g.items.map((e, i) => (
                      <button key={`${g.session}-${i}`} className="th-item" onClick={() => runFromHistory(e.c)} title="点击在当前终端重新执行">
                        <span className="th-time">{fmtTime(e.t)}</span>
                        <code>{e.c}</code>
                      </button>
                    ))}
                  </div>
                ))
              ) : (
                <div className="th-empty">还没有历史命令</div>
              )
            ) : filtered.length ? (
              filtered.slice(0, 80).map((e, i) => (
                <button key={`${e.c}-${i}`} className="th-item" onClick={() => runFromHistory(e.c)} title="点击在当前终端重新执行">
                  {view === 'system' && <span className="th-time">{fmtTime(e.t) || '—'}</span>}
                  <code>{e.c}</code>
                </button>
              ))
            ) : (
              <div className="th-empty">{view === 'system' ? '系统历史为空' : '还没有历史命令'}</div>
            )}
          </div>
        </div>
      )}

      <div className="term-stack">
        {tabs.map((t) => (
          <Terminal
            key={t.id}
            tabId={t.id}
            height={height}
            visible={t.id === activeId}
            initialCommand={t.initialCommand}
            onCommand={commitHistory}
            onStatus={(st, info) => {
              setTabs((prev) => {
                const locals = prev.filter((x) => x.kind === 'local');
                const idx = locals.findIndex((x) => x.id === t.id);
                const shellName = info?.shell ? info.shell.split('/').pop() : '';
                return prev.map((x) =>
                  x.id === t.id
                    ? {
                        ...x,
                        status: st,
                        // 同名 shell 加序号，标签才分得清
                        title: x.kind === 'local' && shellName ? `${shellName}${idx > 0 ? ` ${idx + 1}` : ''}` : x.title,
                      }
                    : x,
                );
              });
            }}
          />
        ))}
      </div>
    </div>
  );
}
