import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { KINDS, KIND_LIST, makeMemory, recall, memoryStats, exportMemories } from '../lib/memory.js';
import { subscribe as subscribeVector, getState as getVectorState, ensureIndex, clearIndex, warmup } from '../lib/retrieval.js';
import { IconClose, IconPin, IconTrash, IconDownload, IconUpload, IconPlus, IconBrain } from './Icons.jsx';

const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const BUDGET_CHARS = 2000;

function Stars({ n, onChange }) {
  return (
    <span className="stars" style={{ cursor: onChange ? 'pointer' : 'default', fontSize: 12 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= n ? '' : 'off'} onClick={() => onChange?.(i)}>
          ★
        </span>
      ))}
    </span>
  );
}

function ScoreRow({ label, value }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="score-row">
      <span className="lab">{label}</span>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="num">{value.toFixed(2)}</span>
    </div>
  );
}

function Inspector({ selected, query, memories, onPatch, onDelete, vector }) {
  const stats = useMemo(() => memoryStats(memories), [memories]);

  const [budgetMemories, setBudgetMemories] = useState(() =>
    [...memories].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt).slice(0, 6),
  );

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    if (!q) {
      setBudgetMemories([...memories].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt).slice(0, 6));
      return () => {
        alive = false;
      };
    }
    recall(q, memories, { k: 6 })
      .then((r) => alive && setBudgetMemories(r.results))
      .catch(() => alive && setBudgetMemories([]));
    return () => {
      alive = false;
    };
  }, [query, memories]);

  const usedChars = budgetMemories.reduce((s, m) => s + m.text.length, 0);
  const pct = Math.min(1, usedChars / BUDGET_CHARS);
  const ringDeg = Math.round(pct * 360);

  const [breakdown, setBreakdown] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!selected) {
      setBreakdown(null);
      return () => {
        alive = false;
      };
    }
    const q = query.trim() || selected.text;
    recall(q, memories, { k: 99, minScore: 0 })
      .then((r) => {
        if (!alive) return;
        const hit = r.results.find((x) => x.id === selected.id);
        const sim = hit?.sim ?? 0;
        const match = hit?.match ?? 0;
        const imp = selected.importance / 5;
        const ageDays = (Date.now() - (selected.updatedAt || Date.now())) / 86400000;
        const recency = 1 / (1 + ageDays / 7);
        const freq = Math.min(1, Math.log(1 + (selected.uses || 0)) / Math.log(11));
        setBreakdown({
          sim,
          match,
          imp,
          recency,
          freq,
          score: 0.62 * match + 0.18 * imp + 0.12 * recency + 0.08 * freq,
          engine: r.engine,
          dim: r.dim,
        });
      })
      .catch(() => alive && setBreakdown(null));
    return () => {
      alive = false;
    };
  }, [selected, query, memories]);

  return (
    <div className="inspector">
      <div className="ins-head">
        <IconBrain size={13} />
        {selected ? '记忆详情' : '记忆概览'}
      </div>
      <div className="ins-body">
        {selected ? (
          <>
            <div className="ins-section">
              <div className="ins-title">
                内容 <span className="line" />
              </div>
              <textarea
                value={selected.text}
                rows={4}
                style={{ width: '100%', fontSize: 12, lineHeight: 1.6 }}
                onChange={(e) => onPatch(selected.id, { text: e.target.value })}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <select
                  value={selected.kind}
                  onChange={(e) => onPatch(selected.id, { kind: e.target.value })}
                  style={{ fontSize: 11.5, padding: '4px 6px' }}
                >
                  {KIND_LIST.map((k) => (
                    <option key={k} value={k}>
                      {KINDS[k].label}
                    </option>
                  ))}
                </select>
                <button className="btn sm" onClick={() => onPatch(selected.id, { pinned: !selected.pinned })}>
                  <IconPin size={11} /> {selected.pinned ? '取消置顶' : '置顶'}
                </button>
                <button className="btn sm danger" onClick={() => onDelete(selected.id)}>
                  <IconTrash size={11} /> 删除
                </button>
              </div>
            </div>

            <div className="ins-section">
              <div className="ins-title">
                权重 <span className="line" />
              </div>
              <div className="kv">
                <span className="k">重要度</span>
                <Stars n={selected.importance} onChange={(n) => onPatch(selected.id, { importance: n })} />
              </div>
              <div className="kv">
                <span className="k">被检索次数</span>
                <span className="v">{selected.uses || 0}</span>
              </div>
              <div className="kv">
                <span className="k">来源</span>
                <span className="v">{selected.source}</span>
              </div>
              <div className="kv">
                <span className="k">创建</span>
                <span className="v">{fmt(selected.createdAt)}</span>
              </div>
              <div className="kv">
                <span className="k">最后更新</span>
                <span className="v">{fmt(selected.updatedAt)}</span>
              </div>
              {selected.mergedCount > 1 && (
                <div className="kv">
                  <span className="k">合并次数</span>
                  <span className="v">{selected.mergedCount}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
                {(selected.tags || []).map((t) => (
                  <span key={t} className="tag" style={{ fontSize: 10, padding: '1px 6px', borderRadius: 5, background: 'var(--bg-4)', color: 'var(--fg-dim)' }}>
                    #{t}
                  </span>
                ))}
                {!selected.tags?.length && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>无标签</span>}
              </div>
            </div>

            <div className="ins-section">
              <div className="ins-title">
                检索评分分解 <span className="line" />
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--fg-mute)', marginBottom: 8 }}>
                query = {query.trim() || '（当前记忆原文）'}
              </div>
              {breakdown ? (
                <>
                  <ScoreRow label="匹配度(归一)" value={breakdown.match} />
                  <ScoreRow label="向量余弦" value={breakdown.sim} />
                  <ScoreRow label="重要度" value={breakdown.imp} />
                  <ScoreRow label="时间新鲜度" value={breakdown.recency} />
                  <ScoreRow label="使用频次" value={breakdown.freq} />
                </>
              ) : (
                <div className="ins-empty">计算中…</div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line-soft)', fontSize: 12 }}>
                <span style={{ color: 'var(--fg-dim)' }}>综合得分</span>
                <b style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{breakdown ? breakdown.score.toFixed(3) : '—'}</b>
              </div>
              {breakdown && (
                <div style={{ fontSize: 10.5, color: 'var(--violet)', marginTop: 4 }}>
                  {breakdown.engine === 'lexical'
                    ? '词频检索（TF-IDF）'
                    : `${breakdown.engine === 'vector' ? '向量检索' : `向量检索 · ${breakdown.engine}`} · ${breakdown.dim} 维`}
                </div>
              )}
              <div style={{ fontSize: 10.5, color: 'var(--fg-mute)', marginTop: 6, lineHeight: 1.6 }}>
                0.62·匹配度 + 0.18·重要度 + 0.12·新鲜度 + 0.08·频次（匹配度 = 候选集内归一化的余弦相似度）
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="ins-section">
              <div className="ins-title">
                上下文预算 <span className="line" />
              </div>
              <div className="budget-ring">
                <div
                  className="ring"
                  style={{
                    background: `conic-gradient(var(--accent) ${ringDeg}deg, var(--bg-3) ${ringDeg}deg)`,
                  }}
                >
                  <div className="num">
                    <b>{Math.round(pct * 100)}%</b>
                    <small>已用</small>
                  </div>
                </div>
                <div className="legend">
                  <div className="li">
                    <i style={{ background: 'var(--accent)' }} />注入记忆
                    <span className="n">{budgetMemories.length}</span>
                  </div>
                  <div className="li">
                    <i style={{ background: 'var(--bg-4)' }} />字符占用
                    <span className="n">{usedChars}</span>
                  </div>
                  <div className="li">
                    <i style={{ background: 'var(--bg-4)' }} />预算上限
                    <span className="n">{BUDGET_CHARS}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="ins-section">
              <div className="ins-title">
                记忆构成 <span className="line" />
              </div>
              {KIND_LIST.map((k) => (
                <div key={k} className="score-row">
                  <span className="lab" style={{ color: KINDS[k].color }}>
                    {KINDS[k].label}
                  </span>
                  <span className="track">
                    <span
                      className="fill"
                      style={{
                        width: `${stats.total ? (stats.byKind[k] / stats.total) * 100 : 0}%`,
                        background: KINDS[k].color,
                      }}
                    />
                  </span>
                  <span className="num">{stats.byKind[k]}</span>
                </div>
              ))}
              <div className="kv" style={{ marginTop: 6 }}>
                <span className="k">平均重要度</span>
                <span className="v">{stats.avgImportance} / 5</span>
              </div>
              <div className="kv">
                <span className="k">累计检索命中</span>
                <span className="v">{stats.uses}</span>
              </div>
              <div className="kv">
                <span className="k">今日新增</span>
                <span className="v">{stats.todayCount}</span>
              </div>
            </div>

            <div className="ins-section">
              <div className="ins-title">
                向量索引 <span className="line" />
              </div>
              <div className="kv">
                <span className="k">嵌入模型</span>
                <span className="v">{vector.provider === 'neural' ? vector.model?.id?.split('/').pop() : 'hash-n-gram'}</span>
              </div>
              <div className="kv">
                <span className="k">维度 / 向量数</span>
                <span className="v">{vector.dim || '—'}d · {vector.count}</span>
              </div>
              <div className="kv">
                <span className="k">索引内存</span>
                <span className="v">{vector.stats?.memoryMb ?? 0} MB</span>
              </div>
              <div className="kv">
                <span className="k">向量缓存</span>
                <span className="v">{vector.cache} 条</span>
              </div>
              <div className="kv">
                <span className="k">建索引耗时</span>
                <span className="v">{vector.embedMs ? `${vector.embedMs}ms` : '—'}</span>
              </div>
            </div>

            <div className="ins-section">
              <div className="ins-title">
                下一轮将注入的记忆 <span className="line" />
              </div>
              {budgetMemories.map((m) => (
                <div key={m.id} style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--fg-dim)', padding: '3px 0', lineHeight: 1.5 }}>
                  <span style={{ color: KINDS[m.kind].color }}>{KINDS[m.kind].glyph}</span>
                  <span style={{ flex: 1 }}>{m.text.slice(0, 46)}{m.text.length > 46 ? '…' : ''}</span>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--violet)' }}>{m.score ? m.score.toFixed(2) : `★${m.importance}`}</span>
                </div>
              ))}
              <div className="ins-empty" style={{ marginTop: 8 }}>
                点左侧任意记忆卡片，可以查看它的评分分解、调整重要度或改写内容。
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function MemoryModal({ onClose }) {
  const { state, dispatch, ops } = useApp();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [vector, setVector] = useState(() => getVectorState());
  useEffect(() => subscribeVector(setVector), []);
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState('fact');
  const fileRef = useRef(null);

  const { memories } = state;

  const baseList = useMemo(() => {
    const items = kind === 'all' ? memories : memories.filter((m) => m.kind === kind);
    return [...items].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.updatedAt - a.updatedAt,
    );
  }, [memories, kind]);

  const [ranked, setRanked] = useState(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setRanked(null);
      return undefined;
    }
    let alive = true;
    setSearching(true);
    recall(q, baseList, { k: 40, minScore: 0.01 })
      .then((r) => alive && setRanked(r.results))
      .catch(() => alive && setRanked([]))
      .finally(() => alive && setSearching(false));
    return () => {
      alive = false;
    };
  }, [query, baseList]);

  const list = query.trim() ? ranked || [] : baseList;

  const selected = memories.find((m) => m.id === selectedId) || null;

  const patch = (id, p) => dispatch({ type: 'mem/update', id, patch: p });
  const remove = (id) => {
    dispatch({ type: 'mem/delete', id });
    if (selectedId === id) setSelectedId(null);
    toast('已删除该条记忆');
  };

  const add = () => {
    if (!draft.trim()) return;
    const mem = makeMemory({ text: draft.trim(), kind: draftKind, importance: 4, source: 'manual', tags: [] });
    dispatch({ type: 'mem/set', memories: [mem, ...memories] });
    dispatch({ type: 'stats/bump', patch: { memoryWrites: 1 } });
    setDraft('');
    setAdding(false);
    setSelectedId(mem.id);
    toast('已写入长期记忆', 'mem');
  };

  const exportMd = () => {
    const md = exportMemories(memories);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cortex-memories-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${memories.length} 条记忆`);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cortex-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出 JSON 备份');
  };

  const importJson = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error('格式不正确');
      const merged = ops.addMemories(data.map((d) => ({ ...d, source: 'import' })));
      toast(`导入完成：新增 ${merged.added.length} 条，合并 ${merged.merged.length} 条`, 'mem');
    } catch (err) {
      toast(`导入失败：${err.message}`, 'err');
    }
    e.target.value = '';
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal memory-modal">
        <div className="modal-head">
          <h2>
            <IconBrain size={16} /> 长期记忆
          </h2>
          <span className="pill">
            <b>{memories.length}</b> 条 · 持久化于本机
          </span>
          <div className="spacer" />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            <IconUpload size={11} /> 导入
          </button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={importJson} />
          <button className="btn sm" onClick={exportJson}>
            <IconDownload size={11} /> JSON
          </button>
          <button className="btn sm" onClick={exportMd}>
            <IconDownload size={11} /> Markdown
          </button>
          <button className="icon-btn" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>

        <div className="mem-layout">
          <div className="mem-main">
            <div className="vector-bar">
              <span className={`vdot ${vector.state}`} />
              <b>{vector.provider === 'neural' ? '神经向量检索' : vector.provider === 'lexical' ? '本地哈希向量' : '初始化中'}</b>
              <span className="vmeta">
                {state.backend.status?.backend ? `服务端 ${state.backend.status.backend} ${state.backend.status.total} 条 · ` : ''}
                {vector.count} 条 · {vector.dim || '—'} 维
                {vector.provider === 'neural' ? ` · ${vector.model?.id?.split('/').pop()}` : ''}
                {vector.state === 'building' ? ` · 构建中 ${vector.progress}%` : ''}
                {vector.lastQueryMs ? ` · 最近查询 ${vector.lastQueryMs}ms` : ''}
              </span>
              {vector.state === 'building' && (
                <span className="vprogress">
                  <i style={{ width: `${vector.progress}%` }} />
                </span>
              )}
              <button
                className="btn sm"
                style={{ marginLeft: 'auto' }}
                onClick={async () => {
                  clearIndex();
                  await ensureIndex(memories, { force: true, provider: state.settings.embedProvider });
                  toast('向量索引已重建', 'mem');
                }}
              >
                重建索引
              </button>
              <button
                className="btn sm"
                onClick={async () => {
                  const r = await warmup(state.settings.embedProvider);
                  toast(r.provider === 'neural' ? '神经嵌入模型已就绪' : '已使用本地向量（模型不可用）', r.provider === 'neural' ? 'mem' : 'err');
                }}
              >
                加载模型
              </button>
            </div>
            <div className="mem-tools">
              <input
                placeholder="语义检索记忆，例如：接口约定 / 代码风格 / dnd-kit"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              />
              <button className="btn sm primary" onClick={() => setAdding((v) => !v)}>
                <IconPlus size={11} /> 新建
              </button>
            </div>

            {adding && (
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-2)' }}>
                <textarea
                  autoFocus
                  rows={2}
                  placeholder="要长期记住什么？例如：所有接口都要做 3 次重试"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
                  }}
                  style={{ width: '100%', fontSize: 12, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 7, alignItems: 'center' }}>
                  <select value={draftKind} onChange={(e) => setDraftKind(e.target.value)} style={{ fontSize: 11.5, padding: '3px 6px' }}>
                    {KIND_LIST.map((k) => (
                      <option key={k} value={k}>
                        {KINDS[k].label}
                      </option>
                    ))}
                  </select>
                  <span style={{ fontSize: 10.5, color: 'var(--fg-mute)' }}>⌘/Ctrl + Enter 保存</span>
                  <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={add}>
                    保存
                  </button>
                  <button className="btn sm" onClick={() => setAdding(false)}>
                    取消
                  </button>
                </div>
              </div>
            )}

            <div className="mem-tabs" style={{ padding: '8px 14px', borderBottom: '1px solid var(--line-soft)' }}>
              <button className={`mem-tab ${kind === 'all' ? 'active' : ''}`} onClick={() => setKind('all')}>
                全部 <span style={{ opacity: 0.6 }}>{memories.length}</span>
              </button>
              {KIND_LIST.map((k) => (
                <button key={k} className={`mem-tab ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
                  <span className="dot" style={{ background: KINDS[k].color }} />
                  {KINDS[k].label}
                  <span style={{ opacity: 0.6 }}>{memories.filter((m) => m.kind === k).length}</span>
                </button>
              ))}
              {query && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-mute)', alignSelf: 'center' }}>语义检索 · {list.length} 条</span>}
            </div>

            <div className="mem-list">
              {list.map((m) => (
                <div
                  key={m.id}
                  className={`mem-card ${selectedId === m.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span className="bar" style={{ background: KINDS[m.kind].color }} />
                  <div className="top">
                    <span className="mem-kind" style={{ color: KINDS[m.kind].color }}>
                      {KINDS[m.kind].label}
                    </span>
                    {m.pinned && <span title="置顶">📌</span>}
                    <Stars n={m.importance} />
                    {m.score != null && (
                      <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--violet)' }}>
                        score {m.score.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="text">{m.text}</div>
                  <div className="meta">
                    {m.tags?.map((t) => (
                      <span key={t} className="tag">
                        #{t}
                      </span>
                    ))}
                    <span>用 {m.uses || 0} 次</span>
                    <span>{fmt(m.updatedAt)}</span>
                  </div>
                  <div className="actions">
                    <button
                      className="btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        patch(m.id, { pinned: !m.pinned });
                      }}
                    >
                      <IconPin size={10} />
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(m.id);
                      }}
                    >
                      <IconTrash size={10} />
                    </button>
                  </div>
                </div>
              ))}
              {searching && <div className="ins-empty" style={{ padding: '20px 0', textAlign: 'center' }}>向量检索中…</div>}
              {!searching && !list.length && (
                <div className="ins-empty" style={{ textAlign: 'center', padding: '40px 0' }}>
                  {query ? `没有和「${query}」相关的记忆` : '还没有记忆，点右上角「新建」写一条'}
                </div>
              )}
            </div>
          </div>

          <Inspector
            selected={selected}
            query={query}
            memories={memories}
            onPatch={patch}
            onDelete={remove}
            vector={vector}
          />
        </div>
      </div>
    </div>
  );
}
