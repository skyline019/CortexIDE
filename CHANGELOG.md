# Changelog

## 0.6.3 — 2026-10-22

### Store
- 拆分 `filesTabs` / `workspace` / `chat` reducers；`chatSessions` 为会话与消息唯一数据源，`messages` 仅为活动会话投影
- 持久化 schema v4；启动时将旧双轨（`messages` / `messagesByWorkspace`）收敛为会话列表
- 切换工作区 / 防抖落盘均走 `sealChatForPersist`
- 副作用 `ops` 抽至 `src/state/createOps.js`

### 记忆库
- 检索（RRF / ANN 精排）抽至 `server/memory-search.js`，由 store bind 注入

### Office 预览
- Excel（xlsx）改用 SheetJS（`sheetStubs` + 公式原文约定）；单表预览上限 8000 行
- PPT（pptx）明确为**文本抽取预览**（非版式还原）
- 损坏非 ZIP 字节拒绝解析；相关单测 140/140 通过

### Welcome
- 欢迎页仅保留工作区 + API Key；模型与 Base URL 归设置
- 展示 Ctrl+O / Ctrl+1…9 / Ctrl+K 快捷键提示

### 其它
- 预览换文件用 `key={path}` 复位；Chat 依赖与压缩徽标加载整理
- 冒烟清单见 `docs/SMOKE.md`
