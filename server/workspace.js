/**
 * 进程内唯一工作区根。fs-api / attach-api / 其它服务端模块必须共用，
 * 否则「上传到 .cortex/attachments」写到 A 盘，read_file 却在 B 盘找 → 文件不存在。
 */
import path from 'node:path';

let ROOT = process.env.CORTEX_WORKSPACE || process.cwd();

export function getWorkspaceRoot() {
  return ROOT;
}

export function setWorkspaceRoot(next) {
  const abs = path.resolve(String(next || ''));
  ROOT = abs;
  process.env.CORTEX_WORKSPACE = abs;
  return ROOT;
}

export function toWorkspaceRel(abs) {
  const rel = path.relative(ROOT, abs);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

export function inWorkspace(abs) {
  const resolved = path.resolve(abs);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  return resolved === ROOT || resolved.startsWith(rootWithSep);
}
