/**
 * 命令执行 API（带白名单）
 *
 * 设计原则：
 *  - 服务端是唯一权威：前端传来的命令必须命中服务端维护的白名单，否则直接拒绝
 *  - 默认禁止 shell 元字符（; | & > < ` $() 等），避免 `pnpm test && rm -rf /` 这类注入
 *  - 白名单保存在 .cortex/exec-allowlist.json，前端可通过 API 追加（用户点「始终允许」时）
 *  - 每次执行有超时（默认 120s）与输出上限（默认 256KB），并记录审计日志
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_ALLOW = [
  'pnpm test',
  'pnpm test:*',
  'pnpm run *',
  'pnpm lint',
  'pnpm build',
  'pnpm vitest *',
  'npm test',
  'npm run *',
  'npm run test:*',
  'npm install *',
  'node *',
  'npx vitest *',
  'npx tsc *',
  'ls',
  'ls *',
  'cat *',
  'head *',
  'tail *',
  'wc *',
  'grep *',
  'find *',
  'git status',
  'git status *',
  'git diff',
  'git diff *',
  'git log *',
  'git branch',
  'git show *',
  'echo *',
  'pwd',
  'which *',
  'tree',
  'tree *',
];

// 只用 shell 元字符确实会构成注入的那些：拼接、重定向、命令替换、换行。
// 括号、引号在 shell:false 下没有特殊含义，允许出现（例如 node -e "console.log(6*7)"）。
const META = /[;&|><`\n\r]|\$\(/;
const DENY = [
  /\brm\b/,
  /\bsudo\b/,
  /\bsu\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bnc\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bxargs\b/,
  /\btee\b/,
  /-delete\b/,
  /-exec(dir)?\b/,
  /--force\b/,
  /git\s+push\b/,
  /git\s+reset\s+--hard\b/,
  /git\s+clean\b/,
  /npm\s+publish\b/,
  /:\(\)\{/,
];

/**
 * 把命令切成 argv（支持单/双引号与反斜杠转义），随后用 shell:false 执行。
 * 不走 shell 意味着 | && > $() 都不会被解释，这也是允许括号/引号的前提。
 */
export function tokenize(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        // 双引号里只有 \" \\ \$ \` 和续行才算转义（POSIX）。
        //
        // 早先这里无差别吞掉反斜杠：`node -e "s.split('\n')"` 到进程里变成了
        // `s.split('n')` —— 命令被静默改写，模型算出「619 行」变成「792 行」，
        // 它在界面上还老老实实贴了自己跑的命令，肉眼看不出问题（真机测试抓到的）。
        const next = cmd[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          cur += next;
          i += 1;
        } else {
          cur += ch; // 原样保留反斜杠，交给被执行的程序自己解释
        }
      } else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** 去掉 ANSI 颜色序列，输出给模型/界面时更干净（原始终端另有 pty 通道） */
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const stripAnsi = (s) => String(s || '').replace(ANSI, '');

let allowlist = null;
let log = [];

function allowFile(cwdRoot) {
  return path.join(cwdRoot, '.cortex', 'exec-allowlist.json');
}

function loadAllow(root) {
  if (allowlist) return allowlist;
  try {
    const p = allowFile(root);
    if (fs.existsSync(p)) {
      allowlist = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {
    /* ignore */
  }
  if (!Array.isArray(allowlist) || !allowlist.length) allowlist = [...DEFAULT_ALLOW];
  return allowlist;
}

function saveAllow(root) {
  try {
    const p = allowFile(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(allowlist, null, 2));
  } catch (err) {
    console.warn('[cortex exec] 白名单保存失败', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 预设命令集（按仓库）                                                */
/* ------------------------------------------------------------------ */

function presetsFile(root) {
  return path.join(root, '.cortex', 'commands.json');
}

/** 从 package.json 的 scripts 自动生成预设 */
function detectPresets(root) {
  const out = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const pm = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : fs.existsSync(path.join(root, 'yarn.lock'))
        ? 'yarn'
        : 'npm';
    const scripts = pkg.scripts || {};
    for (const name of Object.keys(scripts).slice(0, 12)) {
      const cmd = pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} run ${name}`;
      out.push({ id: `pkg:${name}`, name, cmd, source: 'package.json', sandbox: ['test', 'build', 'lint'].includes(name) });
    }
  } catch {
    /* 没有 package.json */
  }
  out.push({ id: 'git:status', name: 'git status', cmd: 'git status', source: 'builtin' });
  out.push({ id: 'git:diff', name: 'git diff', cmd: 'git diff', source: 'builtin' });
  out.push({ id: 'ls', name: 'ls -la', cmd: 'ls -la', source: 'builtin' });
  return out;
}

function loadPresets(root) {
  let saved = [];
  try {
    const p = presetsFile(root);
    if (fs.existsSync(p)) saved = JSON.parse(fs.readFileSync(p, 'utf8')).presets || [];
  } catch {
    /* ignore */
  }
  const detected = detectPresets(root);
  const byId = new Map(detected.map((d) => [d.id, d]));
  for (const s of saved) if (!byId.has(s.id)) byId.set(s.id, { ...s, source: 'saved' });
  return [...byId.values()];
}

function savePresets(root, presets) {
  const p = presetsFile(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ presets }, null, 2));
}

/* ------------------------------------------------------------------ */
/* 文件系统沙箱：在一次性副本里跑命令                                   */
/* ------------------------------------------------------------------ */

const SANDBOX_SKIP = /node_modules|\.git$|\.git\/|\/dist\/|\/build\/|\.cortex\/|\.next\/|\.cache\/|__pycache__/;

/** 沙箱根目录：必须放在工作区之外，否则 cp 会把副本复制进自己（EINVAL） */
function sandboxRoot() {
  return process.env.CORTEX_SANDBOX_DIR || path.join(os.tmpdir(), 'cortex-sandbox');
}

/** 只保留最近 3 个沙箱，避免临时目录越堆越多 */
function pruneSandboxes(dir, keep = 3) {
  try {
    const items = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, t: Number(d.name) || 0 }))
      .sort((a, b) => b.t - a.t);
    for (const old of items.slice(keep)) {
      fs.rmSync(path.join(dir, old.name), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

/** 真容器模式：有 docker 就用 docker run 包一层（无网络、只挂载副本） */
const DOCKER_BIN = () => process.env.CORTEX_DOCKER_BIN || 'docker';
const DOCKER_IMAGE = () => process.env.CORTEX_SANDBOX_IMAGE || 'node:20-alpine';
let dockerState = null; // null=未探测 | {ok, version, reason}

function dockerAvailable() {
  if (dockerState) return dockerState;
  try {
    const r = spawnSync(DOCKER_BIN(), ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000, encoding: 'utf8' });
    if (r.status === 0) {
      dockerState = { ok: true, version: String(r.stdout || '').trim() || 'unknown', image: DOCKER_IMAGE() };
    } else {
      dockerState = { ok: false, reason: (r.stderr || r.error?.message || 'docker info 失败').toString().slice(0, 200) };
    }
  } catch (err) {
    dockerState = { ok: false, reason: err.message.slice(0, 200) };
  }
  return dockerState;
}

/**
 * 把工作区复制到 $TMPDIR/cortex-sandbox/<ts>/，命令在那里执行。
 * 删除、写盘、改配置都只影响副本，跑完可以直接扔掉（保留最近 3 份便于对比）。
 */
function makeSandbox(root, limitMb = 400) {
  const base = sandboxRoot();
  fs.mkdirSync(base, { recursive: true });
  pruneSandboxes(base);
  const dest = path.join(base, String(Date.now()));
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  let skipped = 0;
  const maxBytes = limitMb * 1024 * 1024;
  fs.cpSync(root, dest, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel) return true;
      if (SANDBOX_SKIP.test('/' + rel.split(path.sep).join('/')) || SANDBOX_SKIP.test(rel + '/')) return false;
      try {
        const st = fs.lstatSync(src);
        if (st.isFile()) {
          if (copied + st.size > maxBytes) {
            skipped += 1;
            return false;
          }
          copied += st.size;
        }
      } catch {
        return false;
      }
      return true;
    },
  });
  return { dir: dest, bytes: copied, skipped };
}

function toRegex(pattern) {
  // 'pnpm run *' -> /^pnpm run .+$/；'git status' -> 精确匹配
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 把「引号内的内容」抹掉，只留真正会交给 shell 解析的部分。
 *
 * 为什么需要：执行是 `spawn(..., { shell: false })`，根本不过 shell，
 * `node -e "console.log(a); return"` 里的分号就是普通字符。之前的检查在**整串**上
 * 跑元字符正则，把这类正常写法一并拒了 —— 真机测试里模型连试 3 次 `node -e` 全被拦，
 * 最后交了空白答案（用户看到的就是「什么都没回答」）。
 *
 * 安全性不降：未加引号的 ; | & > < ` $( 换行 仍然一律拒绝；
 * 引号没闭合也直接拒绝（否则没法判断边界在哪）。
 */
function stripQuoted(cmd) {
  let out = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += '""'; // 占位，保证 `a"b"c` 不会拼成 `ac` 这种新词
      continue;
    }
    out += ch;
  }
  return { rest: out, balanced: quote === null };
}

export function checkCommand(cmd, root) {
  const list = loadAllow(root);
  const clean = String(cmd || '').trim();
  if (!clean) return { ok: false, reason: '命令为空' };
  const q = stripQuoted(clean);
  if (!q.balanced) return { ok: false, reason: '命令里的引号没有闭合，拒绝执行' };
  if (META.test(q.rest)) {
    return { ok: false, reason: '命令里包含未加引号的 shell 元字符（; | & > < ` $( 换行），出于安全考虑拒绝执行' };
  }
  for (const re of DENY) {
    if (re.test(clean)) return { ok: false, reason: `命令命中危险模式：${re}` };
  }
  const hit = list.find((p) => toRegex(p).test(clean));
  if (!hit) return { ok: false, reason: '不在命令白名单内，可在设置 → 工作区与终端里添加允许的规则' };
  return { ok: true, matched: hit };
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

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/**
 * 供内部模块（工作流引擎）复用的执行入口：同一套白名单、同一套 tokenize。
 *
 * 为什么不走 HTTP 自己调自己：那要把 dev server 的地址写死，还得处理鉴权与超时；
 * 但也不能绕开 checkCommand —— 工作流的 shell 节点必须和白名单是**一条闸门**。
 */
export async function runWhitelisted(cmd, { root, timeoutMs = 120000, cwd } = {}) {
  const base = root || process.cwd();
  const check = checkCommand(cmd, base);
  if (!check.ok) throw new Error(check.reason);
  const argv = tokenize(String(cmd).trim());
  const [bin, ...args] = argv;
  if (!bin) throw new Error('命令为空');
  const started = performance.now();
  const dir = cwd ? path.resolve(base, cwd) : base;
  if (!dir.startsWith(base)) throw new Error('cwd 越界');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: dir,
        shell: false,
        env: { ...process.env, FORCE_COLOR: '0', CI: '1', TERM: 'dumb' },
      });
    } catch (err) {
      resolve({ cmd, code: -1, stdout: '', stderr: err.message, ms: 0, matched: check.matched });
      return;
    }
    let stdout = '';
    let stderr = '';
    const cap = 128 * 1024;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, Math.min(300000, Math.max(1000, timeoutMs)));
    child.stdout.on('data', (b) => {
      if (stdout.length < cap) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      if (stderr.length < cap) stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ cmd, code: -1, stdout, stderr: `${stderr}\n${err.message}`, ms: Math.round(performance.now() - started) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        cmd,
        code: code ?? -1,
        stdout: stripAnsi(stdout.slice(0, cap)),
        stderr: stripAnsi(stderr.slice(0, cap)),
        ms: Math.round(performance.now() - started),
        matched: check.matched,
      });
    });
  });
}

export function execApiPlugin({ workspace }) {
  const root = () => workspace() || process.cwd();

  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/exec/')) return next();
    const route = url.pathname.slice('/api/exec/'.length);

    const handle = async () => {
      /* ---- 白名单管理 ---- */
      if (route === 'allowlist' && req.method === 'GET') {
        return sendJson(res, 200, { allowlist: loadAllow(root()), defaults: DEFAULT_ALLOW, metacharBlocked: true });
      }
      if (route === 'allowlist' && req.method === 'POST') {
        const body = await readBody(req);
        const list = loadAllow(root());
        if (Array.isArray(body.allowlist)) {
          allowlist = [...new Set(body.allowlist.map((s) => String(s).trim()).filter(Boolean))];
        } else if (body.add) {
          allowlist = [...new Set([...list, String(body.add).trim()])];
        } else if (body.remove) {
          allowlist = list.filter((p) => p !== String(body.remove).trim());
        }
        saveAllow(root());
        return sendJson(res, 200, { ok: true, allowlist });
      }

      /* ---- 执行 ---- */
      if (route === 'presets' && req.method === 'GET') {
        return sendJson(res, 200, { presets: loadPresets(root()) });
      }
      if (route === 'presets' && req.method === 'POST') {
        const body = await readBody(req);
        if (Array.isArray(body.presets)) {
          savePresets(root(), body.presets.map((p) => ({ id: p.id, name: p.name, cmd: p.cmd, sandbox: Boolean(p.sandbox) })));
        }
        return sendJson(res, 200, { presets: loadPresets(root()) });
      }
      if (route === 'shell-history' && req.method === 'GET') {
        // 读 shell 自带的历史文件（bash 只有开了 HISTTIMEFORMAT 才有时间戳）
        const limit = Math.min(1000, Math.max(10, Number(url.searchParams.get('limit') || 300)));
        const homes = [process.env.HOME || '~'];
        const files = [];
        for (const h of homes) {
          for (const f of ['.bash_history', '.zsh_history', '.local/share/fish/fish_history']) {
            const p = path.join(h, f);
            if (fs.existsSync(p)) files.push(p);
          }
        }
        const out = [];
        for (const f of files) {
          let raw = '';
          try {
            const st = fs.statSync(f);
            const start = Math.max(0, st.size - 512 * 1024); // 只读尾部 512KB
            const fd = fs.openSync(f, 'r');
            const buf = Buffer.alloc(st.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            raw = buf.toString('utf8');
          } catch {
            continue;
          }
          const source = path.basename(f);
          let ts = null;
          for (const line of raw.split('\n')) {
            const l = line.trim();
            if (!l) continue;
            if (source === '.bash_history' && /^#\d{9,}$/.test(l)) {
              ts = Number(l.slice(1)) * 1000;
              continue;
            }
            if (source === '.zsh_history') {
              const m = /^: (\d+):\d+;(.*)$/.exec(l);
              if (m) {
                ts = Number(m[1]) * 1000;
                out.push({ cmd: m[2].slice(0, 500), at: ts, source });
                continue;
              }
            }
            if (source === 'fish_history') {
              const m = /^- cmd: (.*)$/.exec(l);
              if (m) out.push({ cmd: m[1].slice(0, 500), at: null, source });
              continue;
            }
            out.push({ cmd: l.slice(0, 500), at: ts, source });
          }
        }
        const seen = new Set();
        const items = out
          .reverse()
          .filter((x) => {
            if (seen.has(x.cmd)) return false;
            seen.add(x.cmd);
            return true;
          })
          .slice(0, limit);
        return sendJson(res, 200, { files: files.map((f) => path.basename(f)), count: items.length, items });
      }
      if (route === 'sandbox' && req.method === 'GET') {
        const d = dockerAvailable();
        return sendJson(res, 200, {
          docker: d,
          defaultMode: d.ok ? 'docker' : 'copy',
          image: DOCKER_IMAGE(),
          root: sandboxRoot(),
        });
      }
      if (route === 'stats' && req.method === 'GET') {
        const ok = log.filter((l) => l.ok && Number.isFinite(l.ms));
        const times = ok.map((l) => l.ms).sort((a, b) => a - b);
        const q = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))] : null);
        const byCmd = new Map();
        for (const l of ok) {
          const key = l.cmd.split(/\s+/).slice(0, 2).join(' ');
          const arr = byCmd.get(key) || [];
          arr.push(l.ms);
          byCmd.set(key, arr);
        }
        return sendJson(res, 200, {
          total: log.length,
          ok: ok.length,
          blocked: log.filter((l) => l.ok === false && l.code === null).length,
          failed: log.filter((l) => l.ok === false && l.code !== null).length,
          p50: q(0.5),
          p95: q(0.95),
          recent: log.slice(0, 40).map((l) => ({ at: l.at, cmd: l.cmd, ms: l.ms, ok: l.ok, code: l.code })),
          slowest: [...ok].sort((a, b) => b.ms - a.ms).slice(0, 5).map((l) => ({ cmd: l.cmd, ms: l.ms })),
        });
      }

      if (route === 'run' && req.method === 'POST') {
        const body = await readBody(req);
        const cmd = String(body.cmd || '').trim();
        const cwdRel = String(body.cwd || '.').trim();
        const check = checkCommand(cmd, root());
        if (!check.ok) {
          log.unshift({ at: Date.now(), cmd, ok: false, reason: check.reason, code: null, ms: 0, blocked: true });
          log = log.slice(0, 100);
          return sendJson(res, 403, { error: check.reason, blocked: true, cmd });
        }

        let base = root();
        let sandboxInfo = null;
        let dockerRun = null;
        if (body.sandbox) {
          try {
            const sb = makeSandbox(base);
            const docker = dockerAvailable();
            sandboxInfo = {
              dir: sb.dir,
              bytes: sb.bytes,
              skipped: sb.skipped,
              mode: docker.ok ? 'docker' : 'copy',
              image: docker.ok ? docker.image : null,
              reason: docker.ok ? null : docker.reason || 'docker 不可用',
            };
            base = sb.dir;
            if (body.sandbox !== 'copy' && docker.ok) dockerRun = docker;
          } catch (err) {
            return sendJson(res, 500, { error: `沙箱创建失败：${err.message}`, blocked: true, cmd });
          }
        }
        const cwd = path.resolve(base, cwdRel);
        if (!cwd.startsWith(base)) return sendJson(res, 400, { error: 'cwd 越界' });

        const timeout = Math.min(300000, Math.max(1000, Number(body.timeout || 120000)));
        const started = performance.now();
        const argv = tokenize(cmd);
        const [bin, ...args] = argv;
        if (!bin) return sendJson(res, 400, { error: '命令为空' });

        const spawnCmd = dockerRun ? DOCKER_BIN() : bin;
        const spawnArgs = dockerRun
          ? [
              'run',
              '--rm',
              '--network=none',
              '--cpus=1',
              '-m',
              '512m',
              '-v',
              `${base}:/w`,
              '-w',
              '/w',
              dockerRun.image,
              'sh',
              '-lc',
              cmd, // 容器内才走 shell：无网络 + 一次性副本，风险可控
            ]
          : args;

        const result = await new Promise((resolve) => {
          const child = spawn(spawnCmd, spawnArgs, {
            cwd,
            shell: false,
            env: { ...process.env, FORCE_COLOR: '0', CI: '1', TERM: 'dumb' },
          });
          let stdout = '';
          let stderr = '';
          let truncated = false;
          const cap = 256 * 1024;
          const push = (buf, toErr) => {
            const text = buf.toString('utf8');
            if (toErr) stderr += text;
            else stdout += text;
            if (stdout.length + stderr.length > cap) truncated = true;
          };
          child.stdout.on('data', (b) => push(b, false));
          child.stderr.on('data', (b) => push(b, true));
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, timeout);
          child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: stderr + `\n${err.message}`, ms: Math.round(performance.now() - started) });
          });
          child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({
              code: code ?? -1,
              signal: signal || null,
              stdout: truncated ? stdout.slice(0, cap) + '\n…（输出已截断）' : stdout,
              stderr,
              ms: Math.round(performance.now() - started),
            });
          });
        });

        log.unshift({
          at: Date.now(),
          cmd,
          ok: result.code === 0,
          code: result.code,
          ms: result.ms,
          matched: check.matched,
          sandbox: sandboxInfo?.dir || null,
        });
        log = log.slice(0, 100);
        return sendJson(res, 200, {
          cmd,
          argv,
          matched: check.matched,
          sandbox: sandboxInfo,
          ...result,
          stdout: stripAnsi(result.stdout),
          stderr: stripAnsi(result.stderr),
        });
      }

      if (route === 'log' && req.method === 'GET') {
        return sendJson(res, 200, { log: log.slice(0, 40) });
      }

      return sendJson(res, 404, { error: `未知路由 ${req.method} /api/exec/${route}` });
    };

    handle().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  };

  return {
    name: 'cortex-exec-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
