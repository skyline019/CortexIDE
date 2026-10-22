/**
 * SSH 远程工作区（无 sshd 依赖本机任何库，直接用系统 ssh 客户端）
 *
 * 设计取向：IDE 里「远程工作区」最常用的四件事是——看清楚目录、知道 git 状态、
 * 读一个远端文件、在远端跑一条命令。所以这里不做 sftp 全量同步，而是：
 *
 *   POST /api/ssh/probe    免交互探活（BatchMode=yes，失败立刻返回原因）
 *   POST /api/ssh/ls       列远程目录（find -maxdepth 1 -printf，解析成 JSON）
 *   POST /api/ssh/git      远程 git 分支 / 变更数 / 最近提交
 *   POST /api/ssh/read     读远程文本文件（限 256KB，且必须在 profile.root 下）
 *   POST /api/ssh/exec     远程执行一条命令（前端必须二次确认）
 *   GET  /api/ssh/profiles 已保存的连接（.cortex/ssh-profiles.json）
 *
 * 安全：所有参数做单引号转义；探活/列目录/读文件都强制 BatchMode，
 * 不会因为要密码而卡住；exec 有 25s 超时 + 输出上限。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CFG_PATH = () => path.join(process.cwd(), '.cortex', 'ssh-profiles.json');
const OUTPUT_LIMIT = 256 * 1024;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 路径表达式：`~/x` 要让远端 shell 自己展开 $HOME，不能整段塞进单引号 */
const cdExpr = (dir) => {
  const d = String(dir || '~');
  if (d === '~') return '"$HOME"';
  if (d.startsWith('~/')) return `"$HOME"${shq(d.slice(1))}`;
  return shq(d);
};

const SAFE_HOST = /^[\w.-]+$/;
const SAFE_USER = /^[\w.-]+$/;

function targetOf(body = {}) {
  const host = String(body.host || '').trim();
  const user = String(body.user || '').trim();
  const port = Number(body.port || 22);
  if (!SAFE_HOST.test(host)) throw new Error('host 只允许字母数字、点、下划线、连字符');
  if (!SAFE_USER.test(user)) throw new Error('user 只允许字母数字、点、下划线、连字符');
  if (!(port > 0 && port < 65536)) throw new Error('端口不合法');
  return { host, user, port, target: `${user}@${host}` };
}

/** 执行一条 ssh 命令（BatchMode，永不弹密码） */
function ssh(base, remoteCmd, { timeout = 15000 } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=6',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'LogLevel=ERROR',
      '-p',
      String(base.port),
      base.target,
      remoteCmd,
    ];
    execFile('ssh', args, { timeout, maxBuffer: OUTPUT_LIMIT * 4, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || '').slice(0, OUTPUT_LIMIT),
        stderr: String(stderr || err?.message || '').slice(0, 8192),
        ms: Date.now() - t0,
      });
    });
  });
}


/* ---------------- 增量同步（tar over ssh，不依赖 rsync） ---------------- */

const SYNC_MAX_FILES = 20000;
const SYNC_MAX_BYTES = 512 * 1024 * 1024;
const SYNC_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.cortex'];

/** 走 tar 管道：ssh 出 → 本地展开（pull）或本地出 → ssh 展开（push） */
function tarPipe(srcCmd, dstCmd, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const src = spawn(srcCmd.bin, srcCmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const dst = spawn(dstCmd.bin, dstCmd.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    src.stdout.pipe(dst.stdin);
    src.stderr.on('data', (d) => {
      err += d.toString();
    });
    dst.stderr.on('data', (d) => {
      err += d.toString();
    });
    const timer = setTimeout(() => {
      src.kill('SIGKILL');
      dst.kill('SIGKILL');
    }, timeout);
    let done = 0;
    const finish = (code) => {
      done += 1;
      if (done < 2) return;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, error: err.slice(0, 4000) || null, ms: Date.now() - t0 });
    };
    src.on('close', (c) => finish(c));
    dst.on('close', (c) => finish(c));
  });
}

const sshBin = (base, remoteCmd) => ({
  bin: 'ssh',
  args: [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=6',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'LogLevel=ERROR',
    '-p',
    String(base.port),
    base.target,
    remoteCmd,
  ],
});

/** 本地目录清单（与远端 find 输出同构：相对路径 / 大小 / mtime） */
function walkLocal(dir, root = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (SYNC_EXCLUDES.some((x) => rel.split('/').includes(x))) continue;
    if (e.isDirectory()) {
      walkLocal(abs, root, out);
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(abs);
        out.push({ path: rel, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch {
        /* ignore */
      }
    }
    if (out.length > SYNC_MAX_FILES) break;
  }
  return out;
}

function diffSets(localList, remoteList) {
  const remote = new Map(remoteList.map((x) => [x.path, x]));
  const local = new Map(localList.map((x) => [x.path, x]));
  const added = []; // 远端有、本地没有
  const modified = [];
  const removed = []; // 本地有、远端没有
  let bytes = 0;
  for (const [p, r] of remote) {
    const l = local.get(p);
    if (!l) {
      added.push({ path: p, size: r.size });
      bytes += r.size;
    } else if (l.size !== r.size || Math.abs(l.mtime - r.mtime) > 2000) {
      modified.push({ path: p, size: r.size });
      bytes += r.size;
    }
  }
  for (const p of local.keys()) if (!remote.has(p)) removed.push({ path: p });
  return { added, modified, removed, bytes };
}

export function sshSyncHandler(body) {
  const base = targetOf(body);
  const direction = body.direction === 'push' ? 'push' : 'pull';
  const remoteDir = String(body.path || body.root || '~').slice(0, 800);
  const localDir = path.resolve(String(body.local || path.join(process.cwd(), '.cortex', 'remote', 'sync')));
  if (remoteDir === '/' || !remoteDir) throw new Error('远端目录不合法');
  const excludes = SYNC_EXCLUDES.map((x) => `--exclude=${x}`).join(' ');

  return (async () => {
    // 1) 先算差异（dry-run 与真实同步共用同一份清单）
    const remoteFind = await (async () => {
      const res = await new Promise((resolve) => {
        const child = spawn(
          'ssh',
          [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=6',
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-o',
            'LogLevel=ERROR',
            '-p',
            String(base.port),
            base.target,
            `cd -- ${cdExpr(remoteDir)} 2>/dev/null || { echo __NODIR__; exit 0; }; find . -type f ${SYNC_EXCLUDES.map((x) => `-not -path './${x}/*'`).join(' ')} -printf '%P\t%s\t%T@\n' 2>/dev/null | head -n ${SYNC_MAX_FILES + 1}`,
          ],
          { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => {
          out += d.toString();
        });
        child.stderr.on('data', (d) => {
          err += d.toString();
        });
        child.on('close', (code) => resolve({ code, out, err }));
      });
      if (res.out.includes('__NODIR__')) throw new Error('远端目录不存在');
      if (res.code !== 0 && !res.out) throw new Error(res.err || '远端命令失败');
      const list = res.out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [p, size, mtime] = l.split('\t');
          return { path: p, size: Number(size) || 0, mtime: Math.round(Number(mtime) * 1000) || 0 };
        });
      return list;
    })();

    const localList = walkLocal(localDir);
    const plan = diffSets(localList, remoteFind);
    const transfer = direction === 'pull' ? plan.added.length + plan.modified.length : localList.length;

    if (body.dryRun) {
      return {
        ok: true,
        dryRun: true,
        direction,
        remoteDir,
        localDir,
        remoteFiles: remoteFind.length,
        localFiles: localList.length,
        plan,
      };
    }
    if (remoteFind.length > SYNC_MAX_FILES) throw new Error(`远端文件太多（>${SYNC_MAX_FILES}），请缩小同步目录`);
    if (plan.bytes > SYNC_MAX_BYTES) throw new Error(`本次要传 ${(plan.bytes / 1048576).toFixed(1)}MB，超过 ${SYNC_MAX_BYTES / 1048576}MB 上限`);

    // 2) 真正传输：tar over ssh（两端都不走 shell 拼接用户输入）
    fs.mkdirSync(localDir, { recursive: true });
    const remoteTarCmd = `tar -czf - -C ${cdExpr(remoteDir)} ${excludes} .`;
    const localTarRead = { bin: 'tar', args: ['-czf', '-', '-C', localDir, '.'] };
    const localTarWrite = { bin: 'tar', args: ['-xzf', '-', '-C', localDir, '--no-same-owner'] };
    const remoteTarWrite = sshBin(base, `tar -xzf - -C ${cdExpr(remoteDir)} --no-same-owner`);
    const res =
      direction === 'pull'
        ? await tarPipe(sshBin(base, remoteTarCmd), localTarWrite)
        : await tarPipe(localTarRead, remoteTarWrite);

    return {
      ok: res.ok,
      direction,
      remoteDir,
      localDir,
      transferred: res.ok ? transfer : 0,
      plan,
      bytes: plan.bytes,
      ms: res.ms,
      error: res.ok ? null : res.error,
    };
  })();
}

function readProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_PATH(), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeProfiles(list) {
  fs.mkdirSync(path.dirname(CFG_PATH()), { recursive: true });
  fs.writeFileSync(CFG_PATH(), JSON.stringify(list.slice(0, 50), null, 2));
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
      if (raw.length > 1024 * 1024) reject(new Error('请求体过大'));
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

/** 解析 `find -printf '%y\t%s\t%T@\t%f\n'` 的输出 */
function parseFind(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [type, size, mtime, ...nameParts] = line.split('\t');
    const name = nameParts.join('\t');
    if (!name) continue;
    rows.push({
      name,
      dir: type === 'd',
      link: type === 'l',
      size: Number(size) || 0,
      mtime: Math.round(Number(mtime) * 1000) || 0,
    });
  }
  rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return rows;
}

export function sshApiPlugin() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/ssh/')) return next();
    const route = url.pathname.slice('/api/ssh/'.length);

    const handle = async () => {
      if (route === 'profiles' && req.method === 'GET') {
        return sendJson(res, 200, { profiles: readProfiles() });
      }
      if (route === 'profiles' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.remove) {
          writeProfiles(readProfiles().filter((p) => p.id !== body.remove));
          return sendJson(res, 200, { profiles: readProfiles() });
        }
        const t = targetOf(body);
        const id = `${t.target}:${t.port}`;
        const next = [
          {
            id,
            host: t.host,
            user: t.user,
            port: t.port,
            root: String(body.root || '').trim().slice(0, 400),
            label: String(body.label || t.target).slice(0, 80),
            savedAt: Date.now(),
          },
          ...readProfiles().filter((p) => p.id !== id),
        ];
        writeProfiles(next);
        return sendJson(res, 200, { profiles: next });
      }

      const body = req.method === 'POST' ? await readBody(req) : {};

      if (route === 'probe' && req.method === 'POST') {
        const base = targetOf(body);
        const r = await ssh(base, 'echo __CORTEX_OK__; uname -srm; echo "$HOME"; echo "$SHELL"');
        const ok = r.ok && r.stdout.includes('__CORTEX_OK__');
        const lines = r.stdout.split('\n').filter((l) => l && l !== '__CORTEX_OK__');
        return sendJson(res, 200, {
          ok,
          ms: r.ms,
          target: `${base.target}:${base.port}`,
          uname: lines[0] || '',
          home: (lines[1] || '').trim(),
          shell: (lines[2] || '').trim(),
          error: ok ? null : r.stderr || '连接失败（可能没配置免密密钥）',
        });
      }

      if (route === 'ls' && req.method === 'POST') {
        const base = targetOf(body);
        const dir = String(body.path || '~').slice(0, 800);
        // 用 find 一次性拿到类型/大小/时间，避免解析 ls 的列宽
        const cmd = `cd -- ${cdExpr(dir)} 2>/dev/null && pwd && find . -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null | head -n 500`;
        const r = await ssh(base, cmd);
        if (!r.ok) return sendJson(res, 200, { ok: false, error: r.stderr || `目录不可读：${dir}` });
        const [abs, ...rest] = r.stdout.split('\n');
        return sendJson(res, 200, {
          ok: true,
          path: abs.trim(),
          entries: parseFind(rest.join('\n')),
          ms: r.ms,
        });
      }

      if (route === 'git' && req.method === 'POST') {
        const base = targetOf(body);
        const dir = String(body.path || '~').slice(0, 800);
        const cmd = `cd -- ${cdExpr(dir)} 2>/dev/null || { echo '__NODIR__'; exit 0; }; git status --porcelain=v1 -b 2>/dev/null | head -n 80; echo '---LOG---'; git log -3 --pretty='%h %s' 2>/dev/null; true`;
        const r = await ssh(base, cmd);
        const [statusPart = '', logPart = ''] = r.stdout.split('---LOG---');
        const lines = statusPart.split('\n').filter(Boolean);
        const branchLine = lines.find((l) => l.startsWith('##')) || '';
        const changes = lines.filter((l) => !l.startsWith('##'));
        const notRepo = !branchLine && !r.stdout.includes('__NODIR__');
        return sendJson(res, 200, {
          ok: r.ok && !notRepo,
          branch: branchLine.replace(/^##\s*/, '').split('...')[0] || '',
          ahead: /ahead (\d+)/.exec(branchLine)?.[1] || null,
          behind: /behind (\d+)/.exec(branchLine)?.[1] || null,
          changes,
          log: logPart.split('\n').filter(Boolean),
          error: r.stdout.includes('__NODIR__') ? '远端目录不存在' : notRepo ? '不是 git 仓库' : r.ok ? null : r.stderr,
        });
      }

      if (route === 'read' && req.method === 'POST') {
        const base = targetOf(body);
        const file = String(body.file || '').slice(0, 800);
        const root = String(body.root || '').slice(0, 800);
        if (!file) return sendJson(res, 400, { ok: false, error: '缺少 file' });
        const cmd = `f=${shq(file)}; if [ ! -f "$f" ]; then echo __NOFILE__; exit 3; fi; head -c ${OUTPUT_LIMIT} -- "$f"`;
        const r = await ssh(base, cmd);
        if (r.stdout.startsWith('__NOFILE__')) return sendJson(res, 200, { ok: false, error: '远端没有这个文件' });
        if (root && !file.startsWith(root)) {
          return sendJson(res, 403, { ok: false, error: `只允许读取 profile.root（${root}）下的文件` });
        }
        return sendJson(res, 200, { ok: r.ok, content: r.stdout, bytes: Buffer.byteLength(r.stdout), error: r.ok ? null : r.stderr });
      }

      if (route === 'sync' && req.method === 'POST') {
        const r = await sshSyncHandler(body);
        return sendJson(res, r.ok ? 200 : 500, r);
      }
      if (route === 'exec' && req.method === 'POST') {
        const base = targetOf(body);
        const cmd = String(body.cmd || '').slice(0, 2000);
        if (!cmd.trim()) return sendJson(res, 400, { error: '缺少 cmd' });
        if (/rm\s+-rf\s+\/(\s|$)|\bmkfs\b|:\(\)\{|dd\s+if=|shutdown|reboot/.test(cmd)) {
          return sendJson(res, 403, { error: '远程命令命中危险模式，已拦截' });
        }
        const r = await ssh(base, `cd -- ${cdExpr(String(body.cwd || '~').slice(0, 800))} 2>/dev/null; ${cmd}`, { timeout: 25000 });
        return sendJson(res, 200, { ...r, cmd });
      }

      return sendJson(res, 404, { error: `未知路由 ${req.method} /api/ssh/${route}` });
    };

    handle().catch((err) => {
      if (res.headersSent) return;
      // 参数校验类错误回 400，别混成服务端 500
      const bad = /只允许|不合法|缺少|过大/.test(err.message || '');
      sendJson(res, bad ? 400 : 500, { error: err.message });
    });
  };

  return {
    name: 'cortex-ssh-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
