# 源码清单（manifest）

自动生成，用于确认「哪些文件属于这个项目」以及每份文件的行数 / 字节数 / 内容指纹。
- 生成时间：2026/10/22 19:47:23
- 文件总数：**162**，总行数：**41,548**
- 指纹为 sha256 前 12 位；不计 `node_modules` / `.cortex` / `dist` / `release` / `shots` / `public/pdfjs` / `.env`。

重新生成：`npm run manifest`

## server/ — 后端（Node，无框架，Vite 中间件挂载）

共 27 个文件 / 9,156 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `server/ann-store.js` | 453 | 17,857 | `e3a751628f80` |
| `server/ann-worker.js` | 51 | 1,880 | `4416f50535cc` |
| `server/ann.js` | 422 | 13,866 | `8fe7beb267a1` |
| `server/attach-api.js` | 182 | 6,923 | `8d2b8d0be809` |
| `server/auth.js` | 106 | 3,581 | `819b78470ab3` |
| `server/ctx-compress.js` | 632 | 30,538 | `fdc2ebf6d0c1` |
| `server/exec-api.js` | 723 | 24,809 | `37073b31b69c` |
| `server/fs-api.js` | 453 | 17,897 | `97aea2c6864d` |
| `server/llm-proxy.js` | 504 | 20,140 | `8d21e7e6dba4` |
| `server/memory-ann.js` | 787 | 25,576 | `dbeb509aa309` |
| `server/memory-api.js` | 233 | 10,129 | `e2c72b4036b0` |
| `server/memory-crud.js` | 273 | 10,626 | `f039109b6807` |
| `server/memory-migrate.js` | 262 | 8,683 | `7eb10415d44b` |
| `server/memory-search.js` | 262 | 10,092 | `f43c6d64809a` |
| `server/memory-store.js` | 371 | 8,584 | `89efe5887c2a` |
| `server/pg-store.js` | 353 | 13,416 | `565f334a8066` |
| `server/prompts.js` | 492 | 22,315 | `6bba9209f0da` |
| `server/skills-api.js` | 114 | 4,293 | `f6f2d45b2be2` |
| `server/ssh-api.js` | 473 | 17,605 | `5c45b159bcda` |
| `server/style-profile.js` | 233 | 9,672 | `5728a171e47f` |
| `server/term-host.mjs` | 158 | 4,177 | `fd36c299c712` |
| `server/terminal.js` | 196 | 5,461 | `fd955f8cec19` |
| `server/text-index.js` | 76 | 2,424 | `80fa6df5c395` |
| `server/tokenizer.js` | 220 | 8,459 | `2b8908bb0d24` |
| `server/watch.js` | 220 | 8,328 | `5edcb80cc689` |
| `server/workflow.js` | 878 | 33,231 | `9c151fe12c78` |
| `server/workspace.js` | 29 | 863 | `b3b69fa37d72` |

## src/ — 前端（React 19）

共 78 个文件 / 22,043 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `src/App.jsx` | 675 | 24,923 | `a6dd83500bdb` |
| `src/components/ChatMessageList.jsx` | 403 | 16,100 | `ccaed022d0f3` |
| `src/components/ChatPanel.jsx` | 408 | 14,779 | `0bfce50c1fe7` |
| `src/components/ChatSessionBar.jsx` | 101 | 3,026 | `39dded779b17` |
| `src/components/CodeEditor.jsx` | 115 | 4,319 | `b7d3adcb7e22` |
| `src/components/CommandApproval.jsx` | 100 | 3,843 | `0fe3474db306` |
| `src/components/CommandPalette.jsx` | 103 | 4,424 | `707815030f04` |
| `src/components/Composer.jsx` | 613 | 23,459 | `40246ecb2bdc` |
| `src/components/DiffView.jsx` | 117 | 4,579 | `09acb5deeeda` |
| `src/components/EditorArea.jsx` | 431 | 17,731 | `c50d5598e028` |
| `src/components/EmptyHome.jsx` | 68 | 2,801 | `d3f6c4c0341d` |
| `src/components/ExecPanel.jsx` | 142 | 5,581 | `47c5a2e8b498` |
| `src/components/ExternalChanges.jsx` | 77 | 2,827 | `52a8dd5d1f84` |
| `src/components/FileTree.jsx` | 271 | 9,073 | `34f399cd7954` |
| `src/components/Icons.jsx` | 220 | 5,582 | `298050f7550f` |
| `src/components/Markdown.jsx` | 409 | 13,118 | `9af665cef03a` |
| `src/components/MemoryBackendPanel.jsx` | 185 | 7,985 | `f4422c55beb4` |
| `src/components/MemoryModal.jsx` | 628 | 26,272 | `cd42d4d171b6` |
| `src/components/PersonalizePanel.jsx` | 257 | 10,167 | `d51f288c2149` |
| `src/components/PlanCard.jsx` | 174 | 6,750 | `7446442cbf77` |
| `src/components/preview/MediaPreview.jsx` | 663 | 22,887 | `db2bf874eb47` |
| `src/components/preview/PdfPreview.jsx` | 177 | 6,281 | `494637148dba` |
| `src/components/preview/Previewers.jsx` | 517 | 18,988 | `c022e7a7f847` |
| `src/components/preview/PreviewPane.jsx` | 65 | 2,734 | `13c08b2962b0` |
| `src/components/RemoteModal.jsx` | 376 | 14,747 | `427a11b3f97e` |
| `src/components/SettingsModal.jsx` | 796 | 36,627 | `9120bc6787fc` |
| `src/components/SidePanel.jsx` | 355 | 12,652 | `03abac141368` |
| `src/components/SkillsModal.jsx` | 402 | 16,478 | `428a0a03e733` |
| `src/components/Terminal.jsx` | 230 | 6,862 | `ff4e43b1bbfd` |
| `src/components/TerminalTabs.jsx` | 297 | 11,152 | `a44141a11e47` |
| `src/components/WelcomeScreen.jsx` | 220 | 8,226 | `dd1e407942f8` |
| `src/components/WorkflowStudio.jsx` | 617 | 24,021 | `7a8478263bc9` |
| `src/lib/agent.js` | 444 | 19,909 | `59085931f107` |
| `src/lib/agentLoop.js` | 472 | 17,328 | `c1846c4f24c1` |
| `src/lib/agentTools.js` | 272 | 10,288 | `ce22f978892b` |
| `src/lib/apiAuth.js` | 87 | 2,915 | `6a76bdd19a6c` |
| `src/lib/bm25.js` | 99 | 3,080 | `e32753d2c520` |
| `src/lib/chatSession.js` | 188 | 5,947 | `051ad19ae28f` |
| `src/lib/context-refs.js` | 339 | 13,514 | `8f399b5f06a8` |
| `src/lib/diff.js` | 121 | 3,742 | `3905ef062476` |
| `src/lib/docx-mammoth.js` | 88 | 3,058 | `eee0e7db8ba4` |
| `src/lib/engineLabel.js` | 8 | 346 | `f1ae62acd50b` |
| `src/lib/fsClient.js` | 79 | 2,608 | `89c2581a4467` |
| `src/lib/highlight.js` | 247 | 8,043 | `d9baff9c7020` |
| `src/lib/layoutPrefs.js` | 27 | 606 | `3c58051b485d` |
| `src/lib/markdown.js` | 399 | 13,671 | `970daf31008d` |
| `src/lib/md-assets.js` | 66 | 2,735 | `01b766929f98` |
| `src/lib/media.js` | 165 | 6,885 | `cd84e92d5361` |
| `src/lib/memory.js` | 322 | 12,690 | `8d3bc42c99c4` |
| `src/lib/memoryBackend.js` | 210 | 6,118 | `b065f594ce36` |
| `src/lib/office.js` | 612 | 22,188 | `e4f6fe802ce4` |
| `src/lib/pdf-text.js` | 338 | 10,701 | `bea1133aa229` |
| `src/lib/plan.js` | 299 | 11,525 | `ac7a67c716a3` |
| `src/lib/preview-kind.js` | 59 | 2,183 | `41c6e854259e` |
| `src/lib/promptClient.js` | 162 | 4,753 | `9f42610ed74d` |
| `src/lib/read-any.js` | 281 | 9,841 | `f88b01efeae8` |
| `src/lib/recentWorkspaces.js` | 36 | 926 | `e27f8b9745b7` |
| `src/lib/refsApi.js` | 202 | 6,566 | `7b4df5172edf` |
| `src/lib/retrieval.js` | 334 | 10,862 | `55c17157d07a` |
| `src/lib/tokenize.js` | 149 | 4,705 | `c0960003b42d` |
| `src/lib/vector.js` | 369 | 11,936 | `fcbe87ccabbe` |
| `src/lib/vfs.js` | 301 | 7,539 | `14f705851612` |
| `src/lib/vision.js` | 120 | 4,396 | `bc9f21cbdcd2` |
| `src/lib/watchClient.js` | 62 | 1,577 | `2a68cdf0e3e8` |
| `src/lib/zip.js` | 94 | 3,742 | `7119339c6e49` |
| `src/main.jsx` | 25 | 777 | `0ff261593ae4` |
| `src/state/createOps.js` | 585 | 21,629 | `fa4f6980f3b2` |
| `src/state/opsHelpers.js` | 58 | 1,897 | `27b3d21bc052` |
| `src/state/reducers/chat.js` | 257 | 9,658 | `a5c16d0bd33b` |
| `src/state/reducers/filesTabs.js` | 72 | 2,902 | `3d5861d020dd` |
| `src/state/reducers/workspace.js` | 23 | 818 | `8dcc1be21f69` |
| `src/state/store.jsx` | 350 | 12,023 | `be9e650074b7` |
| `src/state/toast.jsx` | 32 | 971 | `1a2042203e3c` |
| `src/styles-agent.css` | 542 | 17,489 | `91016090eb12` |
| `src/styles-composer.css` | 340 | 8,135 | `532a87495f7d` |
| `src/styles-preview.css` | 904 | 25,568 | `7faa15ec8cac` |
| `src/styles.css` | 1,532 | 69,827 | `5dec1d203ebc` |
| `src/workers/embedder.worker.js` | 60 | 2,076 | `a7ccbb251019` |

## scripts/ — 冒烟/压测/维护脚本

共 39 个文件 / 7,705 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `scripts/_patch-smoke-launch.mjs` | 32 | 1,053 | `b14f00116b0e` |
| `scripts/bench-ann.mjs` | 172 | 8,697 | `3c61f650d28c` |
| `scripts/bench-compress.mjs` | 207 | 14,757 | `98cfee46c0c2` |
| `scripts/bench-memory.mjs` | 91 | 3,835 | `cd0c7847825b` |
| `scripts/bench-tokenizer.mjs` | 93 | 5,625 | `d711d58ddaf8` |
| `scripts/clean.mjs` | 73 | 2,970 | `bb7036199f59` |
| `scripts/db-compact.mjs` | 214 | 8,861 | `489dd7b12a69` |
| `scripts/desktop-postinstall.mjs` | 19 | 715 | `34a124cb6207` |
| `scripts/e2e-ladder.mjs` | 768 | 40,542 | `8c8b4ae2291b` |
| `scripts/e2e-report.mjs` | 38 | 2,649 | `35f2cddbd0a2` |
| `scripts/ensure-native-abi.mjs` | 141 | 4,463 | `a929bc233990` |
| `scripts/make-media.mjs` | 269 | 10,205 | `5f99727d31d1` |
| `scripts/manifest.mjs` | 82 | 3,159 | `81e956e325f8` |
| `scripts/pg-reset.mjs` | 21 | 1,093 | `a75ca98c0384` |
| `scripts/shot-preview.mjs` | 126 | 4,657 | `cafff2a39066` |
| `scripts/smoke-exe.mjs` | 200 | 6,621 | `14469f44cea6` |
| `scripts/smoke-key.mjs` | 174 | 7,099 | `dedaa497a49e` |
| `scripts/smoke-mock.mjs` | 196 | 7,110 | `8b25bd439b34` |
| `scripts/smoke-preview.mjs` | 129 | 5,920 | `3f9b0d0ba41e` |
| `scripts/smoke.mjs` | 1,468 | 75,295 | `1114cb3f0222` |
| `scripts/sync-icons.mjs` | 67 | 2,278 | `bede11af5689` |
| `scripts/sync-pdfjs-assets.mjs` | 39 | 1,276 | `4709cb52d799` |
| `scripts/test-agent-loop.test.mjs` | 230 | 6,998 | `f36efbae756a` |
| `scripts/test-ann.test.mjs` | 78 | 2,484 | `091423aedc05` |
| `scripts/test-auth.test.mjs` | 151 | 4,135 | `42011d325f15` |
| `scripts/test-chat-session.test.mjs` | 130 | 5,006 | `007cea067b40` |
| `scripts/test-compress.test.mjs` | 317 | 15,951 | `a81f51146076` |
| `scripts/test-docx-mammoth.test.mjs` | 96 | 3,729 | `c42fbcf7f5b2` |
| `scripts/test-exec.test.mjs` | 85 | 4,218 | `e4971cdf94a6` |
| `scripts/test-media.test.mjs` | 204 | 9,473 | `59ca509ed4af` |
| `scripts/test-memory-store.test.mjs` | 193 | 5,381 | `3e3e11a99ed3` |
| `scripts/test-office.test.mjs` | 191 | 7,688 | `374570fe136c` |
| `scripts/test-ops.test.mjs` | 116 | 3,554 | `1c8541f8b105` |
| `scripts/test-pdf-text.test.mjs` | 69 | 2,282 | `c3eea000b6c4` |
| `scripts/test-preview.test.mjs` | 334 | 14,907 | `b9d0dee2b72e` |
| `scripts/test-recall.test.mjs` | 33 | 1,679 | `e7494e4077b8` |
| `scripts/test-refs.test.mjs` | 205 | 9,892 | `e43903806f90` |
| `scripts/test-term-host.test.mjs` | 59 | 1,968 | `8092d7312e51` |
| `scripts/test-workflow.test.mjs` | 595 | 24,621 | `51cdb7d1f75f` |

## docs/ — 文档

共 9 个文件 / 646 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `docs/ARCHITECTURE.md` | 102 | 5,431 | `f26d99b729cf` |
| `docs/e2e-check.md` | 19 | 1,216 | `24f7a89ddfe7` |
| `docs/e2e-ladder.md` | 40 | 6,609 | `6e0193ce5d8d` |
| `docs/INDEX.md` | 30 | 1,649 | `2a8a91648e04` |
| `docs/manifest.md` | 205 | 10,904 | `948054470cae` |
| `docs/plan-demo.md` | 8 | 617 | `c06a00eb658e` |
| `docs/review-latest.md` | 100 | 4,034 | `fd19f1080ec0` |
| `docs/SCORE-0.6.4.md` | 79 | 3,399 | `a37e52e6305b` |
| `docs/SMOKE.md` | 63 | 3,013 | `6b7f0e52858d` |

## 根目录

共 9 个文件 / 1,998 行

| 文件 | 行数 | 字节 | sha256 |
| --- | ---: | ---: | --- |
| `.oxlintrc.json` | 21 | 534 | `5c6cfb4f5dab` |
| `CHANGELOG.md` | 58 | 2,468 | `8c6a40123cd4` |
| `CONSTRAINTS.md` | 51 | 2,428 | `8220aa347794` |
| `desktop/host.mjs` | 198 | 6,306 | `239aea4a6a7b` |
| `desktop/main.mjs` | 175 | 4,881 | `7ba049fa3f16` |
| `index.html` | 17 | 666 | `60ae325a6e35` |
| `package.json` | 80 | 3,909 | `7a6293af0dfc` |
| `README.md` | 1,328 | 101,404 | `f1c7a7003d22` |
| `vite.config.js` | 70 | 2,740 | `078d33970b9a` |
