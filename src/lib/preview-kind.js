/**
 * 预览分发规则（纯函数，单独放 lib 里方便单测）。
 *
 * 判定的顺序很重要：先看扩展名，再退回「是不是二进制」。
 * 早先只看 binary 标志，结果 pdf/docx 点开是一个空编辑器。
 */

import { mediaKindOf } from './media.js';

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

export const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'htm', 'xml',
  'vue', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml',
  'ini', 'env', 'sql', 'rb', 'php', 'kt', 'swift', 'cs', 'lua', 'txt', 'log', 'conf',
]);

export const extOf = (path) => {
  const base = String(path || '').split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
};

/**
 * @returns {'image'|'video'|'audio'|'pdf'|'docx'|'xlsx'|'pptx'|'csv'|'markdown'|'unsupported'|'binary'|null}
 *   null = 用代码编辑器打开
 */
export function previewKind(path, file) {
  const ext = extOf(path);
  if (IMAGE_EXT.has(ext)) return 'image';
  // 音视频排在 binary 之前：不然它们会掉进「二进制文件，暂不支持预览」那个兜底
  const media = mediaKindOf(path);
  if (media) return media;
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  // 旧版二进制 Office 格式：解析不了，但也不能当文本打开，如实说明
  if (ext === 'doc' || ext === 'ppt' || ext === 'xls') return 'unsupported';
  if (file?.binary) return 'binary';
  return null;
}

/** 二进制 / 预览类文件的「语言名」，用在面包屑上 */
export const KIND_LABEL = {
  image: '图片',
  video: '视频',
  audio: '音频',
  pdf: 'PDF',
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  pptx: 'PPT 演示',
  csv: 'CSV 表格',
  markdown: 'Markdown',
  unsupported: '旧版 Office',
  binary: '二进制',
};
