/**
 * 文件监听客户端：订阅 /api/watch 的 WebSocket，把外部改动交给回调处理
 */
import { wsAuthUrl } from './apiAuth.js';

export function connectWatch({ onEvents, onHello, onStatus, onMode } = {}) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = null;
  let queue = [];
  const send = (msg) => {
    const payload = JSON.stringify(msg);
    if (ws && ws.readyState === 1) ws.send(payload);
    else queue.push(payload);
  };

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(wsAuthUrl(`${proto}//${location.host}/api/watch`));
    ws.onopen = () => {
      retry = 0;
      onStatus?.('connected');
      for (const p of queue) ws.send(p);
      queue = [];
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'fs') onEvents?.(msg.events || []);
      else if (msg.type === 'hello') onHello?.(msg);
      else if (msg.type === 'mode' || msg.type === 'sub-ok') onMode?.(msg);
    };
    ws.onclose = () => {
      onStatus?.('closed');
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(open, 500 * retry);
    };
    ws.onerror = () => onStatus?.('error');
  };

  open();

  /** 返回 unsubscribe + 发送能力 */
  const close = () => {
    closed = true;
    clearTimeout(timer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
  close.send = send;
  return close;
}
