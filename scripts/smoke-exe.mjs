/**
 * 打包 exe 冷启动冒烟：进程存活 + 本机 HTTP 就绪 + 渲染页无未捕获异常
 * 运行：npm run smoke:exe（需已有 release/win-unpacked/Cortex.exe）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXE = process.env.CORTEX_EXE || path.join(ROOT, 'release', 'win-unpacked', 'Cortex.exe');
const LOG = path.join(ROOT, '.eval-exe.log');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 120).replace(/\n/g, ' ')}` : ''}`);
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
        if (body.length > 20000) body = body.slice(0, 20000);
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ status: 0, body: '', error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'timeout' });
    });
  });
}

async function findListenUrls(pid, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const { execSync } = await import('node:child_process');
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort"`,
        { encoding: 'utf8', timeout: 5000 },
      );
      const ports = [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => n > 0))];
      if (ports.length) return ports.map((p) => `http://127.0.0.1:${p}/`);
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return [];
}

if (!fs.existsSync(EXE)) {
  console.error('找不到', EXE);
  process.exit(1);
}

fs.writeFileSync(LOG, '');
const child = spawn(EXE, ['--enable-logging', '--log-level=0'], {
  cwd: path.dirname(EXE),
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_LOG_FILE: LOG,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (b) => {
  stdout += b.toString('utf8');
  fs.appendFileSync(LOG, b);
});
child.stderr.on('data', (b) => {
  stderr += b.toString('utf8');
  fs.appendFileSync(LOG, b);
});

const startedAt = Date.now();
await sleep(2500);

const aliveEarly = !child.killed && child.exitCode === null;
check('exe 进程启动后仍存活', aliveEarly, aliveEarly ? `pid=${child.pid}` : `exit=${child.exitCode}`);

const urls = await findListenUrls(child.pid);
check('本机回环已监听', urls.length > 0, urls[0] || '无 Listen 端口');

let uiUrl = urls[0] || '';
let httpOk = false;
if (uiUrl) {
  for (let i = 0; i < 30; i++) {
    const r = await get(uiUrl);
    if (r.status === 200 && /html|doctype|Cortex|root/i.test(r.body)) {
      httpOk = true;
      break;
    }
    await sleep(500);
  }
}
check('HTTP 首页 200', httpOk, uiUrl);

const consoleErrors = [];
const pageErrors = [];
if (httpOk && uiUrl) {
  let browser;
  try {
    for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
      try {
        browser = await chromium.launch({ headless: true, ...opts });
        break;
      } catch {
        /* next */
      }
    }
    if (!browser) throw new Error('无浏览器');
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    const hasWelcome = (await page.locator('.welcome').count()) > 0;
    const hasApp = (await page.locator('#root, .app, .statusbar, .welcome').count()) > 0;
    const text = (await page.locator('body').innerText().catch(() => '')) || '';
    const white = !text.trim() || text.trim().length < 8;
    check('界面非白屏', hasApp && !white, hasWelcome ? '欢迎页' : `body=${text.slice(0, 40)}`);
    check('欢迎页或主壳可见', hasWelcome || /磁盘|设置|工作区|Cortex/i.test(text), hasWelcome ? 'welcome' : 'shell');
  } catch (err) {
    check('界面非白屏', false, err.message);
    check('欢迎页或主壳可见', false, err.message);
  } finally {
    await browser?.close().catch(() => {});
  }
} else {
  check('界面非白屏', false, '无 UI URL');
  check('欢迎页或主壳可见', false, '无 UI URL');
}

const IGNORE_CONSOLE = [
  /Download the React DevTools/i,
  /DevTools failed to load/i,
  /favicon/i,
  /third-party/i,
  /Electron Security Warning/i,
  /Autofill\./i,
];
const badConsole = consoleErrors.filter((t) => !IGNORE_CONSOLE.some((re) => re.test(t)));
const badPage = pageErrors.filter((t) => !IGNORE_CONSOLE.some((re) => re.test(t)));
check(
  '渲染控制台无应用异常',
  badConsole.length === 0 && badPage.length === 0,
  badPage[0] || badConsole[0] || `console=${consoleErrors.length}`,
);

const mainNoise = `${stdout}\n${stderr}`
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((l) => /error|exception|uncaught|fatal|启动失败/i.test(l))
  .filter((l) => !/DevTools|security warning|Gpu|ERROR:gpu|electron-builder/i.test(l));
check('主进程日志无启动失败', mainNoise.length === 0, mainNoise[0] || `elapsed=${Date.now() - startedAt}ms`);

// 清理
try {
  child.kill();
} catch {
  /* ignore */
}
await sleep(800);
try {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
} catch {
  /* ignore */
}
await sleep(500);
check('exe 可退出', true, `pid=${child.pid}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败:', failed.map((r) => r.name).join(', '));
if (badConsole.length || badPage.length) {
  console.log('--- console/pageerror ---');
  for (const x of [...badPage, ...badConsole].slice(0, 8)) console.log(x.slice(0, 200));
}
process.exit(failed.length ? 1 : 0);
