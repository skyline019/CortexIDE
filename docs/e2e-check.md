# Cortex IDE 仓库速览（v0.6.4）

带持久记忆的 Agent IDE：真实磁盘工作区 + 多标签终端 + DeepSeek 模型 + 向量检索记忆。

## 技术栈
- 前端 React 19 + Vite 8，无状态管理库（`src/state/store.jsx` 自建 Context）；编辑器 CodeMirror 6
- 终端 xterm.js + `@lydell/node-pty`（经 `server/term-host.mjs` 隔离）；`server/` 以 Vite 插件挂中间件
- 记忆 bge-small-zh-v1.5 嵌入（Web Worker，512 维）→ sqlite-vec KNN，空则回落 `src/lib/vector.js` 余弦索引
- 存储 better-sqlite3 + sqlite-vec、@electric-sql/pglite(+pgvector)、chokidar、ws

## 启动命令
- `npm install && npm run desktop`：Electron 欢迎页；或 `npm run dev`：浏览器
- 构建与检查：`npm run build` / `lint`（oxlint，门禁 0）/ `test`（**180** 项 node:test）
- 发布冒烟：`smoke:mock`（11/11）· `smoke:key`（9/9）· `smoke:exe`（8/8）
- 可选：`smoke` 全量 · `e2e` / `e2e:report` · `bench*` · `manifest`

## 质量
- 合同：[`CONSTRAINTS.md`](../CONSTRAINTS.md) · 复评：[`SCORE-0.6.4.md`](./SCORE-0.6.4.md)（综合 ≈ 9.17）
- 架构：[`ARCHITECTURE.md`](./ARCHITECTURE.md) · 审查：[`review-latest.md`](./review-latest.md)
