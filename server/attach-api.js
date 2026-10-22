/**
 * 附件 API
 *
 * 拖进输入框的**本地文件**是真的落到磁盘上的：`.cortex/attachments/<yyyy-mm>/<slug>`，
 * 然后按普通工作区文件读取内容当上下文。不做「只在内存里存一份字符串」的假附件 ——
 * 那样刷新页面就丢，模型也看不到路径，用户还没法再打开它。
 *
 * 路由：
 *   POST   /api/attach?name=<原始文件名>   请求体是文件原始字节（不是 multipart），返回落盘路径与元信息
 *   GET    /api/attach                     最近上传的附件列表
 *   DELETE /api/attach?path=<rel>          删除（只允许删附件事录里的文件）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot, toWorkspaceRel } from './workspace.js';

/** 附件体积上限（本机 Agent，默认 512MB；可用 CORTEX_MAX_ATTACH 覆盖） */
const MAX_BYTES = Number(process.env.CORTEX_MAX_ATTACH || 512 * 1024 * 1024);
const KEEP = 60; // 列表里最多回多少条

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'wasm', 'so', 'dylib', 'exe', 'dll', 'bin',
  'pdf', 'mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'flac', 'm4a', 'ogg',
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'sqlite', 'db',
]);

function root() {
  return getWorkspaceRoot();
}

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 文件名清洗：保留中英文、数字、点、下划线、连字符，其余折成 `-`。
 * 目的有两个：① 不让 `../` 之类的东西决定落盘位置；② 保证路径在上下文块里可读、可引用。
 */
export function slugFilename(name = 'file') {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80);
  return cleaned || `file-${Date.now()}`;
}

/** 落盘目录：按月份分桶，避免一个目录塞几千个文件 */
export function attachDir(date = new Date()) {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return path.join(root(), '.cortex', 'attachments', ym);
}

function relOf(abs) {
  return toWorkspaceRel(abs);
}

function isBinaryName(name, buf) {
  const ext = String(name).split('.').pop()?.toLowerCase() || '';
  if (BINARY_EXT.has(ext)) return true;
  return Boolean(buf && buf.includes(0));
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error(`附件过大（上限 ${MAX_BYTES / 1024 / 1024}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function uniquePath(dir, name) {
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let i = 2;
  // 同名不覆盖：附件是用户的原始素材，静默覆盖等于丢文件
  while (await fs.stat(candidate).then(() => true, () => false)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

export function attachApiPlugin() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/attach')) return next();

    const handle = async () => {
      /* ---------------- 上传 ---------------- */
      if (req.method === 'POST') {
        const original = url.searchParams.get('name') || 'file';
        const buf = await readRaw(req);
        if (!buf.length) return sendJson(res, 400, { error: '附件是空的' });
        const name = slugFilename(original);
        const dir = attachDir();
        const abs = await uniquePath(dir, name);
        await fs.writeFile(abs, buf);
        const binary = isBinaryName(name, buf);
        const text = binary ? '' : buf.toString('utf8');
        return sendJson(res, 200, {
          ok: true,
          path: relOf(abs),
          name: path.basename(abs),
          originalName: String(original).slice(0, 120),
          size: buf.length,
          binary,
          chars: text.length,
          lines: text ? text.split('\n').length : 0,
          // 文本附件回一段预览，界面不用再发一次读请求就能显示前几行
          preview: text.slice(0, 1200),
        });
      }

      /* ---------------- 列表 ---------------- */
      if (req.method === 'GET') {
        const base = path.join(root(), '.cortex', 'attachments');
        const out = [];
        const months = await fs.readdir(base).catch(() => []);
        for (const m of months.sort().reverse()) {
          const dir = path.join(base, m);
          const names = await fs.readdir(dir).catch(() => []);
          for (const n of names) {
            const abs = path.join(dir, n);
            const st = await fs.stat(abs).catch(() => null);
            if (!st || !st.isFile()) continue;
            out.push({ path: relOf(abs), name: n, size: st.size, mtime: st.mtimeMs, month: m });
          }
          if (out.length >= KEEP) break;
        }
        out.sort((a, b) => b.mtime - a.mtime);
        return sendJson(res, 200, { dir: relOf(base), total: out.length, files: out.slice(0, KEEP) });
      }

      /* ---------------- 删除 ---------------- */
      if (req.method === 'DELETE') {
        const rel = url.searchParams.get('path') || '';
        const base = path.join(root(), '.cortex', 'attachments');
        const abs = path.resolve(root(), rel);
        // 只允许删附件目录里的东西：这个接口不给「顺手删源码」留口子
        if (!abs.startsWith(base + path.sep)) return sendJson(res, 403, { error: '只能删除附件目录里的文件' });
        const st = await fs.stat(abs).catch(() => null);
        if (!st) return sendJson(res, 404, { error: '附件不存在' });
        await fs.unlink(abs);
        return sendJson(res, 200, { ok: true, path: rel });
      }

      return sendJson(res, 405, { error: `不支持的请求：${req.method} /api/attach` });
    };

    handle().catch((err) => {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    });
  };

  return {
    name: 'cortex-attach-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
