# Cortex IDE 仓库速览（v0.6.3）

带持久记忆的 Agent IDE：真实磁盘工作区 + 多标签终端 + DeepSeek 模型 + 向量检索记忆。

## 技术栈
- 前端 React 19 + Vite 8，无状态管理库（`src/state/store.jsx` 自建 Context）；编辑器 CodeMirror 6
- 终端 xterm.js + node-pty；`server/` 以 Vite 插件挂中间件（fs-api / terminal / llm-proxy / memory-api / watch / exec-api / ssh-api / skills-api / workflow / attach-api）
- 记忆 bge-small-zh-v1.5 嵌入（Web Worker，512 维）→ sqlite-vec KNN，空则回落 `src/lib/vector.js` 余弦索引
- 存储 better-sqlite3 + sqlite-vec、@electric-sql/pglite(+pgvector)、chokidar、ws（deps 22 / devDeps 5）

## 启动命令
- `npm install --legacy-peer-deps && npm run dev`：localhost:5173，需 .env 的 DEEPSEEK_API_KEY；换工作区 `CORTEX_WORKSPACE=/path npm run dev`
- 构建与检查：`npm run build` / `preview`（4173）/ `lint`（oxlint）；测试：`npm run test`（node --test 跑 test-compress / test-exec / test-preview / test-workflow / test-refs / test-media），`test:all` = test + bench:compress（基准，非断言）
- e2e：`npm run e2e`（bash scripts/e2e.sh，依赖 build 产物）/ `e2e:report`
- 其余脚本（共 19 个）：`smoke` / `smoke:mock` / `bench` / `bench:ann` / `bench:compress` / `bench:tokenizer` / `clean` / `db:compact` / `manifest` / `pg:reset` / `media`
