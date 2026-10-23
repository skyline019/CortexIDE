import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, summarizeSession } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { runAgentTurn } from '../lib/agent.js';
import { composePrompt } from '../lib/promptClient.js';
import { extractPlan } from '../lib/plan.js';
import Composer from './Composer.jsx';
import ChatSessionBar from './ChatSessionBar.jsx';
import ChatMessageList from './ChatMessageList.jsx';
import { buildContextBlock, dedupeRefs } from '../lib/context-refs.js';
import { resolveMentionsInText, enrichRefsForSend } from '../lib/refsApi.js';
import { extractMemories } from '../lib/memory.js';
import { uid } from '../lib/vfs.js';

const QUICK = [
  '过一遍这个项目，指出最该先修的三处问题',
  '在 docs/notes.md 写一份本项目的上手笔记，直接写文件',
  '我们统一用 pnpm + vitest，记住这点',
  '上次说过的接口约定是什么？',
  '/mem 约定',
];

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
      <ChatSessionBar
        chatSessions={chatSessions}
        activeSessionId={state.activeSessionId}
        activeSession={activeSession}
        sessionTok={sessionTok}
        memoriesCount={memories.length}
        onSwitch={(id) => ops.switchChatSession(id)}
        onNew={() => {
          ops.newChatSession();
          toast('已新建会话', 'ok');
        }}
        onRename={(id, title) => ops.renameChatSession(id, title)}
        onDelete={(id) => ops.deleteChatSession(id)}
        onOpenMemory={onOpenMemory}
        onArchive={archiveSession}
        onClear={() => dispatch({ type: 'msg/clear' })}
        onOpenSettings={onOpenSettings}
        onCollapse={onCollapse}
      />
      <ChatMessageList
        messages={messages}
        showJump={showJump}
        onJump={scrollToEnd}
        bodyRef={bodyRef}
        onScroll={onScroll}
        quick={QUICK}
        onQuick={send}
        running={running}
        onCopy={copyMsg}
        onRetry={retry}
        onCompressChanged={(k) => toast(`压缩强度已切到「${k}」，下一轮生效`)}
      />

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
