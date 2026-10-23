/**
 * 终端原生宿主（独立进程）
 *
 * 在本进程加载 node-pty / 管道 shell。Vite 主进程只通过 stdio JSON 行协议通信，
 * 宿主若因 ABI/原生崩溃退出，只死这个子进程，不拖垮 Vite。
 *
 * stdin  ← { op:'start', shell, cwd, cols, rows }
 *         { op:'input', data }
 *         { op:'resize', cols, rows }
 *         { op:'kill' }
 * stdout → { type:'ready'|'data'|'exit'|'error'|'pong', ... }
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline';

const forceNoPty = process.env.CORTEX_NO_PTY === '1';
let pty = null;
let ptyLoadError = null;

try {
  if (forceNoPty) {
    ptyLoadError = 'CORTEX_NO_PTY=1';
  } else {
    const mod = await import('node-pty');
    pty = mod.default || mod;
  }
} catch (err) {
  ptyLoadError = err.message;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function shellArgs(forPty) {
  if (process.platform === 'win32') return [];
  return forPty ? ['-l'] : ['-i'];
}

let term = null;
let child = null;
let closed = false;

function cleanup() {
  if (closed) return;
  closed = true;
  try {
    term?.kill();
  } catch {
    /* ignore */
  }
  try {
    child?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

function start({ shell, cwd, cols = 100, rows = 28 }) {
  const sh = shell || (process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash');
  const dir = cwd || process.cwd();
  let usedPty = false;

  try {
    if (pty) {
      try {
        term = pty.spawn(sh, shellArgs(true), {
          name: 'xterm-256color',
          cols: Math.max(20, Math.min(400, cols | 0)),
          rows: Math.max(6, Math.min(200, rows | 0)),
          cwd: dir,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: process.env.LANG || 'en_US.UTF-8',
          },
        });
        usedPty = true;
        term.onData((data) => emit({ type: 'data', data }));
        term.onExit(({ exitCode, signal }) => {
          emit({ type: 'exit', code: exitCode, signal });
          cleanup();
          process.exit(0);
        });
      } catch (err) {
        ptyLoadError = err.message;
        term = null;
      }
    }
    if (!term) {
      child = spawn(sh, shellArgs(false), {
        cwd: dir,
        env: { ...process.env, TERM: 'xterm-256color' },
        windowsHide: true,
      });
      child.stdout.on('data', (b) => emit({ type: 'data', data: b.toString('utf8') }));
      child.stderr.on('data', (b) => emit({ type: 'data', data: b.toString('utf8') }));
      child.on('exit', (code, signal) => {
        emit({ type: 'exit', code, signal });
        cleanup();
        process.exit(0);
      });
      child.on('error', (err) => emit({ type: 'error', message: `shell 启动失败：${err.message}` }));
    }
  } catch (err) {
    emit({ type: 'error', message: `无法启动终端：${err.message}` });
    process.exit(1);
  }

  emit({
    type: 'ready',
    shell: sh,
    cwd: dir,
    pty: usedPty,
    hint: usedPty ? null : ptyLoadError ? `node-pty 不可用（${ptyLoadError}），已降级为管道模式` : null,
    home: os.homedir(),
    platform: process.platform,
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.op === 'start') start(msg);
  else if (msg.op === 'input') {
    if (term) term.write(msg.data ?? '');
    else if (child?.stdin) child.stdin.write(msg.data ?? '');
  } else if (msg.op === 'resize') {
    const cols = Math.max(20, Math.min(400, msg.cols | 0));
    const rows = Math.max(6, Math.min(200, msg.rows | 0));
    try {
      term?.resize(cols, rows);
    } catch {
      /* ignore */
    }
  } else if (msg.op === 'kill') {
    cleanup();
    process.exit(0);
  } else if (msg.op === 'ping') {
    emit({ type: 'pong' });
  }
});

process.on('disconnect', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
