# Cortex IDE 速览（v0.6.4）

- 定位：带持久记忆的 Agent IDE，真实磁盘工作区 + 多标签终端 + DeepSeek 模型 + 向量检索记忆
- 技术栈：React 19 + Vite 8（自建 Context）、CodeMirror 6、xterm.js + term-host 隔离的 node-pty
- 记忆链路：bge-small-zh-v1.5（Web Worker）→ sqlite-vec KNN；lexical / fuseRrf 兜底
- 启动：`npm install && npm run desktop`（或 `npm run dev`）；工作区可用 `CORTEX_WORKSPACE`
- 校验：`npm test`（180）· `lint`（0）· `smoke:mock` / `smoke:key` / `smoke:exe`
- 复评：[`SCORE-0.6.4.md`](./SCORE-0.6.4.md) 综合 ≈ 9.17
