import React, { useCallback, useEffect, useState } from 'react';
import { useToast } from '../state/toast.jsx';
import { IconClose, IconPlug, IconSync, IconSearch } from './Icons.jsx';

const api = async (path, body) => {
  const res = await fetch(`/api/ssh/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)}M` : n > 1024 ? `${Math.round(n / 1024)}k` : `${n}B`);

/**
 * SSH 远程工作区
 *
 * 走系统 ssh 客户端（BatchMode，无密码交互），常用操作：
 *   探活 → 列目录 → 看 git → 读文件 → 执行命令 → 开一个交互式 ssh 终端
 * 打开的 SSH 终端会作为「多标签终端」里的一个标签，和本地 shell 并排。
 */
export default function RemoteModal({ onClose }) {
  const toast = useToast();
  const [profiles, setProfiles] = useState([]);
  const [form, setForm] = useState({ user: 'user', host: '127.0.0.1', port: 22, root: '' });
  const [probe, setProbe] = useState(null);
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState([]);
  const [git, setGit] = useState(null);
  const [file, setFile] = useState(null);
  const [cmd, setCmd] = useState('git status --short');
  const [sync, setSync] = useState({ direction: 'pull', local: '', plan: null, result: null, busy: '' });
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState('');

  const target = () => ({ host: form.host, user: form.user, port: Number(form.port) || 22 });

  const loadProfiles = useCallback(async () => {
    try {
      const r = await api('profiles');
      setProfiles(r.profiles || []);
      if (r.profiles?.length) {
        const p = r.profiles[0];
        setForm({ user: p.user, host: p.host, port: p.port, root: p.root || '' });
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      setOut({ ok: false, stdout: '', stderr: err.message });
      return null;
    } finally {
      setBusy('');
    }
  };

  const doProbe = () =>
    run('probe', async () => {
      const r = await api('probe', target());
      setProbe(r);
      if (r.ok) {
        const start = form.root || r.home || '~';
        await browse(start);
        await loadGit(start);
        toast(`已连接 ${r.target}（${r.uname}）`, 'ok');
      } else {
        toast(r.error || '连接失败', 'err');
      }
      return r;
    });

  const browse = async (p) =>
    run('ls', async () => {
      const r = await api('ls', { ...target(), path: p || dir || form.root || '~' });
      if (!r.ok) {
        setOut({ ok: false, stdout: '', stderr: r.error || '列目录失败' });
        return;
      }
      setDir(r.path);
      setEntries(r.entries || []);
      return r;
    });

  const loadGit = async (p) =>
    run('git', async () => {
      const r = await api('git', { ...target(), path: p || dir || form.root || '~' });
      setGit(r);
      return r;
    });

  const openFile = async (name) =>
    run('read', async () => {
      const p = `${dir.replace(/\/$/, '')}/${name}`;
      const r = await api('read', { ...target(), file: p, root: form.root });
      setFile({ path: p, ...r });
      if (!r.ok) toast(r.error || '读取失败', 'err');
      return r;
    });

  const exec = async () => {
    if (!window.confirm(`在 ${form.user}@${form.host} 上执行：\n\n${cmd}\n\n继续？`)) return;
    await run('exec', async () => {
      const r = await api('exec', { ...target(), cwd: dir || form.root || '~', cmd });
      setOut(r);
      return r;
    });
  };

  const saveProfile = () =>
    run('save', async () => {
      const r = await api('profiles', { ...target(), root: dir || form.root, label: `${form.user}@${form.host}` });
      setProfiles(r.profiles || []);
      toast('已保存连接', 'ok');
    });

  const localDefault = () => new URL(window.location.href).searchParams.get('x') || '.cortex/remote/sync';

  const doSync = async (dryRun) => {
    setSync((v) => ({ ...v, busy: dryRun ? 'plan' : 'run' }));
    try {
      const r = await fetch('/api/ssh/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...target(),
          path: dir || form.root || '~',
          local: sync.local || localDefault(),
          direction: sync.direction,
          dryRun,
        }),
      }).then((x) => x.json());
      if (r.error) toast(r.error, 'err');
      setSync((v) => (dryRun ? { ...v, plan: r, busy: '' } : { ...v, result: r, busy: '' }));
    } catch (e) {
      toast(e.message, 'err');
      setSync((v) => ({ ...v, busy: '' }));
    }
  };

  const openTerminal = () => {
    window.dispatchEvent(
      new CustomEvent('cortex:term-new-ssh', {
        detail: { target: `${form.user}@${form.host}`, port: Number(form.port) || 22, root: dir },
      }),
    );
    toast('已在底部终端新建 SSH 标签', 'ok');
    onClose();
  };

  const parent = dir && dir !== '/' ? dir.replace(/\/[^/]+\/?$/, '') || '/' : '';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal remote-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <IconPlug size={13} />
          <span>SSH 远程工作区</span>
          <div className="grow" />
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose size={12} />
          </button>
        </div>

        <div className="modal-body remote-body">
          <div className="rm-form">
            <input placeholder="user" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
            <input placeholder="host / ip" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            <input
              placeholder="端口"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: e.target.value.replace(/[^\d]/g, '') })}
              style={{ width: 64 }}
            />
            <button className="btn sm primary" disabled={!!busy} onClick={doProbe}>
              {busy === 'probe' ? '连接中…' : '连接'}
            </button>
            <button className="btn sm" disabled={!!busy} onClick={saveProfile}>
              保存
            </button>
            <button className="btn sm" onClick={openTerminal} title="在底部多标签终端里开一个交互式 ssh 会话">
              终端
            </button>
          </div>

          {profiles.length > 0 && (
            <div className="rm-profiles">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  className="rm-profile"
                  onClick={() => setForm({ user: p.user, host: p.host, port: p.port, root: p.root || '' })}
                  title={`${p.user}@${p.host}:${p.port}${p.root ? ` · ${p.root}` : ''}`}
                >
                  {p.label}
                  <span
                    className="rm-del"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const r = await api('profiles', { remove: p.id });
                      setProfiles(r.profiles || []);
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}

          {probe && (
            <div className={`rm-probe ${probe.ok ? 'ok' : 'bad'}`}>
              {probe.ok ? (
                <>
                  已连接 <b>{probe.target}</b> · {probe.uname} · home <code>{probe.home}</code> · {probe.ms}ms
                </>
              ) : (
                <>连接失败：{probe.error}</>
              )}
            </div>
          )}

          {probe?.ok && (
            <div className="rm-grid">
              <div className="rm-files">
                <div className="rm-head">
                  <button className="icon-btn" disabled={!parent} onClick={() => browse(parent)} title="上级目录">
                    ↑
                  </button>
                  <code className="rm-path">{dir}</code>
                  <button className="icon-btn" onClick={() => browse(dir)} title="刷新">
                    <IconSync size={11} />
                  </button>
                </div>
                <div className="rm-list">
                  {entries.map((e) => (
                    <div
                      key={e.name}
                      className={`rm-row ${e.dir ? 'dir' : ''}`}
                      onClick={() => (e.dir ? browse(`${dir.replace(/\/$/, '')}/${e.name}`) : openFile(e.name))}
                      title={e.dir ? '进入目录' : '查看内容'}
                    >
                      <span className="rm-ico">{e.dir ? '▸' : e.link ? '↗' : '·'}</span>
                      <span className="rm-name">{e.name}</span>
                      <span className="rm-meta">{e.dir ? '' : fmtSize(e.size)}</span>
                    </div>
                  ))}
                  {!entries.length && <div className="rm-empty">空目录 / 无权限</div>}
                </div>
              </div>

              <div className="rm-side">
                <div className="rm-head">
                  <span>git</span>
                  <div className="grow" />
                  <button className="icon-btn" onClick={() => loadGit(dir)} title="刷新 git">
                    <IconSync size={11} />
                  </button>
                </div>
                {git?.branch ? (
                  <div className="rm-git">
                    <div>
                      分支 <b>{git.branch}</b>
                      {git.ahead ? ` · ↑${git.ahead}` : ''}
                      {git.behind ? ` · ↓${git.behind}` : ''}
                    </div>
                    <div className="rm-changes">
                      {git.changes?.length ? (
                        git.changes.slice(0, 8).map((c) => <code key={c}>{c}</code>)
                      ) : (
                        <span className="rm-empty">工作区干净</span>
                      )}
                    </div>
                    {git.log?.length ? <div className="rm-log">{git.log.slice(0, 3).map((l) => <code key={l}>{l}</code>)}</div> : null}
                  </div>
                ) : (
                  <div className="rm-empty">这里不是 git 仓库，或不可读</div>
                )}

                <div className="rm-head" style={{ marginTop: 8 }}>
                  <span>远程命令</span>
                </div>
                <div className="rm-exec">
                  <input
                    value={cmd}
                    onChange={(e) => setCmd(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && exec()}
                    placeholder="例如 ls -la / npm test"
                  />
                  <button className="btn sm" disabled={!!busy} onClick={exec}>
                    {busy === 'exec' ? '执行中' : '执行'}
                  </button>
                </div>
                {out && (
                  <pre className={`rm-out ${out.ok ? '' : 'bad'}`}>
                    {out.stdout || out.stderr || '(无输出)'}
                  </pre>
                )}
              </div>
            </div>
          )}

          {probe?.ok && (
            <div className="rm-sync">
              <div className="rm-head">
                <span>增量同步（tar over ssh，不依赖 rsync）</span>
                <div className="grow" />
                <span className="rm-meta">远端 ⇄ 本地目录</span>
              </div>
              <div className="rm-sync-row">
                <select value={sync.direction} onChange={(e) => setSync({ ...sync, direction: e.target.value, plan: null, result: null })}>
                  <option value="pull">远端 → 本地</option>
                  <option value="push">本地 → 远端</option>
                </select>
                <input
                  placeholder="本地目录（默认 .cortex/remote/sync）"
                  value={sync.local}
                  onChange={(e) => setSync({ ...sync, local: e.target.value })}
                />
                <button className="btn sm" disabled={!!sync.busy} onClick={() => doSync(true)}>
                  {sync.busy === 'plan' ? '对比中…' : '预览差异'}
                </button>
                <button className="btn sm primary" disabled={!!sync.busy} onClick={() => doSync(false)}>
                  {sync.busy === 'run' ? '同步中…' : '开始同步'}
                </button>
              </div>
              {sync.plan && !sync.plan.error && (
                <div className="rm-sync-plan">
                  远端 {sync.plan.remoteFiles} 个文件 · 本地 {sync.plan.localFiles} 个 · 新增 {sync.plan.plan.added.length} / 修改{' '}
                  {sync.plan.plan.modified.length} / 仅本地 {sync.plan.plan.removed.length} ·{' '}
                  {(sync.plan.plan.bytes / 1024).toFixed(1)}KB
                  {[...sync.plan.plan.added, ...sync.plan.plan.modified].slice(0, 4).map((f) => (
                    <code key={f.path}>{f.path}</code>
                  ))}
                </div>
              )}
              {sync.result && (
                <div className={`rm-sync-result ${sync.result.ok ? 'ok' : 'bad'}`}>
                  {sync.result.ok
                    ? `已同步 ${sync.result.transferred} 个文件 · ${(sync.result.bytes / 1024).toFixed(1)}KB · ${sync.result.ms}ms · → ${sync.result.localDir}`
                    : `同步失败：${sync.result.error}`}
                </div>
              )}
            </div>
          )}

          {file && (
            <div className="rm-file">
              <div className="rm-head">
                <IconSearch size={10} /> <code>{file.path}</code>
                <div className="grow" />
                <span className="rm-meta">{file.bytes} B</span>
                <button className="icon-btn" onClick={() => setFile(null)}>
                  <IconClose size={10} />
                </button>
              </div>
              <pre>{file.ok ? file.content : file.error}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
