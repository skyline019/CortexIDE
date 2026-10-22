# Cortex IDE 速览（v0.6.3）

- 定位：带持久记忆的 Agent IDE，真实磁盘工作区 + 多标签终端 + DeepSeek 模型 + 向量检索记忆
- 技术栈：React 19 + Vite 8（自建 Context，无状态库）、CodeMirror 6、xterm.js + node-pty；服务端在 server/ 以 Vite 插件挂中间件
- 记忆链路：bge-small-zh-v1.5 嵌入（Web Worker，512 维）→ sqlite-vec KNN，空则回落 src/lib/vector.js 余弦索引
- 启动：npm install && npm run dev（localhost:5173，需 .env 的 DEEPSEEK_API_KEY；换工作区用 CORTEX_WORKSPACE=/path npm run dev）
- 校验：npm run build / lint / test / test:all / e2e
