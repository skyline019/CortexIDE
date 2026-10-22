import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { wsAuthUrl } from '../lib/apiAuth.js';

const THEME = {
  background: '#080b11',
  foreground: '#dbe3ef',
  cursor: '#2dd4bf',
  cursorAccent: '#080b11',
  selectionBackground: 'rgba(45,212,191,0.28)',
  black: '#1a2331',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#38bdf8',
  magenta: '#a78bfa',
  cyan: '#2dd4bf',
  white: '#dbe3ef',
  brightBlack: '#5b6879',
  brightRed: '#fca5a5',
  brightGreen: '#6ee7b7',
  brightYellow: '#fcd34d',
  brightBlue: '#7dd3fc',
  brightMagenta: '#c4b5fd',
  brightCyan: '#5eead4',
  brightWhite: '#f8fafc',
};

export default function Terminal({
  onExit,
  onStatus,
  onCommand,
  initialCommand,
  tabId,
  height = 208,
  visible = true,
}) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('connecting'); // connecting | ready | closed | error
  const [info, setInfo] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!hostRef.current) return undefined;

    const term = new XTerm({
      theme: THEME,
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws = null;
    let disposed = false;
    const connectTimer = setTimeout(() => {
      if (disposed) return;
      // 鉴权开时用 ?access_token=（WebSocket 不能自定义 Authorization）
      ws = new WebSocket(wsAuthUrl(`${proto}//${location.host}/api/term`));
      wsRef.current = ws;
      attach(ws);
    }, 80);

    const banner = () => {
      term.writeln('\x1b[38;2;45;212;191mCortex Terminal\x1b[0m \x1b[90m— 真实 shell，无回显模拟\x1b[0m');
    };
    banner();

    const attach = (ws) => {
      ws.onopen = () => {
        setStatus('ready');
        onStatus?.('ready');
        term.focus();
      };
      ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'data') term.write(msg.data);
      else if (msg.type === 'ready') {
        setInfo(msg);
        onStatus?.('ready', msg);
        if (initialCommand) {
          setTimeout(() => {
            try {
              send({ type: 'input', data: initialCommand + '\r' });
            } catch {
              /* ignore */
            }
          }, 350);
        }
        if (msg.hint) term.writeln(`\x1b[33m${msg.hint}\x1b[0m`);
      } else if (msg.type === 'error') {
        setStatus('error');
        term.writeln(`\x1b[31m${msg.message}\x1b[0m`);
      } else if (msg.type === 'exit') {
        setStatus('closed');
        onStatus?.('closed');
        term.writeln(`\r\n\x1b[90m[进程已退出 code=${msg.code ?? '-'}]\x1b[0m`);
        onExit?.();
      }
      };
      ws.onclose = () =>
        setStatus((s) => {
          if (s !== 'error') onStatus?.('closed');
          return s === 'error' ? s : 'closed';
        });
      ws.onerror = () => {
        setStatus('error');
        term.writeln('\x1b[31m无法连接终端服务，请确认 npm run dev 正在运行\x1b[0m');
      };
    };

    const send = (obj) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    // 捕获用户提交的整行命令（用于命令历史面板）：只做轻量解析，不干扰 shell 回显
    let lineBuf = '';
    const dataSub = term.onData((data) => {
      send({ type: 'input', data });
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const cmd = lineBuf.trim();
          lineBuf = '';
          if (cmd) onCommand?.(cmd);
        } else if (ch === '\x7f') {
          lineBuf = lineBuf.slice(0, -1);
        } else if (ch === '\x03' || ch === '\x15') {
          lineBuf = '';
        } else if (ch === '\x1b') {
          // 方向键 / 转义序列：放弃本行追踪（交给 shell 自己处理）
          lineBuf = '';
        } else if (ch >= ' ' && ch !== '\x7f') {
          lineBuf += ch;
        }
      }
    });

    const resize = () => {
      try {
        fit.fit();
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    };
    // 命令历史面板点击「重跑」时，把命令注入对应标签的会话
    const onInject = (e) => {
      if (!tabId || e.detail?.tabId !== tabId) return;
      send({ type: 'input', data: String(e.detail.data || '') });
    };
    window.addEventListener('cortex:term-input', onInject);

    const ro = new ResizeObserver(resize);
    ro.observe(hostRef.current);
    setTimeout(resize, 60);

    return () => {
      disposed = true;
      clearTimeout(connectTimer);
      window.removeEventListener('cortex:term-input', onInject);
      ro.disconnect();
      dataSub.dispose();
      try {
        send({ type: 'kill' });
        ws?.close();
      } catch {
        /* ignore */
      }
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const restart = () => {
    setStatus('connecting');
    setInfo(null);
    setNonce((n) => n + 1);
  };

  const clear = () => termRef.current?.clear();

  return (
    <div className="term-wrap" style={{ height, display: visible ? 'block' : 'none' }}>
      <div className="term-bar">
        <span className={`tdot ${status}`} />
        <span className="term-title">
          终端
          {info?.cwd ? <span className="term-cwd">{info.cwd}</span> : null}
        </span>
        <span className="term-meta">
          {info?.shell ? info.shell.split('/').pop() : ''}
          {info?.pty ? ' · pty' : ''}
        </span>
        <button className="term-btn" onClick={clear} title="清屏">
          清屏
        </button>
        <button className="term-btn" onClick={restart} title="重启终端">
          重启
        </button>
        <span className={`term-status ${status}`}>
          {status === 'ready' ? '已连接' : status === 'connecting' ? '连接中…' : status === 'closed' ? '已退出' : '连接失败'}
        </span>
      </div>
      <div className="term-host" ref={hostRef} />
    </div>
  );
}
