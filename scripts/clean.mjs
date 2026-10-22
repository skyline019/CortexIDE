/**
 * 清理「可重建」的东西，默认**不碰记忆数据**。
 *
 *   npm run clean           # dist / .cache / .cortex/pgdata / .cortex/ann / WAL / 临时文件
 *   npm run clean -- --db    # 连 .cortex/memory.db 一起删（等于恢复出厂：清空所有记忆）
 *   npm run clean -- --dry   # 只列出会删什么，不动手
 *
 * 为什么这些能删：
 *   dist/            vite 产物，npm run build 重新生成
 *   .cache/          冒烟/压测的夹具与临时库
 *   .cortex/pgdata   PGlite 的数据目录，是 sqlite 记忆的投影；「迁移记忆到 pgvector」会重建
 *   .cortex/ann/     ANN 二值索引的落盘文件，下次查询自动重建（.cortex/memory.db 才是真相）
 *   *.db-wal/-shm    SQLite 事务日志与共享内存，进程退出后残留
 */
import fs from 'node:fs';
import path from 'node:path';

const CWD = process.cwd();
const argv = process.argv.slice(2);
const WITH_DB = argv.includes('--db');
const DRY = argv.includes('--dry');

const targets = [
  { p: 'dist', why: 'vite 构建产物' },
  { p: '.cache', why: '冒烟/压测夹具' },
  { p: '.cortex/pgdata', why: 'PGlite 数据目录（可重新迁移）' },
  { p: '.cortex/ann', why: 'ANN 索引落盘文件（可重建）' },
];
// WAL / SHM 与压缩残留
for (const f of fs.existsSync('.cortex') ? fs.readdirSync('.cortex') : []) {
  if (/\.(db|db\.compact)-(wal|shm)$/.test(f) || /\.db\.(bak|compact)$/.test(f)) {
    targets.push({ p: path.join('.cortex', f), why: 'SQLite 残留日志 / 压缩中间文件' });
  }
}
if (WITH_DB) targets.push({ p: '.cortex/memory.db', why: '记忆库本体（--db 才会删）' });

const sizeOf = (p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const f of fs.readdirSync(p)) total += sizeOf(path.join(p, f));
    return total;
  } catch {
    return 0;
  }
};
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

let freed = 0;
let kept = 0;
for (const t of targets) {
  const abs = path.join(CWD, t.p);
  if (!fs.existsSync(abs)) continue;
  const size = sizeOf(abs);
  if (DRY) {
    console.log(`会删 ${t.p.padEnd(22)} ${mb(size).padStart(9)}  ${t.why}`);
    freed += size;
    continue;
  }
  fs.rmSync(abs, { recursive: true, force: true });
  console.log(`已删 ${t.p.padEnd(22)} ${mb(size).padStart(9)}  ${t.why}`);
  freed += size;
}

// 记忆库在不在
const db = path.join(CWD, '.cortex/memory.db');
if (fs.existsSync(db)) {
  kept = fs.statSync(db).size;
  console.log(`保留 .cortex/memory.db      ${mb(kept).padStart(9)}  ${WITH_DB ? '（--db 已指定，但文件仍存在？）' : '记忆数据，用 npm run clean -- --db 才会删'}`);
}
console.log(`\n${DRY ? '预计' : '共'}释放 ${mb(freed)}${kept ? ` · 记忆库 ${mb(kept)} 保留` : ''}`);
if (!WITH_DB) console.log('提示：node scripts/db-compact.mjs --apply 可以把记忆库里的空洞压掉（vec0 chunk / 孤儿行）。');
