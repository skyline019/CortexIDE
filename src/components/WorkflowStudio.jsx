import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../state/toast.jsx';
import {
  fetchWorkflows,
  fetchWorkflow,
  saveWorkflow,
  deleteWorkflow,
  validateWorkflow,
  runWorkflow,
  fetchRuns,
} from '../lib/promptClient.js';

/**
 * 可视化工作流编辑器 + 运行器。
 *
 * 画布是自己画的（SVG 连线 + 绝对定位节点），没有引 react-flow 之类的库：
 * 需要的只有「拖动 / 连线 / 选中」三件事，引入一个 200KB 的画布框架不值，
 * 而且服务端已经有真引擎（DAG 拓扑 + 分支 + 真磁盘 + 白名单命令 + 真模型），
 * 前端只要把图渲染出来、把事件画上去就够。
 *
 * 数据流向：画布改的是本地 `wf`，点「保存」才落盘到 `.cortex/workflows/<id>.json`；
 * 点「运行」把**当前画布内容**直接发过去跑（不要求先保存，试错更顺）。
 */

const NODE_W = 176;
const NODE_H = 56;

const emptyWf = () => ({
  id: `wf-${Date.now().toString(36)}`,
  name: '新工作流',
  desc: '',
  nodes: [
    { id: 'n1', type: 'input', x: 40, y: 180, data: { label: '输入' } },
    { id: 'n2', type: 'output', x: 420, y: 180, data: { label: '产物', title: '产物' } },
  ],
  edges: [],
});

const portY = (node, port) => {
  const base = node.y + NODE_H / 2;
  if (node.type !== 'branch') return base;
  return port === 'true' ? node.y + NODE_H * 0.32 : port === 'false' ? node.y + NODE_H * 0.7 : base;
};

const edgePath = (a, b, port) => {
  const x1 = a.x + NODE_W;
  const y1 = portY(a, port);
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

export default function WorkflowStudio({ onClose }) {
  const toast = useToast();
  const [types, setTypes] = useState({});
  const [list, setList] = useState([]);
  const [wf, setWf] = useState(emptyWf);
  const [sel, setSel] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [runState, setRunState] = useState('idle'); // idle | running
  const [nodeState, setNodeState] = useState({}); // id → {state, ms, meta}
  const [logs, setLogs] = useState([]);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [runs, setRuns] = useState([]);
  const [link, setLink] = useState(null); // {from, port, x, y}
  const [checking, setChecking] = useState(null);
  const worldRef = useRef(null);
  const dragRef = useRef(null);
  const abortRef = useRef(null);

  const refreshList = useCallback(async () => {
    try {
      const data = await fetchWorkflows();
      setTypes(data.types || {});
      setList(data.workflows || []);
      if (!data.workflows?.length && data.starters?.length) {
        // 第一次打开：把内置模板显示出来（不自动落盘，用户点「载入模板」才用）
        setStarters(data.starters);
      }
    } catch (e) {
      toast(`加载工作流失败：${e.message}`, 'err');
    }
  }, [toast]);

  const [starters, setStarters] = useState([]);

  useEffect(() => {
    refreshList();
    fetchRuns(10)
      .then((r) => setRuns(r.runs || []))
      .catch(() => setRuns([]));
  }, [refreshList]);

  const byId = useMemo(() => new Map(wf.nodes.map((n) => [n.id, n])), [wf.nodes]);
  const selected = sel ? byId.get(sel) : null;
  const selectedType = selected ? types[selected.type] : null;

  const mutate = (fn) => {
    setWf((prev) => {
      const next = fn(prev);
      return next || prev;
    });
    setDirty(true);
  };

  const addNode = (type) => {
    const id = `n${Date.now().toString(36).slice(-4)}`;
    const t = types[type];
    mutate((prev) => ({
      ...prev,
      nodes: [
        ...prev.nodes,
        {
          id,
          type,
          x: 80 + (prev.nodes.length % 5) * 60,
          y: 80 + (prev.nodes.length % 6) * 70,
          data: { label: t?.label || type },
        },
      ],
    }));
    setSel(id);
  };

  const removeNode = (id) => {
    mutate((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => n.id !== id),
      edges: prev.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    setSel(null);
  };

  const connect = (from, port, to) => {
    if (from === to) return;
    mutate((prev) => {
      if (prev.edges.some((e) => e.from === from && e.to === to && e.fromPort === port)) return prev;
      return {
        ...prev,
        edges: [...prev.edges, { id: `e${Date.now().toString(36).slice(-4)}`, from, to, fromPort: port }],
      };
    });
  };

  /* ---------------- 拖动节点 / 拉线 ---------------- */
  const onNodePointerDown = (e, node) => {
    if (e.target.classList.contains('wf-port')) return;
    e.stopPropagation();
    setSel(node.id);
    const rect = worldRef.current.getBoundingClientRect();
    dragRef.current = { id: node.id, dx: e.clientX - rect.left - node.x, dy: e.clientY - rect.top - node.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onCanvasMove = (e) => {
    if (!worldRef.current) return;
    const rect = worldRef.current.getBoundingClientRect();
    if (dragRef.current) {
      const { id, dx, dy } = dragRef.current;
      const x = Math.max(0, Math.round(e.clientX - rect.left - dx));
      const y = Math.max(0, Math.round(e.clientY - rect.top - dy));
      setWf((prev) => ({ ...prev, nodes: prev.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) }));
      setDirty(true);
    }
    if (link) setLink({ ...link, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onCanvasUp = () => {
    dragRef.current = null;
    if (link) setLink(null);
  };

  const startLink = (e, node, port) => {
    e.stopPropagation();
    const rect = worldRef.current.getBoundingClientRect();
    setLink({ from: node.id, port, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const finishLink = (e, node) => {
    if (!link) return;
    e.stopPropagation();
    connect(link.from, link.port, node.id);
    setLink(null);
  };

  /* ---------------- 保存 / 校验 / 运行 ---------------- */
  const save = async () => {
    try {
      const r = await saveWorkflow(wf);
      setWf(r.workflow);
      setDirty(false);
      toast(`已保存 .cortex/workflows/${r.workflow.id}.json`, 'ok');
      refreshList();
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
  };

  const check = async () => {
    try {
      const r = await validateWorkflow(wf);
      setChecking(r);
      toast(r.ok ? `校验通过：${wf.nodes.length} 节点 / ${wf.edges.length} 连线` : `校验失败：${r.errors[0]}`, r.ok ? 'ok' : 'err');
    } catch (e) {
      toast(`校验失败：${e.message}`, 'err');
    }
  };

  const run = async () => {
    if (runState === 'running') {
      abortRef.current?.abort();
      return;
    }
    setRunState('running');
    setNodeState({});
    setLogs([]);
    setOutput('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t0 = performance.now();
    const pushLog = (cls, text) => setLogs((prev) => [...prev, { cls, text, at: Date.now() }]);
    try {
      const res = await runWorkflow({
        workflow: wf,
        input,
        signal: ctrl.signal,
        onEvent: (ev) => {
          if (ev.type === 'run-start') pushLog('', `开始：${ev.nodes} 节点 / ${ev.edges} 连线`);
          else if (ev.type === 'node-start') {
            setNodeState((p) => ({ ...p, [ev.id]: { state: 'run' } }));
            pushLog('', `▶ ${ev.label}`);
          } else if (ev.type === 'node-log') pushLog('', `   ${ev.text}`);
          else if (ev.type === 'node-done') {
            setNodeState((p) => ({ ...p, [ev.id]: { state: 'ok', ms: ev.ms, meta: ev.meta, preview: ev.preview } }));
            pushLog('ok', `✓ ${ev.id} · ${ev.ms}ms · ${ev.chars} 字符`);
          } else if (ev.type === 'node-skip') {
            setNodeState((p) => ({ ...p, [ev.id]: { state: 'skip' } }));
            pushLog('', `↷ ${ev.id} 跳过（${ev.reason}）`);
          } else if (ev.type === 'node-error') {
            setNodeState((p) => ({ ...p, [ev.id]: { state: 'fail', error: ev.error } }));
            pushLog('err', `✗ ${ev.id}：${ev.error}`);
          } else if (ev.type === 'run-done') {
            setOutput(ev.output || '');
            pushLog('ok', `完成 · ${ev.ms}ms · 产物 ${ev.chars} 字符`);
          } else if (ev.type === 'run-error') {
            pushLog('err', `运行失败：${ev.error}`);
          }
        },
      });
      if (!res.ok && !ctrl.signal.aborted) toast(`运行失败：${res.error || '未知原因'}`, 'err');
      else if (res.ok) toast(`工作流跑完：${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok');
      fetchRuns(10).then((r) => setRuns(r.runs || [])).catch(() => {});
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setLogs((prev) => [...prev, { cls: 'err', text: `请求失败：${e.message}`, at: Date.now() }]);
        toast(`运行失败：${e.message}`, 'err');
      }
    } finally {
      setRunState('idle');
      abortRef.current = null;
    }
  };

  const loadWf = async (id) => {
    try {
      const data = await fetchWorkflow(id);
      setWf(data);
      setNodeState({});
      setLogs([]);
      setOutput('');
      setSel(null);
      setDirty(false);
    } catch (e) {
      toast(`打开失败：${e.message}`, 'err');
    }
  };

  const removeWf = async () => {
    if (!list.some((w) => w.id === wf.id)) {
      setWf(emptyWf());
      setDirty(false);
      return;
    }
    try {
      await deleteWorkflow(wf.id);
      toast('已删除工作流文件', 'ok');
      setWf(emptyWf());
      setDirty(false);
      refreshList();
    } catch (e) {
      toast(`删除失败：${e.message}`, 'err');
    }
  };

  /* ---------------- 键盘 ---------------- */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
        e.preventDefault();
        removeNode(sel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setField = (key, value) => {
    if (!selected) return;
    mutate((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, [key]: value } } : n)),
    }));
  };

  return (
    <div className="sk-overlay wf-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="wf-shell">
        <div className="wf-head">
          <input
            className="wf-name"
            value={wf.name}
            onChange={(e) => {
              setWf({ ...wf, name: e.target.value });
              setDirty(true);
            }}
          />
          {dirty ? <span className="pm-badge warn">未保存</span> : null}
          <select
            className="wf-picker"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('load:')) loadWf(v.slice(5));
              else if (v.startsWith('tmpl:')) {
                const t = starters.find((s) => s.id === v.slice(5));
                if (t) {
                  setWf(JSON.parse(JSON.stringify(t)));
                  setDirty(true);
                  setSel(null);
                  toast(`已载入模板「${t.name}」，点保存才会写进 .cortex/workflows`, 'ok');
                }
              }
            }}
          >
            <option value="">打开…</option>
            {list.length ? (
              <optgroup label="已保存">
                {list.map((w) => (
                  <option key={w.id} value={`load:${w.id}`}>
                    {w.name}（{w.nodes} 节点）
                  </option>
                ))}
              </optgroup>
            ) : null}
            {starters.length ? (
              <optgroup label="内置模板">
                {starters.map((s) => (
                  <option key={s.id} value={`tmpl:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <button className="btn sm" onClick={() => { setWf(emptyWf()); setDirty(false); setSel(null); setNodeState({}); setLogs([]); setOutput(''); }}>
            新建
          </button>
          <button className="btn sm" onClick={save} disabled={runState === 'running'}>
            保存
          </button>
          <button className="btn sm" onClick={check} disabled={runState === 'running'}>
            校验
          </button>
          <button className="btn sm" onClick={removeWf} disabled={runState === 'running'}>
            删除
          </button>
          <span className="spacer" />
          <span className="wf-hint">
            {wf.nodes.length} 节点 · {wf.edges.length} 连线 · 命令走白名单 · AI 节点用服务端 Key
          </span>
          <button className="btn sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="wf-main">
          <div className="wf-palette">
            <h4>节点</h4>
            {Object.entries(types).map(([id, t]) => (
              <div key={id}>
                <div className="wf-pal-item" onClick={() => addNode(id)} title={t.desc}>
                  <span className="wf-dot" style={{ background: t.color }} />
                  {t.label}
                </div>
                <div className="wf-pal-desc">{t.desc}</div>
              </div>
            ))}
            {sel ? (
              <div style={{ marginTop: 10 }}>
                <button className="btn sm" style={{ width: '100%' }} onClick={() => removeNode(sel)}>
                  删除选中节点
                </button>
              </div>
            ) : null}
            <h4 style={{ marginTop: 14 }}>最近运行</h4>
            {runs.length ? (
              runs.map((r, i) => (
                <div key={i} className="wf-pal-desc" style={{ margin: '0 0 5px', color: r.ok ? 'var(--fg-mute)' : 'var(--danger)' }}>
                  {new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false })} · {r.name} · {r.ok ? `${r.ms}ms` : '失败'}
                </div>
              ))
            ) : (
              <div className="wf-pal-desc">还没跑过</div>
            )}
          </div>

          <div className="wf-canvas-wrap">
            <div
              className="wf-canvas"
              onPointerMove={onCanvasMove}
              onPointerUp={onCanvasUp}
              onClick={() => setSel(null)}
            >
              <div className="wf-world" ref={worldRef}>
                <svg className="wf-edges">
                  {wf.edges.map((e) => {
                    const a = byId.get(e.from);
                    const b = byId.get(e.to);
                    if (!a || !b) return null;
                    const cls = `wf-edge ${e.fromPort === 'true' ? 'true' : e.fromPort === 'false' ? 'false' : ''} ${
                      nodeState[e.from]?.state === 'ok' ? 'active' : ''
                    }`;
                    return (
                      <g key={e.id}>
                        <path className={cls} d={edgePath(a, b, e.fromPort)} />
                        <path
                          className="wf-edge-hit"
                          d={edgePath(a, b, e.fromPort)}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            mutate((prev) => ({ ...prev, edges: prev.edges.filter((x) => x.id !== e.id) }));
                          }}
                        />
                      </g>
                    );
                  })}
                  {link && byId.get(link.from) ? (
                    <path
                      className="wf-edge active"
                      strokeDasharray="4 3"
                      d={`M ${byId.get(link.from).x + NODE_W} ${portY(byId.get(link.from), link.port)} C ${byId.get(link.from).x + NODE_W + 60} ${
                        portY(byId.get(link.from), link.port)
                      }, ${link.x - 60} ${link.y}, ${link.x} ${link.y}`}
                    />
                  ) : null}
                </svg>

                {wf.nodes.map((n) => {
                  const t = types[n.type] || {};
                  const st = nodeState[n.id];
                  const ports = t.outputs || 1;
                  return (
                    <div
                      key={n.id}
                      className={`wf-node ${sel === n.id ? 'sel' : ''} ${st?.state || ''}`}
                      style={{ left: n.x, top: n.y, width: NODE_W }}
                      onPointerDown={(e) => onNodePointerDown(e, n)}
                      onPointerUp={(e) => finishLink(e, n)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel(n.id);
                      }}
                    >
                      <div className="wf-node-bar" style={{ background: t.color || 'var(--line)' }} />
                      <div className="wf-node-body">
                        <div className="wf-node-type">{t.label || n.type}</div>
                        <div className="wf-node-label">{n.data?.label || n.data?.title || n.id}</div>
                        <div className="wf-node-sub">
                          {n.type === 'read' || n.type === 'write'
                            ? n.data?.path || '未填路径'
                            : n.type === 'shell'
                              ? n.data?.cmd || '未填命令'
                              : n.type === 'ai'
                                ? `${n.data?.mode || 'agent'} · ${(n.data?.prompt || '').slice(0, 14) || '未填任务'}`
                                : n.type === 'search'
                                  ? n.data?.query || '未填搜索词'
                                  : n.type === 'branch'
                                    ? `${n.data?.op || 'contains'} ${n.data?.value || ''}`
                                    : n.type === 'output'
                                      ? n.data?.title || '产物'
                                      : '工作流输入'}
                        </div>
                      </div>
                      {n.type !== 'input' ? <span className="wf-port in" title="输入" /> : null}
                      {ports >= 1 ? <span className="wf-port out" title="从这里拖到别的节点上连线" onPointerDown={(e) => startLink(e, n, 'default')} /> : null}
                      {n.type === 'branch' ? (
                        <>
                          <span className="wf-port out true" title="条件成立" onPointerDown={(e) => startLink(e, n, 'true')} />
                          <span className="wf-port out false" title="条件不成立" onPointerDown={(e) => startLink(e, n, 'false')} />
                          <span className="wf-port-label true">是</span>
                          <span className="wf-port-label false">否</span>
                        </>
                      ) : null}
                      {st?.ms != null ? <span className="wf-badge">{st.ms}ms</span> : null}
                      {st?.state === 'run' ? <span className="wf-badge">跑…</span> : null}
                      {st?.state === 'fail' ? <span className="wf-badge" style={{ color: 'var(--danger)' }}>✗</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="wf-inspector">
            <h5>节点设置</h5>
            {!selected ? (
              <div className="wf-hint">
                点节点编辑；按住右侧圆点拖到另一个节点上连线；点连线可删除。
                <br />
                <br />
                占位符：<code>{'{{input}}'}</code> 运行输入、<code>{'{{prev}}'}</code> 上游结果、
                <code>{'{{nodes.n2}}'}</code> 指定节点输出。
              </div>
            ) : (
              <>
                <div className="wf-field">
                  <label className="wf-label">标题</label>
                  <input
                    className="wf-input"
                    value={selected.data?.label || ''}
                    onChange={(e) => setField('label', e.target.value)}
                  />
                </div>
                {(selectedType?.fields || []).map((f) => (
                  <div className="wf-field" key={f.key}>
                    <label className="wf-label">{f.label}</label>
                    {f.type === 'textarea' ? (
                      <textarea
                        className="wf-textarea"
                        value={selected.data?.[f.key] || ''}
                        placeholder={f.placeholder || ''}
                        onChange={(e) => setField(f.key, e.target.value)}
                      />
                    ) : f.type === 'select' ? (
                      <select className="wf-select" value={selected.data?.[f.key] || f.options[0]} onChange={(e) => setField(f.key, e.target.value)}>
                        {f.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="wf-input"
                        value={selected.data?.[f.key] || ''}
                        placeholder={f.placeholder || ''}
                        onChange={(e) => setField(f.key, e.target.value)}
                      />
                    )}
                  </div>
                ))}
                {nodeState[selected.id]?.preview ? (
                  <div className="wf-field">
                    <label className="wf-label">上次输出</label>
                    <div className="pm-composed" style={{ maxHeight: 120, fontSize: 10.5 }}>
                      {nodeState[selected.id].preview}
                    </div>
                  </div>
                ) : null}
                {nodeState[selected.id]?.error ? <div className="wf-err">{nodeState[selected.id].error}</div> : null}
                {checking && !checking.ok ? (
                  <div className="wf-err" style={{ marginTop: 6 }}>
                    {checking.errors.map((e, i) => (
                      <div key={i}>· {e}</div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        {logs.length ? (
          <div className="wf-log">
            {logs.map((l, i) => (
              <div key={i} className={`wf-log-line ${l.cls}`}>
                <span className="t">{new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className="m">{l.text}</span>
              </div>
            ))}
          </div>
        ) : null}

        {output ? <div className="wf-out">{output.slice(0, 3000)}</div> : null}

        <div className="wf-runbar">
          <input
            className="wf-in"
            placeholder="运行输入（会传给「输入」节点，可用 {{input}} 引用）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && runState !== 'running') run();
            }}
          />
          <button className={`btn ${runState === 'running' ? 'sm' : 'primary sm'}`} onClick={run}>
            {runState === 'running' ? '停止' : '运行'}
          </button>
          {checking && !checking.ok ? <span className="wf-err">{checking.errors[0]}</span> : null}
        </div>
      </div>
    </div>
  );
}
