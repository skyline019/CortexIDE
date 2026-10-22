/**
 * 十三：预览器截图脚本。
 *
 * 用法：先 `npm run dev`，再 `node scripts/shot-preview.mjs`
 * 输出到 shots/23-*.png（Markdown 阅读视图、Word / Excel / PPT / CSV / PDF / 图片、
 * 无法预览的二进制、AI 回答渲染）。
 *
 * 每一步都把关键断言打印出来 —— 截图只是副产品，**数出来的东西才是证据**。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const SHOT = (name) => `shots/23-${name}.png`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`CONSOLE ${m.text()}`));

const log = (label, obj) => console.log(String(label).padEnd(18), JSON.stringify(obj));
const row = (name) => page.locator('.tree-row', { hasText: name }).first();

async function ensureFolder() {
  if (!(await row('sales.csv').count())) {
    await row('demo').click();
    await page.waitForTimeout(400);
  }
}

async function open(name, wait = 1600) {
  await ensureFolder();
  await row(name).click();
  await page.waitForTimeout(wait);
}

const probe = () =>
  page.evaluate(() => ({
    bar: document.querySelector('.pv-bar')?.innerText?.replace(/\n/g, ' · ').slice(0, 110) || null,
    rows: document.querySelectorAll('.pv-table tbody tr').length,
    canvas: (() => {
      const c = document.querySelector('.pv-pdf-canvas');
      return c ? `${c.width}x${c.height}` : null;
    })(),
    fail: document.querySelector('.pv-fail-msg')?.innerText || null,
    crumb: [...document.querySelectorAll('.crumbs span')].map((s) => s.textContent).slice(-3).join(' '),
  }));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 1) Markdown 阅读视图（README 本身）
await page.getByRole('button', { name: '阅读' }).click();
await page.waitForTimeout(600);
log('markdown', {
  h: await page.locator('.md-doc-body .md-h').count(),
  toc: await page.locator('.md-toc-item').count(),
  code: await page.locator('.code-block').count(),
  tokens: await page.locator('[class^="tok-"]').count(),
});
await page.screenshot({ path: SHOT('01-md-readme') });

// 2) 各类文件
for (const [file, name] of [
  ['sample.docx', '02-docx'],
  ['sample.xlsx', '03-xlsx'],
  ['sample.pptx', '04-pptx'],
  ['sales.csv', '05-csv'],
]) {
  await open(file);
  log(file, await probe());
  await page.screenshot({ path: SHOT(name) });
}

// 3) PDF：canvas 渲染 + 翻页
await open('sample.pdf', 3600);
log('sample.pdf', await probe());
await page.screenshot({ path: SHOT('06-pdf') });
await page.locator('.pv-bar .btn.sm', { hasText: '→' }).click();
await page.waitForTimeout(1600);
log('pdf-page2', await page.locator('.pv-meta', { hasText: '页' }).first().innerText());
await page.screenshot({ path: SHOT('07-pdf-p2') });

// 4) 不能预览的二进制：必须如实说明 + 给下载
await open('archive.zip', 1000);
log('archive.zip', await probe());
await page.screenshot({ path: SHOT('09-binary') });

// 5) AI 回答里的 Markdown（真调 DeepSeek，等它自己停下）
const input = page.locator('textarea').last();
await input.fill(
  '不要调用任何工具，不要写文件，只输出 Markdown：一个 3 行 JS 代码块（带注释）、一个 2 行 2 列小表格、一段引用，外加一句说明。整体 200 字以内。',
);
await input.press('Enter');
let idle = 0;
let last = '';
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(1500);
  const text = await page.locator('.msg.agent .content').last().innerText().catch(() => '');
  const busy = await page.locator('.stop, .typing').count();
  if (!busy && text === last && text.length > 0) idle += 1;
  else idle = 0;
  last = text;
  if (idle >= 3) break;
}
log('answer', await page.evaluate(() => {
  const nodes = document.querySelectorAll('.msg.agent .content');
  const el = nodes[nodes.length - 1];
  return {
    chars: el?.innerText.length,
    code: el?.querySelectorAll('.code-block').length,
    tokens: el?.querySelectorAll('[class^="tok-"]').length,
    table: el?.querySelectorAll('.md-table').length,
    quote: el?.querySelectorAll('.md-quote').length,
  };
}));
await page.screenshot({ path: SHOT('08-answer-md') });

await browser.close();
if (errors.length) {
  console.log('\n浏览器报错：');
  for (const e of errors.slice(0, 10)) console.log(' -', e);
  process.exitCode = 1;
} else {
  console.log('\n浏览器控制台：无报错');
}
