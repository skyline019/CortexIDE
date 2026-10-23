import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PlanCard from './PlanCard.jsx';
import Markdown from './Markdown.jsx';
import { DiffBlock } from './DiffView.jsx';
import { IconBrain } from './Icons.jsx';
import { KINDS } from '../lib/memory.js';
import { refMeta } from '../lib/context-refs.js';
import { engineLabel } from '../lib/engineLabel.js';

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

/** 消息列表（含空态 quick prompts） */
export default function ChatMessageList({
  messages,
  showJump,
  onJump,
  bodyRef,
  onScroll,
  quick,
  onQuick,
  running,
  onCopy,
  onRetry,
  onCompressChanged,
}) {
  return (
    <div className="chat-body" ref={bodyRef} onScroll={onScroll}>
      {showJump && (
        <button className="jump-bottom" onClick={() => onJump(true)}>
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
            {(quick || []).map((q) => (
              <button key={q} className="qp" onClick={() => onQuick(q)}>
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
                    {r.binary ? '▦' : r.type === 'attach' ? '📎' : r.type === 'memory' ? '◆' : r.type === 'skill' ? '✦' : '▤'}{' '}
                    {r.name} · {r.error ? '读取失败' : refMeta(r)}
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
            {m.plan || m.planError ? (
              <PlanCard plan={m.plan} error={m.planError} note={m.planNote} mode={m.agentMode || 'plan'} />
            ) : null}
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
                  {m.compress ? <CompressBadge info={m.compress} onChanged={onCompressChanged} /> : null}
                </span>
                {m.doneNote && <span className="note">{m.doneNote}</span>}
                <button className="foot-btn" onClick={() => onCopy(m)}>
                  复制
                </button>
                <button className="foot-btn" onClick={() => onRetry(m)} disabled={running}>
                  重试
                </button>
              </div>
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}
