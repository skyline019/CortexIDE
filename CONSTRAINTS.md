# Cortex 质量合同（CONSTRAINTS）

版本对齐：**0.6.4**。发布与合并前必须满足下列硬门槛；与 [`docs/SMOKE.md`](docs/SMOKE.md) 自动化段一致。  
（七维复评文档仅作者自用，不进本仓库。）

## 测试

- `npm test` 必须全绿。
- 测试总数**单调不降**：基线 **140**；冲 9+ 目标 **≥175**（当前 **180**）。
- `smoke:mock` / `smoke:key` / `smoke:exe` 全部断言为硬门禁；仅当判定本身高度模糊时才允许放宽，禁止为凑绿软过门。
- 新增核心逻辑（store / ops / memory / agent / term-host）须带对应 `scripts/*.test.mjs`。

## Lint

- `npm run lint`（oxlint `--deny-warnings`）：**0 error**，**0 warning**（已达标；CI 等价 `-Werror`）。
- 禁止为过门而批量加 `eslint-disable` / oxlint ignore；允许在 `.oxlintrc.json` 关闭与本仓库架构冲突的噪声规则（如 `only-export-components`、`set-state-in-effect`）。
- **Strict CI**（`.github/workflows/ci.yml`）：Lint → Hygiene → Test → Build → Smoke mock → **Strict CI OK**；任一门失败整链失败。

## 模块体量

- 新建或拆分后的**逻辑**热点单文件建议 **≤600 LOC**（`styles*.css` 除外）。
- 当前优先热点：`server/memory-store*.js`、`src/lib/agent*.js`、`src/components/ChatPanel*.jsx`、`src/state/createOps.js`。
- 已知软债（不挡发布）：`server/workflow.js`、`server/memory-ann.js`、`SettingsModal.jsx`、`App.jsx`、`exec-api.js`。

## 源码卫生

- **禁止**在 `src/` 保留 `_backup/` 或 `*.bak` 源码备份；历史靠 git。
- 密钥只放 gitignore 的 `.env` / `.cortex/.env` / `%APPDATA%\Cortex\.env`；禁止写入文档或提交。

## 原生模块 ABI

- **开发 / 测试**：Node ABI（`npm run rebuild:node` / `ensure-native-abi --target=node`）。
- **桌面 / 打包**：Electron ABI（`npm run rebuild:native`）；`dist:*` 结束后应自动切回 Node。
- 禁止在 `postinstall` 默认编 Electron ABI（会令随后的 `vite` 堆损坏）。
- 终端原生只允许出现在 `term-host` 子进程，不得在 Vite 主进程 `import('node-pty')`。

## 发布前必跑

```bash
npm test
npm run lint
npm run dist:dir
npm run smoke:mock   # 无 API Key
npm run smoke:key    # 真 API Key（需 .env）
npm run smoke:exe    # 打包 exe 冷启动
```

另见手工清单：[`docs/SMOKE.md`](docs/SMOKE.md)。

## 产品边界（不稀释冲分）

本阶段**不做**：SSH 透明挂载、hnswlib 强制接线、PPT 版式还原、公式重算、全量 TS 迁移。  
CI 中的 `smoke:key` / `smoke:exe` 仍为发布机本机门禁（需密钥 / Windows 产物），不强制进 Linux Strict CI。
