/**
 * 多模态（视觉）辅助：把工作区图片读成 OpenAI / DeepSeek 兼容的 image_url 内容块。
 *
 * DeepSeek：deepseek-flash（及 vision 兼容名）支持图；deepseek-chat / reasoner 是纯文本。
 * 其它厂商：模型名含 gpt-4o / claude / gemini / vision / vl 等视为支持。
 */
import { IMAGE_EXT, extOf } from './preview-kind.js';

/** 单张进请求体的上限（base64 会再膨胀 ~33%；总请求还有上游限制） */
export const MAX_VISION_BYTES = Number(
  (typeof process !== 'undefined' && process.env?.CORTEX_MAX_VISION_BYTES) || 12 * 1024 * 1024,
);

const TEXT_ONLY = /^(deepseek-chat|deepseek-reasoner|deepseek-v4-pro)$/i;
const VISION_HINT =
  /(flash|vision|vl\b|gpt-4o|gpt-5|claude-3|claude-4|gemini|qwen[-_.]?vl|glm-4v|step-1v)/i;

export function isImagePath(path) {
  return IMAGE_EXT.has(extOf(path));
}

export function mimeForImage(path) {
  const ext = extOf(path);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'ico') return 'image/x-icon';
  if (ext === 'avif') return 'image/avif';
  return 'application/octet-stream';
}

/** 启发式：当前模型是否吃得下 image_url */
export function modelSupportsVision(model = '') {
  const m = String(model || '').trim();
  if (!m) return false;
  if (TEXT_ONLY.test(m)) return false;
  if (VISION_HINT.test(m)) return true;
  // 未知模型：仍尝试发图（兼容网关）；失败由上游报错
  return true;
}

/** 带图时若当前是 DeepSeek 纯文本模型，自动改用 flash */
export function resolveVisionModel(model = '') {
  const m = String(model || 'deepseek-chat').trim() || 'deepseek-chat';
  if (TEXT_ONLY.test(m) || /^deepseek-chat/i.test(m) || /^deepseek-reasoner/i.test(m)) {
    return { model: 'deepseek-flash', switched: true, from: m };
  }
  return { model: m, switched: false, from: m };
}

function bufToBase64(buf) {
  if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64');
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 从工作区路径加载一张图 → { type:'image_url', image_url:{ url } } 或 { error }
 */
export async function loadImagePart(path, { maxBytes = MAX_VISION_BYTES, detail = 'auto' } = {}) {
  const rel = String(path || '').trim();
  if (!rel) return { error: '空路径' };
  if (!isImagePath(rel)) return { error: `不是图片扩展名：${rel}` };
  try {
    const res = await fetch(`/api/fs/raw?path=${encodeURIComponent(rel)}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { error: j.error || `HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return { error: '空文件' };
    if (buf.byteLength > maxBytes) {
      return {
        error: `图片 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB 超过视觉发送上限 ${Math.round(maxBytes / 1024 / 1024)}MB`,
      };
    }
    const b64 = bufToBase64(buf);
    const mime = mimeForImage(rel);
    return {
      part: {
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}`, detail },
      },
      size: buf.byteLength,
      path: rel,
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

/** 文本 + 若干 image part → OpenAI content（纯文本时仍返回 string，少踩兼容坑） */
export function buildUserContent(text, imageParts = []) {
  const parts = (imageParts || []).filter(Boolean);
  const body = String(text || '').trim() || (parts.length ? '请查看上面的图片。' : '');
  if (!parts.length) return body;
  return [{ type: 'text', text: body }, ...parts];
}

/** 从 refs 里挑出图片路径（附件 / 文件引用） */
export function imagePathsFromRefs(refs = []) {
  const out = [];
  const seen = new Set();
  for (const r of refs || []) {
    if (!r?.path || r.error) continue;
    if (!isImagePath(r.path)) continue;
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(r.path);
  }
  return out;
}
