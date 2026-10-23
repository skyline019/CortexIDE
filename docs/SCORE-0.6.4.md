# Cortex 0.6.4 七维全量评估

日期：**2026-10-23 15:12（UTC+8）** · 冲 9+ 口径 · 公开仓 [skyline019/CortexIDE](https://github.com/skyline019/CortexIDE)。  
硬门槛：七维算术平均 **≥9.0**，且可靠性与可交付均 **≥9.0**。

上轮（2026-10-22）：综合 ≈ **9.17**。本轮在公开 Release + Strict CI 落地后复评。

---

## 当场证据（本轮）

| 项 | 结果 |
| --- | --- |
| Strict CI（[run 39915758304](https://github.com/skyline019/CortexIDE/actions/runs/39915758304)） | **success** · Lint / Hygiene / Test / Build / Smoke mock / **Strict CI OK** 全绿 |
| `npm run lint`（本机） | **0** error / **0** warning（`--deny-warnings`） |
| `npm run ci:hygiene`（本机） | **OK** · tests≈183（≥175）· suites=17 · 无 backup · 无跟踪密钥 |
| `npm test`（CI Ubuntu） | **Full npm test success**（180 项门禁） |
| `npm test`（本机 Windows） | **168/180** · 12 fail：打包后 `better-sqlite3` 绑定丢失（本机无 Python/VS 重建）；**不以本机红否决**，以 CI 为准 |
| GitHub Release [v0.6.4](https://github.com/skyline019/CortexIDE/releases/tag/v0.6.4) | `Cortex-0.6.4-Setup.exe` · `Cortex-0.6.4-Portable.exe`（各 ~130 MB） |
| 本机产物 | `release/win-unpacked/Cortex.exe` ~195 MB · Setup/Portable 仍在 |
| 上轮已证（未本轮重跑） | `smoke:key` 9/9 · `smoke:exe` 8/8 · recall/ABI/term-host |
| `src/` 主进程 `import('node-pty')` | **无**（仅 `term-host`） |
| 跨平台修复 | `rawContentDisposition` 反斜杠归一（Linux CI 曾因 Windows 路径 basename 红 1 测） |

### Strict CI 门禁链

```text
Lint (−Werror) → Hygiene → Full npm test → Vite build → Smoke mock → Strict CI OK
```

无 `continue-on-error`。`smoke:key` / `smoke:exe` 仍为发布机本机门禁（密钥 / Windows）。

### 热点 LOC（本轮）

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
| `terminal.js` + `term-host.mjs` | 175 + 147 | 隔离达标 |

---

## 七维打分

| 维度 | 上轮 | 本轮 | 依据 |
| --- | ---: | ---: | --- |
| 架构 | 9.2 | **9.3** | 既有拆分 + 跨平台 raw 头修复；LOC 软债未挡 |
| Agent | 9.2 | **9.2** | 工具环 / 真 Key 证据仍成立；本轮无回归 |
| 文档预览 | 8.8 | **8.8** | 边界未变（PPT 文本 / SheetJS） |
| UX | 9.0 | **9.1** | GitHub README 落地页 + Release 说明可裁剪展示 |
| 可靠性 | 9.6 | **9.7** | Strict CI 连续全绿；单测进 Ubuntu；假绿仍禁 |
| 安全 | 9.0 | **9.0** | 鉴权 / WS upgrade / 密钥不入库；无新面 |
| 可交付 | 9.4 | **9.6** | 公开仓 + v0.6.4 双 exe + Strict CI 徽章 / Actions |

**算术平均：`(9.3+9.2+8.8+9.1+9.7+9.0+9.6)/7 ≈ 9.24`**

| 硬门槛 | 结果 |
| --- | --- |
| 综合 ≥ 9.0 | **≈9.24 → 达标** |
| 可靠性 ≥ 9.0 | **9.7 → 达标** |
| 可交付 ≥ 9.0 | **9.6 → 达标** |

---

## 相对上轮变化

| 项 | 上轮 → 本轮 |
| --- | --- |
| 综合 | 9.17 → **≈9.24** |
| 可交付 | 9.4 → **9.6**（GitHub 公开 + Release + Strict CI） |
| 可靠性 | 9.6 → **9.7**（CI 自动化 mock/test/lint/build） |
| 架构 | 9.2 → **9.3**（跨平台 Content-Disposition） |
| UX | 9.0 → **9.1**（作品集向 README / Release 精修） |

---

## 剩余项（不挡 9+）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| 本机债 | Windows 打包后 Node ABI 重建 | 无 Python/VS 时 `better-sqlite3` 绑定丢失；CI Linux 不受影响；开发机需 `rebuild:node` 或重装 |
| 可选 | `smoke:key` / `smoke:exe` 入 CI | 需 secrets / Windows runner；现为发布机门禁 |
| 可选 | `npm run smoke` 全量 | 非发布硬拦 |
| 软债 | workflow / memory-ann / SettingsModal / App >600 LOC | 后续纵切 |
| 产品边界 | SSH 挂载 · PPT 版式 · hnswlib · 全量 TS | 明确不做 |
| 安全建议 | 曾暴露过的 API Key | **应轮换** |

---

## 结论

**Cortex 0.6.4 本轮全量评估：综合 ≈ 9.24，可靠性 9.7 / 可交付 9.6，冲 9+ 持续达标；已公开发布并可经 Strict CI 证伪。**
