/**
 * 十三：浏览器端预览器冒烟（被 scripts/smoke.mjs 调用）。
 *
 * 只做一件事：用真浏览器打开 demo/ 里的真文件，数清楚 DOM 里到底渲染出了什么。
 * 输出一行 `RESULT {...}` 给冒烟脚本解析；任何断言不过就把原因写进 errors。
 *
 * 判据（全部可数，不看「看起来对」）：
 *   Markdown  标题数 ≥ 10、大纲项 = 标题数、代码块 ≥ 5、高亮 token > 0
 *   Word      标题 ≥ 3、表格行 ≥ 3
 *   Excel     2 个工作表、切换后数据行数变化
 *   PPT       2 页
 *   CSV       2 数据行、含逗号字段不被拆开
 *   PDF       canvas 宽高 > 0 且能翻到第 2 页
 *   二进制    必须出现「暂不支持预览」而不是空白
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const errors = [];
const result = { ok: false, errors };

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`CONSOLE ${m.text()}`));

const row = (name) => page.locator('.tree-row', { hasText: name }).first();
const openFile = async (name, wait = 1500) => {
  if (!(await row(name).count())) {
    await row('demo').click();
    await page.waitForTimeout(400);
  }
  await row(name).click();
  await page.waitForTimeout(wait);
};
const expect = (cond, msg) => {
  if (!cond) errors.push(msg);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  /* Markdown 阅读视图 */
  await page.getByRole('button', { name: '阅读' }).click();
  await page.waitForTimeout(600);
  const md = {
    headings: await page.locator('.md-doc-body .md-h').count(),
    toc: await page.locator('.md-toc-item').count(),
    codeBlocks: await page.locator('.code-block').count(),
    tokens: await page.locator('[class^="tok-"]').count(),
    tables: await page.locator('.md-doc-body .md-table').count(),
  };
  result.md = md;
  expect(md.headings >= 10, `Markdown 标题只有 ${md.headings} 个`);
  expect(md.toc === md.headings, `大纲项 ${md.toc} ≠ 标题 ${md.headings}`);
  expect(md.codeBlocks >= 5, `代码块只有 ${md.codeBlocks} 个`);
  expect(md.tokens > 0, '代码块没有任何高亮 token');

  /* Word */
  await openFile('sample.docx');
  result.docx = await page.evaluate(() => ({
    headings: document.querySelectorAll('.pv-doc-h').length,
    tableRows: document.querySelectorAll('.pv-table.doc tbody tr').length,
    listItems: document.querySelectorAll('.pv-doc-list li').length,
  }));
  expect(result.docx.headings >= 3, `Word 标题只有 ${result.docx.headings} 个`);
  expect(result.docx.tableRows >= 3, `Word 表格只有 ${result.docx.tableRows} 行`);

  /* Excel：切换工作表后数据要变 */
  await openFile('sample.xlsx');
  const sheet1 = await page.locator('.pv-table tbody tr').count();
  await page.locator('.pv-tab', { hasText: '汇总' }).click();
  await page.waitForTimeout(400);
  const sheet2 = await page.locator('.pv-table tbody tr').count();
  result.xlsx = { sheets: await page.locator('.pv-tab').count(), rows: sheet1, rowsSheet2: sheet2 };
  expect(result.xlsx.sheets === 2, `工作表只有 ${result.xlsx.sheets} 个`);
  expect(sheet1 > 0 && sheet2 > 0 && sheet1 !== sheet2, `切换工作表后行数没变：${sheet1} / ${sheet2}`);

  /* PPT */
  await openFile('sample.pptx');
  result.pptx = { slides: await page.locator('.pv-slide').count() };
  expect(result.pptx.slides === 2, `PPT 只有 ${result.pptx.slides} 页`);

  /* CSV */
  await openFile('sales.csv');
  result.csv = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pv-table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].slice(1).map((td) => td.innerText),
    );
    return { rows: rows.length, first: rows[0] };
  });
  expect(result.csv.rows === 2, `CSV 数据行 ${result.csv.rows}，期望 2`);
  expect(result.csv.first?.[2] === '12,800', `带引号的 "12,800" 被拆坏了：${result.csv.first?.[2]}`);

  /* PDF */
  await openFile('sample.pdf', 3800);
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('.pv-pdf-canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  const pageLabel = await page.locator('.pv-meta', { hasText: '页' }).first().innerText();
  await page.locator('.pv-bar .btn.sm', { hasText: '→' }).click();
  await page.waitForTimeout(1500);
  const page2 = await page.locator('.pv-meta', { hasText: '页' }).first().innerText();
  result.pdf = { canvas: canvas ? `${canvas.w}x${canvas.h}` : null, page: pageLabel.trim(), page2: page2.trim(), text: await page.locator('.pv-pdf-text').innerText() };
  expect(canvas && canvas.w > 100 && canvas.h > 100, 'PDF canvas 没有尺寸（没渲染出来）');
  expect(/^2 \//.test(page2.trim()), `翻页失败：${page2}`);
  // 此时停在第 2 页，文字层应该是第 2 页的内容
  expect((result.pdf.text || '').length > 20 && /Benchmark/.test(result.pdf.text), `PDF 文字层没抽到第 2 页内容：${result.pdf.text}`);

  /* 二进制兜底 */
  await openFile('archive.zip', 1000);
  result.binary = await page.evaluate(() => ({
    fail: document.querySelector('.pv-fail-msg')?.innerText || null,
    hasDownload: !!document.querySelector('.pv-fail .btn'),
  }));
  expect(/暂不支持预览/.test(result.binary.fail || ''), `二进制文件没有如实提示：${result.binary.fail}`);
  expect(result.binary.hasDownload, '二进制文件没有提供下载按钮');

  result.ok = errors.length === 0;
} catch (err) {
  errors.push(`EXCEPTION ${err.message}`);
} finally {
  await browser.close();
}

console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(result.ok ? 0 : 1);
