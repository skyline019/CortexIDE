import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, summarizeSession } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { runAgentTurn } from '../lib/agent.js';
import { composePrompt } from '../lib/promptClient.js';
import { extractPlan } from '../lib/plan.js';
import PlanCard from './PlanCard.jsx';
import Composer from './Composer.jsx';
import { buildContextBlock, refMeta, dedupeRefs } from '../lib/context-refs.js';
import { resolveMentionsInText, enrichRefsForSend } from '../lib/refsApi.js';
import { extractMemories, KINDS } from '../lib/memory.js';
import { uid } from '../lib/vfs.js';
import Markdown from './Markdown.jsx';
import { DiffBlock } from './DiffView.jsx';
import { IconBrain, IconTrash, IconGear, IconSpark, IconChevronRight, IconPlus } from './Icons.jsx';
import { engineLabel } from '../lib/engineLabel.js';

const QUICK = [
  '过一遍这个项目，指出最该先修的三处问题',
  '在 docs/notes.md 写一份本项目的上手笔记，直接写文件',
  '我们统一用 pnpm + vitest，记住这点',
  '上次说过的接口约定是什么？',
  '/mem 约定',
];


/**
 * 压缩徽标：既是「这一轮省了多少」的显示，也是**在线换档**的入口。
 *
 * 两个诚实性细节：
 *  - 数字前面带 `≈`：这是服务端估算，真实值看旁边的 `输入→输出 tok`（上游 usage）；
 *  - 没省（甚至变长）也照实显示 —— 短消息加文风卡是净亏，不拿平均值盖过去。
 */
// 标签写死在客户端：服务端只回「当前是哪档」，按钮文案不该跟着接口字段变（接口少个字段就退化成英文 key）
const STRENGTH_MENU = ['off', 'light', 'balanced', 'aggressive'];
const STRENGTH_LABEL = { off: '关闭', light: '轻', balanced: '均衡', aggressive: '激进' };

function CompressBadge({ info, onChanged }) {
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/llm/compress');
      setCfg((await r.json()).config);
    } catch {
      /* 服务端不可用时静默降级为只读徽标 */
    }
  }, []);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // 贴在徽标上方，并夹在视口里；用 fixed 是因为浮层原来会被 .change-list / .exec-card
    // 这类后面渲染的元素盖住（真机上点不到档位按钮，冒烟里直接超时）。
    const width = 300;
    setPos({
      left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, r.top - 8),
    });
  }, []);

  const openPop = () => {
    place();
    setOpen(true);
    if (!cfg) load();
  };

  // 点外面 / 按 Esc 关掉：以前只能再点一次徽标，浮层又挡住内容，很别扭
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.('.compress-pop') && !e.target.closest?.('.compress-badge')) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  const pick = async (strength) => {
    setBusy(true);
    try {
      const r = await fetch('/api/llm/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strength }),
      });
      const j = await r.json();
      setCfg(j.config || cfg);
      onChanged?.(strength);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;
  const saved = info.savedPct > 0;
  const current = cfg?.strength;
  return (
    <span className="compress-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`compress-badge ${saved ? '' : 'flat'}`}
        onClick={() => (open ? setOpen(false) : openPop())}
        title="这一轮发出去之前压掉了多少（估算）。点一下可以就地换档。"
      >
        {' · '}
        {saved ? '≈压实' : '≈未省'} {(info.before / 1000).toFixed(1)}k→{(info.after / 1000).toFixed(1)}k
        {saved ? `（省 ${info.savedPct}%）` : ''}
      </button>
      {open
        ? createPortal(
            <span
              className="compress-pop"
              role="dialog"
              style={{ position: 'fixed', left: pos.left, top: pos.top, transform: 'translateY(-100%)', zIndex: 9999 }}
            >
              <span className="compress-pop-head">
                压缩强度
                <em className="hint">当前 {current ? STRENGTH_LABEL[current] : '…'}</em>
              </span>
              <span className="compress-pop-row">
                {STRENGTH_MENU.map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy}
                    className={`chip tiny ${current === k ? 'on' : ''}`}
                    onClick={() => pick(k)}
                  >
                    {STRENGTH_LABEL[k]}
                  </button>
                ))}
              </span>
              <span className="compress-pop-note">下一轮生效。文风卡是固定投资（约 80 token），短消息可能反而变长。</span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/** Agent 执行的命令流水（终端风格） */
function ExecList({ execs = [] }) {
  const [open, setOpen] = useState({});
  return (
    <div className="exec-list">
      {execs.map((e, i) => {
        const expanded = open[i] ?? (e.code !== 0 && !e.denied);
        const out = `${e.stdout || ''}${e.stderr ? (e.stdout ? '\n' : '') + e.stderr : ''}`.trim();
        return (
          <div key={i} className={`exec-card ${e.denied ? 'denied' : e.code === 0 ? 'ok' : 'err'}`}>
            <button className="exec-head" onClick={() => setOpen((o) => ({ ...o, [i]: !expanded }))}>
              <span className="exec-dot" />
              <code>$ {e.cmd}</code>
              <span className="spacer" />
              <span className="exec-tag">
                {e.denied ? '已拒绝' : e.code === 0 ? `通过 ${e.ms}ms` : `退出码 ${e.code}`}
              </span>
              <span className="exec-caret">{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded && out && <pre className="exec-out">{out.slice(-4000)}</pre>}
          </div>
        );
      })}
    </div>
  );
}

/** 本轮改动（可折叠 diff） */
function ChangeList({ diffs = [] }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <div className="change-list">
      {diffs.map((d, i) => (
        <details key={i} className="change-item" open={i === diffs.length - 1 && diffs.length === 1}>
          <summary>
            <span className="change-path">{d.path}</span>
            {d.created ? <span className="change-badge">新建</span> : null}
            <span className="spacer" />
            <span className="diff-stat add">{d.after ? `+${d.after.split('\n').length}` : '+0'}</span>
          </summary>
          <DiffBlock before={showAll ? d.before : shortDiff(d).before} after={showAll ? d.after : shortDiff(d).after} path={d.path} compact />
        </details>
      ))}
      {diffs.length > 1 && (
        <button className="foot-btn" onClick={() => setShowAll((v) => !v)}>
          {showAll ? '收起长文件' : '显示完整文件'}
        </button>
      )}
    </div>
  );
}

/** 长文件只截变更附近 60 行，避免时间线爆炸 */
function shortDiff(d) {
  const before = d.before || '';
  const after = d.after || '';
  if (before.length + after.length < 20000) return { before, after };
  const tail = after.split('\n').slice(-120).join('\n');
  return { before, after: tail };
}

function Steps({ steps = [] }) {
  const [open, setOpen] = useState(true);
  if (!steps.length) return null;
  return (
    <div className="steps">
      <button
        className="step-row"
        onClick={() => setOpen((v) => !v)}
        style={{ width: '100%', textAlign: 'left', color: 'var(--fg-mute)' }}
      >
        <span className="ic">{open ? '▾' : '▸'}</span>
        <span className="body">
          <span className="t1">{steps.length} 个执行步骤</span>
        </span>
        <span style={{ fontSize: 10.5 }}>{open ? '收起' : '展开'}</span>
      </button>
      {open &&
        steps.map((s) => (
          <div key={s.id} className={`step-row ${s.kind} ${s.status === 'running' ? 'running' : ''}`}>
            <span className="ic">{s.kind === 'tool' ? '▣' : s.kind === 'memory' ? '◆' : '✧'}</span>
            <span className="body">
              <div className="t1">{s.title}</div>
              {s.detail && <div className="t2">{s.detail}</div>}
            </span>
            {s.status === 'running' && <span className="spin" />}
            {s.status === 'done' && s.kind === 'tool' && <span className="ok">✓</span>}
            {s.status === 'error' && <span className="fail">✕</span>}
          </div>
        ))}
    </div>
  );
}

function ReasoningBox({ text, streaming }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="reasoning-box">
      <button className="rh" onClick={() => setOpen((v) => !v)}>
        <span className="spark">{streaming ? '✧' : '✦'}</span>
        <span>{streaming ? '正在深度思考…' : `思考过程 · ${text.length} 字`}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="reasoning-text">{text}</div>}
    </div>
  );
}

function RecallBox({ items = [], tookMs, query, engine, dim, mode }) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  return (
    <div className="recall-box">
      <button className="rh" onClick={() => setOpen((v) => !v)} style={{ width: '100%' }}>
        <IconBrain size={12} />
        <span>召回 {items.length} 条长期记忆</span>
        <span style={{ marginLeft: 'auto', opacity: 0.75 }}>
          {engine ? `${engineLabel(engine)}${mode === 'hybrid' ? ' · RRF 混合' : ''}${dim ? ` · ${dim}d` : ''} · ` : ''}
          {tookMs}ms
        </span>
        <span style={{ opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open &&
        items.map((m) => (
          <div key={m.id} className="item">
            <span className="kind">{KINDS[m.kind]?.glyph}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.text}</span>
            <span className="ranks" title="向量名次 / BM25 名次 / RRF 融合分">
              {m.vRank ? `V${m.vRank}` : ''}
              {m.bRank ? ` B${m.bRank}` : ''}
            </span>
            <span className="sc">{m.score?.toFixed?.(2) ?? m.score}</span>
          </div>
        ))}
      {query && <div style={{ marginTop: 4, opacity: 0.6, fontSize: 10.5 }}>query: {query.slice(0, 60)}</div>}
    </div>
  );
}

export default function ChatPanel({ onOpenMemory, onOpenSettings, onCollapse, width = 424 }) {
  const { state, dispatch, ops, stateRef } = useApp();
  const { settings, messages, memories } = state;
  const toast = useToast();
  const [input, setInput] = useState('');
  // 本轮上下文引用（附件 / 工作区文件 / @提及 / 拖拽）。发送后不立刻清空，
  // 等 runAgentTurn 把内容读完了再清 —— 否则界面上一闪就没了，用户看不见自己带了什么。
  const [refs, setRefs] = useState([]);
  const [running, setRunning] = useState(false);
  const bodyRef = useRef(null);
  const abortRef = useRef(null);

  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToEnd = useCallback((force) => {
    const el = bodyRef.current;
    if (!el) return;
    if (!force && !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  }, []);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = near;
    setShowJump(!near);
  };

  useEffect(() => {
    scrollToEnd();
  }, [messages, scrollToEnd]);

  const send = useCallback(
    async (raw) => {
      const text = (raw ?? input).trim();
      const pendingRefs = dedupeRefs(refs);
      if ((!text && !pendingRefs.length) || running) return;
      setInput('');

      // 正文里写了 @路径 但没点选过 → 这里补读；读不到的标红，让模型和用户都知道
      let usedRefs = pendingRefs;
      let missing = [];
      let ctx = { text: '', chars: 0, estTokens: 0, included: [], dropped: [], clipped: [] };
      if (pendingRefs.length || /@[^\s@]+/.test(text)) {
        try {
          const resolved = await resolveMentionsInText(text, pendingRefs);
          usedRefs = resolved.refs;
          missing = resolved.missing;
        } catch {
          /* 读不到就按已有 refs 走 */
        }
        try {
          usedRefs = await enrichRefsForSend(usedRefs, ops);
        } catch {
          /* 抽取失败仍用原 refs */
        }
        ctx = buildContextBlock(usedRefs, { budget: 24000 });
        if (missing.length) toast(`${missing.length} 个引用读取失败：${missing.slice(0, 2).join('、')}`, 'err');
        if (ctx.dropped.length) toast(`上下文预算不够，${ctx.dropped.length} 个引用没带上`, 'err');
      }
      setRefs([]);

      const historySnapshot = stateRef.current.messages;
      dispatch({
        type: 'msg/add',
        message: {
          id: uid('msg'),
          role: 'user',
          content: text || '（仅附带上下文）',
          ts: Date.now(),
          steps: [],
          refs: usedRefs.map((r) => ({ type: r.type, path: r.path, name: r.name, binary: r.binary, chars: r.chars, lines: r.lines, size: r.size, error: r.error })),
          ctxNote: ctx.chars ? { chars: ctx.chars, estTokens: ctx.estTokens, clipped: ctx.clipped.length, dropped: ctx.dropped.length, included: ctx.included.length } : null,
        },
      });

      // 自动蒸馏记忆
      if (stateRef.current.settings.autoMemory) {
        const candidates = extractMemories(text, { source: 'chat' });
        if (candidates.length) {
          const res = ops.addMemories(candidates);
          for (const m of res.added) toast(`已自动记住：${m.text.slice(0, 26)}${m.text.length > 26 ? '…' : ''}`, 'mem');
        }
      }

      const aid = uid('msg');
      dispatch({
        type: 'msg/add',
        message: {
          id: aid,
          role: 'assistant',
          content: '',
          steps: [],
          memories: [],
          pending: true,
          model: settings.mode === 'api' ? settings.model : 'cortex-local',
          agentMode: settings.agentMode || 'agent',
          ts: Date.now(),
        },
      });

      setRunning(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const startedAt = performance.now();

      let buffer = '';
      let raf = null;
      let reasoningBuffer = '';
      const flush = () => {
        if (buffer) {
          dispatch({ type: 'msg/delta', id: aid, text: buffer });
          buffer = '';
        }
      };
      const emit = (ev) => {
        switch (ev.type) {
          case 'delta':
            buffer += ev.text;
            if (!raf) {
              raf = requestAnimationFrame(() => {
                raf = null;
                flush();
              });
            }
            break;
          case 'step':
            flush();
            dispatch({ type: 'msg/step', id: aid, step: ev.step });
            break;
          case 'phase':
            flush();
            dispatch({ type: 'msg/patch', id: aid, patch: { phase: ev.label } });
            break;
          case 'reasoning':
            reasoningBuffer += ev.text;
            if (!raf) {
              raf = requestAnimationFrame(() => {
                raf = null;
                dispatch({ type: 'msg/patch', id: aid, patch: { reasoning: reasoningBuffer } });
              });
            }
            break;
          case 'fileWritten': {
            toast(`已写入 ${ev.path}`, 'ok');
            if (ev.diff) {
              const cur = stateRef.current.messages.find((x) => x.id === aid);
              const diffs = [...(cur?.diffs || []), { path: ev.path, ...ev.diff, created: ev.created }];
              dispatch({ type: 'msg/patch', id: aid, patch: { diffs } });
            }
            break;
          }
          case 'execResult': {
            flush();
            const cur = stateRef.current.messages.find((x) => x.id === aid);
            const execs = [...(cur?.execs || []), ev];
            dispatch({ type: 'msg/patch', id: aid, patch: { execs } });
            // 同时写进"命令执行"审计面板
            dispatch({
              type: 'exec/log',
              item: { id: ev.id || `ex-${Date.now()}`, cmd: ev.cmd, at: Date.now(), code: ev.code, stdout: ev.stdout, stderr: ev.stderr, ms: ev.ms, matched: null },
            });
            break;
          }
          case 'approval': {
            // 由 ops.requestApproval 走全局确认卡，这里只需刷新
            break;
          }
          case 'toolResult':
            flush();
            dispatch({ type: 'msg/stepResult', id: aid, stepId: ev.id, ok: ev.ok, detail: ev.detail });
            break;
          case 'done':
            flush();
            dispatch({
              type: 'msg/patch',
              id: aid,
              patch: {
                phase: null,
                doneNote: ev.note || null,
                rounds: ev.rounds,
                usage: ev.usage,
                compress: ev.compress || null,
                tookMs: ev.tookMs,
              },
            });
            if (ev.usage?.prompt || ev.usage?.completion) {
              dispatch({
                type: 'chat/bumpTokens',
                prompt: ev.usage.prompt || 0,
                completion: ev.usage.completion || 0,
                bumpTurn: true,
              });
            }
            break;
          case 'memories':
            flush();
            dispatch({
              type: 'msg/patch',
              id: aid,
              patch: {
                memories: ev.items,
                recallMs: ev.tookMs,
                query: ev.query,
                recallEngine: ev.engine,
                recallDim: ev.dim,
                recallMode: ev.mode,
              },
            });
            dispatch({ type: 'stats/bump', patch: { retrievals: 1, hits: ev.items.length } });
            break;
          case 'memoryWrite':
            // 回答正文里已经说明了写入内容，这里只刷新时间线，不再重复弹提示
            break;
          default:
            break;
        }
      };

      // 每轮都重新合成系统提示词（服务端把「基座 + 模式 + 技能 + 工作区约定」拼好），
      // 这样在设置里改了提示词/技能，下一句话立刻生效，不需要刷新页面
      let systemPrefix = '';
      let promptStats = null;
      try {
        promptStats = await composePrompt({ mode: settings.agentMode || 'agent' });
        systemPrefix = promptStats.composed;
        dispatch({ type: 'msg/patch', id: aid, patch: { promptStats } });
      } catch {
        toast('提示词合成失败，本轮使用内置兜底提示词', 'err');
      }

      try {
        await runAgentTurn({
          input: text,
          data: {
            files: stateRef.current.files,
            activeFileId: stateRef.current.activeFileId,
            memories: stateRef.current.memories,
            messages: historySnapshot,
            autoMemory: stateRef.current.settings.autoMemory,
            contextBlock: ctx.text,
            refs: usedRefs,
          },
          settings: stateRef.current.settings,
          ops,
          emit,
          signal: ctrl.signal,
          approval: (cmd, reason) => ops.requestApproval({ cmd, reason }),
          systemPrefix,
        });
      } catch (err) {
        console.error('[cortex] 回合失败:', err && err.stack ? err.stack : err);
        flush();
        dispatch({
          type: 'msg/patch',
          id: aid,
          patch: { content: `${buffer ? '' : ''}**调用失败**：${err.message}\n\n检查设置里的 Base URL / API Key，或切回本地模式。`, error: true },
        });
      } finally {
        if (raf) cancelAnimationFrame(raf);
        flush();
        // Plan 模式：把 ```plan 块取出来挂在消息上，渲染成可构建的卡片
        if ((stateRef.current.settings.agentMode || 'agent') === 'plan') {
          const full = stateRef.current.messages.find((m) => m.id === aid)?.content || '';
          const parsed = extractPlan(full);
          dispatch({
            type: 'msg/patch',
            id: aid,
            patch: parsed.ok
              ? { plan: parsed.plan, planNote: parsed.note || null, planError: null }
              : { plan: null, planNote: null, planError: parsed.error },
          });
        }
        dispatch({
          type: 'msg/patch',
          id: aid,
          patch: {
            pending: false,
            tookMs: Math.round(performance.now() - startedAt),
            phase: null,
            steps: (stateRef.current.messages.find((m) => m.id === aid)?.steps || []).map((s) =>
              s.status === 'running' ? { ...s, status: 'done' } : s,
            ),
          },
        });
        dispatch({ type: 'stats/bump', patch: { turns: 1 } });
        setRunning(false);
        abortRef.current = null;
      }
    },
    [input, refs, running, dispatch, ops, settings.mode, settings.model, settings.agentMode, stateRef, toast],
  );

  const stop = () => abortRef.current?.abort();

  const copyMsg = async (m) => {
    try {
      await navigator.clipboard.writeText(m.content || '');
      toast('已复制回答');
    } catch {
      toast('复制失败', 'err');
    }
  };

  const retry = (m) => {
    if (running) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    const prevUser = [...messages.slice(0, idx)].reverse().find((x) => x.role === 'user');
    if (!prevUser) return;
    dispatch({ type: 'msg/remove', id: m.id });
    send(prevUser.content);
  };

  const archiveSession = () => {
    const summary = summarizeSession(messages, state.files);
    if (!summary) {
      toast('还没有可归档的对话', 'err');
      return;
    }
    ops.addSession({ id: uid('ses'), ...summary, at: Date.now() });
    const res = ops.addMemories([summary]);
    toast(res.added.length ? '会话已归档为一条情节记忆' : '会话已归档', 'mem');
  };

  const chatSessions = state.chatSessions || [];
  const activeSession = chatSessions.find((s) => s.id === state.activeSessionId) || chatSessions[chatSessions.length - 1];
  const sessionTok =
    (activeSession?.tokenUsage?.prompt || 0) + (activeSession?.tokenUsage?.completion || 0);

  return (
    <aside className="chat" style={{ width, flexBasis: width }}>
      <div className="chat-head">
        <div className="title">
          <span className="avatar">C</span>
          <select
            className="chat-session-sel"
            value={state.activeSessionId || activeSession?.id || ''}
            title="切换会话"
            onChange={(e) => ops.switchChatSession(e.target.value)}
          >
            {chatSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || '未命名'}
              </option>
            ))}
            {!chatSessions.length && <option value="">新会话</option>}
          </select>
        </div>
        <button
          className="icon-btn"
          title="新建会话"
          onClick={() => {
            ops.newChatSession();
            toast('已新建会话', 'ok');
          }}
        >
          <IconPlus size={14} />
        </button>
        <button
          className="icon-btn"
          title="重命名当前会话"
          onClick={() => {
            const cur = activeSession;
            if (!cur) return;
            const name = prompt('会话名称', cur.title || '');
            if (name == null) return;
            ops.renameChatSession(cur.id, name.trim() || '未命名会话');
          }}
        >
          ✎
        </button>
        {chatSessions.length > 1 && activeSession && (
          <button
            className="icon-btn"
            title="删除当前会话"
            onClick={() => {
              if (!confirm(`删除会话「${activeSession.title || '未命名'}」？`)) return;
              ops.deleteChatSession(activeSession.id);
            }}
          >
            ×
          </button>
        )}
        <button className="mem-chip" onClick={onOpenMemory} title="打开记忆库">
          <IconBrain size={12} />
          <b>{memories.length}</b>
        </button>
        {sessionTok > 0 && (
          <span className="tok-chip" title="本会话累计 token（上游 usage）">
            {sessionTok.toLocaleString()} tok
          </span>
        )}
        <div className="spacer" />
        <button className="icon-btn" title="归档会话并写入记忆" onClick={archiveSession}>
          <IconSpark size={14} />
        </button>
        <button
          className="icon-btn"
          title="清空当前会话消息"
          onClick={() => {
            if (!confirm('清空当前会话的全部消息？')) return;
            dispatch({ type: 'msg/clear' });
          }}
        >
          <IconTrash size={14} />
        </button>
        <button className="icon-btn" title="设置" onClick={onOpenSettings}>
          <IconGear size={14} />
        </button>
        {onCollapse && (
          <button className="icon-btn" title="收起对话 (Ctrl+J)" onClick={onCollapse}>
            <IconChevronRight size={14} />
          </button>
        )}
      </div>

      <div className="chat-body" ref={bodyRef} onScroll={onScroll}>
        {showJump && (
          <button className="jump-bottom" onClick={() => scrollToEnd(true)}>
            ↓ 回到最新
          </button>
        )}
        {!messages.length && (
          <div style={{ padding: '6px 2px' }}>
            <p style={{ color: 'var(--fg-dim)', lineHeight: 1.8, marginTop: 4 }}>
              我是带<b style={{ color: 'var(--accent)' }}>持久记忆</b>的编程 Agent，可对接任意 OpenAI 兼容模型。
              每次对话前先检索长期记忆，再读你的工作区文件；多会话可在上方切换，关掉页面也不会丢。
            </p>
            <div className="quick-prompts">
              {QUICK.map((q) => (
                <button key={q} className="qp" onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg user">
              {m.refs?.length ? (
                <div className="msg-refs">
                  {m.refs.map((r) => (
                    <span key={`${r.type}:${r.path}`} className={`mref ${r.type}`} title={r.path}>
                      {r.binary ? '▦' : r.type === 'attach' ? '📎' : r.type === 'memory' ? '◆' : r.type === 'skill' ? '✦' : '▤'} {r.name} · {r.error ? '读取失败' : refMeta(r)}
                    </span>
                  ))}
                  {m.ctxNote ? (
                    <span className="ctx-note">
                      {m.ctxNote.included}/{m.ctxNote.included + m.ctxNote.dropped} 个引用已附带 · ≈{m.ctxNote.estTokens} tok
                      {m.ctxNote.clipped ? ` · ${m.ctxNote.clipped} 个被截断` : ''}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="bubble-user">{m.content}</div>
            </div>
          ) : (
            <div key={m.id} className="msg agent">
              <div className="agent-name">
                <span className="avatar" style={{ width: 16, height: 16, fontSize: 8 }}>
                  C
                </span>
                <b>{m.model || 'cortex-local'}</b>
                {m.tookMs ? <span>· {m.tookMs}ms</span> : null}
                {m.pending && <span className="phase">· {m.phase || '推理中'}</span>}
              </div>
              {m.memories?.length ? (
                <RecallBox
                items={m.memories}
                tookMs={m.recallMs}
                query={m.query}
                engine={m.recallEngine}
                dim={m.recallDim}
                mode={m.recallMode}
              />
              ) : null}
              <ReasoningBox text={m.reasoning} streaming={m.pending && !m.content} />
              <Steps steps={m.steps} />
              {m.execs?.length ? <ExecList execs={m.execs} /> : null}
              {(m.content || m.pending) && (
                <div className={`content ${m.pending ? 'typing' : ''}`}>
                  <Markdown text={m.content} />
                </div>
              )}
              {m.diffs?.length ? <ChangeList diffs={m.diffs} /> : null}
              {m.plan || m.planError ? <PlanCard plan={m.plan} error={m.planError} note={m.planNote} mode={m.agentMode || 'plan'} /> : null}
              {!m.pending && m.content ? (
                <div className="msg-foot">
                  <span>
                    {m.rounds ? `${m.rounds} 轮 · ` : ''}
                    {m.steps?.filter((s) => s.kind === 'tool').length
                      ? `${m.steps.filter((s) => s.kind === 'tool').length} 次工具调用 · `
                      : ''}
                    {m.tookMs ? `${(m.tookMs / 1000).toFixed(1)}s` : ''}
                    {m.usage?.prompt ? ` · ${m.usage.prompt}→${m.usage.completion} tok` : ''}
                    {m.promptStats ? (
                      <span
                        className="prompt-stat"
                        title={`系统提示词 ${m.promptStats.chars} 字符（约 ${m.promptStats.estTokens} token）· 技能：${m.promptStats.skillNames?.join('、') || '无'}${m.promptStats.systemOverridden ? ' · 用了自定义系统提示词' : ''}${m.promptStats.workspacePrompt ? ' · 含工作区约定' : ''}`}
                      >
                        {' '}
                        · 提示词 {m.promptStats.estTokens} tok / {m.promptStats.skillIds?.length || 0} 技能
                      </span>
                    ) : null}
                    {m.compress ? <CompressBadge info={m.compress} onChanged={(k) => toast(`压缩强度已切到「${k}」，下一轮生效`)} /> : null}
                  </span>
                  {m.doneNote && <span className="note">{m.doneNote}</span>}
                  <button className="foot-btn" onClick={() => copyMsg(m)}>
                    复制
                  </button>
                  <button className="foot-btn" onClick={() => retry(m)} disabled={running}>
                    重试
                  </button>
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>

      <Composer
        input={input}
        setInput={setInput}
        refs={refs}
        setRefs={setRefs}
        onSend={() => send()}
        running={running}
        onStop={stop}
        settings={settings}
        dispatch={dispatch}
        memories={memories}
        activeFile={state.files.find((f) => f.id === state.activeFileId) || null}
        messageCount={messages.filter((m) => m.role === 'user').length}
        workspaceRoot={state.workspace.root || ''}
      />
    </aside>
  );
}
