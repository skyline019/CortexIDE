/**
 * Office 文档解析（docx / xlsx / pptx）—— 纯前端
 *
 * - Word(docx)：自研 ZIP/XML 抽文本（版面预览另走 docx-preview）
 * - Excel(xlsx)：SheetJS（xlsx）成熟引擎
 * - PPT(pptx)：文本抽取 only（非版式还原；图/动画/SmartArt 不显示）
 */

import * as XLSX from 'xlsx';
import { readTextEntries } from './zip.js';

/* ---------------- XML 小工具 ---------------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function unescapeXml(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

export function elements(xml, tag) {
  const out = [];
  const src = String(xml ?? '');
  // 允许命名空间前缀：w:p / a:t / 裸 sheet
  const local = tag.includes(':') ? tag.split(':').pop() : tag;
  const re = new RegExp(`<(?:[\\w.-]+:)?${local}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}>)`, 'g');
  let m;
  while ((m = re.exec(src))) out.push({ attrs: m[1] || '', inner: m[2] ?? '' });
  return out;
}

export function attr(attrs, name) {
  const m = new RegExp(`(?:\\s|^)${name}="([^"]*)"`).exec(attrs || '');
  return m ? unescapeXml(m[1]) : null;
}

/** 文本节点：w:t / a:t / 裸 t；保留 xml:space="preserve" 的空格 */
export function texts(xml) {
  const out = [];
  const re = /<(?:[\w.-]+:)?t(\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g;
  let m;
  while ((m = re.exec(xml))) {
    const preserve = /xml:space\s*=\s*"preserve"/.test(m[1] || '');
    let t = unescapeXml(m[2]);
    if (!preserve) t = t.replace(/\s+/g, (s) => (s.includes('\n') ? '\n' : ' '));
    out.push(t);
  }
  return out;
}

/** 把 run/段落片段里的 tab、换行转成可见字符再抽字 */
function expandBreaks(xml) {
  return String(xml || '')
    .replace(/<(?:[\w.-]+:)?tab\s*\/>/g, '\t')
    .replace(/<(?:[\w.-]+:)?br\b[^>]*\/?>/g, '\n')
    .replace(/<(?:[\w.-]+:)?cr\s*\/>/g, '\n');
}

function plainFromXml(xml) {
  return texts(expandBreaks(xml)).join('');
}

/* ---------------- docx ---------------- */

const HEADING_RE = /(?:Heading|heading|标题|标题\s*)\s*([1-9])|^[Hh]([1-9])$|Outline\s*([1-9])/i;

function headingLevel(styleId) {
  if (!styleId) return 0;
  const m = HEADING_RE.exec(styleId);
  return m ? Number(m[1] || m[2] || m[3]) : 0;
}

/** Word 等宽 / 代码样式字体（含中英文常见名） */
const MONO_FONT_RE =
  /Consolas|Courier|Cascadia\s*Mono|Cascadia\s*Code|Fira\s*Code|Fira\s*Mono|JetBrains\s*Mono|Source\s*Code|SF\s*Mono|Menlo|Monaco|Inconsolata|Roboto\s*Mono|Ubuntu\s*Mono|Lucida\s*Console|Noto\s*Sans\s*Mono|Sarasa\s*Mono|Iosevka|Hack\b|DejaVu\s*Sans\s*Mono|Droid\s*Sans\s*Mono|PT\s*Mono|IBM\s*Plex\s*Mono|等线\s*Mono|微软雅黑\s*Mono|方正等线|宋体\s*Mono|Code\s*New\s*Roman|Anonymous\s*Pro|Input\s*Mono/i;

const CODE_STYLE_RE =
  /^(?:Code|SourceCode|HTMLCode|PlainText|Verbatim|CodeBlock|CodeSnippet|代码|源代码|纯文本)/i;

function runFonts(inner) {
  const m =
    /<(?:[\w.-]+:)?rFonts\b([^>]*)\/?>/.exec(inner) ||
    /<(?:[\w.-]+:)?rFonts\b([^>]*)>/.exec(inner);
  if (!m) return '';
  const a = m[1] || '';
  return [
    attr(a, 'w:ascii'),
    attr(a, 'w:hAnsi'),
    attr(a, 'w:cs'),
    attr(a, 'w:eastAsia'),
    attr(a, 'ascii'),
    attr(a, 'hAnsi'),
  ]
    .filter(Boolean)
    .join(' ');
}

function isMonoFont(name) {
  return Boolean(name && MONO_FONT_RE.test(name));
}

function paragraphLooksLikeCode(chunk, style, runs) {
  if (CODE_STYLE_RE.test(style || '')) return true;
  // 段落底纹 / 深色底常见于代码块
  if (/<(?:[\w.-]+:)?shd\b[^>]*(?:w:fill|fill)="(?!auto|FFFFFF|ffffff)[0-9A-Fa-f]{3,8}"/.test(chunk)) {
    const monoChars = runs.reduce((n, r) => n + (r.mono ? (r.text || '').length : 0), 0);
    const total = runs.reduce((n, r) => n + (r.text || '').length, 0) || 1;
    if (monoChars / total >= 0.4) return true;
  }
  const monoChars = runs.reduce((n, r) => n + (r.mono ? (r.text || '').length : 0), 0);
  const total = runs.reduce((n, r) => n + (r.text || '').length, 0) || 1;
  // 整段几乎全是等宽，或单 run 等宽且含代码感字符
  if (monoChars / total >= 0.72) return true;
  if (runs.length === 1 && runs[0].mono && /[{};=<>]|\/\/|\/\*|#include|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bdef\b|\bclass\b/.test(runs[0].text || '')) {
    return true;
  }
  return false;
}

function parseParagraphChunk(chunk) {
  const styleM = /<(?:[\w.-]+:)?pStyle\s+[^>]*w:val="([^"]+)"/.exec(chunk)
    || /<(?:[\w.-]+:)?pStyle\s+[^>]*val="([^"]+)"/.exec(chunk);
  const style = styleM ? styleM[1] : '';
  const level = headingLevel(style);
  const numPr = /<(?:[\w.-]+:)?numPr[\s>]/.test(chunk);
  const runs = elements(chunk, 'w:r').map((r) => {
    const inner = expandBreaks(r.inner);
    const fonts = runFonts(r.inner);
    return {
      text: texts(inner).join(''),
      bold: /<(?:[\w.-]+:)?b\s*\/>|<(?:[\w.-]+:)?b\s+[^>]*w:val="(?:1|true|on)"/i.test(r.inner),
      italic: /<(?:[\w.-]+:)?i\s*\/>|<(?:[\w.-]+:)?i\s+[^>]*w:val="(?:1|true|on)"/i.test(r.inner),
      mono: isMonoFont(fonts),
      fonts,
    };
  });
  // 超链接：把显示文字留下，URL 附在后面（relationship 解析成本高，先取显示字）
  const plain = (runs.length ? runs.map((r) => r.text).join('') : plainFromXml(chunk)).replace(/\s+$/g, '');
  const code = paragraphLooksLikeCode(chunk, style, runs);
  return { style, level, numPr, runs, plain, code };
}

function parseTableXml(chunk) {
  return elements(chunk, 'w:tr').map((tr) =>
    elements(tr.inner, 'w:tc').map((tc) => plainFromXml(tc.inner).replace(/\n+/g, ' ').trim()),
  );
}

function walkDocBody(bodyXml) {
  const blocks = [];
  let tables = 0;
  let headings = 0;
  // 表格优先整块匹配，避免表内段落被拆出去；同时抓文本框
  const tokenRe =
    /<(?:[\w.-]+:)?tbl\b[\s\S]*?<\/(?:[\w.-]+:)?tbl>|<(?:[\w.-]+:)?txbxContent\b[\s\S]*?<\/(?:[\w.-]+:)?txbxContent>|<(?:[\w.-]+:)?p\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?p>/g;
  let m;
  while ((m = tokenRe.exec(bodyXml))) {
    const chunk = m[0];
    if (/^<(?:[\w.-]+:)?tbl\b/.test(chunk)) {
      tables += 1;
      blocks.push({ type: 'table', rows: parseTableXml(chunk) });
      continue;
    }
    if (/txbxContent/i.test(chunk.slice(0, 48))) {
      const inner = walkDocBody(chunk.replace(/^[\s\S]*?<(?:[\w.-]+:)?txbxContent\b[^>]*>/i, '').replace(/<\/(?:[\w.-]+:)?txbxContent>[\s\S]*$/i, ''));
      const nested = mergeListItems(inner.blocks || []);
      if (nested.length) blocks.push({ type: 'textbox', blocks: nested });
      else {
        const t = plainFromXml(chunk).trim();
        if (t) blocks.push({ type: 'paragraph', runs: [{ text: t }], text: t });
      }
      continue;
    }
    const p = parseParagraphChunk(chunk);
    if (!p.plain.trim() && !p.code) continue;
    if (p.level) {
      headings += 1;
      blocks.push({ type: 'heading', level: p.level, text: p.plain });
    } else if (p.code) {
      blocks.push({ type: 'codeLine', text: p.plain });
    } else if (p.numPr || /ListParagraph|List Bullet|List Number|列表/i.test(p.style)) {
      const ordered = /List Number|编号|Number/i.test(p.style);
      blocks.push({ type: 'listItem', ordered, text: p.plain });
    } else {
      // 段内混排：等宽连续片段抽成行内 `code`，整段仍是 paragraph
      const runs = p.runs.filter((r) => r.text);
      blocks.push({ type: 'paragraph', runs, text: p.plain });
    }
  }
  return { blocks, tables, headings };
}

function mergeListItems(blocks) {
  const merged = [];
  for (const b of blocks) {
    if (b.type === 'textbox') {
      merged.push({ type: 'textbox', blocks: mergeListItems(b.blocks || []) });
      continue;
    }
    const last = merged[merged.length - 1];
    if (b.type === 'listItem' && last?.type === 'list' && last.ordered === b.ordered) last.items.push(b.text);
    else if (b.type === 'listItem') merged.push({ type: 'list', ordered: b.ordered, items: [b.text] });
    else if (b.type === 'codeLine' && last?.type === 'code') last.lines.push(b.text);
    else if (b.type === 'codeLine') merged.push({ type: 'code', lines: [b.text] });
    else merged.push(b);
  }
  return merged;
}

/**
 * @returns {Promise<{type:'docx', blocks:Array, title:string, headers:string[], footers:string[], stats:object}>}
 */
export async function parseDocx(bytes) {
  const files = await readTextEntries(
    bytes,
    (n) =>
      n === 'word/document.xml' ||
      /^word\/header\d*\.xml$/.test(n) ||
      /^word\/footer\d*\.xml$/.test(n) ||
      n.startsWith('word/numbering'),
  );
  const xml = files.get('word/document.xml');
  if (!xml) throw new Error('docx 里找不到 word/document.xml（文件可能损坏或不是 Word 文档）');

  const bodyMatch = /<(?:[\w.-]+:)?body\b[^>]*>([\s\S]*)<\/(?:[\w.-]+:)?body>/.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;
  const { blocks, tables, headings } = walkDocBody(body);
  const merged = mergeListItems(blocks);

  const headers = [];
  const footers = [];
  for (const [name, hx] of files) {
    if (/^word\/header/.test(name)) {
      const t = plainFromXml(hx).replace(/\s+/g, ' ').trim();
      if (t) headers.push(t);
    }
    if (/^word\/footer/.test(name)) {
      const t = plainFromXml(hx).replace(/\s+/g, ' ').trim();
      if (t) footers.push(t);
    }
  }

  const firstHeading = merged.find((b) => b.type === 'heading');
  return {
    type: 'docx',
    blocks: merged,
    title: firstHeading?.text || '',
    headers: [...new Set(headers)],
    footers: [...new Set(footers)],
    stats: {
      paragraphs: merged.filter((b) => b.type === 'paragraph').length,
      codeBlocks: merged.filter((b) => b.type === 'code').length,
      tables,
      headings,
      headers: headers.length,
      footers: footers.length,
    },
  };
}

/* ---------------- xlsx（SheetJS） ---------------- */

const XLSX_MAX_ROWS = 8000;

/**
 * 显示约定（对齐预览「琥珀色公式格」）：
 * - 有公式且无真实缓存（stub / 无 v·w）→ 显示 `=公式原文`
 * - 否则优先格式化文本 w，再退到 v
 */
function cellDisplay(cell) {
  if (!cell) return '';
  const hasFormula = Boolean(cell.f);
  const stub = cell.t === 'z';
  const noCache = cell.v == null && (cell.w == null || cell.w === '');
  if (hasFormula && (stub || noCache)) return `=${cell.f}`;
  if (cell.w != null && String(cell.w).length) return String(cell.w);
  if (cell.t === 'd' && cell.v instanceof Date) {
    const d = cell.v;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (cell.v == null) return hasFormula ? `=${cell.f}` : '';
  return String(cell.v);
}

function assertXlsxZip(u8) {
  // SheetJS 对垃圾字节可能静默吐出空 Sheet1；先挡非 ZIP
  if (!u8?.length || u8.length < 4) throw new Error('xlsx 数据过短或为空');
  if (u8[0] !== 0x50 || u8[1] !== 0x4b) throw new Error('不是有效的 xlsx（缺少 ZIP 头）');
}

/**
 * @returns {Promise<{type:'xlsx', sheets:Array, stats:object}>}
 */
export async function parseXlsx(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  assertXlsxZip(u8);
  let wb;
  try {
    // sheetStubs：保留「只有公式、无缓存值」的格，否则公式坐标会丢
    wb = XLSX.read(u8, {
      type: 'array',
      cellDates: true,
      cellNF: true,
      cellFormula: true,
      sheetStubs: true,
      dense: false,
    });
  } catch (err) {
    throw new Error(`Excel 解析失败：${err?.message || err}`);
  }
  if (!wb?.SheetNames?.length) throw new Error('xlsx 里找不到工作表（文件可能损坏）');

  const sheets = [];
  let totalRows = 0;
  let truncated = false;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const ref = ws['!ref'];
    let maxCol = 0;
    const formulas = [];
    let rows = [];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      maxCol = Math.max(0, range.e.c - range.s.c + 1);
      const lastR = Math.min(range.e.r, range.s.r + XLSX_MAX_ROWS - 1);
      if (range.e.r - range.s.r + 1 > XLSX_MAX_ROWS) truncated = true;
      for (let R = range.s.r; R <= lastR; R += 1) {
        const row = [];
        for (let C = range.s.c; C <= range.e.c; C += 1) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          const cell = ws[addr];
          if (cell?.f) formulas.push([R - range.s.r, C - range.s.c]);
          row.push(cellDisplay(cell));
        }
        rows.push(row);
      }
      while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
    } else {
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }).slice(0, XLSX_MAX_ROWS);
      maxCol = rows.reduce((n, r) => Math.max(n, r.length), 0);
      rows = rows.map((r) => Array.from({ length: maxCol }, (_, i) => (r[i] == null ? '' : String(r[i]))));
    }
    totalRows += rows.length;
    sheets.push({ name, rows, cols: maxCol, formulas });
  }

  return {
    type: 'xlsx',
    sheets,
    stats: {
      sheets: sheets.length,
      rows: totalRows,
      engine: 'sheetjs',
      truncated: truncated || undefined,
    },
  };
}

/* ---------------- pptx ---------------- */

function shapeOrigin(xmlChunk) {
  const m = /<(?:[\w.-]+:)?off\b([^>/]*)/.exec(xmlChunk);
  if (!m) return { x: 0, y: 0 };
  const x = Number((/\bx="(\d+)"/.exec(m[1]) || [])[1] || 0);
  const y = Number((/\by="(\d+)"/.exec(m[1]) || [])[1] || 0);
  return { x, y };
}

function extractSlideBlocks(xml) {
  // 按 sp / graphicFrame / pic 等块切，再按位置排序
  const chunks = [];
  const re = /<(?:[\w.-]+:)?(?:sp|graphicFrame|cxnSp|pic)\b[\s\S]*?<\/(?:[\w.-]+:)?(?:sp|graphicFrame|cxnSp|pic)>/g;
  let m;
  while ((m = re.exec(xml))) chunks.push(m[0]);
  if (!chunks.length) {
    // 退化：整页所有段落
    const paragraphs = elements(xml, 'a:p')
      .map((p) => plainFromXml(p.inner).trim())
      .filter(Boolean);
    return { paragraphs, tables: [] };
  }

  const items = chunks.map((chunk) => {
    const { x, y } = shapeOrigin(chunk);
    const tables = elements(chunk, 'a:tbl').map((tbl) =>
      elements(tbl.inner, 'a:tr').map((tr) =>
        elements(tr.inner, 'a:tc').map((tc) => plainFromXml(tc.inner).replace(/\n+/g, ' ').trim()),
      ),
    );
    const paragraphs = elements(chunk, 'a:p')
      .map((p) => plainFromXml(p.inner).trim())
      .filter(Boolean);
    return { x, y, paragraphs, tables };
  });

  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const paragraphs = [];
  const tables = [];
  for (const it of items) {
    for (const t of it.tables) tables.push(t);
    for (const p of it.paragraphs) paragraphs.push(p);
  }
  return { paragraphs, tables };
}

/**
 * @returns {Promise<{type:'pptx', slides:Array, stats:object}>}
 */
export async function parsePptx(bytes) {
  const files = await readTextEntries(
    bytes,
    (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n),
  );
  const slideNames = [...files.keys()].filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n));
  if (!slideNames.length) throw new Error('pptx 里找不到幻灯片（文件可能损坏）');
  slideNames.sort((a, b) => {
    const na = Number((a.match(/slide(\d+)/) || [])[1] || 0);
    const nb = Number((b.match(/slide(\d+)/) || [])[1] || 0);
    return na - nb;
  });

  const slides = slideNames.map((n, i) => {
    const idx = Number((n.match(/slide(\d+)/) || [])[1] || i + 1);
    const xml = files.get(n);
    const { paragraphs, tables } = extractSlideBlocks(xml);
    const notesName = `ppt/notesSlides/notesSlide${idx}.xml`;
    const notesXml = files.get(notesName);
    const notes = notesXml
      ? elements(notesXml, 'a:p')
          .map((p) => plainFromXml(p.inner).trim())
          .filter((t) => t && !/^[\d\s]+$/.test(t)) // 去掉页码噪音
      : [];
    return { index: idx, paragraphs, tables, notes };
  });

  return { type: 'pptx', slides, stats: { slides: slides.length, withNotes: slides.filter((s) => s.notes?.length).length } };
}

/* ---------------- CSV ---------------- */

export function parseCsv(text, delimiter) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const delim = delimiter || (src.split('\n')[0].split('\t').length > src.split('\n')[0].split(',').length ? '\t' : ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].length === 1 && !rows[rows.length - 1][0].trim()) rows.pop();
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  return { type: 'csv', rows: rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? '')), cols, delimiter: delim };
}

/* ---------------- 统一转 Markdown（Agent / 复制） ---------------- */

function runsToMarkdown(runs) {
  if (!runs?.length) return '';
  // 相邻等宽 run 合并成一段 `code`，避免每个字一个反引号
  const parts = [];
  let monoBuf = '';
  const flushMono = () => {
    if (!monoBuf) return;
    const t = monoBuf.replace(/`/g, '\\`');
    parts.push(t.includes('\n') ? `\`\`\`\n${t}\n\`\`\`` : `\`${t}\``);
    monoBuf = '';
  };
  for (const r of runs) {
    let t = r.text || '';
    if (r.mono) {
      monoBuf += t;
      continue;
    }
    flushMono();
    if (r.bold && r.italic) t = `***${t}***`;
    else if (r.bold) t = `**${t}**`;
    else if (r.italic) t = `*${t}*`;
    parts.push(t);
  }
  flushMono();
  return parts.join('');
}

function tableToMarkdown(rows) {
  if (!rows?.length) return '';
  const width = rows.reduce((n, r) => Math.max(n, (r || []).length), 0);
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => String((r || [])[i] ?? '').replace(/\n/g, ' ').trim()));
  const head = norm[0];
  const sep = head.map(() => '---');
  const body = norm.slice(1);
  const line = (cells) => `| ${cells.map((c) => c || ' ').join(' | ')} |`;
  return [line(head), line(sep), ...body.map(line)].join('\n');
}

function blocksToMarkdown(blocks, depth = 0) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === 'heading') out.push(`${'#'.repeat(Math.min(6, b.level || 1))} ${b.text || ''}`);
    else if (b.type === 'list') {
      b.items.forEach((it, i) => out.push(b.ordered ? `${i + 1}. ${it}` : `- ${it}`));
    } else if (b.type === 'table') out.push(tableToMarkdown(b.rows));
    else if (b.type === 'textbox') {
      out.push('> 【文本框】');
      out.push(blocksToMarkdown(b.blocks, depth + 1));
    }     else if (b.type === 'code') {
      const body = (b.lines || []).join('\n').replace(/\n+$/, '');
      out.push(`\`\`\`\n${body}\n\`\`\``);
    } else if (b.type === 'paragraph') {
      // 优先 runs（含行内等宽）；无 runs 时退回纯文本
      out.push((b.runs?.length ? runsToMarkdown(b.runs) : b.text) || '');
    } else if (b.text) out.push(b.text);
  }
  return out.filter((x) => x !== '').join('\n\n');
}

/** 把 parse* 结果收成高质量 Markdown，供 Agent / 一键复制 */
export function documentToMarkdown(doc, { maxRowsPerSheet = 2000, maxChars = 400_000 } = {}) {
  if (!doc) return '';
  let text = '';
  if (doc.type === 'docx') {
    const head = [];
    if (doc.headers?.length) head.push(`【页眉】${doc.headers.join(' | ')}`);
    if (doc.title) head.push(`# ${doc.title}`);
    text = [...head, blocksToMarkdown(doc.blocks)].filter(Boolean).join('\n\n');
    if (doc.footers?.length) text += `\n\n【页脚】${doc.footers.join(' | ')}`;
  } else if (doc.type === 'xlsx') {
    text = (doc.sheets || [])
      .map((sh) => {
        const rows = (sh.rows || []).slice(0, maxRowsPerSheet);
        const more =
          (sh.rows || []).length > maxRowsPerSheet
            ? `\n\n…（共 ${sh.rows.length} 行，此处前 ${maxRowsPerSheet} 行）`
            : '';
        return `## 工作表：${sh.name}\n\n${tableToMarkdown(rows) || '_（空表）_'}${more}`;
      })
      .join('\n\n');
  } else if (doc.type === 'pptx') {
    text = (doc.slides || [])
      .map((sl) => {
        const parts = [`## 幻灯片 ${sl.index}`];
        for (const t of sl.tables || []) parts.push(tableToMarkdown(t));
        for (const p of sl.paragraphs || []) parts.push(p);
        if (sl.notes?.length) parts.push(`\n**演讲者备注**\n\n${sl.notes.join('\n')}`);
        return parts.join('\n\n');
      })
      .join('\n\n---\n\n');
  } else if (doc.type === 'csv') {
    text = tableToMarkdown((doc.rows || []).slice(0, maxRowsPerSheet));
  } else {
    text = JSON.stringify(doc).slice(0, maxChars);
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n\n…（已截断，原文约 ${text.length} 字符）`;
  }
  return text.trim();
}

export async function parseOffice(bytes, ext) {
  switch (String(ext || '').toLowerCase()) {
    case 'docx':
      return parseDocx(bytes);
    case 'xlsx':
      return parseXlsx(bytes);
    case 'pptx':
      return parsePptx(bytes);
    case 'csv':
    case 'tsv':
      return typeof bytes === 'string'
        ? parseCsv(bytes, ext === 'tsv' ? '\t' : undefined)
        : parseCsv(new TextDecoder().decode(bytes), ext === 'tsv' ? '\t' : undefined);
    default:
      throw new Error(`不支持的 Office 格式：${ext}`);
  }
}
