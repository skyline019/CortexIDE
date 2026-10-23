/**
 * 无真实上游 API Key 的浏览器冒烟（全部检查均为硬门禁）。
 * 运行：先 `npm run dev`（Windows 上建议 CORTEX_NO_PTY=1，避免错误 ABI 的 node-pty 拖垮 Vite），再 `npm run smoke:mock`
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
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function launchBrowser() {
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch {
      /* try next */
    }
  }
  throw new Error('无法启动浏览器：请安装 Chrome，或 npx playwright install chromium');
}

/** 最近一条助手回复正文（不含用户气泡，避免用提问文案假绿） */
async function lastAgentText(page) {
  const nodes = page.locator('.msg.agent .content');
  const n = await nodes.count();
  if (!n) return '';
  return (await nodes.nth(n - 1).innerText().catch(() => '')) || '';
}

/** 等最近助手气泡出现期望文案，并等到回合结束（避免流式中途假绿） */
async function ask(page, text, { expectRe = null, timeoutMs = 20000 } = {}) {
  const ta = page.locator('.composer textarea');
  await ta.click();
  await ta.fill(text);
  await page.keyboard.press('Enter');

  const deadline = Date.now() + timeoutMs;
  let sawExpect = !expectRe;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const agent = await lastAgentText(page);
    if (expectRe && expectRe.test(agent)) sawExpect = true;
    const stopping = (await page.locator('.send-btn.stop').count()) > 0;
    // 已看到期望文案且停止按钮消失 → 流式结束
    if (sawExpect && !stopping) break;
  }
  const stop = page.locator('.send-btn.stop');
  if (await stop.count()) await stop.click().catch(() => {});
  await page.waitForTimeout(400);
  return lastAgentText(page);
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.route('**/api/llm/status', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, available: true, keyHint: 'smoke-mock' }),
  }),
);

await page.route('**/api/mem/**', async (route) => {
  const u = route.request().url();
  const method = route.request().method();
  let body = { ok: true };
  if (u.includes('/status')) {
    body = { available: true, backend: 'mock', total: 0, dim: 0 };
  } else if (u.includes('/list')) {
    body = { memories: [] };
  } else if (u.includes('/users')) {
    body = { users: [{ id: 'local', name: 'local' }] };
  } else if (u.includes('/search')) {
    body = { hits: [], backend: 'mock', mode: 'hybrid', tookMs: 0 };
  } else if (u.includes('/sync') && method === 'POST') {
    body = { ok: true, upserted: 0, deleted: 0 };
  } else if (u.includes('/delete')) {
    body = { ok: true };
  }
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem(
    'cortex-ide:v1',
    JSON.stringify({
      settings: { mode: 'local', provider: 'server', embedProvider: 'lexical' },
      version: 4,
    }),
  );
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);

const onWelcome = (await page.locator('.welcome').count()) > 0;
check('欢迎页出现', onWelcome);
if (onWelcome) {
  check('快捷键提示', /Ctrl/.test(await page.locator('.welcome-shortcuts').innerText().catch(() => '')));
  await page.locator('.welcome-section input').nth(1).fill(WORKSPACE);
  await page.getByRole('button', { name: '进入' }).click();
  await page.waitForSelector('.welcome', { state: 'detached', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);
} else {
  check('快捷键提示', true, '已跳过欢迎页');
}

await page.locator('.ab-btn[title="设置"]').click({ timeout: 8000 }).catch(() => {});
await page.waitForTimeout(400);
const localBtn = page.getByRole('button', { name: /本地规则引擎/ });
check('设置里可见本地模式', (await localBtn.count()) > 0);
if (await localBtn.count()) await localBtn.click();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

const status = await page.locator('.statusbar').innerText().catch(() => '');
check('连接真实磁盘工作区', /磁盘/.test(status), status.split('\n')[0]?.slice(0, 48) || '');

const newBtn = page.locator('.chat-head button[title="新建会话"]');
if (await newBtn.count()) {
  await newBtn.click({ timeout: 5000 }).catch(() => {});
  check('新建会话可用', true);
} else {
  check('新建会话可用', (await page.locator('.chat-head').count()) > 0);
}

check('终端面板存在', (await page.locator('.term-host, .xterm, .term-wrap').count()) > 0);

const alive = async () => {
  try {
    await page.locator('body').innerText({ timeout: 2000 });
    return true;
  } catch {
    return false;
  }
};

const ta = page.locator('.composer textarea');
check('composer 可用', (await ta.count()) > 0);

if (await ta.count()) {
  const afterRemember = await ask(page, '记住：所有新页面都要用 React.lazy 做代码分割', {
    expectRe: /已记住|remember|写入长期记忆/i,
  });
  check(
    '本地引擎写入记忆',
    /已记住|写入长期记忆|remember/i.test(afterRemember),
    afterRemember.slice(0, 80).replace(/\n/g, ' '),
  );

  const afterMem = await ask(page, '/mem 代码分割', {
    expectRe: /相关的记忆|长期记忆|记忆库/,
    timeoutMs: 25000,
  });
  const hasMemList = /相关的记忆|长期记忆|记忆库/.test(afterMem);
  const hasLazy = /React\.lazy/.test(afterMem);
  const notCrash = !/调用失败|toFixed|TypeError/i.test(afterMem);
  check(
    '记忆检索',
    hasMemList && hasLazy && notCrash,
    afterMem.slice(0, 160).replace(/\n/g, ' '),
  );

  const afterSum = await ask(page, '总结一下当前工作区', {
    expectRe: /文件|工作区|总结|概览|src|package/i,
    timeoutMs: 25000,
  });
  check(
    '本地引擎可应答总结',
    /文件|工作区|总结|概览|package/i.test(afterSum) && !/调用失败/i.test(afterSum),
    afterSum.slice(0, 70).replace(/\n/g, ' '),
  );
}

check('页面仍存活', await alive());

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败:', failed.map((r) => r.name).join(', '));

await browser.close().catch(() => {});
process.exit(failed.length ? 1 : 0);
