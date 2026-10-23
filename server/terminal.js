/**
 * 终端服务：WebSocket ↔ 独立 term-host 子进程（node-pty / 管道）
 *
 * 原生模块只在 term-host.mjs 里加载。宿主若因 ABI 崩溃，只死子进程，不拖垮 Vite。
 *
 * 协议（JSON 文本帧，对浏览器不变）：
 *   client -> { type: 'input', data }
 *             { type: 'resize', cols, rows }
 *             { type: 'kill' }
 *             { type: 'ping' }
 *   server -> { type: 'ready', shell, cwd, pty }
 *             { type: 'data', data }
 *             { type: 'exit', code, signal }
 *             { type: 'error', message }
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { checkAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = path.join(__dirname, 'term-host.mjs');

function pickShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

/** 为一条 WS 会话拉起隔离宿主 */
function spawnTermHost({ shell, cwd, cols = 100, rows = 28, onMessage, onDead }) {
  const host = spawn(process.execPath, [HOST_SCRIPT], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  const rl = readline.createInterface({ input: host.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    try {
      onMessage(JSON.parse(line));
    } catch {
      /* ignore malformed */
    }
  });

  host.on('error', (err) => onDead(err.message));
  host.on('exit', (code, signal) => {
    rl.close();
    onDead(signal ? `term-host signal ${signal}` : `term-host exit ${code}`);
  });

  const send = (obj) => {
    if (host.stdin.writable) host.stdin.write(JSON.stringify(obj) + '\n');
  };

  send({ op: 'start', shell, cwd, cols, rows });

  return {
    input: (data) => send({ op: 'input', data }),
    resize: (c, r) => send({ op: 'resize', cols: c, rows: r }),
    kill: () => {
      try {
        send({ op: 'kill' });
      } catch {
        /* ignore */
      }
      try {
        host.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },
    ping: () => send({ op: 'ping' }),
  };
}

export function terminalPlugin({ workspace }) {
  const root = () => workspace() || process.cwd();

  const attach = (httpServer) => {
    if (!httpServer) return;

    import('ws').then(({ WebSocketServer }) => {
      const wss = new WebSocketServer({ noServer: true });

      httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/api/term') return;
        const auth = checkAuth(req);
        if (!auth.ok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });

      wss.on('connection', (ws) => {
        const shell = pickShell();
        const cwd = root();
        let closed = false;
        let session = null;

        const send = (obj) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
        };

        session = spawnTermHost({
          shell,
          cwd,
          onMessage: (msg) => {
            if (msg.type === 'ready') {
              send({
                ...msg,
                home: msg.home || os.homedir(),
                platform: msg.platform || process.platform,
              });
              return;
            }
            if (msg.type === 'exit') {
              send(msg);
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              return;
            }
            send(msg);
          },
          onDead: (reason) => {
            if (closed) return;
            send({ type: 'error', message: `终端宿主已退出：${reason}` });
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          },
        });

        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (!session) return;
          if (msg.type === 'input') session.input(msg.data);
          else if (msg.type === 'resize') {
            const cols = Math.max(20, Math.min(400, msg.cols | 0));
            const rows = Math.max(6, Math.min(200, msg.rows | 0));
            session.resize(cols, rows);
          } else if (msg.type === 'kill') session.kill();
          else if (msg.type === 'ping') session.ping();
        });

        ws.on('close', () => {
          if (closed) return;
          closed = true;
          try {
            session?.kill();
          } catch {
            /* ignore */
          }
          session = null;
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
  return {
    pty: process.env.CORTEX_NO_PTY === '1' ? false : 'host',
    error: null,
    shell: pickShell(),
    cwd: process.cwd(),
    platform: process.platform,
    host: HOST_SCRIPT,
  };
}
