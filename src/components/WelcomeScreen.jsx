import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { loadRecentWorkspaces, rememberWorkspace, removeRecentWorkspace } from '../lib/recentWorkspaces.js';
import { checkServerLLM, saveServerCredentials } from '../lib/agent.js';
import { IconFolder, IconPlus, IconTrash, IconChevronRight, IconGear } from './Icons.jsx';

async function pickFolderNative() {
  if (window.cortexNative?.selectFolder) {
    return window.cortexNative.selectFolder();
  }
  return null;
}

export default function WelcomeScreen({ onEntered, onOpenSettings }) {
  const { ops, state, dispatch } = useApp();
  const toast = useToast();
  const [recent, setRecent] = useState(() => loadRecentWorkspaces());
  const [path, setPath] = useState(state.workspace.root || '');
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [llm, setLlm] = useState(null);
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    checkServerLLM().then((s) => {
      setLlm(s);
    });
  }, []);

  const hint = useMemo(() => {
    if (window.cortexNative) return '选择本机文件夹作为 Agent 工作区';
    return '输入绝对路径，或在设置里切换工作区';
  }, []);

  const saveKey = async () => {
    if (!apiKey.trim()) {
      toast('请填写 API Key', 'err');
      return false;
    }
    setSavingKey(true);
    try {
      const r = await saveServerCredentials({
        apiKey: apiKey.trim(),
        baseUrl: llm?.baseUrl || 'https://api.deepseek.com/v1',
        provider: 'openai-compatible',
      });
      setLlm({ ...llm, ...r, available: true, configured: true });
      setApiKey('');
      dispatch({ type: 'settings/set', patch: { mode: 'api', provider: 'server' } });
      toast('API Key 已保存到本机', 'ok');
      return true;
    } catch (err) {
      toast(`保存密钥失败：${err.message}`, 'err');
      return false;
    } finally {
      setSavingKey(false);
    }
  };

  const enter = async (root) => {
    const target = (root || path || '').trim();
    if (!target) {
      toast('请先选择或填写工作区路径', 'err');
      return;
    }
    if (apiKey.trim()) {
      const okKey = await saveKey();
      if (!okKey) return;
    } else if (!llm?.configured && !llm?.available) {
      toast('请先填写 API Key（或点右上角打开设置）', 'err');
      return;
    }
    setBusy(true);
    try {
      dispatch({ type: 'settings/set', patch: { mode: 'api', provider: 'server' } });
      const ok = await ops.connect({ root: target, mode: 'real' });
      if (!ok) {
        toast('无法打开该目录，请检查路径与权限', 'err');
        return;
      }
      setRecent(rememberWorkspace(target));
      await ops.connectMemory({ user: state.settings.userId, workspace: target }).catch(() => {});
      onEntered?.(target);
      toast(`已打开工作区 ${target.split(/[/\\]/).pop()}`, 'ok');
    } catch (err) {
      toast(err.message || '打开失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const picked = await pickFolderNative();
    if (picked) {
      setPath(picked);
      await enter(picked);
    } else if (!window.cortexNative) {
      toast('浏览器里请手动填写路径，或使用桌面版一键选文件夹', 'err');
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">
          <img className="welcome-logo" src="/brand.svg" alt="" width={44} height={44} />
          <div>
            <h1>Cortex</h1>
            <p>带持久记忆的本机 Agent IDE</p>
          </div>
          {onOpenSettings && (
            <button type="button" className="btn sm welcome-settings" onClick={onOpenSettings} title="模型 / Base URL / 完整设置">
              <IconGear size={14} /> 设置
            </button>
          )}
        </div>

        <div className="welcome-section">
          <div className="welcome-label">API Key</div>
          <div className="welcome-llm">
            <div className="form-row" style={{ margin: 0 }}>
              <label>
                {llm?.configured || llm?.available
                  ? `已配置${llm.keyHint ? `（${llm.keyHint}）` : ''} · 模型请到设置修改`
                  : '必填 · 模型与 Base URL 在设置里改'}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={llm?.configured || llm?.available ? '已保存，如需更换再填写' : 'sk-...'}
                disabled={busy || savingKey}
                autoComplete="off"
              />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn" disabled={busy || savingKey || !apiKey.trim()} onClick={saveKey}>
                {savingKey ? '保存中…' : '保存密钥'}
              </button>
              {onOpenSettings && (
                <button type="button" className="btn ghost" disabled={busy} onClick={onOpenSettings}>
                  模型与端点…
                </button>
              )}
              <span className="welcome-hint" style={{ margin: 0 }}>
                {llm?.configured || llm?.available ? '密钥已就绪，选工作区即可进入' : '未配置密钥时无法调用真实模型'}
              </span>
            </div>
          </div>
        </div>

        <div className="welcome-section">
          <div className="welcome-label">打开工作区</div>
          <div className="welcome-row">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="D:\projects\my-app"
              disabled={busy}
              onKeyDown={(e) => e.key === 'Enter' && enter()}
            />
            <button type="button" className="btn" disabled={busy} onClick={browse} title={hint}>
              <IconFolder size={14} /> 浏览
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => enter()}>
              进入
            </button>
          </div>
          <div className="welcome-hint">{hint}</div>
        </div>

        {recent.length > 0 && (
          <div className="welcome-section">
            <div className="welcome-label">最近打开</div>
            <ul className="welcome-recent">
              {recent.map((r, idx) => (
                <li key={r.path}>
                  <button type="button" className="welcome-recent-item" disabled={busy} onClick={() => enter(r.path)}>
                    <kbd className="wr-kbd">{idx < 9 ? idx + 1 : ''}</kbd>
                    <IconFolder size={14} />
                    <span className="wr-name">{r.name}</span>
                    <span className="wr-path">{r.path}</span>
                    <IconChevronRight size={13} />
                  </button>
                  <button
                    type="button"
                    className="welcome-recent-del"
                    title="从列表移除"
                    onClick={() => setRecent(removeRecentWorkspace(r.path))}
                  >
                    <IconTrash size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="welcome-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => enter(path || state.workspace.root)}>
            <IconPlus size={13} /> 使用当前路径继续
          </button>
        </div>

        <div className="welcome-shortcuts" aria-label="快捷键">
          <span>
            <kbd>Ctrl</kbd>+<kbd>O</kbd> 打开欢迎页
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> 最近工作区
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>K</kbd> 命令面板
          </span>
        </div>
      </div>
    </div>
  );
}
