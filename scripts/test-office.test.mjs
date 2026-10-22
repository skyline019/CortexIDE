/**
 * Office / Markdown 导出回归：保证段落 runs、表格、PPT 备注能进 Agent 文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { documentToMarkdown, texts, elements, unescapeXml, parseDocx, parsePptx, parseXlsx } from '../src/lib/office.js';

/** 极简 store-only ZIP（method=0），够我们的 zip 读取器吃 */
function storeZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const cens = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc skip
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    Buffer.from(nameBytes).copy(local, 30);
    Buffer.from(data).copy(local, 30 + nameBytes.length);
    locals.push(local);

    const cen = Buffer.alloc(46 + nameBytes.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(0, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBytes.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    Buffer.from(nameBytes).copy(cen, 46);
    cens.push(cen);
    offset += local.length;
  }
  const cenStart = offset;
  const cenBuf = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cens.length, 8);
  eocd.writeUInt16LE(cens.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(cenStart, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...locals, cenBuf, eocd]));
}

test('texts / unescape 保留实体与空格', () => {
  assert.equal(unescapeXml('a&amp;b'), 'a&b');
  assert.deepEqual(texts('<w:t>hello</w:t><w:t xml:space="preserve">  x</w:t>'), ['hello', '  x']);
  assert.equal(elements('<w:p>a</w:p><w:p/>', 'w:p').length, 2);
});

test('documentToMarkdown 不丢段落 runs', () => {
  const md = documentToMarkdown({
    type: 'docx',
    headers: ['页眉A'],
    footers: ['页脚B'],
    blocks: [
      { type: 'heading', level: 1, text: '标题' },
      { type: 'paragraph', runs: [{ text: '你好', bold: true }, { text: '世界' }], text: '你好世界' },
      { type: 'list', ordered: false, items: ['一', '二'] },
      { type: 'table', rows: [['列1', '列2'], ['a', 'b']] },
      { type: 'code', lines: ['const x = 1;', 'console.log(x);'] },
    ],
  });
  assert.match(md, /页眉A/);
  assert.match(md, /# 标题/);
  assert.match(md, /你好/);
  assert.match(md, /世界/);
  assert.match(md, /- 一/);
  assert.match(md, /\| 列1 \|/);
  assert.match(md, /页脚B/);
  assert.match(md, /```[\s\S]*const x = 1;/);
});

test('parseDocx 等宽字体段落合成代码块', async () => {
  const xml = `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>说明</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>const a = 1;</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>const b = 2;</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t>return a + b;</w:t></w:r></w:p>
        <w:sectPr/>
      </w:body>
    </w:document>`;
  const bytes = storeZip({ 'word/document.xml': xml });
  const doc = await parseDocx(bytes);
  const code = doc.blocks.find((b) => b.type === 'code');
  assert.ok(code, '应合并为 code 块');
  assert.ok(code.lines.some((l) => /const a/.test(l)));
  const md = documentToMarkdown(doc);
  assert.match(md, /```[\s\S]*const a = 1;/);
  assert.match(md, /return a \+ b;/);
});

test('parseDocx 抽出段落与表格', async () => {
  const xml = `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>粗体</w:t></w:r><w:r><w:t>正文</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
        <w:sectPr/>
      </w:body>
    </w:document>`;
  const bytes = storeZip({ 'word/document.xml': xml });
  const doc = await parseDocx(bytes);
  const md = documentToMarkdown(doc);
  assert.equal(doc.blocks.some((b) => b.type === 'heading' && b.text === 'Hello'), true);
  assert.match(md, /粗体/);
  assert.match(md, /正文/);
  assert.match(md, /A1/);
});

test('parsePptx 按页抽字并带备注', async () => {
  const slide = `<?xml version="1.0"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:cSld><p:spTree>
        <p:sp>
          <p:spPr><a:xfrm><a:off x="100" y="100"/></a:xfrm></p:spPr>
          <p:txBody><a:p><a:r><a:t>封面标题</a:t></a:r></a:p></p:txBody>
        </p:sp>
        <p:sp>
          <p:spPr><a:xfrm><a:off x="100" y="500"/></a:xfrm></p:spPr>
          <p:txBody><a:p><a:r><a:t>要点一</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:spTree></p:cSld>
    </p:sld>`;
  const notes = `<?xml version="1.0"?>
    <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        <p:sp><p:txBody><a:p><a:r><a:t>这是演讲备注</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld>
    </p:notes>`;
  const bytes = storeZip({
    'ppt/slides/slide1.xml': slide,
    'ppt/notesSlides/notesSlide1.xml': notes,
  });
  const doc = await parsePptx(bytes);
  assert.equal(doc.slides.length, 1);
  assert.ok(doc.slides[0].paragraphs.includes('封面标题'));
  assert.ok(doc.slides[0].notes.some((n) => n.includes('演讲备注')));
  assert.match(documentToMarkdown(doc), /演讲备注/);
});

test('parseXlsx 共享字符串与单元格', async () => {
  // 用手搓残缺 ZIP（无 CRC）SheetJS 会拒；改用引擎自写的合法 xlsx 对齐生产路径
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['姓名', 42],
    ['张三', 7],
  ]);
  XLSX.utils.book_append_sheet(book, ws, '数据');
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  const doc = await parseXlsx(bytes);
  assert.equal(doc.stats.engine, 'sheetjs');
  assert.equal(doc.sheets[0].name, '数据');
  assert.equal(doc.sheets[0].rows[0][0], '姓名');
  assert.equal(doc.sheets[0].rows[1][0], '张三');
  assert.equal(String(doc.sheets[0].rows[0][1]), '42');
  assert.match(documentToMarkdown(doc), /张三/);
});
