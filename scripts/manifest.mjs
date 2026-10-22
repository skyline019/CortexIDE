/**
 * 生成 docs/manifest.md：源码清单（行数 / 字节 / sha256 前 12 位）
 *
 * 作用很朴素：确认「哪些文件属于这个项目」，以及在改动后一眼看出哪几份变了。
 * 不计入 node_modules / .cortex / dist / shots / .env（缓存、产物、截图、密钥）。
 *
 * 运行：npm run manifest
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.cortex', '.cache', 'dist', 'shots', '.git', 'out', 'build']);
const EXTS = ['.js', '.jsx', '.css', '.html', '.md', '.mjs', '.json'];
const GROUPS = {
  server: 'server/ — 后端（Node，无框架，Vite 中间件挂载）',
  src: 'src/ — 前端（React 19）',
  scripts: 'scripts/ — 冒烟/压测/维护脚本',
  docs: 'docs/ — 文档',
  root: '根目录',
};

const files = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name));
      continue;
    }
    const rel = path.relative(ROOT, path.join(dir, ent.name)).split(path.sep).join('/');
    if (rel.startsWith('package-lock') || ent.name === '.env' || !EXTS.some((e) => rel.endsWith(e))) continue;
    const buf = fs.readFileSync(path.join(dir, ent.name));
    const top = rel.split('/')[0];
    files.push({
      rel,
      group: GROUPS[top] ? top : 'root',
      bytes: buf.length,
      lines: buf.toString('utf8').split('\n').length - 1,
      sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
    });
  }
})(ROOT);

const totalLines = files.reduce((n, f) => n + f.lines, 0);
const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
const out = [
  '# 源码清单（manifest）',
  '',
  '自动生成，用于确认「哪些文件属于这个项目」以及每份文件的行数 / 字节数 / 内容指纹。',
  `- 生成时间：${stamp}`,
  `- 文件总数：**${files.length}**，总行数：**${totalLines.toLocaleString('en-US')}**`,
  '- 指纹为 sha256 前 12 位；`node_modules` / `.cortex` / `dist` / `shots` / `.env` 不计入。',
  '',
  '重新生成：`npm run manifest`',
  '',
];

for (const [key, label] of Object.entries(GROUPS)) {
  const rows = files.filter((f) => f.group === key).sort((a, b) => a.rel.localeCompare(b.rel));
  if (!rows.length) continue;
  out.push(`## ${label}`, '', `共 ${rows.length} 个文件 / ${rows.reduce((n, r) => n + r.lines, 0).toLocaleString('en-US')} 行`, '');
  out.push('| 文件 | 行数 | 字节 | sha256 |', '| --- | ---: | ---: | --- |');
  for (const r of rows) {
    out.push(`| \`${r.rel}\` | ${r.lines.toLocaleString('en-US')} | ${r.bytes.toLocaleString('en-US')} | \`${r.sha}\` |`);
  }
  out.push('');
}

fs.writeFileSync(path.join(ROOT, 'docs/manifest.md'), out.join('\n'));
console.log(`docs/manifest.md：${files.length} 个文件 / ${totalLines.toLocaleString('en-US')} 行`);
