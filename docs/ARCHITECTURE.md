# Cortex 架构（0.6.4）

本文描述**当前**代码结构，与历史 README 长文互补。变更说明见根目录 [`CHANGELOG.md`](../CHANGELOG.md)。  
质量合同：[`CONSTRAINTS.md`](../CONSTRAINTS.md) · 冒烟：[`SMOKE.md`](./SMOKE.md) · 复评：[`SCORE-0.6.4.md`](./SCORE-0.6.4.md)。

## 总览

```
┌──────────────── Electron（desktop/main.mjs）────────────────┐
│  本机 127.0.0.1 · 数据 %APPDATA%\Cortex · 打包后 host.mjs    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / WS
┌──────────────── Vite + React 19（src/）─────────────────────┐
│  App · Welcome · Chat · Editor · Preview · Terminal · …    │
│  state: reducers + createOps · chatSessions 单源             │
└──────────────────────────┬──────────────────────────────────┘
                           │ /api/*
┌──────────────── Node 中间件（server/ · vite.config）────────┐
│  fs · term-host · exec · mem · llm · watch · ssh · workflow │
└─────────────────────────────────────────────────────────────┘
```

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 桌面壳 | `desktop/main.mjs` / `host.mjs` | 窗口、选文件夹、打包后静态托管 + API |
| UI | `src/App.jsx` | 布局、快捷键、欢迎页、面板开关 |
| 状态 | `src/state/store.jsx` | reducer 组合、持久化、Provider |
| 副作用 | `src/state/createOps.js` + `opsHelpers.js` | 文件/工作区/会话/记忆/执行 |
| Agent | `agent.js` + `agentTools.js` + `agentLoop.js` | 本地规则 / 远程工具环 |
| Chat UI | `ChatPanel` + `ChatSessionBar` + `ChatMessageList` | 会话条与消息列表 |
| 预览 | `preview/*` + `office.js` | PDF / Word / Excel / PPT / 媒体 |
| 记忆 | `memory-store` 门面 + crud / ann / search / migrate | SQLite·vec / ANN / RRF |
| 终端 | `terminal.js` ↔ **`term-host.mjs` 子进程** | WS 协议不变；原生隔离 |

## 状态机

- **唯一会话源**：`chatSessions` + `activeSessionId`；`messages` 是活动会话投影。
- **Reducer 拆分**：
  - `reducers/filesTabs.js` — 文件与标签
  - `reducers/workspace.js` — 工作区连接与目录树
  - `reducers/chat.js` — 消息与多会话；`sealChatForPersist`
  - `store.jsx` 的 `reduceRest` — 记忆 / 设置 / 审批 / 统计
- **持久化**：`localStorage` schema **v4**；工作区会话另存 `.cortex/sessions/store.json`。
- **启动**：`coerceChatSource` 把旧版「仅 messages」收成单会话。

## Agent

| 模式 | 工具 |
| --- | --- |
| `agent` | read / write / list / search / run_command / remember / recall |
| `ask` / `plan` | 只读四件套（无写盘、无执行） |

只读工具可并行；写文件与跑命令串行。模式白名单在客户端与服务端提示词两侧对齐（有单测）。  
`recall` 统一 lexical / fuseRrf 的 `sim`/`score`；`embed('auto')` 在 neural 未就绪时立刻走 lexical。

## 文档预览（诚实边界）

| 格式 | 引擎 | 边界 |
| --- | --- | --- |
| PDF | pdfjs（懒加载） | 加密 PDF 明确报错 |
| Word `.docx` | 预览 docx-preview；Agent 读 mammoth + 自研回退 | 版式不完全还原 |
| Excel `.xlsx` | **SheetJS**（`sheetStubs` + 公式原文约定） | 单表预览上限 8000 行；不重算公式 |
| PPT `.pptx` | 文本抽取 | **非版式还原**；备注可见 |

## 安全

- HTTP：`server/auth.js` 最先挂 `/api/*`（`CORTEX_AUTH_TOKEN` / `CORTEX_AUTH_TOKENS`）。
- **WebSocket**：`/api/term`、`/api/watch` 的 `upgrade` 再调 `checkAuth`（含 `?access_token=`）；Connect middleware 管不到 upgrade。
- 禁止只靠 `x-cortex-user` 冒充身份。
- 执行：白名单 + DENY / 管道负向单测。

## 原生 ABI 与终端隔离

| 场景 | ABI | 脚本 |
| --- | --- | --- |
| `npm install` / `dev` / `test` | Node | `ensure-native-abi --target=node` |
| `desktop` / `dist:*` | Electron | `ensure-native-abi --target=electron`；打包后切回 Node |

- `better-sqlite3` / `node-pty` 错 ABI 会导致 Vite `0xC0000374`。
- `node-pty` **不得**在 Vite 主进程加载；由 `server/term-host.mjs` 子进程承载，宿主崩溃不拖死 Vite。

## 记忆检索

检索实现在 `server/memory-search.js`，由 `memory-store.bindMemorySearch()` 注入打开库与表状态，避免环形依赖。

## 主要依赖

- 前端：React 19、Vite 8、CodeMirror 6、xterm
- 桌面：Electron 37、electron-builder
- 记忆：better-sqlite3、sqlite-vec、可选 PGlite/pgvector
- 终端：`@lydell/node-pty`（npm 别名 `node-pty`）

## 验证

```bash
npm test                 # ≥175（0.6.4 = 180）
npm run lint             # 0 error / 0 warning
npm run dist:dir         # Windows 未打包目录
npm run smoke:mock       # 无 API Key
npm run smoke:key        # 真 API Key
npm run smoke:exe        # 打包 exe 冷启动
```
