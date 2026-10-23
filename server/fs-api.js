/**
 * 真实文件系统 API
 *
 * 所有路径都被限制在 workspace root 之内（防目录穿越），默认 root 是启动目录，
 * 可通过 CORTEX_WORKSPACE 环境变量或 POST /api/fs/root 切换。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { getWorkspaceRoot, setWorkspaceRoot } from './workspace.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__', '.turbo', 'coverage', '.arena']);
/**
 * 文本整文件读入上限。默认 0 = 不截断（本机 Agent，不是沙箱）。
 * 若需保护渲染进程，可设 CORTEX_MAX_TEXT_READ（字节），例如 67108864。
 */
const TEXT_FULL_READ = Number(process.env.CORTEX_MAX_TEXT_READ || 0);
/** POST write 请求体上限（默认不卡小文件；可用环境变量收紧） */
const MAX_WRITE_BODY = Number(process.env.CORTEX_MAX_WRITE || 512 * 1024 * 1024);
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'eot', 'zip', 'gz', 'tgz', 'pdf', 'mp4', 'mp3',
  'wasm', 'so', 'dylib', 'node',
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba',
  // Office 文档：当文本读会得到一堆乱码，必须走二进制预览
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf',
  'avif', 'bmp', 'svg',
]);

/**
 * 预览用的 MIME。之前 /api/fs/raw 一律发 application/octet-stream，
 * 结果 `<iframe src=...>` 里 PDF 不会渲染、`<img>` 在部分浏览器里也不显示 —— 全变成下载。
 */
export const MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 视频 / 音频：不写对 MIME，<video>/<audio> 会拒绝播放（有的浏览器直接当下载）
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm',
  woff2: 'font/woff2', woff: 'font/woff', wasm: 'application/wasm',
};
const MIME = MIME_TYPES;

/**
 * `/api/fs/raw` 的 Content-Disposition。
 * 预览（img/video）只回 `inline`；下载才带文件名。
 * 文件名必须跨平台取 basename：Linux 上 `path.basename('E:\\a\\b.png')` 不会按 `\` 切开，
 * 会把整段盘符路径塞进下载头；先把 `\` 归一成 `/` 再 basename。
 */
export function rawContentDisposition(abs, { download = false } = {}) {
  if (!download) return 'inline';
  const base = path.basename(String(abs || '').replace(/\\/g, '/'));
  return `attachment; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/**
 * 解析 `Range: bytes=…`。视频拖动进度条全靠它 —— 没有 206，浏览器只能从头下整段。
 *
 * @returns {null}            没有 Range 头（整份发送）
 * @returns {{invalid:true}}  语法不认识 / 越界（回 416 + Content-Range: bytes *\/size）
 * @returns {{start:number,end:number}} 闭区间，已按文件大小裁剪
 */
export function parseRange(header, size) {
  const total = Number(size);
  if (!Number.isFinite(total) || total < 0) return { invalid: true };
  const raw = String(header || '').trim();
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m) return { invalid: true };
  const [, a, b] = m;
  if (a === '' && b === '') return { invalid: true };
  if (total === 0) return { invalid: true };
  if (a === '') {
    // bytes=-500：最后 500 字节
    const want = Number(b);
    if (!want) return { invalid: true };
    return { start: Math.max(0, total - want), end: total - 1 };
  }
  const start = Number(a);
  if (start >= total) return { invalid: true };
  const end = b === '' ? total - 1 : Math.min(Number(b), total - 1);
  if (end < start) return { invalid: true };
  return { start, end };
}


function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_WRITE_BODY) reject(new Error(`内容过大（>${Math.round(MAX_WRITE_BODY / 1024 / 1024)}MB）`));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 把用户传入的相对路径解析成 root 内的绝对路径，越界直接抛错 */
function safeJoin(rel = '.') {
  const abs = path.resolve(getWorkspaceRoot(), rel || '.');
  const root = getWorkspaceRoot();
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) throw new Error('路径越界：只能访问工作区内的文件');
  return abs;
}

function toRel(abs) {
  const rel = path.relative(getWorkspaceRoot(), abs);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

async function statOf(abs) {
  try {
    return await fs.stat(abs);
  } catch {
    return null;
  }
}

function kindOf(name, stat) {
  if (stat.isDirectory()) return 'dir';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (BINARY_EXT.has(ext)) return 'binary';
  return 'file';
}

async function listDir(abs, { depth = 1, limit = 400 } = {}) {
  const out = [];
  let count = 0;

  async function walk(dir, level) {
    if (count >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (count >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.env.example' && e.name !== '.gitignore') {
        if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
      }
      if (IGNORED.has(e.name)) continue;
      const childAbs = path.join(dir, e.name);
      let st;
      try {
        st = await fs.stat(childAbs);
      } catch {
        continue;
      }
      count++;
      out.push({
        name: e.name,
        path: toRel(childAbs),
        type: e.isDirectory() ? 'dir' : kindOf(e.name, st),
        size: st.size,
        mtime: st.mtimeMs,
        depth: level,
      });
      if (e.isDirectory() && level < depth) await walk(childAbs, level + 1);
    }
  }

  await walk(abs, 1);
  return out;
}

async function walkFiles(dir, out, limit) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORED.has(e.name) || (e.name.startsWith('.') && e.name !== '.env.example')) continue;
    const child = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(child, out, limit);
    else out.push(child);
    if (out.length >= limit) return;
  }
}

async function search(query, limit = 40) {
  const q = String(query || '').toLowerCase();
  if (!q) return { hits: [], total: 0 };
  const files = [];
  await walkFiles(getWorkspaceRoot(), files, 3000);
  const hits = [];
  let total = 0;
  for (const f of files) {
    if (BINARY_EXT.has(f.split('.').pop()?.toLowerCase() || '')) continue;
    let text;
    try {
      const st = await fs.stat(f);
      if (st.size > 512 * 1024) continue;
      text = await fs.readFile(f, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(q) && !text.toLowerCase().includes(q)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        total++;
        if (hits.length < limit) hits.push({ path: toRel(f), line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  return { hits, total };
}

export function fsApiPlugin() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/fs/')) return next();
    const route = url.pathname.slice('/api/fs/'.length);

    const handle = async () => {
      switch (`${req.method} ${route}`) {
        case 'GET terminal-info': {
          const { terminalStatus } = await import('./terminal.js');
          return sendJson(res, 200, { ...terminalStatus(), root: getWorkspaceRoot() });
        }

        /* -------- 元信息 -------- */
        case 'GET info': {
          const st = await statOf(getWorkspaceRoot());
          return sendJson(res, 200, {
            root: getWorkspaceRoot(),
            name: path.basename(getWorkspaceRoot()),
            exists: Boolean(st),
            platform: process.platform,
            node: process.version,
            writable: Boolean(st),
          });
        }
        case 'POST root': {
          const { root } = await readBody(req);
          const abs = path.resolve(String(root || ''));
          const st = await statOf(abs);
          if (!st || !st.isDirectory()) return sendJson(res, 400, { error: `目录不存在：${abs}` });
          setWorkspaceRoot(abs);
          return sendJson(res, 200, { ok: true, root: getWorkspaceRoot() });
        }

        /* -------- 读 -------- */
        case 'GET tree': {
          const rel = url.searchParams.get('path') || '.';
          const depth = Math.min(6, Number(url.searchParams.get('depth') || 2));
          const limit = Math.min(2000, Number(url.searchParams.get('limit') || 600));
          const abs = safeJoin(rel);
          const st = await statOf(abs);
          if (!st || !st.isDirectory()) return sendJson(res, 404, { error: `不是目录：${rel}` });
          const entries = await listDir(abs, { depth, limit });
          return sendJson(res, 200, { root: getWorkspaceRoot(), path: toRel(abs), entries });
        }
        case 'GET read': {
          const rel = url.searchParams.get('path') || '';
          const abs = safeJoin(rel);
          const st = await statOf(abs);
          if (!st) return sendJson(res, 404, { error: `文件不存在：${rel}` });
          if (st.isDirectory()) return sendJson(res, 400, { error: '这是一个目录' });
          const ext = path.extname(abs).slice(1).toLowerCase();
          // 已知二进制 / 媒体 / Office：不整文件进 JSON，前端用 /api/fs/raw 流式渲染（任意体积）
          if (BINARY_EXT.has(ext)) {
            return sendJson(res, 200, {
              path: toRel(abs),
              size: st.size,
              mtime: st.mtimeMs,
              binary: true,
              content: '',
            });
          }
          // 无扩展名时先探头：二进制则同样走 raw，不把大文件塞进编辑器
          if (st.size > 0) {
            const fh = await fs.open(abs, 'r');
            try {
              const probeLen = Math.min(8192, st.size);
              const probe = Buffer.alloc(probeLen);
              await fh.read(probe, 0, probeLen, 0);
              if (probe.includes(0)) {
                return sendJson(res, 200, {
                  path: toRel(abs),
                  size: st.size,
                  mtime: st.mtimeMs,
                  binary: true,
                  content: '',
                });
              }
            } finally {
              await fh.close().catch(() => {});
            }
          }
          // 文本：不因体积拒绝。默认整文件读入；仅当显式设置了 CORTEX_MAX_TEXT_READ 才截断
          const cap = TEXT_FULL_READ > 0 ? TEXT_FULL_READ : st.size;
          const take = Math.min(st.size, cap);
          const truncated = TEXT_FULL_READ > 0 && st.size > TEXT_FULL_READ;
          let content = '';
          if (take > 0) {
            if (!truncated && take === st.size) {
              content = await fs.readFile(abs, 'utf8');
            } else {
              const fh = await fs.open(abs, 'r');
              try {
                const buf = Buffer.alloc(take);
                const { bytesRead } = await fh.read(buf, 0, take, 0);
                content = buf.subarray(0, bytesRead).toString('utf8');
              } finally {
                await fh.close().catch(() => {});
              }
            }
          }
          return sendJson(res, 200, {
            path: toRel(abs),
            size: st.size,
            mtime: st.mtimeMs,
            binary: false,
            truncated,
            content,
          });
        }
        // 工作区文件清单（扁平、只有路径）：给输入框的 @ 引用做候选。
        // 不走 search：那是全文 grep，按文件名补全要的是「列目录」，两件事。
        case 'GET files': {
          const limit = Math.min(8000, Number(url.searchParams.get('limit') || 4000));
          const all = [];
          await walkFiles(getWorkspaceRoot(), all, limit);
          const query = String(url.searchParams.get('q') || '').toLowerCase();
          const files = all.map((f) => {
            const rel = toRel(f);
            return { path: rel, name: path.basename(rel), ext: rel.split('.').pop()?.toLowerCase() || '' };
          });
          const out = query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files;
          return sendJson(res, 200, { root: getWorkspaceRoot(), total: files.length, files: out.slice(0, limit) });
        }
        case 'GET search': {
          const q = url.searchParams.get('q') || '';
          const limit = Math.min(200, Number(url.searchParams.get('limit') || 40));
          const r = await search(q, limit);
          return sendJson(res, 200, { ...r, root: getWorkspaceRoot() });
        }
        case 'GET raw':
        case 'HEAD raw': {
          // 供 <img> / <video> / <audio> / PDF iframe / Office 预览读取二进制
          const rel = url.searchParams.get('path') || '';
          const abs = safeJoin(rel);
          const st = await statOf(abs);
          if (!st || st.isDirectory()) return sendJson(res, 404, { error: '文件不存在' });
          // Windows 路径是反斜杠：不能用 abs.split('/') / abs.split('.')，要用 path API
          const ext = path.extname(abs).slice(1).toLowerCase();
          const type = MIME[ext] || 'application/octet-stream';
          const range = parseRange(req.headers.range, st.size);

          res.setHeader('Content-Type', type);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader(
            'Content-Disposition',
            rawContentDisposition(abs, { download: Boolean(url.searchParams.get('download')) }),
          );
          res.setHeader('Cache-Control', 'no-cache');

          if (range && range.invalid) {
            // 416 要带 Content-Range: bytes */总长，播放器才知道文件到底多大
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${st.size}`);
            return res.end();
          }

          if (range) {
            const len = range.end - range.start + 1;
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
            res.setHeader('Content-Length', String(len));
            if (req.method === 'HEAD') return res.end();
            return createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
          }

          res.statusCode = 200;
          res.setHeader('Content-Length', String(st.size));
          if (req.method === 'HEAD') return res.end();
          createReadStream(abs).pipe(res);
          return;
        }

        /* -------- 写 -------- */
        case 'POST write': {
          const { path: rel, content = '' } = await readBody(req);
          const abs = safeJoin(rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, 'utf8');
          const st = await fs.stat(abs);
          return sendJson(res, 200, { ok: true, path: toRel(abs), size: st.size, mtime: st.mtimeMs });
        }
        case 'POST mkdir': {
          const { path: rel } = await readBody(req);
          const abs = safeJoin(rel);
          await fs.mkdir(abs, { recursive: true });
          return sendJson(res, 200, { ok: true, path: toRel(abs) });
        }
        case 'POST rename': {
          const { from, to } = await readBody(req);
          const absFrom = safeJoin(from);
          const absTo = safeJoin(to);
          await fs.rename(absFrom, absTo);
          return sendJson(res, 200, { ok: true, from: toRel(absFrom), to: toRel(absTo) });
        }
        case 'POST delete': {
          const { path: rel } = await readBody(req);
          const abs = safeJoin(rel);
          if (abs === getWorkspaceRoot()) return sendJson(res, 400, { error: '不能删除工作区根目录' });
          await fs.rm(abs, { recursive: true, force: true });
          return sendJson(res, 200, { ok: true });
        }
        default:
          return sendJson(res, 404, { error: `未知路由 ${req.method} /api/fs/${route}` });
      }
    };

    handle().catch((err) => {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    });
  };

  return {
    name: 'cortex-fs-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
