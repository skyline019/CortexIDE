/**
 * Store 副作用 ops：文件 / 工作区 / 会话 / 记忆 / 执行
 * 从 store.jsx 抽出，便于维护与单测。
 */
import { newFileTemplate, uid } from '../lib/vfs.js';
import { mergeMemories } from '../lib/memory.js';
import { fsClient, probeServer } from '../lib/fsClient.js';
import { dedupeByVector, docText } from '../lib/retrieval.js';
import { embed } from '../lib/vector.js';
import {
  configureBackend,
  probeBackend as probeMemBackend,
  pullMemories,
  queueMemory,
  queueDelete,
  deleteOnServer,
  flush as flushMemSync,
  listUsers as fetchUsers,
  createUser as createMemUser,
  getBackendState,
} from '../lib/memoryBackend.js';
import { loadChatStoreForWorkspace, saveChatStoreToWorkspace, makeSession } from '../lib/chatSession.js';
import { sealChatForPersist } from './reducers/chat.js';

/**
 * @param {{
 *   stateRef: { current: any },
 *   dispatch: Function,
 *   approvalResolvers: { current: Map },
 *   watchSender: { current: Function|null },
 *   treeTimer: { current: any },
 *   lastChatRoot: { current: string },
 *   hashOf: (text: string) => number,
 * }} ctx
 */
export function createOps(ctx) {
  const {
    stateRef,
    dispatch,
    approvalResolvers,
    watchSender,
    treeTimer,
    lastChatRoot,
    hashOf,
  } = ctx;

  return {
      /** 当前是否接在真实目录上 */
      isReal: () => stateRef.current.workspace.mode === 'real' && stateRef.current.workspace.connected,

      /** 真实模式：读取磁盘文件 */
      async readFile(path) {
        const cur = stateRef.current;
        const open = cur.files.find((f) => f.path === path);
        if (this.isReal()) {
          const res = await fsClient.read(path);
          const content = res.content || '';
          return {
            path: res.path || path,
            content,
            lines: content ? content.split('\n').length : 0,
            fromDisk: true,
            binary: Boolean(res.binary),
            size: Number(res.size) || 0,
          };
        }
        if (!open) throw new Error(`找不到文件：${path}`);
        return {
          path: open.path,
          content: open.content || '',
          lines: (open.content || '').split('\n').length,
          binary: Boolean(open.binary),
          size: Number(open.size) || 0,
        };
      },

      /** 写入文件：真实模式落盘，否则写内存 */
      async writeFile(path, content, id) {
        const cur = stateRef.current;
        const existing = cur.files.find((f) => f.id === id) || cur.files.find((f) => f.path === path) || null;
        const real = this.isReal();
        if (real) await fsClient.write(path, content);
        const file = {
          id: existing?.id || uid('file'),
          path,
          content,
          updatedAt: Date.now(),
          savedAt: Date.now(),
          dirty: false,
          real,
        };
        dispatch({ type: 'file/write', file });
        if (real) dispatch({ type: 'ws/bump' });
        return file;
      },

      async createFile(path) {
        const cur = stateRef.current;
        const exists = cur.files.find((f) => f.path === path);
        if (exists) return exists;
        if (this.isReal()) {
          try {
            const probe = await fsClient.read(path);
            if (probe && !probe.binary) return this.openPath(path);
          } catch {
            /* 文件不存在，继续创建 */
          }
        }
        return this.writeFile(path, newFileTemplate(path));
      },

      async openPath(path) {
        const cur = stateRef.current;
        const open = cur.files.find((f) => f.path === path);
        if (open && (!this.isReal() || open.real)) {
          dispatch({ type: 'file/open', id: open.id });
          return open;
        }
        let content = '';
        let binary = false;
        let size = 0;
        let truncated = false;
        if (this.isReal()) {
          const res = await fsClient.read(path);
          content = res.content || '';
          binary = Boolean(res.binary);
          size = Number(res.size) || 0;
          truncated = Boolean(res.truncated);
        }
        const file = {
          id: uid('file'),
          path,
          content,
          binary,
          size,
          truncated,
          updatedAt: Date.now(),
          savedAt: Date.now(),
          dirty: false,
          real: this.isReal(),
        };
        dispatch({ type: 'file/write', file });
        return file;
      },

      async saveFile(path) {
        const cur = stateRef.current;
        const f = cur.files.find((x) => x.path === path) || cur.files.find((x) => x.id === cur.activeFileId);
        if (!f) return null;
        if (this.isReal()) await fsClient.write(f.path, f.content);
        dispatch({ type: 'file/save', id: f.id });
        return f;
      },

      async deletePath(path) {
        if (this.isReal()) await fsClient.remove(path);
        const cur = stateRef.current;
        for (const f of cur.files.filter((x) => x.path === path)) dispatch({ type: 'file/delete', id: f.id });
        if (this.isReal()) dispatch({ type: 'ws/bump' });
      },

      async listFiles() {
        if (this.isReal()) {
          const res = await fsClient.tree({ depth: 3, limit: 800 });
          return { files: res.entries.filter((e) => e.type !== 'dir').map((e) => e.path) };
        }
        return { files: stateRef.current.files.map((f) => f.path) };
      },

      async searchFiles(query) {
        if (this.isReal()) {
          const res = await fsClient.search(query, 30);
          return { hits: res.hits, total: res.total };
        }
        const q = String(query || '').toLowerCase();
        const hits = [];
        for (const f of stateRef.current.files) {
          f.content.split('\n').forEach((line, i) => {
            if (line.toLowerCase().includes(q)) hits.push({ path: f.path, line: i + 1, text: line.trim().slice(0, 160) });
          });
        }
        return { hits: hits.slice(0, 30), total: hits.length };
      },

      /** 真实模式：重新拉取目录树 */
      /** 记忆被编辑后重新同步 */
      async resyncMemory(id) {
        const m = stateRef.current.memories.find((x) => x.id === id);
        if (m) await this.syncMemories([m]);
      },

      /**
       * 请求用户批准一条命令。
       * 返回 'allow' | 'always' | 'deny'
       */
      requestApproval({ cmd, reason }) {
        return new Promise((resolve) => {
          const id = uid('apr');
          dispatch({ type: 'approval/add', item: { id, cmd, reason, at: Date.now() } });
          approvalResolvers.current.set(id, resolve);
        });
      },

      resolveApproval(id, decision) {
        const fn = approvalResolvers.current.get(id);
        approvalResolvers.current.delete(id);
        dispatch({ type: 'approval/remove', id });
        fn?.(decision);
      },

      /** 把某个命令写法加入服务端白名单 */
      async allowCommand(cmd) {
        const pattern = cmd.trim().split(/\s+/).slice(0, 2).join(' ') + ' *';
        try {
          const res = await fetch('/api/exec/allowlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ add: pattern }),
          });
          const json = await res.json();
          return json.allowlist || [];
        } catch {
          return [];
        }
      },

      /** 手动执行命令（终端面板 / 命令面板） */
      async execCommand(cmd, { sandbox = false } = {}) {
        const t0 = performance.now();
        const res = await fetch('/api/exec/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd, sandbox }),
        });
        const json = await res.json();
        const item = {
          id: uid('ex'),
          cmd,
          at: Date.now(),
          code: json.code,
          stdout: json.stdout || '',
          stderr: json.stderr || '',
          error: json.error,
          blocked: json.blocked,
          matched: json.matched,
          sandbox: json.sandbox?.dir || null,
          ms: json.ms ?? Math.round(performance.now() - t0),
        };
        dispatch({ type: 'exec/log', item });
        return item;
      },

      /**
       * 处理文件监听推送：刷新文件树 + 外部改动同步到已打开的 tab
       * events: [{ path, kind: 'add'|'change'|'unlink', dir }]
       */
      async applyDiskEvents(events, { onDiff } = {}) {
        if (!Array.isArray(events) || !events.length) return;
        if (!this.isReal()) return;
        const cur = stateRef.current;
        const interesting = events.filter((e) => !e.dir && /\.(jsx?|tsx?|css|json|md|html|mjs|cjs|vue|py|txt|yml|yaml|toml)$/i.test(e.path));
        const touched = events.filter((e) => e.kind !== 'unlink' && !e.dir).map((e) => e.path);

        // 1) 已打开且被外部改动的文件
        const openPaths = cur.files.filter((f) => f.real);
        for (const ev of events) {
          if (ev.dir || ev.kind === 'unlink') continue;
          const tab = openPaths.find((f) => (f.realPath || f.path) === ev.path);
          if (!tab) continue;
          try {
            const res = await fsClient.read(ev.path);
            if (res.binary) continue;
            if (res.content === tab.content) continue;
            // 有未保存改动时不覆盖，只做标记
            if (tab.dirty) {
              dispatch({ type: 'file/markStale', id: tab.id });
              onDiff?.({ path: ev.path, before: tab.content, after: res.content, stale: true, fileId: tab.id });
            } else {
              dispatch({ type: 'file/diskSync', id: tab.id, content: res.content, before: tab.content });
              onDiff?.({ path: ev.path, before: tab.content, after: res.content, auto: true, fileId: tab.id, kind: ev.kind });
            }
          } catch {
            /* 文件可能刚被删除 */
          }
        }

        // 2) 刷新文件树（节流）
        if (interesting.length || events.some((e) => e.kind !== 'change')) {
          clearTimeout(treeTimer.current);
          treeTimer.current = setTimeout(() => {
            this.refreshTree().catch(() => {});
          }, 260);
        }
        dispatch({ type: 'ws/set', patch: { lastFsEvent: { at: Date.now(), events: events.slice(0, 20), count: events.length } } });
        return { touched };
      },

      /** 订阅目录（由 App 注入的实际 WebSocket 发送函数） */
      setWatchSubs(dirs) {
        watchSender.current?.(dirs);
      },

      /** 切换监听模式：fs（inotify） / poll（大仓、网络盘） */
      async setWatchMode(mode, interval) {
        const res = await fetch('/api/watch/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, interval }),
        });
        const json = await res.json();
        dispatch({ type: 'ws/set', patch: { watch: 'connected', watchMode: json.mode } });
        return json;
      },

      bindWatchSender(fn) {
        watchSender.current = fn;
      },

      /** 从服务端审计日志恢复命令执行记录 */
      async hydrateExecLog() {
        try {
          const res = await fetch('/api/exec/log');
          const json = await res.json();
          for (const e of (json.log || []).slice().reverse()) {
            dispatch({
              type: 'exec/log',
              item: {
                id: `srv-${e.at}-${e.cmd}`,
                cmd: e.cmd,
                at: e.at,
                code: e.code,
                blocked: e.ok === false && e.code === null,
                error: e.reason,
                matched: e.matched,
                ms: e.ms,
                fromServer: true,
              },
            });
          }
        } catch {
          /* 忽略 */
        }
      },

      async refreshTree({ depth } = {}) {
        if (!this.isReal()) return;
        dispatch({ type: 'ws/set', patch: { loading: true, error: null } });
        try {
          const d = depth || stateRef.current.workspace.depth || 2;
          const res = await fsClient.tree({ depth: d, limit: 900 });
          dispatch({ type: 'ws/entries', entries: res.entries });
        } catch (err) {
          dispatch({ type: 'ws/set', patch: { loading: false, error: err.message } });
        }
      },

      /** 展开目录时懒加载一层子项（初始 tree 只有 depth=2，更深会误显示「空目录」） */
      async loadDir(dirPath) {
        if (!this.isReal()) return [];
        const rel = !dirPath || dirPath === '.' ? '.' : dirPath;
        const res = await fsClient.tree({ path: rel, depth: 1, limit: 2000 });
        dispatch({ type: 'ws/mergeEntries', entries: res.entries || [] });
        return res.entries || [];
      },

      /** 连接服务端工作区 */
      async connect({ root, mode } = {}) {
        const info = await probeServer();
        if (!info) {
          dispatch({ type: 'ws/set', patch: { connected: false, error: '后端不可用（请用 npm run dev 启动）' } });
          return false;
        }
        const prevRoot = stateRef.current.workspace?.root || '';
        // 切换工作区前先落盘当前多会话
        if (prevRoot) {
          const sealed = sealChatForPersist(stateRef.current);
          await saveChatStoreToWorkspace(prevRoot, {
            version: 2,
            root: prevRoot,
            activeSessionId: sealed.activeSessionId,
            sessions: sealed.chatSessions,
          }).catch(() => {});
        }
        let target = info;
        if (root && root !== info.root) {
          try {
            await fsClient.setRoot(root);
            target = await fsClient.info();
          } catch (err) {
            dispatch({ type: 'ws/set', patch: { error: err.message } });
            return false;
          }
        }
        dispatch({
          type: 'ws/set',
          patch: {
            connected: true,
            mode: mode || stateRef.current.workspace.mode,
            root: target.root,
            name: target.name,
            error: null,
          },
        });
        if (target.root && (target.root !== prevRoot || !(stateRef.current.chatSessions || []).length)) {
          const store = await loadChatStoreForWorkspace(target.root).catch(() => null);
          if (store) {
            dispatch({
              type: 'chat/hydrate',
              sessions: store.sessions,
              activeSessionId: store.activeSessionId,
            });
          } else {
            dispatch({ type: 'chat/hydrate', sessions: [makeSession()], activeSessionId: null });
          }
          lastChatRoot.current = target.root;
        }
        if ((mode || stateRef.current.workspace.mode) === 'real') {
          dispatch({ type: 'files/modeReset' });
          const res = await fsClient.tree({ depth: stateRef.current.workspace.depth || 2, limit: 900 });
          dispatch({ type: 'ws/entries', entries: res.entries });
        }
        return true;
      },

      newChatSession(title) {
        dispatch({ type: 'chat/new', title });
      },
      switchChatSession(id) {
        dispatch({ type: 'chat/switch', id });
      },
      renameChatSession(id, title) {
        dispatch({ type: 'chat/rename', id, title });
      },
      deleteChatSession(id) {
        dispatch({ type: 'chat/delete', id });
      },

      openFile(id) {
        dispatch({ type: 'file/open', id });
      },
      openFileByPath(path) {
        const f = stateRef.current.files.find((x) => x.path === path);
        if (f) dispatch({ type: 'file/open', id: f.id });
        else this.openPath(path);
      },
      addMemories(items) {
        const cur = stateRef.current;
        const { memories, added, merged } = mergeMemories(cur.memories, items);
        dispatch({ type: 'mem/set', memories });
        if (added.length) dispatch({ type: 'stats/bump', patch: { memoryWrites: added.length } });
        // 后台用向量做一次语义去重（说法不同但意思相同的记忆会被合并）
        if (added.length) {
          dedupeByVector(memories, { provider: cur.settings.embedProvider })
            .then((res) => {
              if (res.removed.length) dispatch({ type: 'mem/set', memories: res.memories });
            })
            .catch(() => {});
        }
        // 向量化 + 同步到服务端（sqlite-vec），失败不阻塞主流程
        this.syncMemories([...added, ...merged]);
        return { added, merged };
      },
      deleteMemory(id) {
        dispatch({ type: 'mem/delete', id });
        queueDelete(id);
        deleteOnServer(id);
      },

      /** 把若干记忆（重新）向量化并排队同步到服务端 */
      async syncMemories(list) {
        const cur = stateRef.current;
        if (!getBackendState().available) return;
        const items = list.filter((m) => m && m.text);
        if (!items.length) return;
        dispatch({ type: 'backend/set', patch: { syncing: true } });
        try {
          const { vectors } = await embed(items.map(docText), { provider: cur.settings.embedProvider });
          items.forEach((m, i) => {
            const hash = hashOf(docText(m));
            queueMemory({ ...m, uid: m.id }, vectors[i], hash);
          });
          await flushMemSync();
        } catch (err) {
          console.warn('[cortex] 记忆同步失败', err.message);
        } finally {
          dispatch({ type: 'backend/set', patch: { syncing: false, lastSync: cur.backend?.lastSync } });
        }
      },

      /** 探测服务端记忆库 + 拉取当前用户的记忆 */
      async connectMemory({ user, workspace: ws } = {}) {
        const cur = stateRef.current;
        const uid = user || cur.settings.userId || 'local';
        configureBackend({
          user: uid,
          ws: ws !== undefined ? ws : undefined,
          token: cur.settings.accessToken || '',
        });
        const probe = await probeMemBackend();
        dispatch({ type: 'backend/set', patch: { available: probe.available, status: probe.status } });
        if (!probe.available) return false;
        try {
          const users = await fetchUsers();
          dispatch({ type: 'backend/set', patch: { users } });
        } catch {
          /* ignore */
        }
        try {
          const remote = await pullMemories();
          if (remote.length) {
            // 服务端为准，但保留本地独有的（例如离线期间产生的）
            const byId = new Map(cur.memories.map((m) => [m.id, m]));
            const merged = remote.map((r) => {
              const local = byId.get(r.uid);
              return {
                id: r.uid,
                kind: r.kind,
                text: r.text,
                tags: r.tags || [],
                importance: r.importance ?? 3,
                uses: r.uses || 0,
                pinned: Boolean(r.pinned),
                source: r.source || 'server',
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                lastUsedAt: r.last_used_at || 0,
                ...(local ? { score: local.score } : {}),
              };
            });
            const remoteIds = new Set(merged.map((m) => m.id));
            const localOnly = cur.memories.filter((m) => !remoteIds.has(m.id));
            // 去重：同一句话只保留一份（历史上重复同步会产生多行）
            const keep = new Map();
            const dupes = [];
            for (const m of [...merged, ...localOnly]) {
              const key = String(m.text || '').trim();
              const prev = keep.get(key);
              if (!prev) {
                keep.set(key, m);
                continue;
              }
              // 优先保留服务端已有记录（id 稳定在库里），另一份删掉
              if (m.source === 'server' || !prev.source || prev.source !== 'server') dupes.push(prev.id);
              else dupes.push(m.id);
              if (m.source === 'server') keep.set(key, m);
            }
            if (dupes.length) {
              dupes.forEach((id) => queueDelete(id));
              flushMemSync().catch(() => {});
            }
            dispatch({ type: 'mem/set', memories: [...keep.values()] });
            // 本地独有的补推上去
            if (localOnly.length) this.syncMemories(localOnly);
          } else if (cur.memories.length) {
            this.syncMemories(cur.memories);
          }
        } catch (err) {
          console.warn('[cortex] 拉取服务端记忆失败', err.message);
        }
        return true;
      },

      /** 切换用户（记忆隔离） */
      async switchUser(userId) {
        const users = await fetchUsers().catch(() => []);
        if (!users.some((u) => u.id === userId)) await createMemUser(userId).catch(() => {});
        dispatch({ type: 'mem/switchUser', userId, memories: null });
        configureBackend({ user: userId, token: stateRef.current.settings.accessToken || '' });
        const remote = await pullMemories().catch(() => []);
        const mapped = remote.map((r) => ({
          id: r.uid,
          kind: r.kind,
          text: r.text,
          tags: r.tags || [],
          importance: r.importance ?? 3,
          uses: r.uses || 0,
          pinned: Boolean(r.pinned),
          source: r.source || 'server',
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          lastUsedAt: r.last_used_at || 0,
        }));
        dispatch({ type: 'mem/set', memories: mapped });
        dispatch({ type: 'backend/set', patch: { users: await fetchUsers().catch(() => []) } });
        return mapped.length;
      },
      touchMemories(ids) {
        dispatch({ type: 'mem/touch', ids });
      },
      addSession(session) {
        dispatch({ type: 'session/add', session });
      },

  };
}
