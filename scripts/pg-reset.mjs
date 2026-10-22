/**
 * 把 PGlite 的数据目录挪到旁边（不是删除），下次启动自动重建。
 *
 * 为什么需要它：pgvector 后端的数据是**从 sqlite 迁移过来的副本**，
 * 进程被异常杀掉（比如 2GB 机器上的 OOM）时 PGlite 可能把目录写坏，
 * 之后就再也起不来，报「PGlite failed to initialize properly」。
 * 删数据是危险动作，所以这里只改名保留，并把怎么恢复写清楚。
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.CORTEX_PG_DIR || path.join(process.cwd(), '.cortex', 'pgdata');
if (!fs.existsSync(dir)) {
  console.log(`没有找到 ${dir}，不需要重置。`);
  process.exit(0);
}
const bak = `${dir}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.renameSync(dir, bak);
console.log(`✓ 旧数据目录已挪到 ${path.relative(process.cwd(), bak)}`);
console.log('  下次切到 pg 后端（或重启后访问 /api/mem/backend）会重建，并从 sqlite 重新迁移。');
console.log('  确认新库好用之后，旧目录可以直接删掉。');
