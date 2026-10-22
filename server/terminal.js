/**
 * 终端服务：WebSocket + node-pty（没有 pty 时退化为 child_process）
 *
 * 协议（JSON 文本帧）：
 *   client -> { type: 'input', data }       键盘输入
 *             { type: 'resize', cols, rows } 尺寸变化
 *             { type: 'kill' }               结束会话
 *             { type: 'ping' }
 *   server -> { type: 'ready', shell, cwd, pty }
 *             { type: 'data', data }         终端输出（含 ANSI）
 *             { type: 'exit', code, signal }
 *             { type: 'error', message }
 */
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let pty = null;
let ptyLoadError = null;
try {
  // 原生模块，装不上时自动退化
  const mod = await import('node-pty');
  pty = mod.default || mod;
} catch (err) {
  ptyLoadError = err.message;
}

function pickShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

export function terminalPlugin({ workspace }) {
  const root = () => workspace() || process.cwd();

  const attach = (httpServer) => {
    if (!httpServer) return;

    // 动态引入 ws，避免影响非终端场景
    import('ws').then(({ WebSocketServer }) => {
      const wss = new WebSocketServer({ noServer: true });

      httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/api/term') return;
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });

      wss.on('connection', (ws) => {
        const shell = pickShell();
        const cwd = root();
        let term = null;
        let child = null;
        let closed = false;

        const send = (obj) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
        };

        try {
          if (pty) {
            term = pty.spawn(shell, ['-l'], {
              name: 'xterm-256color',
              cols: 100,
              rows: 28,
              cwd,
              env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' },
            });
            term.onData((data) => send({ type: 'data', data }));
            term.onExit(({ exitCode, signal }) => {
              send({ type: 'exit', code: exitCode, signal });
              try {
                ws.close();
              } catch {
                /* ignore */
              }
            });
          } else {
            child = spawn(shell, ['-i'], { cwd, env: { ...process.env, TERM: 'xterm-256color' } });
            child.stdout.on('data', (b) => send({ type: 'data', data: b.toString('utf8') }));
            child.stderr.on('data', (b) => send({ type: 'data', data: b.toString('utf8') }));
            child.on('exit', (code, signal) => send({ type: 'exit', code, signal }));
          }
        } catch (err) {
          send({ type: 'error', message: `无法启动终端：${err.message}` });
          return;
        }

        send({
          type: 'ready',
          shell,
          cwd,
          pty: Boolean(pty),
          hint: pty ? null : ptyLoadError ? `node-pty 不可用（${ptyLoadError}），已降级为管道模式` : null,
          home: os.homedir(),
          platform: process.platform,
        });

        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (msg.type === 'input') {
            if (term) term.write(msg.data);
            else if (child) child.stdin.write(msg.data);
          } else if (msg.type === 'resize') {
            const cols = Math.max(20, Math.min(400, msg.cols | 0));
            const rows = Math.max(6, Math.min(200, msg.rows | 0));
            if (term) {
              try {
                term.resize(cols, rows);
              } catch {
                /* ignore */
              }
            }
          } else if (msg.type === 'kill') {
            try {
              if (term) term.kill();
              if (child) child.kill();
            } catch {
              /* ignore */
            }
          } else if (msg.type === 'ping') {
            send({ type: 'pong' });
          }
        });

        ws.on('close', () => {
          if (closed) return;
          closed = true;
          try {
            if (term) term.kill();
            if (child) child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        });
      });
    });
  };

  return {
    name: 'cortex-terminal',
    configureServer(server) {
      attach(server.httpServer);
    },
    configurePreviewServer(server) {
      attach(server.httpServer);
    },
  };
}

export function terminalStatus() {
  return { pty: Boolean(pty), error: ptyLoadError, shell: pickShell(), cwd: process.cwd(), platform: process.platform };
}

export const _unusedPath = path;
