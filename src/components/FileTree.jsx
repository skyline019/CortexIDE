import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { buildTree, fsClient } from '../lib/fsClient.js';
import { fileIcon, newFileTemplate } from '../lib/vfs.js';
import { IconPlus, IconTrash, IconCheck, IconClose } from './Icons.jsx';

function Row({ node, depth, openDirs, toggle, onOpen, activePath, onDelete, loadingDirs, probedDirs }) {
  const isDir = node.type === 'dir';
  const open = openDirs.has(node.path);
  const icon = fileIcon(node.name);
  const loading = loadingDirs.has(node.path);
  const probed = probedDirs.has(node.path);
  const empty = isDir && open && !loading && probed && !node.children?.length;

  return (
    <>
      <div
        className={`tree-row ${activePath === node.path ? 'active' : ''} ${isDir ? 'dir' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => (isDir ? toggle(node.path) : onOpen(node.path))}
        title={`${node.path}${isDir ? '' : '（可以直接拖到右侧输入框当上下文）'}`}
        draggable={!isDir}
        onDragStart={(e) => {
          if (isDir) return;
          // 多种 MIME：Electron/Chromium 对自定义类型常在 drop 时读不到，text/plain 必须有
          e.dataTransfer.setData('application/x-cortex-path', node.path);
          e.dataTransfer.setData('text/x-cortex-path', node.path);
          e.dataTransfer.setData('text/plain', node.path);
          e.dataTransfer.setData('text/uri-list', node.path);
          e.dataTransfer.effectAllowed = 'copyMove';
        }}
      >
        {isDir ? (
          <span className="tw">{open ? '▾' : '▸'}</span>
        ) : (
          <span className="glyph" style={{ color: icon.color }}>
            {icon.glyph}
          </span>
        )}
        <span className="name">{node.name}</span>
        {!isDir && node.size > 1024 && <span className="sz">{Math.round(node.size / 1024)}k</span>}
        {!isDir && (
          <button
            className="row-del"
            title="删除文件"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path);
            }}
          >
            <IconTrash size={10} />
          </button>
        )}
      </div>
      {isDir &&
        open &&
        node.children?.map((c) => (
          <Row
            key={c.path}
            node={c}
            depth={depth + 1}
            openDirs={openDirs}
            toggle={toggle}
            onOpen={onOpen}
            activePath={activePath}
            onDelete={onDelete}
            loadingDirs={loadingDirs}
            probedDirs={probedDirs}
          />
        ))}
      {isDir && open && loading && (
        <div className="tree-empty" style={{ paddingLeft: 18 + depth * 12 }}>
          加载中…
        </div>
      )}
      {empty && (
        <div className="tree-empty" style={{ paddingLeft: 18 + depth * 12 }}>
          空目录
        </div>
      )}
    </>
  );
}

export default function FileTree() {
  const { state, dispatch, ops } = useApp();
  const toast = useToast();
  const { workspace, files, activeFileId } = state;
  const active = files.find((f) => f.id === activeFileId);
  const [openDirs, setOpenDirs] = useState(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState(() => new Set());
  const [probedDirs, setProbedDirs] = useState(() => new Set());
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState('');

  const tree = useMemo(() => buildTree(workspace.entries || []), [workspace.entries]);

  /**
   * 目录级订阅：把当前展开的目录报给服务端，只推送这些目录下的变更。
   */
  useEffect(() => {
    const dirs = [...openDirs].filter(Boolean);
    dispatch({ type: 'ws/set', patch: { subDirs: dirs } });
    ops.setWatchSubs?.(dirs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDirs]);

  useEffect(() => {
    if (!workspace.connected) return;
    setProbedDirs(new Set());
    setOpenDirs(new Set());
    ops.refreshTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.connected, workspace.root]);

  const ensureLoaded = async (dirPath) => {
    if (probedDirs.has(dirPath) || loadingDirs.has(dirPath)) return;
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      await ops.loadDir(dirPath);
      setProbedDirs((prev) => new Set(prev).add(dirPath));
    } catch (err) {
      toast(`读取目录失败：${err.message}`, 'err');
      // 失败也标 probed，避免反复打同一坏路径；已有缓存子项仍可显示
      setProbedDirs((prev) => new Set(prev).add(dirPath));
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  };

  const toggle = (path) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        return next;
      }
      next.add(path);
      return next;
    });
    if (!openDirs.has(path)) {
      // 正在展开：懒加载一层
      void ensureLoaded(path);
    }
  };

  const openFile = async (path) => {
    try {
      await ops.openPath(path);
    } catch (err) {
      toast(`打开失败：${err.message}`, 'err');
    }
  };

  const removeFile = async (path) => {
    if (!confirm(`确定删除磁盘上的 ${path} 吗？`)) return;
    try {
      await ops.deletePath(path);
      await ops.refreshTree();
      setProbedDirs(new Set());
      toast(`已删除 ${path}`);
    } catch (err) {
      toast(`删除失败：${err.message}`, 'err');
    }
  };

  const create = async () => {
    const p = newPath.trim().replace(/^\/+/, '');
    if (!p) return setCreating(false);
    try {
      await fsClient.write(p, newFileTemplate(p));
      await ops.refreshTree();
      setProbedDirs(new Set());
      await openFile(p);
      toast(`已创建 ${p}`);
    } catch (err) {
      toast(`创建失败：${err.message}`, 'err');
    }
    setNewPath('');
    setCreating(false);
  };

  const refresh = async () => {
    setProbedDirs(new Set());
    await ops.refreshTree();
  };

  if (!workspace.connected) {
    return (
      <div className="side-body">
        <div className="ins-empty" style={{ padding: 14, lineHeight: 1.8 }}>
          还没连上服务端的工作目录。
          <br />
          用 <code>npm run dev</code> 启动后会自动连接当前项目目录；
          也可以在设置 → 工作区里改路径。
        </div>
        <div style={{ padding: '0 12px' }}>
          <button className="btn sm" onClick={() => ops.connect()}>
            重新连接
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="side-head">
        <span title={workspace.root} style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--fg-dim)' }}>
          {workspace.name || '工作区'}
        </span>
        <div className="spacer" />
        <button onClick={() => setCreating((v) => !v)} title="新建文件">
          <IconPlus size={13} />
        </button>
        <button onClick={refresh} title="刷新">
          ↻
        </button>
      </div>
      <div className="side-body">
        {creating && (
          <div style={{ display: 'flex', gap: 4, padding: '4px 6px 8px' }}>
            <input
              autoFocus
              placeholder="src/new-file.js"
              value={newPath}
              style={{ fontSize: 11.5, padding: '4px 7px' }}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
                if (e.key === 'Escape') setCreating(false);
              }}
            />
            <button className="btn sm primary" onClick={create}>
              <IconCheck size={11} />
            </button>
            <button className="btn sm" onClick={() => setCreating(false)}>
              <IconClose size={11} />
            </button>
          </div>
        )}
        {workspace.loading && <div className="ins-empty" style={{ padding: 12 }}>读取目录…</div>}
        {workspace.error && <div className="ins-empty" style={{ padding: 12, color: 'var(--danger)' }}>{workspace.error}</div>}
        {tree.map((node) => (
          <Row
            key={node.path}
            node={node}
            depth={0}
            openDirs={openDirs}
            toggle={toggle}
            onOpen={openFile}
            activePath={active?.path}
            onDelete={removeFile}
            loadingDirs={loadingDirs}
            probedDirs={probedDirs}
          />
        ))}
        {!tree.length && !workspace.loading && <div className="ins-empty" style={{ padding: 12 }}>目录为空。</div>}
        <div className="tree-foot">
          <span>{workspace.entries.filter((e) => e.type !== 'dir').length} 个文件</span>
          <span>{workspace.root}</span>
        </div>
      </div>
    </>
  );
}
