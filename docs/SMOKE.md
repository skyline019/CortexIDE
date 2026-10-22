# Cortex 冒烟清单（发布前）

在 `npm run dist:dir` 或 `npm run desktop` 后按序勾选。

## 自动化门禁（本机已跑）
- [x] `npm test` → 140/140
- [x] SheetJS / office / preview 相关用例绿
- [x] `npm run dist:dir` 可产出 `release/win-unpacked/Cortex.exe`（若产物已过期请重打）

## 启动与欢迎页
- [ ] 桌面端打开后出现欢迎页；品牌 / Logo 正常
- [ ] 仅显示 API Key + 工作区；模型入口在「设置」
- [ ] 底部可见 Ctrl+O / Ctrl+1…9 / Ctrl+K 提示
- [ ] 填写 Key → 选文件夹进入；最近列表出现当前路径

## 工作区与快捷键
- [ ] Ctrl+O 回到欢迎页；Ctrl+1…9 打开对应最近工作区
- [ ] 侧栏文件树展开 / 打开文件 / 关标签后不再「假回退」到第一个文件
- [ ] 切换工作区后会话列表来自新目录 `.cortex/sessions/`

## 多会话
- [ ] 新建会话、切换、重命名、删除；消息不串台
- [ ] 刷新 / 重启后活动会话与消息一致（无双轨漂移）
- [ ] Token 累计显示在当前会话上

## 预览与 Agent 读文件
- [ ] PDF / Word(docx) 预览可读
- [ ] Excel(xlsx) 多表切换；大表有截断提示；栏目标注 SheetJS
- [ ] PPT(pptx) 显示「文本抽取预览」；备注可见；无假版式
- [ ] Agent `read_file` 对 xlsx/pptx 返回抽取文本

## 对话与设置
- [ ] 设置里可改模型 ID / Base URL；欢迎页不强制改模型
- [ ] Agent 一轮：读文件 → 回答；停止按钮可中断
- [ ] 记忆写入 / 检索无报错（后端可用时）

## 打包产物
- [ ] `npm run dist:dir` 成功；`release/win-unpacked/Cortex.exe` 可启动
- [ ] 无白屏；控制台无未捕获异常
