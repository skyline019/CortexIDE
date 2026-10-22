# 代码审查快照（最新）

> 更新于 2026-10-22。前人若仍按「plan.js 四个必须改」或「仅靠 x-cortex-user」返工，请以本文为准。

---

## 结论

| 项 | 状态 |
| --- | --- |
| `plan.js` 四项必改（空计划 / stopOnError / args 校验 / 工具缺失语义） | **已落地**，勿再按旧稿改一遍 |
| Windows + WSL：`test-compress` 写盘 | **已改** `os.tmpdir()`，勿再写死 `/tmp` |
| 公网鉴权 | **已落地**：`CORTEX_AUTH_TOKEN` / `CORTEX_AUTH_TOKENS`；禁止只靠 `x-cortex-user` |
| SSH 远程 | **产品边界：只同步 / 只读浏览，不做透明挂载**（第六阶段缺口已明确，不再当作待修 bug） |
| hnswlib | **可选升级**：`CORTEX_ANN_ENGINE=hnsw` 门面已留；需 ≥16GB + `hnswlib-node`，未接线时回退 BitIndex |

当前定位：本地优先 Agent IDE（v0.6.3），`npm test` 应全绿。

---

## 已关闭的旧审查（勿返工）

下列内容曾出现在早期 `docs/review-latest.md`，**代码侧已修复**，不要再开同题 PR：

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
| `CORTEX_AUTH_TOKENS` | `user:token,...` 多用户；**身份由令牌决定**，覆盖客户端伪造的 `x-cortex-user` |
| `CORTEX_AUTH_DEFAULT_USER` | 共享令牌下强制用户（默认 `local`） |
| `CORTEX_AUTH_TRUST_USER_HEADER=1` | 共享令牌时才允许信任客户端 `x-cortex-user`（默认关闭） |

实现：`server/auth.js`（Vite 插件最先挂 `/api`）+ 前端 `accessToken`（设置页）+ `apiAuth.js`（fetch 包装 / WS `?access_token=`）。

**禁止**：把「带了 `x-cortex-user`」当成已鉴权。未开令牌环境变量时本地开发仍免密（默认关闭鉴权）。

### 3. SSH 产品边界（同步 ≠ 挂载）

已有：探活、列目录、读文件、远程 exec、tar-over-ssh 增量 **pull/push**（不做删除）。

**明确不做（本阶段）**：sshfs / FUSE 透明挂载、把远程目录直接当成 `CORTEX_WORKSPACE` 内核级挂载。

UI / 文档话术应写「同步到本地再编辑」，不要写「已挂载远端」。若产品以后要挂载，单独立项，不要混进「修同步 bug」。

### 4. ANN / hnswlib

- 默认：`BitIndex` 二值量化 + 落盘增量写（见 README 实测表）。
- 可选：`CORTEX_ANN_ENGINE=hnsw` → `createAnnIndex()` 门面；完整 HNSW 需 16GB 级内存，见 README「要不要换成 hnswlib」。

---

## 建议的验证

```bash
npm test
# 鉴权单测已含在 scripts/test-auth.test.mjs
```

公网冒烟：设 `CORTEX_AUTH_TOKEN=...` 后，不带 Bearer 访问任意 `/api/*` 应 401；设置页填同一令牌后恢复。

---

## 仍可后续做（非阻塞）

- 真正接上 `hnswlib-node` 的 `HnswIndex`（接口对齐 `BitIndex.search/upsert/remove`）
- 若产品要「透明挂载」：sshfs/rclone mount 守护进程 + 工作区根切换（新产品能力）
- 增量落盘按块合并 CRC（性能优化，非正确性）
