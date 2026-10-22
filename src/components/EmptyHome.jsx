import React from 'react';
import { useApp } from '../state/store.jsx';
import { IconFolder, IconCmd, IconChat, IconBrain, IconFiles } from './Icons.jsx';

/**
 * 主视图空态：有工作区时给快捷入口，而不是一块空白。
 */
export default function EmptyHome({ onOpenWelcome, onOpenPalette, onToggleChat, onOpenMemory }) {
  const { state, ops } = useApp();
  const entries = (state.workspace.entries || []).filter((e) => e.type !== 'dir').slice(0, 8);
  const connected = state.workspace.connected;

  return (
    <div className="empty-home">
      <div className="empty-home-inner">
        <img className="empty-home-mark" src="/brand.svg" alt="" width={40} height={40} />
        <h2>{connected ? '开始编辑' : '尚未打开工作区'}</h2>
        <p>
          {connected
            ? `当前工作区 ${state.workspace.name || state.workspace.root}。从左侧打开文件，或让 Agent 直接改代码。`
            : '先选择一个本机文件夹，Agent 才能读写磁盘并记住项目约定。'}
        </p>

        <div className="empty-home-actions">
          {!connected ? (
            <button type="button" className="btn primary" onClick={onOpenWelcome}>
              <IconFolder size={14} /> 选择工作区
            </button>
          ) : (
            <>
              <button type="button" className="btn primary" onClick={onOpenPalette}>
                <IconCmd size={14} /> 命令面板
              </button>
              <button type="button" className="btn" onClick={onToggleChat}>
                <IconChat size={14} /> 打开 Agent
              </button>
              <button type="button" className="btn" onClick={onOpenMemory}>
                <IconBrain size={14} /> 记忆库
              </button>
              <button type="button" className="btn" onClick={() => ops.refreshTree()}>
                <IconFiles size={14} /> 刷新目录
              </button>
            </>
          )}
        </div>

        {connected && entries.length > 0 && (
          <div className="empty-home-files">
            <div className="empty-home-label">工作区文件</div>
            <div className="empty-home-grid">
              {entries.map((e) => (
                <button key={e.path} type="button" className="empty-file-chip" onClick={() => ops.openPath(e.path)}>
                  {e.path}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="empty-home-keys">
          <kbd>Ctrl</kbd>+<kbd>K</kbd> 命令 · <kbd>Ctrl</kbd>+<kbd>J</kbd> Agent · <kbd>Ctrl</kbd>+<kbd>B</kbd> 侧栏
          <br />
          <kbd>Ctrl</kbd>+<kbd>O</kbd> 工作区 · <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> 最近工作区
        </div>
      </div>
    </div>
  );
}
