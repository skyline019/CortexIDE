import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { IconClose, IconShield } from './Icons.jsx';

/** 允许的命令前缀（只做展示提醒，真实校验在服务端） */
const RISK = [
  { re: /\b(rm|del|rmdir)\b/, level: 'high', why: '删除类命令' },
  { re: /\b(sudo|su)\b/, level: 'high', why: '提权' },
  { re: /\b(git\s+(push|reset|checkout\s+--|clean))\b/, level: 'mid', why: '会改动仓库历史' },
  { re: /(\||&&|;|`|\$\()/, level: 'high', why: '包含 shell 拼接，服务端会直接拒绝' },
];

function assess(cmd) {
  for (const r of RISK) if (r.re.test(cmd)) return r;
  return null;
}

/** 命令审批卡：Agent 想执行命令时弹出 */
export default function CommandApproval() {
  const { state, ops } = useApp();
  const toast = useToast();
  const item = state.approvals[0];
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!item) return;
    setBusy(false);
    setElapsed(0);
    btnRef.current?.focus();
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [item?.id]);

  const risk = useMemo(() => (item ? assess(item.cmd) : null), [item?.cmd]);

  useEffect(() => {
    if (!item) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') ops.resolveApproval(item.id, 'deny');
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ops.resolveApproval(item.id, 'allow');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item?.id]);

  if (!item) return null;

  const decide = async (decision) => {
    if (decision === 'always') {
      setBusy(true);
      const list = await ops.allowCommand(item.cmd);
      toast(list.length ? `已加入白名单，下次不再询问` : '白名单更新失败', list.length ? 'ok' : 'err');
    }
    ops.resolveApproval(item.id, decision);
  };

  return (
    <div className="overlay approval-overlay">
      <div className="approval-card" role="dialog" aria-modal="true">
        <div className="approval-head">
          <IconShield size={15} />
          <b>Agent 请求执行命令</b>
          <span className="spacer" />
          <span className="approval-count">{state.approvals.length > 1 ? `还有 ${state.approvals.length - 1} 条待确认` : `${elapsed}s`}</span>
          <button className="icon-btn" onClick={() => ops.resolveApproval(item.id, 'deny')} title="拒绝 (Esc)">
            <IconClose size={14} />
          </button>
        </div>

        {item.reason ? <div className="approval-reason">{item.reason}</div> : null}

        <pre className="approval-cmd">{item.cmd}</pre>

        <div className={`approval-risk ${risk ? risk.level : 'low'}`}>
          {risk ? `⚠ ${risk.why}，请确认这是你期望的操作` : '✓ 命令格式正常，执行前会再校验白名单'}
        </div>

        <div className="approval-tip">
          服务端只放行白名单内的命令，且拒绝 <code>; | &amp; &gt; &lt; ` $(</code> 等 shell 元字符；
          命令以 argv 方式直接执行（不经过 shell），超时 120s 自动终止，全程写审计日志。
        </div>

        <div className="approval-actions">
          <button className="btn ghost" onClick={() => decide('deny')}>
            拒绝
          </button>
          <button className="btn ghost" onClick={() => decide('always')} disabled={busy}>
            始终允许
          </button>
          <button ref={btnRef} className="btn primary" onClick={() => decide('allow')}>
            执行 ⌘↵
          </button>
        </div>
      </div>
    </div>
  );
}
