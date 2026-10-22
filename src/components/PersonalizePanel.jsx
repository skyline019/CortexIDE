import React, { useCallback, useEffect, useState } from 'react';
import { useToast } from '../state/toast.jsx';

/**
 * 个性化 · 省 token
 *
 * 界面里所有数字都来自真实请求：
 * - 「原始 / 实际」是服务端压缩前后的估算值，「真实 prompt」是上游返回的 usage.prompt_tokens
 * - 「估算误差」= 估算 vs 真实，用来判断估算器可信不可信（样本够了会自动拟合系数）
 * - 文风画像只统计用户自己发过的话，不调模型、不偷偷打分
 */

const STRENGTH_LABEL = { off: '关闭', light: '轻', balanced: '均衡', aggressive: '激进' };

export default function PersonalizePanel({ userId = 'local' }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/llm/compress?user=${encodeURIComponent(userId)}`, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const setStrength = async (strength) => {
    setBusy(strength);
    try {
      await fetch('/api/llm/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strength }),
      });
      await load();
      toast(`压缩强度：${STRENGTH_LABEL[strength]}`, 'ok');
    } finally {
      setBusy('');
    }
  };

  const toggleStyle = async () => {
    setBusy('style');
    try {
      await fetch('/api/llm/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleEnabled: !data?.config?.styleEnabled }),
      });
      await load();
    } finally {
      setBusy('');
    }
  };

  const resetStyle = async () => {
    setBusy('reset');
    try {
      await fetch(`/api/llm/style?user=${encodeURIComponent(userId)}&reset=1`);
      await load();
      toast('文风画像已清空，会从接下来的对话重新学', 'ok');
    } finally {
      setBusy('');
    }
  };

  const t = data?.totals;
  const tk = data?.tokenizer;
  const st = data?.style;

  return (
    <div>
      <label>回答个性化 · token 压缩</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {['off', 'light', 'balanced', 'aggressive'].map((k) => (
          <button
            key={k}
            className={`btn sm ${data?.config?.strength === k ? 'primary' : ''}`}
            disabled={!!busy || !data}
            onClick={() => setStrength(k)}
          >
            {STRENGTH_LABEL[k]}
          </button>
        ))}
        <button className={`btn sm ${data?.config?.styleEnabled ? 'primary' : ''}`} disabled={!!busy || !data} onClick={toggleStyle}>
          文风卡：{data?.config?.styleEnabled ? '开' : '关'}
        </button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        {err ? <span className="bad">读取失败：{err}</span> : null}
        {data ? (
          <>
            <div>
              压缩发生在发给模型之前（服务端）：工具回传按「相关行 + 头尾 + 关键符号索引」压，老历史抽成摘要，
              重复内容只留一份；永远不会删消息，所以不会破坏 tool_call 配对。
            </div>
            <div>
              累计：{t.requests} 次请求 · 估算 {t.beforeTokens.toLocaleString()} → {t.afterTokens.toLocaleString()} token
              {t.beforeTokens ? `（省 ${t.savedPct}%）` : ''} · 上游真实 prompt 合计 {t.actualPromptTokens.toLocaleString()} token
              {t.actualCacheHitTokens ? `（其中缓存命中 ${t.actualCacheHitTokens.toLocaleString()}）` : ''}
            </div>
          </>
        ) : null}
      </div>

      <div style={{ marginTop: 14 }}>
        <label>token 估算器（用真实 usage 在线拟合）</label>
        <div className="hint">
          {tk ? (
            <>
              <div>
                样本 {tk.samples} 条{tk.calibrated ? ' · 已校准' : ' · 样本不足，先用经验系数'}
                {tk.meanAbsErr != null ? ` · 平均绝对误差 ${tk.meanAbsErr}%（${tk.meanSignedErr > 0 ? '偏高' : '偏低'} ${Math.abs(tk.meanSignedErr)}%）` : ''}
              </div>
              <div>
                系数：汉字 {tk.weights.cjk} · 拉丁 {tk.weights.latin} · 标点 {tk.weights.punct} · 换行 {tk.weights.newline} · 每条消息 {tk.weights.perMsg}
              </div>
              <div>
                最近一次：估 {tk.lastPredict} / 真实 {tk.lastActual}
              </div>
            </>
          ) : (
            '读取中…'
          )}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label>个人文风画像（只统计你自己发过的话）</label>
        <div className="hint">
          {st && st.samples ? (
            <>
              <div className="stat-grid">
                <span>
                  <b>{st.samples}</b> 条样本
                </span>
                <span>
                  平均 <b>{st.avgLen}</b> 字（中位 {st.p50Len}）
                </span>
                <span>
                  中文 <b>{Math.round((st.cjkRatio || 0) * 100)}%</b>
                </span>
                <span>
                  提问率 <b>{Math.round((st.questionRate || 0) * 100)}%</b>
                </span>
                <span>
                  习惯：简洁 {st.signals.brief} · 详细 {st.signals.detail} · 表格 {st.signals.table} · 列表 {st.signals.list} · 代码{' '}
                  {st.signals.code}
                </span>
              </div>
              <div style={{ marginTop: 4 }}>
                {st.terms?.length ? (
                  <>
                    他反复用的词：
                    {st.terms.slice(0, 8).map((x) => (
                      <span key={x.term} className="tag-mini">
                        {x.term}×{x.count}
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="hint">还没出现重复≥2 次的行话（工具名、文件名不算个人用词，已过滤）</span>
                )}
              </div>
              <div style={{ marginTop: 6 }}>
                注入模型的文风卡（{st.cardChars} 字符{st.card ? ` / ≈${Math.round(st.cardChars * 0.5)} token` : ''}）：
              </div>
              <pre className="hint-card">{st.card || '（样本还不够，攒到 3 条提问后自动生成）'}</pre>
            </>
          ) : (
            <div>还没有样本：在这个用户下发几轮消息，就会自动学出来。</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn sm" disabled={!!busy || !st?.samples} onClick={resetStyle}>
              清空文风画像
            </button>
            <button className="btn sm" disabled={!!busy} onClick={load}>
              刷新
            </button>
            <button
              className="btn sm"
              disabled={!st?.card}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(st.card);
                  toast('文风卡已复制');
                } catch {
                  toast('复制失败：浏览器不允许访问剪贴板');
                }
              }}
            >
              复制文风卡
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label>最近请求（压缩前 → 压缩后 / 上游真实 prompt）</label>
        <div className="hint">
          {data?.recent?.length ? (
            <table className="kv-table">
              <thead>
                <tr>
                  <th>原始</th>
                  <th>实际发送</th>
                  <th>省</th>
                  <th>真实 prompt</th>
                  <th>估算误差</th>
                  <th title="这一轮压缩主要靠哪一步省下来的">主要来源</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r, i) => {
                  const stages = r.stages || {};
                  const top = Object.entries(stages)
                    .filter(([k, v]) => k !== 'style' && v)
                    .sort((a, b) => b[1] - a[1])[0];
                  // 负值 = 这一轮反而变长了（短消息被追加了文风卡）。如实标出来，
                  // 不拿「平均省 43%」把个别变长的轮次盖过去。
                  const label = r.savedPct < 0
                    ? `文风卡 +${Math.max(0, stages.style || 0).toLocaleString()} token（短消息净亏）`
                    : { tool: '工具回传', history: '历史摘要', dedupe: '去重', reread: '重读去旧', budget: '预算兜底' }[top?.[0]]
                      || (r.savedPct > 0 ? '未分类（旧记录）' : '—');
                  return (
                    <tr key={`${r.at}-${i}`}>
                      <td>{r.beforeTokens.toLocaleString()}</td>
                      <td>{r.afterTokens.toLocaleString()}</td>
                      <td className={r.savedPct < 0 ? 'bad' : undefined}>
                        {r.savedPct > 0 ? `${r.savedPct}%` : r.savedPct < 0 ? `增 ${Math.abs(r.savedPct)}%` : '—'}
                      </td>
                      <td>{r.actualPrompt ?? '—'}</td>
                      <td>{r.estErrPct != null ? `${r.estErrPct > 0 ? '+' : ''}${r.estErrPct}%` : '—'}</td>
                      <td>{label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div>还没有请求：发一条消息就会出现在这里。</div>
          )}
        </div>
      </div>
    </div>
  );
}
