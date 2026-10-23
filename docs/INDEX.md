# 文档索引（Cortex 0.6.4）

| 文档 | 内容 |
| --- | --- |
| [`../README.md`](../README.md) | GitHub 首页（定位 / 下载 / 门禁）；附录为能力长文 |
| [`RELEASE_NOTES_v0.6.4.md`](./RELEASE_NOTES_v0.6.4.md) | v0.6.4 发布说明（与 GitHub Release 对齐） |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | **当前**分层架构、状态机、预览边界、安全、ABI / term-host |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本变更（0.6.4） |
| [`../CONSTRAINTS.md`](../CONSTRAINTS.md) | **质量合同**（测试 / lint / 体量 / ABI / 发布门禁） |
| [`SCORE-0.6.4.md`](./SCORE-0.6.4.md) | 冲 9+ 七维全量评估（综合 ≈ **9.17**） |
| [`SMOKE.md`](./SMOKE.md) | 发布前冒烟清单（mock / key / exe 自动化） |
| [`manifest.md`](./manifest.md) | 源码清单 / 行数 / sha256（`npm run manifest`） |
| [`e2e-ladder.md`](./e2e-ladder.md) | 真机阶梯测试报告（`npm run e2e` 生成） |
| [`e2e-check.md`](./e2e-check.md) | e2e 检查补充说明 |
| [`review-latest.md`](./review-latest.md) | 审查结论与有效约束（勿按旧稿返工） |
| [`plan-demo.md`](./plan-demo.md) | 工作流 / Plan 演示产物示例 |

配置模板：根目录 [`.env.example`](../.env.example)。

## 常用脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Vite 开发（先确保 Node ABI） |
| `npm test` / `npm run lint` / `ci:hygiene` | 单测 + oxlint（deny-warnings）+ 卫生门 |
| GitHub Actions Strict CI | Lint → Hygiene → Test → Build → smoke:mock → OK |
| `npm run desktop` | Electron 开发窗（先切 Electron ABI） |
| `npm run dist:dir` / `dist:win` | 打包；结束后切回 Node ABI |
| `npm run smoke:mock` | 无 Key 浏览器冒烟 |
| `npm run smoke:key` | 真 Key Agent 精简冒烟 |
| `npm run smoke:exe` | `Cortex.exe` 冷启动 |
| `npm run rebuild:node` / `rebuild:native` | 手动切换原生 ABI |
