/**
 * mammoth Word → Markdown 冒烟（最小 store-only docx）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocxMarkdown } from '../src/lib/docx-mammoth.js';

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
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
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

test('mammoth 抽出标题与正文', async () => {
  const contentTypes = `<?xml version="1.0"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`;
  const rels = `<?xml version="1.0"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`;
  const docXml = `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hello Mammoth</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>粗体</w:t></w:r><w:r><w:t>与正文</w:t></w:r></w:p>
        <w:sectPr/>
      </w:body>
    </w:document>`;
  const bytes = storeZip({
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels,
    'word/document.xml': docXml,
  });
  const { text, engine } = await extractDocxMarkdown(bytes);
  assert.equal(engine, 'mammoth');
  assert.match(text, /Hello Mammoth/);
  assert.match(text, /粗体/);
  assert.match(text, /正文/);
});
