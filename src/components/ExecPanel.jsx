import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { IconPlay, IconStop } from './Icons.jsx';

/** 迷你耗时趋势图（近 N 次执行的毫秒数） */
function Sparkline({ data = [], width = 220, height = 34 }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`);
  const last = data[data.length - 1];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={`0,${height} ${pts.join(' ')} ${width},${height}`} className="spark-fill" />
      <polyline points={pts.join(' ')} className="spark-line" />
      <circle cx={pts[pts.length - 1].split(',')[0]} cy={pts[pts.length - 1].split(',')[1]} r="2" className="spark-dot" />
      <title>{`最近 ${data.length} 次 · 峰值 ${max}ms · 最近 ${last}ms`}</title>
    </svg>
  );
}

export default function ExecPanel() {
  const { state, ops } = useApp();
  const toast = useToast();
  const [presets, setPresets] = useState([]);
  const [sandbox, setSandbox] = useState(false);
  const [sbMode] = useState(null); // 服务端探测：有 docker 就用真容器（只读展示）
  const [busy, setBusy] = useState(null);
  const [stats, setStats] = useState(null);

  const loadPresets = async () => {
    try {
      const res = await fetch('/api/exec/presets');
      const json = await res.json();
      setPresets(json.presets || []);
    } catch {
      setPresets([]);
    }
  };
  const loadStats = async () => {
    try {
      setStats(await (await fetch('/api/exec/stats')).json());
    } catch {
      setStats(null);
    }
  };

  useEffect(() => {
    loadPresets();
    loadStats();
  }, []);

  useEffect(() => {
    loadStats();
  }, [state.execLog.length]);

  const recent = useMemo(() => (stats?.recent || []).slice(0, 24).map((r) => r.ms).reverse(), [stats]);

  const run = async (preset) => {
    setBusy(preset.id);
    try {
      const res = await ops.execCommand(preset.cmd, { sandbox: sandbox || preset.sandbox });
      if (res.blocked || res.error) toast(`已拒绝：${res.error}`, 'err');
      else toast(`${preset.name} · 退出码 ${res.code} · ${res.ms}ms`, res.code === 0 ? 'ok' : 'err');
      loadStats();
    } catch (err) {
      toast(`执行失败：${err.message}`, 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="exec-panel">
      <div className="exec-presets">
        {presets.map((p) => (
          <button
            key={p.id}
            className={`preset ${busy === p.id ? 'busy' : ''}`}
            disabled={Boolean(busy)}
            onClick={() => run(p)}
            title={`${p.cmd}${p.sandbox ? '（默认在沙箱副本里跑）' : ''}`}
          >
            {busy === p.id ? <IconStop size={9} /> : <IconPlay size={9} />}
            {p.name}
            {p.sandbox ? <i className="sb">沙箱</i> : null}
          </button>
        ))}
        <div className="spacer" />
        <label className={`exec-sandbox ${sandbox ? 'on' : ''}`} title="在 .cortex/sandbox/ 的一次性副本里执行，改动不落到真实工作区">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
          沙箱执行
          {sbMode ? (
            <span
              className={`sb-mode ${sbMode.defaultMode === 'docker' ? 'docker' : 'copy'}`}
              title={
                sbMode.defaultMode === 'docker'
                  ? `docker ${sbMode.docker.version} · 镜像 ${sbMode.image} · 无网络 + 一次性副本`
                  : `docker 不可用（${sbMode.docker?.reason || '未安装'}），退回文件系统副本`
              }
            >
              {sbMode.defaultMode === 'docker' ? '容器' : '副本'}
            </span>
          ) : null}
        </label>
      </div>

      {stats && (
        <div className="exec-stats">
          <span>
            共 {stats.total} 次 · 成功 {stats.ok} · 失败 {stats.failed} · 拦截 {stats.blocked}
          </span>
          <span className="ms">
            p50 {stats.p50 ?? '—'}ms · p95 {stats.p95 ?? '—'}ms
          </span>
          <Sparkline data={recent} />
        </div>
      )}

      <div className="exec-log">
        {state.execLog.length ? (
          state.execLog.map((e) => (
            <div key={e.id} className={`log-line ${e.blocked ? 'error' : e.code === 0 ? 'tool' : 'error'}`}>
              <span className="t">{new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              <span style={{ minWidth: 66, color: 'var(--fg-mute)' }}>
                {e.blocked ? 'DENIED' : e.code === 0 ? 'EXIT 0' : `EXIT ${e.code ?? '?'}`}
              </span>
              <code style={{ fontFamily: 'var(--mono)' }}>$ {e.cmd}</code>
              {e.sandbox && <span className="sb-badge">沙箱</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--fg-mute)' }}>
                {e.blocked ? (e.error || '').slice(0, 46) : `${e.ms}ms${e.matched ? ` · 命中 ${e.matched}` : ''}`}
              </span>
            </div>
          ))
        ) : (
          <div className="log-line">还没有执行过命令。点上面的预设、或让 Agent 改完代码后跑测试。</div>
        )}
      </div>
    </div>
  );
}
