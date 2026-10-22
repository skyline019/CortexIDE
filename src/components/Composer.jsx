/**
 * 输入区（composer）
 *
 * 这一版把「上下文」做成一等公民：附件、工作区、@提及、拖拽**共用同一份 refs**，
 * 输入框上方就是它们，发送时统一拼成一段有预算、截断会明说的上下文块。
 *
 * 为什么从 ChatPanel 里抽出来：ChatPanel 已经 780 行，输入区的交互（补全弹层、
 * 键盘导航、拖拽计数、上传状态）再塞进去就没人敢改了。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../state/toast.jsx';
import { MODE_META } from '../lib/agent.js';
import {
  mentionQueryAt,
  replaceMention,
  rankCandidates,
  upsertRef,
  refKey,
  refMeta,
  originLabel,
  refsSummary,
  formatSize,
  shortPath,
  estimateTokens,
} from '../lib/context-refs.js';
import { listWorkspaceFiles, loadFileRef, uploadAttachment, listAttachments, makeMemoryRef, makeSkillRef } from '../lib/refsApi.js';
import { fetchSkills } from '../lib/promptClient.js';
import { IconSend, IconStop, IconClip, IconAt, IconFolder, IconChat, IconClose, IconCheck } from './Icons.jsx';

const KIND_GLYPH = { file: '▤', attach: '📎', memory: '◆', skill: '✦' };

/** 引用条上的一个 chip：点一下看内容，点 ✕ 拿掉 */
function RefChip({ item, onRemove, onPreview }) {
  const bad = Boolean(item.error);
  return (
    <span className={`ref-chip ${bad ? 'bad' : ''} ${item.type}`} title={`${originLabel(item)} · ${item.path}${item.error ? ` · ${item.error}` : ''}`}>
      <button type="button" className="ref-main" onClick={() => onPreview(item)}>
        <span className="ref-glyph">{item.binary ? '▦' : KIND_GLYPH[item.type] || '▤'}</span>
        <span className="ref-name">{item.name}</span>
        <span className="ref-meta">{bad ? '读取失败' : refMeta(item)}</span>
      </button>
      <button type="button" className="ref-x" onClick={() => onRemove(item)} aria-label={`移除 ${item.name}`}>
        <IconClose size={9} />
      </button>
    </span>
  );
}

/** 把本机绝对路径收成工作区相对路径（Electron 拖入系统文件时用） */
function absToWorkspaceRel(absPath, workspaceRoot) {
  if (!absPath || !workspaceRoot) return null;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(absPath);
  const r = norm(workspaceRoot);
  const al = a.toLowerCase();
  const rl = r.toLowerCase();
  if (al === rl) return '.';
  if (!al.startsWith(`${rl}/`)) return null;
  return a.slice(r.length + 1);
}

/** 判断一段文本是否像工作区相对路径（放宽：允许中文、空格外的常见文件名） */
function looksLikeRelPath(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('\n') || t.includes('://') || t.length > 512) return false;
  if (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('/')) return false; // 绝对路径另处理
  if (t.includes('\\')) return false;
  return /[\w.\u4e00-\u9fff/@+-]+\.[A-Za-z0-9]{1,12}$/.test(t) || t.includes('/');
}

export default function Composer({
  input,
  setInput,
  refs,
  setRefs,
  onSend,
  running,
  onStop,
  settings,
  dispatch,
  memories = [],
  activeFile = null,
  messageCount = 0,
  workspaceRoot = '',
}) {
  const toast = useToast();
  const ctaRef = useRef(null); // 输入框（引用条、补全面板都基于它的光标位置）
  const boxRef = useRef(null);
  const dragDepth = useRef(0);
  const [mention, setMention] = useState(null); // { range, query, index }
  const [files, setFiles] = useState([]);
  // 技能从服务端取（系统层 + 当前层），@ 面板里可以直接引用某个技能当上下文
  const [skills, setSkills] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(0);
  const [preview, setPreview] = useState(null);
  const [browse, setBrowse] = useState(false); // 点「工作区」按钮时，显示全部文件而不只是匹配项

  useEffect(() => {
    if (!mention) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.('.composer-box')) setMention(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [mention]);

  useEffect(() => {
    listWorkspaceFiles().then(setFiles);
    listAttachments().then(setAttachments);
    fetchSkills()
      .then((j) => setSkills([...(j.system || []), ...(j.workspace || [])]))
      .catch(() => setSkills([]));
  }, []);

  const summary = refsSummary(refs);

  /* ---------------- 引用增删 ---------------- */

  const addRefs = useCallback(
    (items) => {
      if (!items?.length) return;
      setRefs((prev) => {
        let next = prev;
        for (const item of items) next = upsertRef(next, item);
        return next;
      });
    },
    [setRefs],
  );

  const removeRef = useCallback(
    (item) => {
      setRefs((prev) => prev.filter((r) => refKey(r) !== refKey(item)));
      if (preview && refKey(preview) === refKey(item)) setPreview(null);
    },
    [setRefs, preview],
  );

  /** 统一入口：给一条「候选」或「路径」，读成 ref 并加到引用条 */
  const attachPath = useCallback(
    async (path, origin = 'mention') => {
      if (!path) return null;
      setBusy((n) => n + 1);
      try {
        const ref = await loadFileRef(path, { origin });
        addRefs([ref]);
        if (ref.error) toast(`读取失败：${ref.error}`, 'err');
        return ref;
      } finally {
        setBusy((n) => n - 1);
      }
    },
    [addRefs, toast],
  );

  /* ---------------- @ 补全 ---------------- */

  const syncMention = useCallback((el) => {
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const hit = mentionQueryAt(el.value, caret);
    setMention((prev) => {
      if (!hit) return prev && prev.range === null ? prev : null; // 浏览模式不因为光标移动被关掉
      if (prev && prev.range && prev.range.start === hit.start && prev.query === hit.query) return prev;
      return { range: hit, query: hit.query, index: 0 };
    });
  }, []);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query;
    const raw = [
      ...files.map((f) => ({ kind: 'file', path: f.path, name: f.name, ext: f.ext })),
      ...(browse || !q
        ? activeFile
          ? [{ kind: 'file', path: activeFile.path, name: activeFile.name || activeFile.path.split('/').pop(), ext: '' }]
          : []
        : []),
      ...attachments.map((a) => ({ kind: 'attach', path: a.path, name: a.name, ext: '' })),
      ...memories.map((m) => ({ kind: 'memory', path: `memory:${m.id}`, name: m.text || '(记忆)', memory: m })),
      ...skills.map((s) => ({ kind: 'skill', path: `skill:${s.id}`, name: s.name || s.id, skill: s })),
    ];
    const seenKey = new Set();
    const pool = [];
    for (const item of raw) {
      const k = `${item.kind}:${item.path}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      pool.push(item);
    }
    const picked = rankCandidates(pool, q, 30);
    // 分组：先文件（最常用），再附件、记忆、技能
    const order = { file: 0, attach: 1, memory: 2, skill: 3 };
    picked.sort((a, b) => order[a.kind] - order[b.kind]);
    return picked.slice(0, 12);
  }, [mention, files, memories, skills, attachments, activeFile, browse]);

  const pick = useCallback(
    async (item) => {
      if (!item) return;
      const el = ctaRef.current;
      const range = mention?.range;
      setMention(null);
      if (item.kind === 'memory') {
        if (range) setInput((v) => `${v.slice(0, range.start)}${v.slice(range.end)}`);
        addRefs([makeMemoryRef(item.memory)]);
        return;
      }
      if (item.kind === 'skill') {
        if (range) setInput((v) => `${v.slice(0, range.start)}${v.slice(range.end)}`);
        addRefs([makeSkillRef(item.skill)]);
        return;
      }
      // 文件 / 附件：把 @path 写进正文，同时把内容读进引用条
      const joiner = input && !/\s$/.test(input) ? ' ' : '';
      const nextText = range ? replaceMention(input, range, item.path) : `${input}${joiner}@${item.path} `;
      setInput(nextText);
      await attachPath(item.path, item.kind === 'attach' ? 'upload' : 'mention');
      requestAnimationFrame(() => {
        if (!el) return;
        el.focus();
        const pos = range ? range.start + item.path.length + 2 : nextText.length;
        el.setSelectionRange(Math.min(pos, nextText.length), Math.min(pos, nextText.length));
      });
    },
    [mention, input, setInput, addRefs, attachPath],
  );

  /* ---------------- 拖拽 ---------------- */

  const handleFiles = useCallback(
    async (fileList) => {
      const list = Array.from(fileList || []);
      if (!list.length) return;
      if (list.length > 5) toast(`一次最多拖 5 个文件，已取前 5 个`, 'err');
      for (const file of list.slice(0, 5)) {
        setBusy((n) => n + 1);
        try {
          // Electron：File.path 是本机绝对路径。若已在当前工作区内，直接引用，勿再拷到 attachments
          const abs = file.path || file.webkitRelativePath || '';
          const rel = absToWorkspaceRel(abs, workspaceRoot);
          let ref;
          if (rel && rel !== '.') {
            ref = await loadFileRef(rel, { origin: 'drag' });
            addRefs([ref]);
            if (ref.error) toast(`读取失败：${ref.error}`, 'err');
            else toast(`已引用工作区文件 ${ref.name}`, 'ok');
          } else {
            ref = await uploadAttachment(file);
            addRefs([ref]);
            toast(`已附加 ${ref.name}（${formatSize(ref.size)}，已存到 ${ref.path}）`, 'ok');
            listAttachments().then(setAttachments);
          }
        } catch (err) {
          toast(`附加失败：${err.message}`, 'err');
        } finally {
          setBusy((n) => n - 1);
        }
      }
    },
    [addRefs, toast, workspaceRoot],
  );

  const onDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const types = [...(e.dataTransfer?.types || [])];
    e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'copy';
  };
  const onDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    // 1) 文件树拖来的自定义 MIME（部分 Chromium/Electron 会丢掉，后面用 text/plain 兜底）
    const internal =
      dt.getData('application/x-cortex-path') ||
      dt.getData('text/x-cortex-path') ||
      dt.getData('text/uri-list');
    const plain = (dt.getData('text/plain') || '').trim();
    const fromTree = (internal || '').trim() || (looksLikeRelPath(plain) ? plain : '');
    if (fromTree && !fromTree.startsWith('file:') && looksLikeRelPath(fromTree.replace(/^\.\//, ''))) {
      const path = fromTree.replace(/^\.\//, '').split('\n')[0].trim();
      const ref = await attachPath(path, 'drag');
      if (ref && !ref.error) toast(`已引用 ${ref.name}`, 'ok');
      return;
    }
    // 2) 系统文件（含：从资源管理器拖入；或 Electron 下拖入已在工作区的文件）
    if (dt.files && dt.files.length) {
      await handleFiles(dt.files);
      return;
    }
    // 3) 纯文本绝对路径 → 尝试映射到工作区
    if (plain && !plain.includes('\n')) {
      const rel = absToWorkspaceRel(plain, workspaceRoot);
      if (rel && rel !== '.') {
        await attachPath(rel, 'drag');
        return;
      }
      if (looksLikeRelPath(plain)) await attachPath(plain.replace(/^\.\//, ''), 'drag');
    }
  };

  const onPaste = async (e) => {
    const files = e.clipboardData?.files;
    if (files?.length) {
      e.preventDefault();
      await handleFiles(files);
    }
  };

  /* ---------------- 键盘 ---------------- */

  const onKeyDown = (e) => {
    if (mention && candidates.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention((m) => ({ ...m, index: (m.index + 1) % candidates.length }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention((m) => ({ ...m, index: (m.index - 1 + candidates.length) % candidates.length }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(candidates[Math.min(mention.index, candidates.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      onSend();
    }
    if (e.key === 'Escape' && preview) setPreview(null);
  };

  const canSend = Boolean(input.trim() || refs.length);

  return (
    <div className="composer">
      <div
        ref={boxRef}
        className={`composer-box ${dragOver ? 'drop-live' : ''} ${mention ? 'mentioning' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {refs.length > 0 && (
          <div className="ref-bar">
            <span className="ref-bar-label">
              <IconClip size={11} /> 上下文
            </span>
            {refs.map((r) => (
              <RefChip key={refKey(r)} item={r} onRemove={removeRef} onPreview={setPreview} />
            ))}
            <span className={`ref-sum ${summary.estTokens > 6000 ? 'warn' : ''}`} title="这些内容会在发送时拼进本轮上下文">
              ≈{summary.estTokens} tok
            </span>
            <button
              type="button"
              className="ref-clear"
              onClick={() => {
                setRefs([]);
                setPreview(null);
              }}
              title="清空所有引用"
            >
              清空
            </button>
          </div>
        )}

        {mention && (
          <div className="mention-panel" role="listbox" aria-label="引用候选">
            <div className="mention-head">
              <span>
                {mention.query ? `匹配「${mention.query}」` : browse ? '工作区文件（全部）' : '继续输入以筛选'}
              </span>
              <span className="mention-hint">↑↓ 选择 · Enter 引用 · Esc 关闭</span>
            </div>
            {candidates.length === 0 && <div className="mention-empty">没有匹配的文件 / 记忆 / 技能</div>}
            {candidates.map((c, i) => (
              <button
                key={`${c.kind}:${c.path}`}
                type="button"
                role="option"
                aria-selected={i === mention.index}
                className={`mention-row ${i === mention.index ? 'on' : ''} ${c.kind}`}
                data-idx={i}
                data-path={c.path}
                onMouseEnter={() => setMention((m) => (m ? { ...m, index: i } : m))}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
              >
                <span className="mention-glyph">{KIND_GLYPH[c.kind] || '▤'}</span>
                <span className="mention-name">{c.name}</span>
                <span className="mention-path">
                  {c.kind === 'memory' ? '记忆' : c.kind === 'skill' ? '技能' : shortPath(c.path)}
                </span>
                {i === mention.index && <IconCheck size={10} />}
              </button>
            ))}
            <div className="mention-foot">
              <span>{files.length} 个工作区文件 · {memories.length} 条记忆 · {skills.length} 个技能</span>
              <button
                type="button"
                className="link-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setBrowse((b) => !b);
                }}
              >
                {browse ? '只看匹配' : '浏览全部'}
              </button>
            </div>
          </div>
        )}

        <textarea
          ref={ctaRef}
          rows={Math.min(6, Math.max(2, input.split('\n').length))}
          placeholder="问点什么，或说“记住：……”（@ 引用文件 / 拖文件进来 / Enter 发送，Shift+Enter 换行）"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            syncMention(e.target);
          }}
          onClick={(e) => syncMention(e.target)}
          onKeyUp={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) syncMention(e.target);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        {running ? (
          <div className="composer-progress">
            <span className="dot" /> 正在处理… <button type="button" className="link-btn" onClick={onStop}>停止</button>
          </div>
        ) : null}

        {dragOver && (
          <div className="drop-hint">
            <IconClip size={16} />
            <b>松手加入上下文</b>
            <span>工作区文件直接引用；本地文件会存到 .cortex/attachments/</span>
          </div>
        )}

        <div className="composer-foot">
          {/* 面板只有 420px 宽：按钮全挤在一行会被折成三行（真机上「发送」被挤到最下面单独一行），
              所以明确分成两行：上排切模式 + 发送，下排挂上下文与常用开关。 */}
          <div className="foot-row main">
            <div className="mode-switch" role="group" aria-label="Agent 模式">
              {Object.entries(MODE_META).map(([id, meta]) => (
                <button
                  key={id}
                  type="button"
                  className={`mode-btn ${(settings.agentMode || 'agent') === id ? 'on' : ''}`}
                  title={`${meta.hint}${id === 'plan' ? '（会产出可一键构建的计划）' : ''}`}
                  onClick={() => {
                    dispatch({ type: 'settings/set', patch: { agentMode: id } });
                    toast(`已切到 ${meta.name} 模式：${meta.hint}`);
                  }}
                >
                  <span className="mode-icon">{meta.icon}</span>
                  {meta.name}
                </button>
              ))}
            </div>
            {running ? (
              <button className="send-btn stop" onClick={onStop}>
                <IconStop size={13} /> 停止
              </button>
            ) : (
              <button className="send-btn" disabled={!canSend} onClick={onSend} title={canSend ? '发送（Enter）' : '写点什么，或加个引用'}>
                <IconSend size={13} /> 发送
              </button>
            )}
          </div>

          <div className="foot-row tools">
            <div className="add-group">
              <button type="button" className="chip add" onClick={() => ctaRef.current?.focus()} title="输入 @ 引用文件 / 记忆 / 技能">
                <IconAt size={11} /> 引用
              </button>
              <button
                type="button"
                className="chip add"
                title="浏览工作区文件（等同输入 @）"
                onClick={() => {
                  setBrowse(true);
                  setMention({ range: null, query: '', index: 0 });
                  ctaRef.current?.focus();
                }}
              >
                <IconFolder size={11} /> 工作区
              </button>
              <label className="chip add" title="附加本地文件（会存到 .cortex/attachments/）">
                <IconClip size={11} /> 附件
                <input
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    handleFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
              {activeFile && (
                <button
                  type="button"
                  className="chip add"
                  title={`把当前文件 ${activeFile.path} 加进上下文`}
                  onClick={() => attachPath(activeFile.path, 'tab')}
                >
                  当前文件
                </button>
              )}
            </div>
            <button className="chip" onClick={() => setInput((v) => v + '/mem ')} title="查看记忆">
              /mem
            </button>
            <button
              className={`chip ${settings.autoMemory ? 'on' : ''}`}
              onClick={() => {
                dispatch({ type: 'settings/set', patch: { autoMemory: !settings.autoMemory } });
                toast(settings.autoMemory ? '已关闭自动记忆' : '已开启自动记忆');
              }}
              title="自动从对话中蒸馏记忆"
            >
              自动记忆
            </button>
          </div>
        </div>
        {busy > 0 && (
          <div className="composer-busy">
            <span className="dot" /> 正在读取 {busy} 个引用…
          </div>
        )}
      </div>

      <div className="composer-hint">
        <span>
          模型：{settings.mode === 'api' ? `${settings.provider === 'server' ? 'DeepSeek（服务端）' : '自定义 API'} · ${settings.model}` : '本地规则引擎'}
        </span>
        <span className={`mode-note ${settings.agentMode === 'plan' ? 'plan' : ''}`}>
          {MODE_META[settings.agentMode || 'agent'].name} 模式 · {MODE_META[settings.agentMode || 'agent'].hint}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <IconChat size={10} /> {messageCount} 轮
        </span>
      </div>

      {preview &&
        createPreview(preview, () => setPreview(null))}
    </div>
  );
}

/** 引用预览：点 chip 就地看内容（不跳编辑器，避免打断正在写的这句话） */
function createPreview(ref, onClose) {
  const body = ref.binary
    ? `（二进制文件 ${formatSize(ref.size)}，没有可显示的正文；发送时也只附路径与大小）`
    : ref.content?.slice(0, 4000) || '（没有内容）';
  return (
    <div className="ref-preview-mask" onClick={onClose}>
      <div className="ref-preview" onClick={(e) => e.stopPropagation()}>
        <div className="ref-preview-head">
          <span className={`ref-type ${ref.type}`}>{originLabel(ref)}</span>
          <b>{ref.path}</b>
          <span className="ref-preview-meta">
            {refMeta(ref)} · ≈{estimateTokens(ref.chars)} tok
          </span>
          <button type="button" className="link-btn" onClick={onClose}>
            关闭
          </button>
        </div>
        <pre className="ref-preview-body">{body}</pre>
        {!ref.binary && ref.chars > 4000 && (
          <div className="ref-preview-note">只显示前 4000 字符（共 {ref.chars}）；发送时会按预算再裁剪。</div>
        )}
      </div>
    </div>
  );
}
