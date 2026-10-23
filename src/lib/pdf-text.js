/**
 * PDF 文本抽取 —— Mozilla pdf.js + 视觉阅读序重建。
 *
 * 针对「极其混乱」的常见根因：
 * 1. 中日韩：每个字一项，乱插空格 → 字间绝不插空格
 * 2. 双栏：按行左右拼 → 用 X 投影找栏缝，栏内自上而下
 * 3. 英文：用字宽推空隙，大间隙用 tab（表格）
 * 4. 未挂 CMap → 中文变成乱码/空；统一走 public/pdfjs
 * 5. hasEOL：pdf.js 已标明换行时优先尊重
 */

const CJK_RE =
  /[\u3000-\u303F\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{2A6DF}]/u;

function isCjkChar(ch) {
  return Boolean(ch && CJK_RE.test(ch));
}

function lastChar(s) {
  const t = String(s || '');
  return t ? [...t].pop() : '';
}

function firstChar(s) {
  const t = String(s || '');
  return t ? [...t][0] : '';
}

/** 是否应在两项之间插入空白：false | ' ' | '\t' */
function gapKind(prev, next, gap) {
  const fs = Math.max(prev.h, next.h, 1);
  const a = lastChar(prev.str);
  const b = firstChar(next.str);
  // 中日韩相邻：永不插空格（再小的 gap 也是字距）
  if (isCjkChar(a) && isCjkChar(b)) {
    if (gap > fs * 2.2) return '\t';
    return false;
  }
  // 已有空白
  if (/\s$/.test(prev.str) || /^\s/.test(next.str)) return false;
  // 标点贴字
  if (/^[),.;:!?\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u201d\u2019\]]/.test(b)) return false;
  if (/[([{\u201c\u2018\uff08]$/.test(a)) return false;

  if (gap > fs * 2.0) return '\t';
  if (gap > fs * 0.22) return ' ';
  return false;
}

function itemToGeom(item, pageHeight) {
  const t = item.transform || [1, 0, 0, 1, 0, 0];
  // PDF 用户空间：原点左下，Y 向上。转成「上原点、Y 向下」便于阅读序排序
  const h = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || Math.abs(t[0]) || 1;
  const w = typeof item.width === 'number' && item.width > 0 ? item.width : Math.max(h * 0.5, (item.str || '').length * h * 0.45);
  const x = t[4];
  const yPdf = t[5];
  const y = pageHeight - yPdf; // 自上而下增大
  return {
    str: String(item.str || '').replace(/\u00ad/g, ''),
    x,
    y,
    w,
    h,
    hasEOL: Boolean(item.hasEOL),
    cx: x + w / 2,
  };
}

/** 同行聚类（屏幕坐标，Y 向下） */
function clusterLines(geoms) {
  if (!geoms.length) return [];
  const sorted = [...geoms].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const g of sorted) {
    const last = lines[lines.length - 1];
    const tol = last ? Math.max(2.5, Math.min(last.h, g.h) * 0.55) : 2.5;
    if (last && Math.abs(last.y - g.y) <= tol) {
      last.items.push(g);
      last.y = (last.y * (last.items.length - 1) + g.y) / last.items.length;
      last.h = Math.max(last.h, g.h);
    } else {
      lines.push({ y: g.y, h: g.h, items: [g] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.x0 = line.items[0].x;
    line.x1 = line.items[line.items.length - 1].x + line.items[line.items.length - 1].w;
    line.text = joinLineItems(line.items);
  }
  return lines;
}

function joinLineItems(items) {
  let text = '';
  let prev = null;
  for (const it of items) {
    if (!it.str) continue;
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      const kind = gapKind(prev, it, gap);
      if (kind) text += kind;
    }
    text += it.str;
    prev = it;
    if (it.hasEOL) {
      // hasEOL 表示该项后换行；同行里偶发出现时当作软换行忽略，留给行级拼接
    }
  }
  return text.replace(/[ \t]+$/g, '').replace(/[ \t]{3,}/g, '\t');
}

/**
 * X 投影找栏缝：在页面中部找「竖直空白带」。
 * 仅当左右两侧都有足够文字块且缝够宽时才分栏，避免单栏被误劈。
 */
function detectColumnBounds(geoms, pageWidth) {
  if (geoms.length < 20 || pageWidth < 200) return null;

  const bins = 48;
  const hist = new Float64Array(bins);
  for (const g of geoms) {
    if (!g.str.trim()) continue;
    const i = Math.min(bins - 1, Math.max(0, Math.floor((g.cx / pageWidth) * bins)));
    hist[i] += g.str.length;
  }

  // 忽略左右边距带，在中间 20%–80% 找最深谷
  const lo = Math.floor(bins * 0.22);
  const hi = Math.ceil(bins * 0.78);
  let best = -1;
  let bestVal = Infinity;
  const peak = Math.max(...hist, 1);
  for (let i = lo; i <= hi; i++) {
    // 谷要「宽」一点：看 i-1..i+1
    const v = hist[i - 1] + hist[i] + hist[i + 1];
    if (v < bestVal) {
      bestVal = v;
      best = i;
    }
  }
  // 谷必须够空（相对峰值），否则不是真分栏
  if (best < 0 || bestVal > peak * 0.12) return null;

  const splitX = ((best + 0.5) / bins) * pageWidth;
  const left = geoms.filter((g) => g.cx < splitX - pageWidth * 0.02);
  const right = geoms.filter((g) => g.cx > splitX + pageWidth * 0.02);
  const span = geoms.filter((g) => g.x < splitX && g.x + g.w > splitX && g.w > pageWidth * 0.4);

  if (left.length < 10 || right.length < 10) return null;
  if (span.length > Math.min(left.length, right.length) * 0.2) return null;

  // 两栏纵向覆盖应大致重叠（都是正文栏，而不是页眉+侧栏）
  const yRange = (arr) => {
    let min = Infinity;
    let max = -Infinity;
    for (const g of arr) {
      min = Math.min(min, g.y);
      max = Math.max(max, g.y);
    }
    return { min, max, span: max - min };
  };
  const L = yRange(left);
  const R = yRange(right);
  const overlap = Math.min(L.max, R.max) - Math.max(L.min, R.min);
  if (overlap < Math.min(L.span, R.span) * 0.35) return null;

  return [left, right];
}

function columnToText(geoms) {
  const lines = clusterLines(geoms.filter((g) => g.str.length));
  if (!lines.length) return '';

  // 段间距：行距明显大于字号 → 空行
  const out = [];
  let prev = null;
  for (const line of lines) {
    if (prev) {
      const gap = line.y - prev.y;
      const fs = Math.max(prev.h, line.h, 1);
      if (gap > fs * 1.85) out.push('');
    }
    out.push(line.text);
    prev = line;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 将一页 pdf.js TextContent items → 可读纯文本
 * @param {Array} items
 * @param {{width:number, height:number}} pageSize
 */
export function pageItemsToText(items, pageSize) {
  const pageWidth = pageSize?.width || 612;
  const pageHeight = pageSize?.height || 792;
  const raw = (items || []).filter((it) => it && typeof it.str === 'string' && it.str.length);
  if (!raw.length) return '';

  const geoms = raw.map((it) => itemToGeom(it, pageHeight)).filter((g) => g.str.length);

  // 路径 A：内容流顺序已带可靠 hasEOL，且多数项有换行标记 → 直接拼（报刊/部分导出 PDF）
  const eolCount = raw.filter((it) => it.hasEOL).length;
  if (eolCount >= Math.max(3, raw.length * 0.08)) {
    let s = '';
    let prev = null;
    for (const it of raw) {
      const g = itemToGeom(it, pageHeight);
      if (prev && !prev.hasEOL) {
        const gap = g.x - (prev.x + prev.w);
        // 同流里 Y 跳变过大也换行
        if (Math.abs(g.y - prev.y) > Math.max(prev.h, g.h) * 0.7) s += '\n';
        else {
          const k = gapKind(prev, g, gap);
          if (k) s += k;
        }
      } else if (prev?.hasEOL) {
        s += '\n';
      }
      s += g.str;
      prev = { ...g, hasEOL: it.hasEOL };
    }
    const streamText = s.replace(/\n{3,}/g, '\n\n').trim();
    // 若几乎没有换行、却像散文，仍走视觉重建
    if (streamText.includes('\n') || streamText.length < 80) return streamText;
  }

  // 路径 B：视觉阅读序（分栏 + 行聚类）
  const cols = detectColumnBounds(geoms, pageWidth);
  if (cols) {
    return cols
      .map((c) => columnToText(c))
      .filter(Boolean)
      .join('\n\n');
  }
  return columnToText(geoms);
}

export function resolvePdfAssets(pdfjs) {
  const ver = pdfjs?.version || '4.10.38';
  const base =
    typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL != null ? import.meta.env.BASE_URL : '/';
  return {
    cMapUrl: `${base}pdfjs/cmaps/`,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    cMapPacked: true,
    fallbackCMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${ver}/cmaps/`,
    fallbackFontUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${ver}/standard_fonts/`,
  };
}

export async function ensurePdfjsWorker(pdfjs) {
  if (pdfjs.GlobalWorkerOptions.workerSrc) return;
  try {
    const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  } catch {
    /* ignore */
  }
}

/**
 * @param {Uint8Array|ArrayBuffer} data
 * @param {{maxPages?:number, maxChars?:number}} opts
 */
export async function extractPdfLayoutText(data, { maxPages = 120, maxChars = 280_000 } = {}) {
  const pdfjs = await import('pdfjs-dist');
  await ensurePdfjsWorker(pdfjs);

  const assets = resolvePdfAssets(pdfjs);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = await pdfjs
    .getDocument({
      data: bytes,
      useSystemFonts: true,
      cMapUrl: assets.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: assets.standardFontDataUrl,
      disableFontFace: false,
      isEvalSupported: false,
    })
    .promise;

  const pageCount = doc.numPages;
  const take = Math.min(pageCount, maxPages);
  const parts = [];
  let chars = 0;
  let truncated = false;

  for (let i = 1; i <= take; i += 1) {
    if (chars >= maxChars) {
      truncated = true;
      break;
    }
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent({
      includeMarkedContent: false,
      // false：让 pdf.js 合并相邻字形，英文词更完整；中文仍可能一字一项
      disableCombineTextItems: false,
    });
    const block = pageItemsToText(tc.items || [], {
      width: viewport.width,
      height: viewport.height,
    }).trim();
    if (block) {
      const piece = `## 第 ${i} / ${pageCount} 页\n\n${block}`;
      parts.push(piece);
      chars += piece.length;
    }
    page.cleanup?.();
  }

  if (pageCount > take) truncated = true;
  await doc.destroy?.();

  let text = parts
    .join('\n\n')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\uFFFD{3,}/g, '…');

  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    text += `\n\n…（已截断：共 ${pageCount} 页，本次解析到此。）`;
  }
  return {
    text,
    pages: pageCount,
    pagesRead: Math.min(take, parts.length ? take : 0),
    truncated,
    chars: text.length,
    engine: 'pdfjs-visual',
  };
}
