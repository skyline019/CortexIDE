import React, { useMemo, useState } from 'react';
import { planSummary, planToMarkdown, buildPlan } from '../lib/plan.js';
import { createTools } from '../lib/agent.js';
import { useApp } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';

/**
 * Plan 卡：把模型的 ```plan 块变成「能点的东西」。
 *
 * 三件事：
 *  1) 展示每一步（工具、目标、为什么、预期），并把「写文件 / 执行命令」标成风险色；
 *  2) 「构建计划」= 按顺序真的调工具（不是再问一遍模型），每步状态实时更新；
 *  3) 「存档」= 把计划写成 markdown 落盘到 .cortex/plans/，可以进 git、贴 issue。
 *
 * 不做的：不替用户确认就执行写/执行类步骤 —— 命令会走全局确认卡（和 Agent 模式同一条路）。
 */
const TOOL_LABEL = {
  read_file: '读文件',
  write_file: '写文件',
  list_files: '列目录',
  search_files: '搜索',
  run_command: '执行命令',
  recall: '记忆检索',
};

export default function PlanCard({ plan, error, note, mode = 'plan' }) {
  const { state, ops } = useApp();
  const toast = useToast();
  const [status, setStatus] = useState({}); // stepId → {state:'run'|'ok'|'fail', detail, ms}
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState(null);
  const [saved, setSaved] = useState(null);
  const summary = useMemo(() => planSummary(plan), [plan]);

  if (!plan) {
    return (
      <div className="plan-card bad">
        <div className="plan-head">
          <span className="plan-badge">PLAN</span>
          <b>没拿到可执行的计划</b>
        </div>
        <div className="plan-err">{error || '模型没有按格式输出 ```plan 代码块。'}</div>
        <div className="plan-hint">可以点「重试」，或切到 Agent 模式直接让它动手。</div>
      </div>
    );
  }

  const build = async () => {
    setBusy(true);
    setBuilt(null);
    const tools = createTools({
      data: { files: state.files, activeFileId: state.activeFileId, memories: state.memories },
      ops,
      provider: state.settings.embedProvider || 'auto',
      approval: (cmd, reason) => ops.requestApproval({ cmd, reason }),
    });
    try {
      const res = await buildPlan({
        steps: plan.steps,
        tools,
        onStep: ({ phase, step, result }) => {
          setStatus((prev) => ({
            ...prev,
            [step.id]:
              phase === 'start'
                ? { state: 'run' }
                : { state: result.ok ? 'ok' : 'fail', detail: result.detail, ms: result.ms },
          }));
        },
        onWrite: async (path) => {
          try {
            await ops.openPath(path);
          } catch {
            /* 打开失败不影响构建结果 */
          }
        },
      });
      setBuilt(res);
      const failed = res.results.filter((r) => !r.ok);
      if (res.ok) toast(`计划已构建：${res.ran}/${res.total} 步全部成功`, 'ok');
      else toast(`第 ${res.ran} 步失败：${failed[0]?.detail || '未知原因'}`, 'err');
    } catch (err) {
      setBuilt({ ok: false, error: err.message, results: [], ran: 0, total: plan.steps.length });
      toast(`构建失败：${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = `.cortex/plans/${stamp}.md`;
    try {
      await ops.writeFile(path, planToMarkdown(plan, { mode }));
      setSaved(path);
      toast(`计划已存到 ${path}`, 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    }
  };

  return (
    <div className="plan-card">
      <div className="plan-head">
        <span className="plan-badge">PLAN</span>
        <b>{plan.goal}</b>
        <span className="spacer" />
        <span className="plan-stat">
          {summary.steps} 步 · 只读 {summary.reads} · 写 {summary.writes} · 命令 {summary.commands}
        </span>
      </div>

      {note ? <div className="plan-warn">{note}。请确认要不要补全后再构建。</div> : null}

      <ol className="plan-steps">
        {plan.steps.map((s) => {
          const st = status[s.id];
          return (
            <li key={s.id} className={`plan-step ${s.risky ? 'risky' : ''} ${st ? st.state : ''}`}>
              <div className="plan-step-head">
                <span className="plan-step-no">{s.id}</span>
                <span className="plan-step-title">{s.title}</span>
                <span className={`plan-tool ${s.risky ? 'risky' : ''}`}>{TOOL_LABEL[s.tool] || s.tool}</span>
                {st?.state === 'run' && <span className="plan-step-st">执行中…</span>}
                {st?.state === 'ok' && <span className="plan-step-st ok">✓ {st.ms}ms</span>}
                {st?.state === 'fail' && <span className="plan-step-st fail">✗ 失败</span>}
              </div>
              <div className="plan-step-target">
                <code>{s.args?.path || s.args?.cmd || s.args?.query || '—'}</code>
              </div>
              {s.why ? <div className="plan-step-why">{s.why}</div> : null}
              {st?.detail ? <div className={`plan-step-detail ${st.state}`}>{st.detail}</div> : null}
            </li>
          );
        })}
      </ol>

      {built ? (
        <div className={`plan-built ${built.ok ? 'ok' : 'fail'}`}>
          {built.ok
            ? `构建完成：${built.ran}/${built.total} 步全部成功`
            : `构建中断：跑了 ${built.ran}/${built.total} 步 —— ${built.results.find((r) => !r.ok)?.detail || built.error || '已中止'}`}
        </div>
      ) : null}

      <div className="plan-actions">
        <button className="btn primary sm" disabled={busy} onClick={build}>
          {busy ? '正在构建…' : built ? '再构建一次' : '构建计划'}
        </button>
        <button className="btn sm" onClick={save} disabled={busy}>
          {saved ? '已存档 ✓' : '存为 Markdown'}
        </button>
        <button
          className="btn sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(plan, null, 2));
              toast('计划 JSON 已复制');
            } catch {
              toast('复制失败：浏览器拒绝了剪贴板权限', 'err');
            }
          }}
        >
          复制 JSON
        </button>
        <span className="plan-foot">
          {summary.risky
            ? `含 ${summary.risky} 个会改磁盘的步骤；构建时执行命令仍需你确认`
            : '全是只读步骤，可以放心构建'}
        </span>
      </div>
    </div>
  );
}
