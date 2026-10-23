# 代码审查快照（最新）

> 更新：2026-10-22（0.6.4）。前人若仍按「plan.js 四个必须改」或「仅靠 x-cortex-user」返工，请以本文为准。

---

## 结论

| 项 | 状态 |
| --- | --- |
| `plan.js` 四项必改（空计划 / stopOnError / args 校验 / 工具缺失语义） | **已落地**，勿再按旧稿改一遍 |
| Windows + WSL：`test-compress` 写盘 | **已改** `os.tmpdir()`，勿再写死 `/tmp` |
| 公网鉴权 | **已落地**：`CORTEX_AUTH_TOKEN` / `CORTEX_AUTH_TOKENS`；禁止只靠 `x-cortex-user` |
| WS upgrade 鉴权 | **已落地**：`/api/term`、`/api/watch` 调用 `checkAuth`（含 `?access_token=`） |
| Node / Electron 原生 ABI | **已根治**：`ensure-native-abi` + `term-host` 隔离 |
| SSH 远程 | **产品边界：只同步 / 只读浏览，不做透明挂载** |
| hnswlib | **可选升级**：`CORTEX_ANN_ENGINE=hnsw` 门面已留；未接线时回退 BitIndex |
| 质量门禁 | **Strict CI** + 本机 smoke（评估文档作者自用，不进仓库） |

当前定位：本地优先 Agent IDE（**v0.6.4**），`npm test` **180/180** 应全绿。

---

## 已关闭的旧审查（勿返工）

下列内容曾出现在早期稿中，**代码侧已修复**，不要再开同题 PR：

1. **`buildPlan`**：工具缺失与抛错合并；`stopOnError` 单点判断；空计划 `ok: true`；透出 `aborted`。
2. **`validatePlan`**：`args` 须为纯对象；危险键裁剪；白名单字段。
3. **空 `steps` / 中断语义**：与调用方（Agent / UI）约定一致。
4. **`extractPlan` 边界**：无「必须改」遗留。

若要核对，直接读 `src/lib/plan.js` 与相关 `node:test`，不要照抄旧 diff。

---

## 当前有效约束

### 1. 跨系统测试路径

- 单元测试临时目录一律 `fs.mkdtempSync(path.join(os.tmpdir(), ...))`。
- Windows 本机与 WSL 挂载同一仓库时，`/tmp` 在 Win 上不存在；`os.tmpdir()` 两边都合法。

### 2. 鉴权（公网前必开）

| 环境变量 | 作用 |
| --- | --- |
| `CORTEX_AUTH_TOKEN` | 共享访问令牌 |
| `CORTEX_AUTH_TOKENS` | `user:token,...` 多用户；**身份由令牌决定** |
| `CORTEX_AUTH_DEFAULT_USER` | 共享令牌下强制用户（默认 `local`） |
| `CORTEX_AUTH_TRUST_USER_HEADER=1` | 共享令牌时才允许信任客户端 `x-cortex-user` |

实现：`server/auth.js` + 前端 `apiAuth.js`（fetch / WS `?access_token=`）。  
**WebSocket**：`upgrade` 必须再调 `checkAuth`（Connect middleware 管不到）。

**禁止**：把「带了 `x-cortex-user`」当成已鉴权。未开令牌时本地仍免密。

公网冒烟：设令牌后，无 `access_token` 的 `ws://…/api/term` 应被拒绝。

### 3. 原生 ABI

- 开发默认 Node：`npm run rebuild:node` / `dev` 前置探测。
- 桌面/打包：`rebuild:native`；`dist:*` 结束后切回 Node。
- 终端：`server/term-host.mjs` 独立进程加载 `node-pty`。

### 4. SSH 产品边界（同步 ≠ 挂载）

已有：探活、列目录、读文件、远程 exec、tar-over-ssh 增量 pull/push（不做删除）。  
**明确不做**：sshfs / FUSE 透明挂载。话术写「同步到本地再编辑」。

### 5. ANN / hnswlib

- 默认：`BitIndex` 二值量化 + 落盘增量写。
- 可选：`CORTEX_ANN_ENGINE=hnsw` → `createAnnIndex()` 门面。

### 6. 冒烟假 Key 禁忌

欢迎页 / `smoke:key` **禁止**向 `/api/llm/credentials` 写入占位 Key（会覆盖 `.cortex/.env` 热更新 `process.env`）。服务端已配置时只填工作区路径进入。

---

## 建议的验证

```bash
npm test
npm run lint
npm run smoke:mock    # 需 npm run dev
npm run smoke:key     # 需真实 DEEPSEEK_API_KEY
npm run smoke:exe     # 需已 dist:dir
```

---

## 仍可后续做（非阻塞）

- 真正接上 `hnswlib-node` 的 `HnswIndex`
- 若产品要「透明挂载」：sshfs/rclone mount（新产品能力）
- 纵切 `workflow.js` / `memory-ann.js` / `SettingsModal.jsx`（LOC 软债）
- 设置页改模型 ID / Base URL 的自动化冒烟
- `npm run smoke` 全量可选套件
