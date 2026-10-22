/**
 * 打包后的桌面宿主：不跑 Vite（asar 里无法 bundle vite.config），
 * 用 Node HTTP + 与 vite.config 相同的 API 插件，静态托管 dist/。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { authApiPlugin } from '../server/auth.js';
import { llmProxyPlugin } from '../server/llm-proxy.js';
import { fsApiPlugin } from '../server/fs-api.js';
import { terminalPlugin } from '../server/terminal.js';
import { memoryApiPlugin } from '../server/memory-api.js';
import { watchPlugin } from '../server/watch.js';
import { execApiPlugin } from '../server/exec-api.js';
import { sshApiPlugin } from '../server/ssh-api.js';
import { skillsApiPlugin } from '../server/skills-api.js';
import { workflowApiPlugin } from '../server/workflow.js';
import { attachApiPlugin } from '../server/attach-api.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function applyEnv(root) {
  const envDir = process.env.CORTEX_ENV_DIR || root;
  loadEnvFile(path.join(root, '.env'));
  loadEnvFile(path.join(envDir, '.env'));
  process.env.LLM_API_KEY =
    process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
  process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
  process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'deepseek';
  process.env.LLM_ALLOW_OVERRIDE = process.env.LLM_ALLOW_OVERRIDE || '1';
}

function createStack() {
  const stack = [];
  const run = (req, res) => {
    let i = 0;
    const next = (err) => {
      if (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(String(err?.message || err));
        }
        return;
      }
      const layer = stack[i++];
      if (!layer) {
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end('Not Found');
        }
        return;
      }
      try {
        layer(req, res, next);
      } catch (e) {
        next(e);
      }
    };
    next();
  };
  run.use = (fn) => {
    stack.push(fn);
  };
  return run;
}

function invokePluginHook(plugin, name, server) {
  if (!plugin) return;
  const hook = plugin[name];
  if (!hook) return;
  if (typeof hook === 'function') return hook.call(plugin, server);
  if (typeof hook.handler === 'function') return hook.handler.call(plugin, server);
}

function staticMiddleware(distDir) {
  const index = path.join(distDir, 'index.html');
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const raw = (req.url || '/').split('?')[0];
    if (raw.startsWith('/api/')) return next();

    let rel = decodeURIComponent(raw);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(distDir, rel.replace(/^[/\\]+/, '')));
    if (!file.startsWith(path.normalize(distDir))) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }

    const sendFile = (target) => {
      fs.stat(target, (err, st) => {
        if (err || !st.isFile()) {
          // SPA：没有实体文件就回 index.html（前端路由）
          if (target !== index && fs.existsSync(index)) return sendFile(index);
          return next();
        }
        const ext = path.extname(target).toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', st.size);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(target).pipe(res);
      });
    };

    sendFile(file);
  };
}

/**
 * @param {{ root: string, host?: string, port: number }} opts
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startDesktopHost({ root, host = '127.0.0.1', port }) {
  applyEnv(root);
  process.env.CORTEX_DESKTOP = '1';

  const distDir = path.join(root, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`缺少前端构建：${path.join(distDir, 'index.html')}`);
  }

  const workspace = () => process.env.CORTEX_WORKSPACE || root;
  const middlewares = createStack();
  const httpServer = http.createServer(middlewares);
  const server = { middlewares, httpServer };

  const plugins = [
    authApiPlugin(),
    llmProxyPlugin(),
    fsApiPlugin(),
    terminalPlugin({ workspace }),
    memoryApiPlugin({ workspace }),
    watchPlugin({ workspace }),
    execApiPlugin({ workspace }),
    sshApiPlugin(),
    skillsApiPlugin({ workspace }),
    workflowApiPlugin({ workspace }),
    attachApiPlugin(),
  ];

  for (const p of plugins) {
    await invokePluginHook(p, 'configurePreviewServer', server);
    // 个别插件只有 configureServer
    if (!p.configurePreviewServer) await invokePluginHook(p, 'configureServer', server);
  }

  middlewares.use(staticMiddleware(distDir));

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });

  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

// 便于直接探测
export const __dirname_host = path.dirname(fileURLToPath(import.meta.url));
void pathToFileURL;
