# Cortex IDE v0.6.4

**发布日期：** 2026-10-22 · **标签：** [`v0.6.4`](https://github.com/skyline019/CortexIDE/releases/tag/v0.6.4)

本机优先的 Agent IDE：真实磁盘工作区 · 多会话 · 终端 · OpenAI 兼容模型 · 分区向量记忆 · Windows 桌面构建。

---

## Downloads

| Asset | 说明 |
|:---|:---|
| [Cortex-0.6.4-Setup.exe](https://github.com/skyline019/CortexIDE/releases/download/v0.6.4/Cortex-0.6.4-Setup.exe) | NSIS 安装包（~130 MB） |
| [Cortex-0.6.4-Portable.exe](https://github.com/skyline019/CortexIDE/releases/download/v0.6.4/Cortex-0.6.4-Portable.exe) | 便携版（~130 MB） |

安装 / 便携运行后，数据在 `%APPDATA%\Cortex\`（`.env`、记忆库）。

---

## What's new

### Quality gates

- `npm test` **180** · `npm run lint` **0**
- Playwright 硬门禁：`smoke:mock` **11/11** · `smoke:key` **9/9** · `smoke:exe` **8/8**

### Stability & native

- Node / Electron **ABI** 根治：`ensure-native-abi`；开发默认 Node，桌面 / 打包切 Electron
- **term-host**：`node-pty` 独立进程，宿主崩不拖死 Vite
- `recall` 统一 `sim` / `score`；`embed('auto')` neural 未就绪走 lexical

### Architecture

- `memory-store` 门面 + crud / migrate / ann / search
- `agentTools` + `agentLoop`；Chat → `ChatSessionBar` + `ChatMessageList`
- WS `/api/term` · `/api/watch` upgrade 走 `checkAuth`

### Docs

- README / CONSTRAINTS / SMOKE / ARCHITECTURE / INDEX 对齐 0.6.4

---

## Boundaries

| 项 | 约定 |
|:---|:---|
| PPT 预览 | **文本抽取 only**，非版式还原 |
| SSH | 同步 / 只读浏览 / 远程命令，**不做透明挂载** |
| API Key | 仅本机 `.env` 或 `%APPDATA%\Cortex\`；**勿提交仓库** |
| `smoke:key` | **禁止**向服务端写入占位假 Key（会覆盖热更新密钥） |

---

## Verify

```bash
npm test
npm run lint
npm run smoke:mock    # 需 npm run dev
npm run smoke:key     # 需真实 DEEPSEEK_API_KEY
npm run smoke:exe     # 需已 dist:dir / 本 Release 产物
```

---

## License

[MIT](../LICENSE)
