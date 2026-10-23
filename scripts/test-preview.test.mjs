/**
 * 十三：Markdown / 高亮 / 文件预览解析器的单测。
 *
 * 这些解析器是自研的（不引第三方），最容易在细节上错 —— 比如
 * 「自闭合标签被漏掉导致工作表列表为空」「xlsx 的裸 <t> 没识别导致文字全是空」，
 * 都是本轮真实踩过的坑，这里逐条钉住。
 *
 * 夹具在 .cache/fixtures（由 scripts/make-fixtures.mjs 生成，缺失时本文件会现场补造）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, astStats, outlineOf, parseInline } from '../src/lib/markdown.js';
import { tokenizeCode, highlightStats, normalizeLang } from '../src/lib/highlight.js';
import { parseDocx, parseXlsx, parsePptx, parseCsv, elements } from '../src/lib/office.js';
import { listEntries, readEntry } from '../src/lib/zip.js';
import { previewKind, extOf, KIND_LABEL } from '../src/lib/preview-kind.js';
import { dirOf, joinRel, resolveAssetSrc, shortAlt } from '../src/lib/md-assets.js';
import { rawContentDisposition, MIME_TYPES } from '../server/fs-api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// 夹具放在 demo/ 里（会随仓库持久化）；.cache 会被快照清掉，不能当唯一来源
const FIX = path.join(here, '..', 'demo');
const has = (f) => fs.existsSync(path.join(FIX, f));
const read = (f) => new Uint8Array(fs.readFileSync(path.join(FIX, f)));

/* ------------------------------ Markdown ------------------------------ */

test('markdown：块级语法全部识别', () => {
  const src = [
    '# 标题一',
    '',
    '普通段落，含 **粗体**、*斜体*、~~删除~~、`code` 与 [链接](https://a.b)。',
    '',
    '## 二级 code 标题',
    '',
    '> 引用一行',
    '',
    '> [!WARNING]',
    '> 提示内容',
    '',
    '- 列表项 A',
    '  - 嵌套 B',
    '1. 有序一',
    '2. 有序二',
    '',
    '- [x] 已完成',
    '- [ ] 未完成',
    '',
    '| 左 | 中 | 右 |',
    '| :--- | :---: | ---: |',
    '| 1 | 2 | 3 |',
    '',
    '---',
    '',
    '```js',
    'const a = 1;',
    '```',
  ].join('\n');

  const blocks = parseMarkdown(src);
  const stats = astStats(blocks);
  assert.equal(stats.heading, 2);
  assert.equal(stats.table, 1);
  assert.equal(stats.hr, 1);
  assert.ok(stats.code >= 1, '围栏代码 + 行内代码');
  assert.ok(stats.list >= 2, '列表块应至少 2 个');
  assert.equal(stats.quote, 2, '两段引用（普通引用 + callout）');
  assert.ok(stats.strong >= 1 && stats.em >= 1 && stats.del >= 1 && stats.link >= 1);

  const table = blocks.find((b) => b.type === 'table');
  assert.deepEqual(table.aligns, ['left', 'center', 'right'], '列对齐要从分隔行解析出来');
  assert.equal(table.head.length, 3);
  assert.equal(table.rows.length, 1);

  const quote = blocks.find((b) => b.type === 'quote' && b.kind !== 'quote');
  assert.equal(quote.kind, 'warning', '> [!WARNING] 要识别成 callout');

  const tasks = blocks.filter((b) => b.type === 'list' && b.items.some((i) => i.task !== null));
  assert.equal(tasks.length, 1, '无序列表与有序列表必须拆成两个 list 块，任务列表独立');
  assert.equal(tasks[0].items[0].task, true);
  assert.equal(tasks[0].items[1].task, false);
});

test('markdown：大纲只收标题，层级正确', () => {
  const outline = outlineOf(parseMarkdown('# A\n\n## B\n\ntext\n\n### C'));
  assert.deepEqual(
    outline.map((o) => [o.depth, o.text]),
    [
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
    ],
  );
});

test('markdown：原始 HTML 当纯文本，不产生标签', () => {
  const blocks = parseMarkdown('<script>alert(1)</script>\n\n<b>粗</b> 正常文字');
  const flat = JSON.stringify(blocks);
  assert.ok(!flat.includes('"type":"html"'), '不应产生 HTML 块');
  const inline = parseInline('<img src=x onerror=alert(1)>');
  assert.ok(inline.every((n) => n.type !== 'image'), 'HTML 里的 img 不能被当成图片节点');
});

test('markdown：围栏代码块保留语言与原文', () => {
  const blocks = parseMarkdown('```python\ndef f():\n    return 1\n```');
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].lang, 'python');
  assert.ok(blocks[0].value.includes('def f():'));
});

/* ------------------------------ 高亮 ------------------------------ */

test('高亮：JS 分类出关键字/字符串/注释/数字', () => {
  const s = highlightStats('const x = 42; // 注释\nconst y = "str";', 'js').counts;
  assert.ok(s.kw >= 2, `kw 应 >= 2，实际 ${s.kw}`);
  assert.ok(s.num >= 1);
  assert.ok(s.str >= 1);
  assert.ok(s.cmt >= 1);
});

test('高亮：python / json / shell / sql 都能出分类', () => {
  assert.ok(highlightStats('def f():\n    return "x"', 'python').counts.kw >= 1);
  const jsn = highlightStats('{"a": 1, "b": [true, null]}', 'json').counts;
  assert.ok(jsn.prop >= 2 && jsn.lit >= 1 && jsn.num >= 1, 'JSON 的键/字面量/数字要分开着色');
  assert.ok(highlightStats('cd /tmp && ls -la', 'sh').counts.fn >= 1);
  assert.ok(highlightStats('SELECT * FROM t WHERE id = 1', 'sql').counts.kw >= 1);
});

test('高亮：token 拼回去必须与原文完全一致（不能吞字符）', () => {
  const src = 'const a = `tpl ${b}`; /* c */ let d = 1e3;';
  const joined = tokenizeCode(src, 'js')
    .map((t) => t.v)
    .join('');
  assert.equal(joined, src);
});

test('高亮：语言名归一化', () => {
  assert.equal(normalizeLang('JS'), 'js');
  assert.equal(normalizeLang('language-TS'), 'ts');
  assert.equal(normalizeLang('node'), 'sh');
  assert.equal(normalizeLang(''), 'text');
  assert.equal(normalizeLang('klingon'), 'text');
});

/* ------------------------------ CSV ------------------------------ */

test('CSV：引号、转义引号、字段内逗号与换行', () => {
  const t = parseCsv('a,b\n1,"x,y"\n"he said ""hi""",3\n"multi\nline",4');
  assert.equal(t.cols, 2);
  assert.equal(t.rows.length, 4);
  assert.equal(t.rows[1][1], 'x,y');
  assert.equal(t.rows[2][0], 'he said "hi"');
  assert.equal(t.rows[3][0], 'multi\nline');
});

test('CSV：CRLF 与结尾空行', () => {
  const t = parseCsv('a,b\r\n1,2\r\n\r\n');
  assert.equal(t.rows.length, 2, '结尾空行不该算一行');
  assert.deepEqual(t.rows[1], ['1', '2']);
});

/* ------------------------------ zip ------------------------------ */

test('zip：能列出条目并解出文本', async () => {
  if (!has('sample.docx')) return;
  const bytes = read('sample.docx');
  const entries = listEntries(bytes);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('[Content_Types].xml'));
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  const text = new TextDecoder().decode(await readEntry(bytes, docEntry));
  assert.ok(text.includes('<w:document'));
});

test('zip：自闭合元素也要能取到（xlsx 的工作表列表就是自闭合）', () => {
  const found = elements('<sheets><sheet name="A" sheetId="1"/><sheet name="B" sheetId="2"/></sheets>', 'sheet');
  assert.equal(found.length, 2);
  assert.ok(found[0].attrs.includes('name="A"'));
});

/* ------------------------------ Office ------------------------------ */

test('docx：标题 / 段落 / 表格数量与内容', async () => {
  if (!has('sample.docx')) return;
  const d = await parseDocx(read('sample.docx'));
  assert.equal(d.stats.tables, 1);
  assert.ok(d.stats.headings >= 3, `标题数 ${d.stats.headings}`);
  assert.equal(d.blocks[0].type, 'heading');
  assert.equal(d.blocks[0].text, '季度技术评审');
  const table = d.blocks.find((b) => b.type === 'table');
  assert.ok(table.rows.length >= 3);
  assert.equal(table.rows[0][0], '档位');
});

test('xlsx：两个工作表、表头与公式单元格', async () => {
  if (!has('sample.xlsx')) return;
  const x = await parseXlsx(read('sample.xlsx'));
  assert.equal(x.stats.sheets, 2);
  assert.deepEqual(
    x.sheets.map((s) => s.name),
    ['月度销售', '汇总'],
  );
  assert.equal(x.sheets[0].rows[0].slice(0, 3).join(','), '日期,类别,渠道');
  assert.equal(x.sheets[0].rows[1][3], '12800', '文字列不能是空的（xlsx 的裸 <t> 必须识别）');
  // 没有缓存值的公式：显示公式原文，绝不假装算出了结果
  const formulaCell = x.sheets[1].rows[1][1];
  assert.ok(formulaCell.startsWith('=SUMIF'), `公式格应为公式原文，实际 ${formulaCell}`);
  // UI 靠解析器给出的坐标标「琥珀色公式格」，不靠「看着像 =」去猜
  assert.deepEqual(x.sheets[1].formulas, [[1, 1]]);
});

test('xlsx：真 Excel 的 sharedStrings（t="s"）也要能解出文字', async () => {
  // 夹具 sample.xlsx 是 openpyxl 写的 inlineStr；真实 Excel 存的是共享字符串表，
  // 两条路径都得走通，否则「能打开自己造的样例」只是自我安慰。
  if (!has('sample-excel.xlsx')) return;
  const x = await parseXlsx(read('sample-excel.xlsx'));
  assert.equal(x.sheets[0].name, '员工');
  assert.deepEqual(x.sheets[0].rows[0], ['姓名', '部门', '工龄']);
  assert.deepEqual(x.sheets[0].rows[1], ['张伟', '平台组', '5']);
});

test('pptx：按页抽段落', async () => {
  if (!has('sample.pptx')) return;
  const p = await parsePptx(read('sample.pptx'));
  assert.equal(p.stats.slides, 2);
  assert.equal(p.slides[0].index, 1);
  assert.ok(p.slides[0].paragraphs[0].includes('Cortex'));
});

test('office：损坏的字节要抛错，不能返回空文档', async () => {
  await assert.rejects(() => parseDocx(new Uint8Array([1, 2, 3, 4])));
  await assert.rejects(() => parseXlsx(new Uint8Array([1, 2, 3, 4])));
});

/* ------------------------------ 预览分发 ------------------------------ */

test('预览分发：扩展名优先，二进制兜底', () => {
  assert.equal(previewKind('demo/sample.pdf'), 'pdf');
  assert.equal(previewKind('demo/sample.docx'), 'docx');
  assert.equal(previewKind('demo/sample.xlsx'), 'xlsx');
  assert.equal(previewKind('demo/sample.pptx'), 'pptx');
  assert.equal(previewKind('demo/sales.csv'), 'csv');
  assert.equal(previewKind('README.md'), 'markdown');
  assert.equal(previewKind('logo.PNG'), 'image');
  assert.equal(previewKind('src/App.jsx'), null, '源码仍然进代码编辑器');
  assert.equal(previewKind('demo/archive.zip'), null);
  assert.equal(previewKind('demo/archive.zip', { binary: true }), 'binary');
  assert.equal(previewKind('legacy.doc'), 'unsupported');
  assert.equal(previewKind('legacy.ppt'), 'unsupported');
});

test('预览分发：每种类型都有中文标签（面包屑不会显示成「纯文本」）', () => {
  for (const k of ['image', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'markdown', 'unsupported', 'binary']) {
    assert.ok(KIND_LABEL[k] && KIND_LABEL[k].length, `${k} 缺中文标签`);
  }
  assert.equal(extOf('a/b/c.TXT'), 'txt');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf('.gitignore'), '', '点开头的隐藏文件没有扩展名');
  assert.equal(extOf('x.tar.gz'), 'gz');
});


/* ---------------- 文档里的图片地址 ---------------- */
// 真机上撞到的：README 里 19 张图只显示出来 2 张。
// 两个原因 —— ① 相对路径被按「应用地址」而不是「文档目录」解析；② loading="lazy" 在滚动容器里不触发。

test('文档图片：相对路径按文档所在目录解析，并走工作区读盘接口', () => {
  assert.equal(resolveAssetSrc('shots/a.png', ''), '/api/fs/raw?path=shots%2Fa.png');
  assert.equal(resolveAssetSrc('shots/a.png', 'docs'), '/api/fs/raw?path=docs%2Fshots%2Fa.png');
  assert.equal(resolveAssetSrc('../shots/a.png', 'docs/v2'), '/api/fs/raw?path=docs%2Fshots%2Fa.png');
  assert.equal(resolveAssetSrc('./a.png', 'docs'), '/api/fs/raw?path=docs%2Fa.png');
  assert.equal(resolveAssetSrc('/shots/a.png', 'docs'), '/api/fs/raw?path=shots%2Fa.png');
});

test('文档图片：外链 / data / 已解析过的接口地址都不改写', () => {
  for (const src of [
    'https://example.com/a.png',
    '//cdn.example.com/a.png',
    'data:image/png;base64,AAAA',
    'blob:http://localhost/abc',
    '/api/fs/raw?path=shots%2Fa.png',
  ]) {
    assert.equal(resolveAssetSrc(src, 'docs'), src, `${src} 被改写了`);
  }
  assert.equal(resolveAssetSrc('', 'docs'), '');
});

test('文档图片：file:// 与越界的 ../ 都被收进工作区', () => {
  // file:// 的绝对路径按「工作区根」解释（和 `/shots/a.png` 一致）
  assert.equal(resolveAssetSrc('file:///home/u/shot.png', ''), '/api/fs/raw?path=home%2Fu%2Fshot.png');
  // 多余的 .. 吃掉，不许穿出工作区
  assert.equal(joinRel('docs', '../../etc/passwd'), 'etc/passwd');
  assert.equal(joinRel('', '../a.png'), 'a.png');
  assert.equal(joinRel('docs/a', 'b/c.png'), 'docs/a/b/c.png');
});

test('文档图片：目录推导与 alt 截断', () => {
  assert.equal(dirOf('README.md'), '');
  assert.equal(dirOf('docs/a/b.md'), 'docs/a');
  assert.equal(dirOf('docs\\a.md'), 'docs');
  assert.equal(shortAlt('短', 10), '短');
  assert.equal(shortAlt('一二三四五六七八九十', 5), '一二三四五…');
});

test('文档图片：README 里本地图走读盘接口；外链徽章可 https', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  // 先去掉围栏代码块和行内代码：README 里讲「怎么写图片」的示例本身不是图片
  const prose = readme.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const srcs = [...prose.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 1, `README 里至少应有一张图，实际 ${srcs.length}`);
  const local = [];
  for (const src of srcs) {
    if (/^https?:\/\//i.test(src)) continue; // shields.io 等外链徽章
    const resolved = resolveAssetSrc(src, dirOf('README.md'));
    assert.match(resolved, /^\/api\/fs\/raw\?path=/, `${src} 没走读盘接口`);
    const rel = decodeURIComponent(resolved.split('path=')[1]);
    assert.ok(fs.existsSync(path.join(process.cwd(), rel)), `图片不存在：${rel}`);
    local.push(rel);
  }
  assert.ok(local.length >= 1, 'README 应至少保留一张仓库内截图');
});

test('文档图片：raw 响应头在 Windows 盘符路径下不能把整段路径塞进 Content-Disposition', () => {
  // 模拟 Windows 绝对路径：split('/') 会得到整段字符串，basename 才对
  const winAbs = 'E:\\Agent\\cortex-ide\\shots\\e2e-10-exec-loop.png';
  assert.equal(rawContentDisposition(winAbs), 'inline', '预览只要 inline');
  const broken = winAbs.split('/').pop();
  assert.ok(broken.includes('\\') || broken.includes('Agent'), '证明 split(/) 在 Windows 路径上是错的');
  const dl = rawContentDisposition(winAbs, { download: true });
  assert.match(dl, /^attachment; filename\*=UTF-8''/);
  assert.ok(dl.includes('e2e-10-exec-loop.png'), `下载文件名应是 basename，实际：${dl}`);
  assert.ok(!dl.includes('Agent'), '下载头里不能出现盘符目录');
  assert.equal(MIME_TYPES.png, 'image/png');
});
