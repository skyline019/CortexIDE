import React from 'react';
import { IconBrain, IconTrash, IconGear, IconSpark, IconChevronRight, IconPlus } from './Icons.jsx';

/**
 * 对话顶栏：多会话切换 / 新建重命名删除 / 记忆徽标 / 归档清空 / 设置
 */
export default function ChatSessionBar({
  chatSessions,
  activeSessionId,
  activeSession,
  sessionTok,
  memoriesCount,
  onSwitch,
  onNew,
  onRename,
  onDelete,
  onOpenMemory,
  onArchive,
  onClear,
  onOpenSettings,
  onCollapse,
}) {
  return (
    <div className="chat-head">
      <div className="title">
        <span className="avatar">C</span>
        <select
          className="chat-session-sel"
          value={activeSessionId || activeSession?.id || ''}
          title="切换会话"
          onChange={(e) => onSwitch(e.target.value)}
        >
          {chatSessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || '未命名'}
            </option>
          ))}
          {!chatSessions.length && <option value="">新会话</option>}
        </select>
      </div>
      <button className="icon-btn" title="新建会话" onClick={onNew}>
        <IconPlus size={14} />
      </button>
      <button
        className="icon-btn"
        title="重命名当前会话"
        onClick={() => {
          if (!activeSession) return;
          const name = prompt('会话名称', activeSession.title || '');
          if (name == null) return;
          onRename(activeSession.id, name.trim() || '未命名会话');
        }}
      >
        ✎
      </button>
      {chatSessions.length > 1 && activeSession && (
        <button
          className="icon-btn"
          title="删除当前会话"
          onClick={() => {
            if (!confirm(`删除会话「${activeSession.title || '未命名'}」？`)) return;
            onDelete(activeSession.id);
          }}
        >
          ×
        </button>
      )}
      <button className="mem-chip" onClick={onOpenMemory} title="打开记忆库">
        <IconBrain size={12} />
        <b>{memoriesCount}</b>
      </button>
      {sessionTok > 0 && (
        <span className="tok-chip" title="本会话累计 token（上游 usage）">
          {sessionTok.toLocaleString()} tok
        </span>
      )}
      <div className="spacer" />
      <button className="icon-btn" title="归档会话并写入记忆" onClick={onArchive}>
        <IconSpark size={14} />
      </button>
      <button
        className="icon-btn"
        title="清空当前会话消息"
        onClick={() => {
          if (!confirm('清空当前会话的全部消息？')) return;
          onClear();
        }}
      >
        <IconTrash size={14} />
      </button>
      <button className="icon-btn" title="设置" onClick={onOpenSettings}>
        <IconGear size={14} />
      </button>
      {onCollapse && (
        <button className="icon-btn" title="收起对话 (Ctrl+J)" onClick={onCollapse}>
          <IconChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
