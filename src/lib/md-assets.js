/**
 * Markdown 里的资源地址解析（纯函数，可单测）
 *
 * 文档里的 `![图](shots/23-01.png)` 是**相对路径**。以前直接把它塞进 `<img src>`，
 * 浏览器会按应用地址解析成 `/shots/23-01.png`：
 *   - 开发时 Vite 恰好把项目根目录当静态目录，能歪打正着；
 *   - 一构建（`vite build` + preview）就没有这个目录，图片全裂；
 *   - 打开别的工作区、或者文档在子目录里，也会全错。
 * 所以统一改成走 `/api/fs/raw?path=<工作区相对路径>`：和预览器同一套读盘通道。
 */

/** 取文件所在目录（`docs/a/b.md` → `docs/a`；根目录文件 → 空串） */
export function dirOf(filePath = '') {
  const p = String(filePath).replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * 规范化相对路径：处理 `./`、`../`、重复斜杠，并防止穿出工作区。
 * `joinRel('docs', '../shots/a.png')` → `shots/a.png`
 * `joinRel('docs', '../../etc/passwd')` → `etc/passwd`（多余的 `..` 直接吃掉，不让它越界）
 */
export function joinRel(dir = '', rel = '') {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  const base = String(dir).replace(/\\/g, '/').split('/').filter(Boolean);
  const out = String(rel).trim().startsWith('/') ? [] : base.slice();
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i; // http: https: data: blob: file: //cdn…

/**
 * 把 Markdown 里的图片地址解析成能真正加载的 URL。
 *  - `http(s):` / `data:` / `blob:` / `//cdn` 原样返回（外链图片不改写）
 *  - 已经是本站接口（`/api/...`）原样返回（避免二次编码）
 *  - 其余（相对路径、`/abs/path`、`file:///…`）一律映射到工作区文件
 */
export function resolveAssetSrc(src, baseDir = '') {
  const raw = String(src || '').trim();
  if (!raw) return '';
  if (/^\/api\//i.test(raw)) return raw;
  if (EXTERNAL.test(raw)) {
    // file:// 指的就是本机磁盘，换成工作区相对路径更有意义
    if (!/^file:/i.test(raw)) return raw;
    return toRaw(joinRel(baseDir, raw.replace(/^file:\/\//i, '')));
  }
  if (raw.startsWith('#')) return raw;
  return toRaw(joinRel(baseDir, raw));
}

function toRaw(rel) {
  if (!rel) return '';
  return `/api/fs/raw?path=${encodeURIComponent(rel)}`;
}

/** 图标 alt 太长会挤爆布局，这里只留一小段给兜底占位用 */
export function shortAlt(alt = '', max = 28) {
  const s = String(alt).trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
