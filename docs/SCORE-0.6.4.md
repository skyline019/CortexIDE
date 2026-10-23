# Cortex 0.6.4 七维全量评估

日期：**2026-10-22 19:40（UTC+8）** · 冲 9+ 口径。  
硬门槛：七维算术平均 **≥9.0**，且可靠性与可交付均 **≥9.0**。

## 当场证据（本轮同会话复跑）

| 项 | 结果 |
| --- | --- |
| `npm test` | **180 / 180** pass（17 个 `test-*.test.mjs`） |
| `npm run lint` | **0** error / **0** warning |
| `ensure-native-abi --target=node` | **Node ABI ok** |
| `smoke:mock` | **11 / 11** · EXIT 0 |
| `smoke:key`（真 DeepSeek） | **9 / 9** · EXIT 0（读 `package.json` → `cortex-ide`） |
| `smoke:exe`（打包冷启动） | **8 / 8** · EXIT 0（欢迎页、console=0、可退出） |
| Vite 冒烟后 | **HTTP 200** |
| `Cortex.exe` | 存在 · ~195 MB（`release/win-unpacked/`） |
| `src/` backup/bak | **0** |
| `smoke:mock` 软过门 | **无** |
| 主进程 `import('node-pty')` | **无**（仅 `term-host`） |

### 热点 LOC

| 模块 | LOC | 判定 |
| --- | ---: | --- |
| `server/memory-store.js` | 344 | 门面达标 |
| `server/memory-ann.js` | 730 | 软债 >600 |
| `server/workflow.js` | 813 | 软债 >600 |
| `server/exec-api.js` | 663 | 软债 >600 |
| `SettingsModal.jsx` | 733 | 软债 >600 |
| `App.jsx` | 652 | 软债略超 |
| `createOps.js` | 544 | 可接受 |
| `agent.js` / `agentLoop` / `agentTools` | 412 / 434 / 255 | 拆分达标 |
| `ChatPanel` / `ChatMessageList` | 380 / 379 | 拆分达标 |
| `terminal.js` + `term-host.mjs` | 175 + 145 | 隔离达标 |

## 七维打分

| 维度 | 0.6.3 | 本轮 | 依据 |
| --- | ---: | ---: | --- |
| 架构 | 8.5 | **9.2** | memory/agent/Chat 拆分；门面可测；LOC 软债未挡 |
| Agent | 8.0 | **9.2** | 工具环单测 + 真 Key 读文件回答 + recall 修复 |
| 文档预览 | 8.0 | **8.8** | SheetJS/PPT 文本边界诚实；版式还原属不做 |
| UX | 7.5≈ | **9.0** | 欢迎/本地/API/会话；exe 冷启欢迎页 |
| 可靠性 | 8.0 | **9.6** | 180 测 + 三冒烟同会话全绿 + ABI 根治 + term-host |
| 安全 | 7.5 | **9.0** | 鉴权伪造拒绝 + exec 负向 + WS upgrade 鉴权 |
| 可交付 | 8.0 | **9.4** | CONSTRAINTS + mock/key/exe 自动化 + 产物 exe |

**算术平均：`(9.2+9.2+8.8+9.0+9.6+9.0+9.4)/7 ≈ 9.17`**

| 硬门槛 | 结果 |
| --- | --- |
| 综合 ≥ 9.0 | **≈9.17 → 达标** |
| 可靠性 ≥ 9.0 | **9.6 → 达标** |
| 可交付 ≥ 9.0 | **9.4 → 达标** |

## 相对上轮变化

| 项 | 上轮 → 本轮 |
| --- | --- |
| 综合 | 9.13 → **≈9.17** |
| Agent | 9.1 → **9.2**（真 Key smoke:key 稳定绿） |
| 可靠性 | 9.5 → **9.6**（mock+key+exe 同会话） |
| 可交付 | 9.3 → **9.4**（exe 冷启动自动化入门禁） |

## 剩余项（不挡 9+）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| 可选 | `npm run smoke` 全量浏览器 | 含 pg/边界；非发布硬拦 |
| 手工可选 | 设置里改模型 ID / Base URL | 未自动化 |
| 手工可选 | 多会话/快捷键/预览细项 | `SMOKE.md` 后半；核心已被单测或 smoke 覆盖 |
| 软债 | workflow / memory-ann / SettingsModal >600 LOC | 建议后续纵切 |
| 产品边界 | SSH 挂载 · PPT 版式 · hnswlib · 全量 TS · CI | 明确不做 |
| 安全建议 | DeepSeek Key 曾出现在对话 | **应轮换**；仅存 gitignore 的 `.env` |

## 结论

**Cortex 0.6.4 本轮全量评估：综合 ≈ 9.17，可靠性 9.6 / 可交付 9.4，冲 9+ 达标，可发布。**
