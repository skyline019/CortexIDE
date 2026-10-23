# Cortex 冒烟清单（发布前）

版本：**0.6.4** · 质量合同见根目录 [`CONSTRAINTS.md`](../CONSTRAINTS.md) · 七维复评见 [`SCORE-0.6.4.md`](./SCORE-0.6.4.md)。  
在 `npm run dist:dir` 或 `npm run desktop` 后按序勾选。

## 自动化门禁

```bash
npm test              # 全绿；总数 ≥175（当前 180）
npm run lint          # 0 error；warning ≤10（目标 0，当前 0）
npm run dist:dir      # 产出 release/win-unpacked/Cortex.exe
npm run smoke:mock    # 无 API Key；需先 npm run dev + Playwright（系统 Chrome/Edge）
npm run smoke:key     # 真 API Key 精简冒烟（.env / .cortex/.env 已配置）
npm run smoke:exe     # 打包 exe 冷启动 + 渲染控制台
```

原生模块 ABI：`dev` / `test` / `postinstall` → **Node ABI**；`desktop` / `dist:*` → **Electron ABI**（打包后自动切回 Node）。终端 `node-pty` 仅在 `term-host` 子进程。应急：`CORTEX_NO_PTY=1`。

本仓库最近一次自动化结果（**2026-10-22 19:40**）：

- [x] `npm test` → **180/180**
- [x] `npm run lint` → **0 warning**
- [x] `npm run dist:dir` → 已产出 `release/win-unpacked/Cortex.exe`
- [x] `npm run smoke:mock` → **11/11**（硬门禁；本轮复跑）
- [x] `npm run smoke:key` → **9/9**（真 DeepSeek；读 `package.json` → `cortex-ide`）
- [x] `npm run smoke:exe` → **8/8**（欢迎页、非白屏、console=0）
- [ ] `npm run smoke`（完整浏览器冒烟；可选，含 pg / 边界）

## 手工（无法 mock 的 ≤5 项）

记录日期：2026-10-22

- [x] 真 API Key：Agent 一轮读文件 → 回答；停止可中断（`smoke:key`）
- [ ] 设置里改模型 ID / Base URL 后生效
- [x] 记忆写入 / 检索无报错（`smoke:mock` 本地引擎路径）
- [x] `release/win-unpacked/Cortex.exe` 可启动；无白屏（`smoke:exe`）
- [x] 控制台无未捕获应用异常（`smoke:exe` console=0）

## 启动与欢迎页（优先由 smoke:mock / smoke:exe 覆盖）

- [x] 桌面端打开后出现欢迎页（`smoke:exe`）
- [ ] 仅显示 **API Key + 工作区**；模型 / Base URL 在「设置」
- [ ] 底部可见 `Ctrl+O` / `Ctrl+1…9` / `Ctrl+K` 提示
- [ ] 填写 Key → 选文件夹进入；最近列表出现当前路径

## 工作区与快捷键

- [ ] `Ctrl+O` 回到欢迎页；`Ctrl+1…9` 打开对应最近工作区
- [ ] 侧栏文件树展开 / 打开文件；关标签后不「假回退」到第一个文件
- [ ] 切换工作区后会话来自新目录 `.cortex/sessions/`

## 多会话（单源；单测已覆盖核心）

- [ ] 新建 / 切换 / 重命名 / 删除；消息不串台
- [ ] 刷新或重启后活动会话与消息一致（无双轨漂移）
- [ ] Token 累计挂在当前会话上

## 预览与 Agent 读文件

- [ ] PDF / Word(docx) 预览可读
- [ ] Excel(xlsx) 多表切换；大表有截断提示；栏目标注 SheetJS
- [ ] PPT(pptx) 显示「文本抽取预览」；备注可见；不假装版式还原
- [ ] Agent `read_file` 对 xlsx/pptx 返回抽取文本
