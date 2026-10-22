/**
 * PDF 视觉序重建：CJK 不插空、英文插空、双栏先左后右。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageItemsToText } from '../src/lib/pdf-text.js';

/** 模拟 pdf.js TextItem：transform = [sx,0,0,sy,x,yPdf]，yPdf 为 PDF 底原点 */
function item(str, x, yFromTop, h = 12, pageH = 800, w) {
  const yPdf = pageH - yFromTop;
  const width = w ?? str.length * h * (/[一-龥]/.test(str) ? 1 : 0.5);
  return {
    str,
    width,
    hasEOL: false,
    transform: [h, 0, 0, h, x, yPdf],
  };
}

test('CJK 一字一项不插空格', () => {
  const pageH = 800;
  const items = ['中', '文', '测', '试'].map((ch, i) => item(ch, 50 + i * 12, 100, 12, pageH, 11));
  const text = pageItemsToText(items, { width: 400, height: pageH });
  assert.equal(text.replace(/\s/g, ''), '中文测试');
  assert.doesNotMatch(text, /中\s+文/);
});

test('英文词间按空隙插空格', () => {
  const pageH = 800;
  const items = [
    item('Hello', 50, 100, 12, pageH, 30),
    item('world', 88, 100, 12, pageH, 30), // gap ≈ 8 > 0.22*12
  ];
  const text = pageItemsToText(items, { width: 400, height: pageH });
  assert.match(text, /Hello\s+world/);
});

test('双栏先读左栏再右栏', () => {
  const pageH = 800;
  const pageW = 500;
  const items = [];
  // 左栏两行
  for (let row = 0; row < 12; row++) {
    items.push(item(`L${row}`, 40, 80 + row * 18, 11, pageH, 40));
  }
  // 右栏两行
  for (let row = 0; row < 12; row++) {
    items.push(item(`R${row}`, 300, 80 + row * 18, 11, pageH, 40));
  }
  const text = pageItemsToText(items, { width: pageW, height: pageH });
  const iL0 = text.indexOf('L0');
  const iL11 = text.indexOf('L11');
  const iR0 = text.indexOf('R0');
  assert.ok(iL0 >= 0 && iR0 >= 0);
  // 左栏应整体出现在右栏之前
  assert.ok(iL11 < iR0 || iL0 < iR0, `期望左栏先于右栏：\n${text}`);
});

test('多行按 Y 自上而下', () => {
  const pageH = 800;
  const items = [
    item('第二行', 50, 140, 12, pageH, 60),
    item('第一行', 50, 100, 12, pageH, 60),
  ];
  const text = pageItemsToText(items, { width: 400, height: pageH });
  const a = text.indexOf('第一行');
  const b = text.indexOf('第二行');
  assert.ok(a >= 0 && b > a);
});
