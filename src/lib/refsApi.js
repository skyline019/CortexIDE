/**
 * 引用的取数层：把「路径」变成「带正文的 ref」。
 *
 * 这里只做两件事 —— 调服务端、把结果整理成 context-refs.js 认识的形状；
 * 排序/预算/截断那些判断全在纯函数里，方便单测。
 */
import { makeRef } from './context-refs.js';
import { readAnyFile } from './read-any.js';
import { isImagePath } from './vision.js';
import { mediaKindOf } from './media.js';

const fileCache = { at: 0, files: [], pending: null };

/** 工作区文件清单（扁平路径）。缓存 30 秒，@ 面板每次打字不用重新走一遍磁盘。 */
export async function listWorkspaceFiles({ refresh = false } = {}) {
  const fresh = Date.now() - fileCache.at < 30_000;
  if (!refresh && fresh && fileCache.files.length) return fileCache.files;
  if (fileCache.pending) return fileCache.pending;
  fileCache.pending = fetch('/api/fs/files?limit=4000')
    .then((r) => r.json())
    .then((j) => {
      fileCache.files = Array.isArray(j.files) ? j.files : [];
      fileCache.at = Date.now();
      return fileCache.files;
    })
    .catch(() => fileCache.files || [])
    .finally(() => {
      fileCache.pending = null;
    });
  return fileCache.pending;
}

export function invalidateWorkspaceFiles() {
  fileCache.at = 0;
}

/** 读一个工作区文件 → ref（读不到就返回带 error 的 ref，界面上标红比静默消失好） */
export async function loadFileRef(path, { origin = 'mention' } = {}) {
  try {
    const r = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
    const j = await r.json();
    if (!r.ok) return makeRef({ type: 'file', path, name: path.split('/').pop(), origin, extra: { error: j.error || '读取失败' } });
    return makeRef({
      type: 'file',
      path: j.path || path,
      name: (j.path || path).split('/').pop(),
      content: j.content || '',
      binary: Boolean(j.binary),
      size: j.size,
      origin,
    });
  } catch (err) {
    return makeRef({ type: 'file', path, name: String(path).split('/').pop(), origin, extra: { error: err.message } });
  }
}

/** 本地文件 → 上传落盘 → ref。真写盘，刷新后还在。 */
export async function uploadAttachment(file) {
  const name = file.name || 'file';
  const r = await fetch(`/api/attach?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || '上传失败');
  return makeRef({
    type: 'attach',
    path: j.path,
    name: j.name,
    content: j.preview || '',
    binary: j.binary,
    size: j.size,
    origin: 'upload',
    extra: { previewOnly: (j.chars || 0) > (j.preview || '').length, chars: j.chars, lines: j.lines },
  });
}

/**
 * 附件上传成功后服务端只回前 1200 字符的预览。
 * 真要当上下文用，就得把完整内容读回来（不然模型只看到开头，界面还装作全带上了）。
 */
export async function hydrateRef(ref) {
  if (ref.type !== 'attach' || ref.binary || !ref.previewOnly) return ref;
  const full = await loadFileRef(ref.path, { origin: ref.origin });
  return { ...ref, content: full.content, chars: full.chars, lines: full.lines, previewOnly: false, error: full.error };
}

export async function listAttachments() {
  try {
    const r = await fetch('/api/attach');
    const j = await r.json();
    return Array.isArray(j.files) ? j.files : [];
  } catch {
    return [];
  }
}

export async function deleteAttachment(path) {
  const r = await fetch(`/api/attach?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  return r.json();
}

export function makeMemoryRef(memory) {
  return makeRef({
    type: 'memory',
    path: `memory:${memory.id}`,
    name: memory.text?.slice(0, 40) || '记忆',
    content: '',
    origin: 'mention',
    extra: { memory },
  });
}

export function makeSkillRef(skill) {
  return makeRef({
    type: 'skill',
    path: `skill:${skill.id}`,
    name: skill.name || skill.id,
    content: '',
    origin: 'mention',
    extra: { skill },
  });
}

/**
 * 发送前把正文里的 @提及 兑现成真正的 ref。
 * 已经被拖进来/点进来的同一个文件不会重复读取；读不到的路径返回带 error 的 ref，
 * 由界面标红、由上下文块如实写明「读取失败」，而不是悄悄当不存在。
 */
export async function resolveMentionsInText(text, existing = [], parseFn) {
  const mentions = (parseFn || (await import('./context-refs.js')).parseMentions)(text);
  const byPath = new Map(existing.map((r) => [r.path, r]));
  const extra = [];
  const missing = [];
  for (const m of mentions) {
    if (byPath.has(m.path)) continue;
    const ref = await loadFileRef(m.path, { origin: 'mention' });
    if (ref.error) missing.push(m.path);
    byPath.set(m.path, ref);
    extra.push(ref);
  }
  return { refs: [...existing, ...extra], extra, missing };
}

/**
 * 发送前把 PDF/Office 等抽成文本，图片留给多模态，音视频补元数据。
 * 这样 buildContextBlock 不再只剩「二进制未附正文」。
 */
export async function enrichRefsForSend(refs = [], ops = null) {
  const out = [];
  for (const ref of refs || []) {
    if (!ref?.path || ref.error) {
      out.push(ref);
      continue;
    }
    if (isImagePath(ref.path)) {
      out.push(ref);
      continue;
    }
    if (mediaKindOf(ref.path)) {
      try {
        const got = await readAnyFile(ref.path, { ops });
        out.push({
          ...ref,
          binary: true,
          content: got.content || '',
          chars: (got.content || '').length,
          size: got.size || ref.size,
          extra: { ...(ref.extra || {}), kind: got.kind },
        });
      } catch (err) {
        out.push({ ...ref, error: err.message });
      }
      continue;
    }
    // 已有正文的文本引用不用再抽
    if (!ref.binary && ref.content) {
      out.push(ref);
      continue;
    }
    try {
      const got = await readAnyFile(ref.path, { ops });
      if (got.image) {
        out.push({ ...ref, binary: true, size: got.size || ref.size });
        continue;
      }
      out.push({
        ...ref,
        binary: Boolean(got.binary) && !got.content,
        content: got.content || ref.content || '',
        chars: (got.content || '').length,
        lines: got.totalLines || ref.lines,
        size: got.size || ref.size,
        error: undefined,
      });
    } catch (err) {
      out.push({ ...ref, error: err.message });
    }
  }
  return out;
}
