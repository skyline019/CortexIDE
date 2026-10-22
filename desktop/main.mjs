/**
 * Cortex Windows 桌面外壳（Electron）
 *
 * - 数据目录：%APPDATA%\Cortex（userData）—— .env / memory.db / pgdata
 * - 打包后：自建 HTTP 宿主（desktop/host.mjs），不跑 Vite preview（asar 无法 bundle 配置）
 * - 开发：仍用 Vite createServer
 * - 本机只监听 127.0.0.1
 */
import { app, BrowserWindow, shell, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');

let mainWindow = null;
let backend = null;

function ensureUserData() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'ann'), { recursive: true });

  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) {
    const example = path.join(ROOT, '.env.example');
    if (fs.existsSync(example)) fs.copyFileSync(example, envPath);
    else fs.writeFileSync(envPath, '# Cortex desktop — 填入 DEEPSEEK_API_KEY\n', 'utf8');
  }

  process.env.CORTEX_DESKTOP = '1';
  process.env.CORTEX_ENV_DIR = dir;
  process.env.CORTEX_DIR = dir;
  process.env.CORTEX_DB = process.env.CORTEX_DB || path.join(dir, 'memory.db');
  process.env.CORTEX_PG_DIR = process.env.CORTEX_PG_DIR || path.join(dir, 'pgdata');
  if (!process.env.CORTEX_WORKSPACE) {
    const docs = app.getPath('documents');
    const ws = path.join(docs, 'Cortex');
    fs.mkdirSync(ws, { recursive: true });
    process.env.CORTEX_WORKSPACE = ws;
  }
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startBackend() {
  const port = await freePort();
  const host = '127.0.0.1';

  if (app.isPackaged) {
    const { startDesktopHost } = await import('./host.mjs');
    backend = await startDesktopHost({ root: ROOT, host, port });
    return backend.url;
  }

  const { createServer } = await import('vite');
  const configFile = path.join(ROOT, 'vite.config.js');
  const server = await createServer({
    root: ROOT,
    configFile,
    server: { host, port, strictPort: true },
  });
  await server.listen();
  backend = {
    url: `http://${host}:${port}`,
    close: async () => {
      await server.close();
    },
  };
  return backend.url;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Cortex',
    backgroundColor: '#080b11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents
      .executeJavaScript(`window.cortexDesktop=true;document.documentElement.classList.add('is-desktop');`)
      .catch(() => {});
  });
  mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const u = new URL(target);
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(target);
    } catch {
      /* ignore */
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function boot() {
  ensureUserData();
  const url = await startBackend();
  createWindow(url);
}

ipcMain.handle('dialog:openDirectory', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: '选择工作区文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return null;
  return result.filePaths[0];
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot).catch(async (err) => {
    console.error('[cortex-desktop] 启动失败', err);
    try {
      await dialog.showErrorBox('Cortex 启动失败', String(err?.stack || err?.message || err));
    } catch {
      /* ignore */
    }
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', async () => {
    try {
      if (backend?.close) await backend.close();
    } catch {
      /* ignore */
    }
  });
}
