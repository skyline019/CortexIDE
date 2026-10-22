/**
 * 不依赖 API Key 的离线冒烟：本地规则引擎 + 真实磁盘 + 终端 + 向量记忆
 * 运行：npm run smoke:mock
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const errors = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
const IGNORE = [/etc%2Fpasswd/, /status of 400/];
page.on('console', (m) => {
  if (m.type() === 'error' && !IGNORE.some((re) => re.test(m.text()))) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(process.env.CORTEX_URL || 'http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => localStorage.clear());
// 切到本地规则引擎，保证无 Key 也能跑
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('cortex-ide:v1') || '{}');
  raw.settings = { ...(raw.settings || {}), mode: 'local' };
  localStorage.setItem('cortex-ide:v1', JSON.stringify(raw));
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2600);

const status = await page.locator('.statusbar').innerText();
check('连接真实磁盘工作区', /磁盘/.test(status), status.split('\n')[0]);

await page.locator('.term-host').click();
await page.keyboard.type('echo MOCK_$((7*6))\n');
await page.waitForTimeout(1200);
check('终端可用', (await page.locator('.xterm-rows').innerText()).includes('MOCK_42'));

const ta = page.locator('.composer textarea');
const ask = async (t) => {
  await ta.fill(t);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await page.waitForFunction(() => !document.querySelector('.send-btn.stop'), null, { timeout: 60000 });
  await page.waitForTimeout(400);
};

await ask('记住：所有新页面都要用 React.lazy 做代码分割');
await page.waitForTimeout(1200);
const memText = await page.locator('.chat-body').innerText();
check('本地引擎写入记忆', /已记住|自动记住/.test(memText));

await ask('/mem 代码分割');
check('记忆检索', (await page.locator('.chat-body').innerText()).includes('React.lazy'));

await ask('总结当前文件');
const summary = await page.locator('.msg.agent .content').last().innerText();
check('文件总结（读真实磁盘）', /概览|规模|工作区/.test(summary), summary.slice(0, 60).replace(/\n/g, ' '));

const vbar = await (async () => {
  await page.locator('.titlebar .tb-btn', { hasText: '记忆' }).click();
  await page.waitForTimeout(2500);
  return page.locator('.vector-bar').innerText();
})();
check('向量索引就绪', /向量检索/.test(vbar), vbar.replace(/\n/g, ' ').slice(0, 70));

check('控制台无错误', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
await browser.close();
process.exit(failed.length ? 1 : 0);
