# Changelog

## 0.6.4 — 2026-10-22

### 质量门禁（冲 9+）

- 新增根目录 `CONSTRAINTS.md`；`npm test` **180**、`npm run lint` **0 warning**
- 单测：chatSessions / opsHelpers / memory-store / recall / term-host / agent 工具环 / 鉴权与 exec 负向
- Playwright：`smoke:mock`（11/11）· `smoke:key`（9/9）· `smoke:exe`（8/8）入发布门禁；**全部硬断言**
- 七维复评综合 ≈ **9.17**（可靠性 9.6 / 可交付 9.4）— 见 `docs/SCORE-0.6.4.md`

### 架构拆分

- `memory-store` 门面（~344）+ `memory-crud` / `memory-migrate` / `memory-ann` / `memory-search`
- `agent.js` → `agentTools.js` + `agentLoop.js`；Chat → `ChatSessionBar` + `ChatMessageList`
- 移除 `src/state/_backup/`

### 正确性 / 安全 / 稳定性

- `recall`：统一 lexical/fuseRrf 的 `sim`/`score`，避免 `toFixed` 崩检索
- `embed('auto')`：neural 未就绪立刻走 lexical
- **原生 ABI 根治**：默认 Node；桌面/打包才切 Electron；错 ABI 探测在子进程
- **终端隔离**：`node-pty` 仅在 `server/term-host.mjs`；宿主崩不拖死 Vite
- **WebSocket 鉴权**：`/api/term`、`/api/watch` 的 `upgrade` 走 `checkAuth`
- 冒烟：只断言最近助手气泡并等回合结束；`smoke:key` 禁止填假 Key 覆盖服务端密钥

### 文档

- `README` / `CONSTRAINTS` / `SMOKE` / `ARCHITECTURE` / `INDEX` / `SCORE-0.6.4` / `review-latest` 对齐 0.6.4

## 0.6.3 — 2026-10-22

### Store

- 拆分 `filesTabs` / `workspace` / `chat` reducers；`chatSessions` 为会话与消息唯一数据源，`messages` 仅为活动会话投影
- 持久化 schema v4；启动时将旧双轨（`messages` / `messagesByWorkspace`）收敛为会话列表
- 切换工作区 / 防抖落盘均走 `sealChatForPersist`
- 副作用 `ops` 抽至 `src/state/createOps.js`

### 记忆库

- 检索（RRF / ANN 精排）抽至 `server/memory-search.js`，由 store bind 注入

### Office 预览

- Excel（xlsx）改为 SheetJS（`sheetStubs` + 公式原文约定）；单表预览上限 8000 行
- PPT（pptx）明确为**文本抽取预览**（非版式还原）
- 损坏的 ZIP 字节拒绝解析

### Welcome

- 欢迎页仅保留工作区 + API Key；模型与 Base URL 归设置
- 展示 Ctrl+O / Ctrl+1…9 / Ctrl+K 快捷键提示

### 其它

- 预览换文件用 `key={path}` 复位；Chat 依赖与压缩徽标加载整理
- 文档：`docs/INDEX.md` · `docs/ARCHITECTURE.md` · `docs/SMOKE.md`；首发提交 `2e28f77`
