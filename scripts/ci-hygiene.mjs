/**
 * Strict CI 卫生门：源码备份、密钥、测试清单与数量下限。
 * 失败即 exit 1；禁止软过门。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = require(path.join(root, 'package.json'));

const MIN_TESTS = 175;
const errors = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'release' || name === '.git') continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

// 1) 禁止 src 下备份树 / bak
const srcFiles = walk(path.join(root, 'src'));
for (const f of srcFiles) {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  if (rel.includes('/_backup/') || rel.endsWith('.bak')) {
    errors.push(`forbidden backup path: ${rel}`);
  }
}

// 2) 密钥不得被 git 跟踪（本机可有被 ignore 的 .env）
{
  const tracked = spawnSync('git', ['ls-files', '.env', '.env.local', '.env.production', '.cortex/.env'], {
    cwd: root,
    encoding: 'utf8',
  });
  const lines = (tracked.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of lines) errors.push(`secret file is tracked by git: ${f}`);
}

// 3) package.json test 脚本必须覆盖 scripts/test-*.test.mjs
const testDir = path.join(root, 'scripts');
const onDisk = fs
  .readdirSync(testDir)
  .filter((n) => /^test-.*\.test\.mjs$/.test(n))
  .sort();
const testScript = String(pkg.scripts?.test || '');
for (const name of onDisk) {
  if (!testScript.includes(name)) {
    errors.push(`npm test script missing: scripts/${name}`);
  }
}

// 4) 统计 test() 用例数下限（与 CONSTRAINTS 单调不降对齐）
let testCount = 0;
for (const name of onDisk) {
  const text = fs.readFileSync(path.join(testDir, name), 'utf8');
  const matches = text.match(/\btest\s*\(/g) || [];
  const skips = text.match(/\btest\.skip\s*\(/g) || [];
  testCount += matches.length - skips.length;
}
if (testCount < MIN_TESTS) {
  errors.push(`test() count ${testCount} < floor ${MIN_TESTS}`);
}

// 5) lint 脚本必须 deny-warnings（等价 -Werror）
if (!String(pkg.scripts?.lint || '').includes('--deny-warnings')) {
  errors.push('npm run lint must include --deny-warnings');
}

if (errors.length) {
  console.error('ci-hygiene FAILED:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}

console.log(
  `ci-hygiene OK — tests≈${testCount} (≥${MIN_TESTS}) · suites=${onDisk.length} · no backup · lint deny-warnings`,
);
