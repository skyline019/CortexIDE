#!/usr/bin/env node
/**
 * e2e-report —— 把 .cache/e2e/cases/*.json 汇总成 docs/e2e-ladder.md。
 * 为什么要拆开：每个用例单独起一个 node 进程（每个进程一个浏览器，跑完就退），
 * 这样内存不会在 2 GB 的机器上累积到把系统拖死。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, '.cache/e2e/cases');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
const rows = files
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
  .sort((a, b) => a.id.localeCompare(b.id));

const pass = rows.filter((r) => r.ok).length;
const byGroup = (g) => rows.filter((r) => r.group === g);
const fmt = (n) => Number(n || 0).toLocaleString();

const lines = ['# 真机对话阶梯测试报告\n'];
lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 模型 deepseek-chat · 真浏览器 + 真磁盘\n`);
lines.push(`**${pass}/${rows.length} 通过**（通用 ${byGroup('通用').filter((r) => r.ok).length}/${byGroup('通用').length} · 代码 ${byGroup('代码').filter((r) => r.ok).length}/${byGroup('代码').length}）\n`);
lines.push('| 用例 | 组 | 难度 | 任务 | 结果 | 耗时 | 轮/工具 | token | 压缩 | 判定依据 |');
lines.push('| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |');
for (const r of rows) {
  lines.push(
    `| ${r.id} | ${r.group} | ${r.level} | ${r.title} | ${r.ok ? '✅' : '❌'} | ${(r.ms / 1000).toFixed(1)}s | ${r.rounds}/${r.toolCalls} | ${r.promptTokens || '—'}→${r.completionTokens || '—'} | ${(r.badge || '—').replace(/^·\s*/, '').replace(/\|/g, '/')} | ${String(r.detail).replace(/\|/g, '/')} |`,
  );
}
lines.push('');
lines.push(`合计：${rows.length} 个任务 · 输入 ${fmt(rows.reduce((n, r) => n + (r.promptTokens || 0), 0))} token · 输出 ${fmt(rows.reduce((n, r) => n + (r.completionTokens || 0), 0))} token · 总耗时 ${(rows.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(1)}s`);
lines.push('');
lines.push('> 代码类用例全部由测试脚本**自己去磁盘核对 / 自己重跑测试 / 用自己的语义探针**，不采信 Agent 的自述。');
lines.push('> 文本类用例的关键词断言属于弱证据，原始回答全文在 `.cache/e2e/answers/<用例>.md`。');
fs.writeFileSync(path.join(ROOT, 'docs/e2e-ladder.md'), lines.join('\n') + '\n');
console.log(`已汇总 ${rows.length} 个用例：${pass}/${rows.length} 通过 → docs/e2e-ladder.md`);
process.exit(pass === rows.length ? 0 : 1);
