# 源码清单（manifest）

自动生成，用于确认「哪些文件属于这个项目」以及每份文件的行数 / 字节数 / 内容指纹。
- 生成时间：2026/10/22 05:20:00
- 文件总数：**109**，总行数：**33,820**
- 指纹为 sha256 前 12 位；`node_modules` / `.cortex` / `dist` / `shots` / `.env` 不计入。

重新生成：`npm run manifest`

## server/ — 后端（Node，无框架，Vite 中间件挂载）

共 20 个文件 / 8,391 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `server/ann-store.js` | 453 | 17,857 | `e3a751628f80` |
| `server/ann-worker.js` | 51 | 1,880 | `4416f50535cc` |
| `server/ann.js` | 396 | 12,922 | `b9f0afba726a` |
| `server/attach-api.js` | 180 | 6,826 | `323406ac9633` |
| `server/ctx-compress.js` | 624 | 30,171 | `baaf2fb1f479` |
| `server/exec-api.js` | 723 | 24,810 | `77ba5fc6958c` |
| `server/fs-api.js` | 385 | 15,071 | `d147b56393cb` |
| `server/llm-proxy.js` | 433 | 17,306 | `ca9be5fc5e0c` |
| `server/memory-api.js` | 233 | 10,129 | `e2c72b4036b0` |
| `server/memory-store.js` | 1,837 | 69,211 | `d9c679f128a4` |
| `server/pg-store.js` | 353 | 13,416 | `565f334a8066` |
| `server/prompts.js` | 492 | 22,315 | `6bba9209f0da` |
| `server/skills-api.js` | 114 | 4,293 | `f6f2d45b2be2` |
| `server/ssh-api.js` | 473 | 17,605 | `5c45b159bcda` |
| `server/style-profile.js` | 233 | 9,672 | `5728a171e47f` |
| `server/terminal.js` | 160 | 4,998 | `96263d06dcc3` |
| `server/text-index.js` | 76 | 2,424 | `80fa6df5c395` |
| `server/tokenizer.js` | 220 | 8,459 | `2b8908bb0d24` |
| `server/watch.js` | 212 | 7,982 | `65c4c0a86d66` |
| `server/workflow.js` | 743 | 29,314 | `9f8b141af241` |

## src/ — 前端（React 19）

共 58 个文件 / 18,333 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `src/App.jsx` | 439 | 18,096 | `e2a010fef77d` |
| `src/components/ChatPanel.jsx` | 777 | 30,301 | `5bfe13436b3a` |
| `src/components/CodeEditor.jsx` | 115 | 4,319 | `b7d3adcb7e22` |
| `src/components/CommandApproval.jsx` | 100 | 3,843 | `0fe3474db306` |
| `src/components/CommandPalette.jsx` | 87 | 3,575 | `92c4160bcbef` |
| `src/components/Composer.jsx` | 563 | 21,150 | `c3669df32a3c` |
| `src/components/DiffView.jsx` | 117 | 4,579 | `09acb5deeeda` |
| `src/components/EditorArea.jsx` | 376 | 14,816 | `22727b98aa5f` |
| `src/components/ExecPanel.jsx` | 142 | 5,585 | `c701c3e23b0a` |
| `src/components/ExternalChanges.jsx` | 77 | 2,827 | `52a8dd5d1f84` |
| `src/components/FileTree.jsx` | 220 | 7,472 | `fe2dc583c340` |
| `src/components/Icons.jsx` | 190 | 4,834 | `a09f6eff6559` |
| `src/components/Markdown.jsx` | 409 | 13,118 | `9af665cef03a` |
| `src/components/MemoryBackendPanel.jsx` | 185 | 7,985 | `f4422c55beb4` |
| `src/components/MemoryModal.jsx` | 628 | 26,272 | `cd42d4d171b6` |
| `src/components/PersonalizePanel.jsx` | 257 | 10,167 | `d51f288c2149` |
| `src/components/PlanCard.jsx` | 174 | 6,750 | `7446442cbf77` |
| `src/components/preview/MediaPreview.jsx` | 662 | 22,829 | `3f0d4a9392ba` |
| `src/components/preview/PdfPreview.jsx` | 156 | 6,126 | `8e6487b1a742` |
| `src/components/preview/Previewers.jsx` | 505 | 18,098 | `b19fee6575b0` |
| `src/components/preview/PreviewPane.jsx` | 63 | 2,484 | `50942be04cdb` |
| `src/components/RemoteModal.jsx` | 376 | 14,747 | `427a11b3f97e` |
| `src/components/SettingsModal.jsx` | 695 | 31,917 | `f6b471d7e75b` |
| `src/components/SidePanel.jsx` | 290 | 10,040 | `03c3e99e6685` |
| `src/components/SkillsModal.jsx` | 402 | 16,478 | `428a0a03e733` |
| `src/components/Terminal.jsx` | 228 | 6,719 | `270d9d8d8991` |
| `src/components/TerminalTabs.jsx` | 297 | 11,152 | `a44141a11e47` |
| `src/components/WorkflowStudio.jsx` | 617 | 24,021 | `6f5f40c00b1d` |
| `src/lib/agent.js` | 1,018 | 42,025 | `3d89f0a05f72` |
| `src/lib/bm25.js` | 97 | 2,976 | `f6add7214ad3` |
| `src/lib/context-refs.js` | 331 | 12,918 | `e13aff1b1883` |
| `src/lib/diff.js` | 121 | 3,742 | `3905ef062476` |
| `src/lib/fsClient.js` | 77 | 2,533 | `814cd622ca46` |
| `src/lib/highlight.js` | 247 | 8,043 | `d9baff9c7020` |
| `src/lib/markdown.js` | 402 | 13,738 | `74e3c669a555` |
| `src/lib/md-assets.js` | 66 | 2,735 | `01b766929f98` |
| `src/lib/media.js` | 165 | 6,885 | `cd84e92d5361` |
| `src/lib/memory.js` | 304 | 11,986 | `5e5a206fe80c` |
| `src/lib/memoryBackend.js` | 205 | 5,850 | `9561c8aa19e1` |
| `src/lib/office.js` | 351 | 13,720 | `708bf518c0e8` |
| `src/lib/plan.js` | 261 | 10,983 | `5ba7d7d62fa8` |
| `src/lib/preview-kind.js` | 59 | 2,183 | `41c6e854259e` |
| `src/lib/promptClient.js` | 162 | 4,753 | `9f42610ed74d` |
| `src/lib/refsApi.js` | 141 | 4,828 | `809634e3f88f` |
| `src/lib/retrieval.js` | 334 | 10,862 | `55c17157d07a` |
| `src/lib/tokenize.js` | 149 | 4,705 | `c0960003b42d` |
| `src/lib/vector.js` | 358 | 11,485 | `d41d21655027` |
| `src/lib/vfs.js` | 301 | 7,539 | `14f705851612` |
| `src/lib/watchClient.js` | 60 | 1,523 | `1f6dc2310022` |
| `src/lib/zip.js` | 94 | 3,742 | `7119339c6e49` |
| `src/main.jsx` | 19 | 519 | `5d420917c2bc` |
| `src/state/store.jsx` | 883 | 32,632 | `37874d7f3aec` |
| `src/state/toast.jsx` | 32 | 971 | `1a2042203e3c` |
| `src/styles-agent.css` | 542 | 17,489 | `91016090eb12` |
| `src/styles-composer.css` | 340 | 8,135 | `532a87495f7d` |
| `src/styles-preview.css` | 793 | 23,165 | `e6482ca43ba7` |
| `src/styles.css` | 1,214 | 57,623 | `eb8d0c8ff62f` |
| `src/workers/embedder.worker.js` | 60 | 2,076 | `a7ccbb251019` |

## scripts/ — 冒烟/压测/维护脚本

共 21 个文件 / 5,278 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `scripts/bench-ann.mjs` | 172 | 8,746 | `0128731a145b` |
| `scripts/bench-compress.mjs` | 207 | 14,759 | `ccdba6db1f78` |
| `scripts/bench-memory.mjs` | 91 | 3,835 | `cd0c7847825b` |
| `scripts/bench-tokenizer.mjs` | 91 | 5,596 | `870a12bdeb64` |
| `scripts/clean.mjs` | 73 | 2,970 | `bb7036199f59` |
| `scripts/db-compact.mjs` | 214 | 8,861 | `489dd7b12a69` |
| `scripts/e2e-ladder.mjs` | 768 | 40,534 | `3cc39c25878f` |
| `scripts/e2e-report.mjs` | 38 | 2,649 | `35f2cddbd0a2` |
| `scripts/make-media.mjs` | 171 | 7,294 | `3bcc9a7f20b3` |
| `scripts/manifest.mjs` | 71 | 3,026 | `d66dfde8c6e3` |
| `scripts/pg-reset.mjs` | 21 | 1,093 | `a75ca98c0384` |
| `scripts/shot-preview.mjs` | 126 | 4,657 | `cafff2a39066` |
| `scripts/smoke-mock.mjs` | 74 | 3,168 | `156c4e64d11f` |
| `scripts/smoke-preview.mjs` | 129 | 5,920 | `3f9b0d0ba41e` |
| `scripts/smoke.mjs` | 1,462 | 75,136 | `7baeef85f705` |
| `scripts/test-compress.test.mjs` | 309 | 15,639 | `20f7072345fa` |
| `scripts/test-exec.test.mjs` | 73 | 3,778 | `3ec7b80e75b2` |
| `scripts/test-media.test.mjs` | 204 | 9,473 | `59ca509ed4af` |
| `scripts/test-preview.test.mjs` | 320 | 13,973 | `68011ed7e3c4` |
| `scripts/test-refs.test.mjs` | 205 | 9,892 | `e43903806f90` |
| `scripts/test-workflow.test.mjs` | 459 | 19,077 | `84d2878af34b` |

## docs/ — 文档

共 5 个文件 / 410 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `docs/e2e-check.md` | 15 | 1,391 | `ecf33a1e1445` |
| `docs/e2e-ladder.md` | 40 | 6,609 | `6e0193ce5d8d` |
| `docs/manifest.md` | 152 | 7,629 | `827fa2ea505a` |
| `docs/plan-demo.md` | 7 | 640 | `02e5b9a87df0` |
| `docs/review-latest.md` | 196 | 10,025 | `6cda94f2d6a9` |

## 根目录

共 5 个文件 / 1,408 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `.oxlintrc.json` | 8 | 231 | `1be899e45c49` |
| `index.html` | 14 | 746 | `99464a8e0737` |
| `package.json` | 59 | 2,116 | `e23aeb362a78` |
| `README.md` | 1,271 | 101,268 | `2a3e98108497` |
| `vite.config.js` | 56 | 2,068 | `92dac1e7bb88` |
