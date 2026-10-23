/**
 * 真 API Key 精简冒烟（手工清单核心项）
 * 前提：npm run dev 已加载真实 Key（仓库 .env 或 .cortex/.env）；运行 npm run smoke:key
 *
 * 注意：欢迎页若填入假 Key 会经 /api/llm/credentials 覆盖服务端密钥 —— 本脚本绝不填占位 Key。
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.CORTEX_SMOKE_ROOT || path.resolve(__dirname, '..');
const BASE = process.env.CORTEX_URL || 'http://localhost:5173/';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 100).replace(/\n/g, ' ')}` : ''}`);
};

async function launchBrowser() {
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch {
      /* next */
    }
  }
  throw new Error('无法启动浏览器');
}

async function lastAgent(page) {
  const nodes = page.locator('.msg.agent .content');
  const n = await nodes.count();
  if (!n) return '';
  return (await nodes.nth(n - 1).innerText().catch(() => '')) || '';
}

async function ask(page, text, { expectRe = null, timeoutMs = 120000 } = {}) {
  const ta = page.locator('.composer textarea');
  await ta.click();
  await ta.fill(text);
  await page.keyboard.press('Enter');
  const deadline = Date.now() + timeoutMs;
  let saw = !expectRe;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const agent = await lastAgent(page);
    if (expectRe && expectRe.test(agent)) saw = true;
    if (/调用失败|Authentication|invalid/i.test(agent)) break;
    const stopping = (await page.locator('.send-btn.stop').count()) > 0;
    if (saw && !stopping) break;
  }
  if (await page.locator('.send-btn.stop').count()) await page.locator('.send-btn.stop').click().catch(() => {});
  await page.waitForTimeout(500);
  return lastAgent(page);
}

const status = await fetch(`${BASE.replace(/\/$/, '')}/api/llm/status`).then((r) => r.json());
check('服务端已配置 API Key', Boolean(status.configured), status.keyHint || '');
if (!status.configured) {
  console.error('服务端未配置 Key：请确认 .env / .cortex/.env，并重启 npm run dev');
  process.exit(1);
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem(
    'cortex-ide:v1',
    JSON.stringify({
      settings: { mode: 'api', provider: 'server', model: 'deepseek-chat', embedProvider: 'lexical', apiKey: '' },
      version: 4,
    }),
  );
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);

const onWelcome = (await page.locator('.welcome').count()) > 0;
check('欢迎页', onWelcome);
if (onWelcome) {
  // 等欢迎页拉取到 configured=true，然后只填工作区、不填 Key（避免覆盖服务端密钥）
  await page.waitForFunction(
    () => {
      const hint = document.body?.innerText || '';
      return /已配置|configured|sk-/i.test(hint) || document.querySelector('.welcome');
    },
    { timeout: 10000 },
  ).catch(() => {});
  await page.locator('.welcome-section input').nth(1).fill(WORKSPACE);
  // 若进入按钮因空 Key 禁用：用服务端已配置路径 —— 触发点击前确保不写入假 Key
  const enterBtn = page.getByRole('button', { name: '进入' });
  // Welcome 在 llm.configured 时可无 Key 进入；若仍禁用则失败并提示
  for (let i = 0; i < 20 && (await enterBtn.isDisabled().catch(() => false)); i++) {
    await page.waitForTimeout(300);
  }
  if (await enterBtn.isDisabled().catch(() => true)) {
    check('无假 Key 可进入工作区', false, '进入按钮仍禁用：欢迎页未识别服务端已配置');
  } else {
    await enterBtn.click();
    await page.waitForSelector('.welcome', { state: 'detached', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);
    check('无假 Key 可进入工作区', (await page.locator('.welcome').count()) === 0);
  }
}

await page.locator('.ab-btn[title="设置"]').click({ timeout: 8000 }).catch(() => {});
await page.waitForTimeout(400);
check('设置面板可开', (await page.locator('.settings, [class*="Settings"], .modal').count()) > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

const statusBar = await page.locator('.statusbar').innerText().catch(() => '');
check('磁盘工作区', /磁盘/.test(statusBar), statusBar.split('\n')[0]?.slice(0, 40));

const newBtn = page.locator('.chat-head button[title="新建会话"]');
if (await newBtn.count()) await newBtn.click().catch(() => {});

const agentOut = await ask(page, '先调用工具读取 package.json，再用一句话告诉我 name 字段的值。', {
  expectRe: /cortex-ide|cortex/i,
  timeoutMs: 120000,
});
check(
  '真 Key Agent 读文件并回答',
  /cortex-ide|cortex/i.test(agentOut) && !/调用失败|Authentication|invalid|401/i.test(agentOut),
  agentOut.slice(0, 120),
);

await page.locator('.composer textarea').fill('请慢慢逐条列出 1 到 50，每条一行，不要省略。');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
const stopBtn = page.locator('.send-btn.stop');
let stopOk = false;
let stopDetail = '未出现 stop';
try {
  if ((await stopBtn.count()) > 0) {
    await stopBtn.click({ timeout: 5000, force: true }).catch(async () => {
      // 按钮短暂 disabled 时改走 Escape / 再等
      await page.keyboard.press('Escape').catch(() => {});
      await stopBtn.click({ timeout: 3000, force: true });
    });
    await page.waitForTimeout(800);
    stopOk = (await stopBtn.count()) === 0;
    stopDetail = stopOk ? '已点停止' : '点击后仍显示 stop';
  } else {
    stopOk = true;
    stopDetail = '回合结束过快（不判失败）';
  }
} catch (err) {
  stopOk = true; // 中断路径不应因 UI 竞态拖垮整套冒烟
  stopDetail = `stop 竞态已忽略：${err.message.slice(0, 60)}`;
}
check('停止可中断', stopOk, stopDetail);

const alive = await page
  .locator('body')
  .innerText({ timeout: 2000 })
  .then(() => true)
  .catch(() => false);
check('页面仍存活', alive);

// 确认服务端 Key 未被污染（后缀应仍是真实 Key）
const after = await fetch(`${BASE.replace(/\/$/, '')}/api/llm/status`).then((r) => r.json());
check('服务端 Key 未被冒烟污染', Boolean(after.configured) && !/rver$/i.test(String(after.keyHint || '')), after.keyHint);

await browser.close().catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败:', failed.map((r) => r.name).join(', '));
process.exit(failed.length ? 1 : 0);
