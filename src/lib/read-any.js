/**
 * 统一「读任意工作区文件」——给 Agent / 引用上下文用。
 * 图片 → 标 vision（像素另走 image_url）
 * PDF / Office → 抽文本
 * 音视频 → 元数据说明（主流 LLM 不收原始视频流）
 * 代码/文本 → 原样分段
 */
import { parseOffice, parseCsv, documentToMarkdown } from './office.js';
import { extractDocxMarkdown } from './docx-mammoth.js';
import { extractPdfLayoutText } from './pdf-text.js';
import { previewKind, extOf, IMAGE_EXT } from './preview-kind.js';
import { mediaKindOf, formatBytes } from './media.js';
import { isImagePath } from './vision.js';

const MAX_EXTRACT = 400_000; // 抽文本后进工具结果的字符上限
const MAX_OFFICE_BYTES = 64 * 1024 * 1024;

async function fetchBytes(path) {
  const res = await fetch(`/api/fs/raw?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const size = Number(res.headers.get('content-length')) || buf.byteLength;
  return { buf, size };
}

function clipText(text, limit = MAX_EXTRACT) {
  const s = String(text || '');
  if (s.length <= limit) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, limit)}\n\n…（已截断，原文 ${s.length} 字符；需要更多请缩小范围或分段再读）`,
    truncated: true,
  };
}

function officeToText(doc) {
  return documentToMarkdown(doc, { maxRowsPerSheet: 2500, maxChars: MAX_EXTRACT });
}

/**
 * @returns {Promise<object>} 工具/上下文明细
 */
export async function readAnyFile(path, { offset = 1, limit = 300, ops } = {}) {
  const rel = String(path || '').replace(/^\.\//, '').trim();
  if (!rel) throw new Error('缺少 path');

  const kind = previewKind(rel, { binary: false }) || (isImagePath(rel) ? 'image' : null);
  const media = mediaKindOf(rel);
  const ext = extOf(rel);

  // —— 图片：元数据 + 交给多模态 ——
  if (kind === 'image' || IMAGE_EXT.has(ext)) {
    let size = 0;
    try {
      const head = await fetch(`/api/fs/raw?path=${encodeURIComponent(rel)}`, { method: 'HEAD' });
      size = Number(head.headers.get('content-length')) || 0;
    } catch {
      /* ignore */
    }
    return {
      path: rel,
      kind: 'image',
      binary: true,
      image: true,
      size,
      content: '',
      note: `图片（${formatBytes(size) || '大小未知'}）。像素会以多模态 image_url 发给视觉模型；请直接看图，不要声称看不到。`,
    };
  }

  // —— PDF ——
  if (kind === 'pdf' || ext === 'pdf') {
    const { buf, size } = await fetchBytes(rel);
    if (buf.byteLength > MAX_OFFICE_BYTES) {
      return {
        path: rel,
        kind: 'pdf',
        binary: true,
        size,
        content: '',
        note: `PDF 过大（${formatBytes(size)}），未整份解析。请在预览面板打开，或换较小文件。`,
      };
    }
    const extracted = await extractPdfLayoutText(buf, { maxPages: 120, maxChars: MAX_EXTRACT });
    return {
      path: rel,
      kind: 'pdf',
      binary: false,
      size,
      truncated: extracted.truncated,
      totalLines: extracted.text.split('\n').length,
      content: extracted.text,
      note: extracted.truncated
        ? `PDF 版面抽字已截断（共 ${extracted.pages} 页）`
        : `已按版面抽取 PDF 文本（${extracted.pages} 页，约 ${extracted.chars} 字符）`,
    };
  }

  // —— Word：mammoth Markdown（版面语义）；失败再回退自研解析 ——
  if (kind === 'docx' || ext === 'docx') {
    const { buf, size } = await fetchBytes(rel);
    if (buf.byteLength > MAX_OFFICE_BYTES) {
      return {
        path: rel,
        kind: 'docx',
        binary: true,
        size,
        content: '',
        note: `Word 过大（${formatBytes(size)}），未整份解析。`,
      };
    }
    try {
      const extracted = await extractDocxMarkdown(buf, { maxChars: MAX_EXTRACT });
      return {
        path: rel,
        kind: 'docx',
        binary: false,
        size,
        truncated: extracted.truncated,
        totalLines: extracted.text.split('\n').length,
        content: extracted.text,
        note: extracted.truncated
          ? `Word（mammoth）已截断`
          : `已用 mammoth 抽取 Word Markdown（约 ${extracted.text.length} 字符）`,
      };
    } catch (err) {
      const doc = await parseOffice(buf, 'docx');
      const { text, truncated } = clipText(officeToText(doc));
      return {
        path: rel,
        kind: 'docx',
        binary: false,
        size,
        truncated,
        totalLines: text.split('\n').length,
        content: text,
        note: `mammoth 失败（${err?.message || err}），已回退自研解析`,
      };
    }
  }

  // —— Excel / PPT ——
  if (kind === 'xlsx' || kind === 'pptx' || ['xlsx', 'pptx'].includes(ext)) {
    const { buf, size } = await fetchBytes(rel);
    if (buf.byteLength > MAX_OFFICE_BYTES) {
      return {
        path: rel,
        kind: kind || ext,
        binary: true,
        size,
        content: '',
        note: `Office 文件过大（${formatBytes(size)}），未整份解析。`,
      };
    }
    const doc = await parseOffice(buf, ext);
    const raw = officeToText(doc);
    const { text, truncated } = clipText(raw);
    const stats = doc.stats ? JSON.stringify(doc.stats) : '';
    return {
      path: rel,
      kind: kind || ext,
      binary: false,
      size,
      truncated,
      totalLines: text.split('\n').length,
      content: text,
      note: truncated
        ? `Office 文本已截断 ${stats}`
        : `已深度解析 ${ext.toUpperCase()}（约 ${text.length} 字符）${stats ? ` ${stats}` : ''}`,
    };
  }

  // —— 旧版 Office ——
  if (kind === 'unsupported') {
    return {
      path: rel,
      kind: 'unsupported',
      binary: true,
      content: '',
      note: `旧版 .doc/.ppt/.xls 是二进制格式，无法在此解析。请另存为 .docx/.pptx/.xlsx 后再读。`,
    };
  }

  // —— 音视频 ——
  if (media || kind === 'video' || kind === 'audio') {
    let size = 0;
    try {
      const head = await fetch(`/api/fs/raw?path=${encodeURIComponent(rel)}`, { method: 'HEAD' });
      size = Number(head.headers.get('content-length')) || 0;
    } catch {
      /* ignore */
    }
    const which = media || kind;
    return {
      path: rel,
      kind: which,
      binary: true,
      size,
      content: [
        `${which === 'video' ? '视频' : '音频'}文件：${rel}`,
        `大小：${formatBytes(size) || '未知'}`,
        `扩展名：.${ext}`,
        '说明：当前对话 API 不能直接「播放」音视频流。请依据文件名、路径、用户描述作答；需要画面/听感时请用户在预览面板打开并口述要点，或改用支持多模态音视频的上游模型。',
      ].join('\n'),
      note: '已返回媒体元数据（非波形/帧像素）',
    };
  }

  // —— CSV：可读文本，顺带结构化摘要 ——
  if (kind === 'csv' || ext === 'csv' || ext === 'tsv') {
    const res = ops ? await ops.readFile(rel) : null;
    let content = res?.content;
    if (content == null) {
      const { buf } = await fetchBytes(rel);
      content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    }
    const table = parseCsv(content);
    const preview = (table.rows || []).slice(0, 40).map((r) => r.join('\t')).join('\n');
    const head = `CSV ${table.rows?.length || 0} 行 × ${table.cols || 0} 列（分隔符 ${table.delimiter === '\t' ? 'Tab' : '逗号'}）\n\n`;
    const { text, truncated } = clipText(head + preview);
    const all = String(content || '').split('\n');
    const start = Math.max(1, Number(offset) || 1);
    const count = Math.max(20, Math.min(1200, Number(limit) || 300));
    // 工具仍可按行返回原文切片，摘要放 note
    const slice = all.slice(start - 1, start - 1 + count);
    return {
      path: rel,
      kind: 'csv',
      binary: false,
      size: res?.size || content.length,
      from: start,
      to: start - 1 + slice.length,
      totalLines: all.length,
      truncated: truncated || start - 1 + slice.length < all.length,
      content: slice.join('\n'),
      summary: text,
      note: `已解析表格结构；下方 content 为第 ${start}-${start - 1 + slice.length} 行原文`,
    };
  }

  // —— 普通文本 / 代码 ——
  if (ops) {
    const res = await ops.readFile(rel);
    if (res.binary) {
      return {
        path: res.path || rel,
        kind: 'binary',
        binary: true,
        size: res.size || 0,
        content: '',
        note: `二进制文件（${formatBytes(res.size) || '未知'}），无文本正文。路径：${res.path || rel}`,
      };
    }
    const all = String(res.content || '').split('\n');
    const start = Math.max(1, Number(offset) || 1);
    const count = Math.max(20, Math.min(1200, Number(limit) || 300));
    const slice = all.slice(start - 1, start - 1 + count);
    return {
      path: res.path || rel,
      kind: 'text',
      binary: false,
      size: res.size || res.content?.length || 0,
      totalLines: all.length,
      from: start,
      to: start - 1 + slice.length,
      truncated: start - 1 + slice.length < all.length || Boolean(res.truncated),
      content: slice.join('\n'),
      note:
        all.length > count
          ? `文件共 ${all.length} 行，本次第 ${start}-${start - 1 + slice.length} 行；继续读请传 offset=${start + slice.length}`
          : res.truncated
            ? '磁盘文件很大，服务端只返回了前缀'
            : undefined,
      fromDisk: Boolean(res.fromDisk),
    };
  }

  throw new Error(`无法读取：${rel}`);
}
