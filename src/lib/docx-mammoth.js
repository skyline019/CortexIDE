/**
 * Word → Markdown：mammoth（成熟引擎）
 * 预览仍用 docx-preview 做版面；Agent / 引用走这里拿结构化文本。
 */

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote:separator('\\n')",
  "p[style-name='Block Text'] => blockquote:separator('\\n')",
  "p[style-name='Intense Quote'] => blockquote:separator('\\n')",
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='Source Code'] => pre:separator('\\n')",
  "p[style-name='HTML Code'] => pre:separator('\\n')",
  "p[style-name='Plain Text'] => pre:separator('\\n')",
  "p[style-name='代码'] => pre:separator('\\n')",
  "p[style-name='源代码'] => pre:separator('\\n')",
  "r[style-name='Code Char'] => code",
  "r[style-name='HTML Code Char'] => code",
  "r[style-name='Strong'] => strong",
  "r[style-name='Emphasis'] => em",
];

function mammothInput(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Node mammoth 认 buffer；浏览器认 arrayBuffer
  if (typeof Buffer !== 'undefined') {
    return { buffer: Buffer.from(u8) };
  }
  const ab =
    u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
      ? u8.buffer
      : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return { arrayBuffer: ab };
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{maxChars?: number}} [opts]
 * @returns {Promise<{text:string, messages:string[], engine:string, truncated:boolean}>}
 */
export async function extractDocxMarkdown(bytes, { maxChars = 400_000 } = {}) {
  const mammoth = await import('mammoth');
  const api = mammoth.default || mammoth;
  const result = await api.convertToMarkdown(mammothInput(bytes), {
    styleMap: STYLE_MAP,
    includeDefaultStyleMap: true,
    ignoreEmptyParagraphs: false,
  });
  let text = String(result.value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  // mammoth 的 pre 有时变成缩进块；把连续缩进行收成 fenced code，便于模型识别
  text = promoteIndentedCode(text);

  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n…（已截断，原文约 ${text.length} 字符）`;
    truncated = true;
  }
  const messages = (result.messages || []).map((m) => m.message || String(m)).filter(Boolean);
  return { text, messages, engine: 'mammoth', truncated };
}

/** 把连续 4+ 空格缩进段落收成 ``` 代码块（mammoth 对 pre 的常见输出） */
function promoteIndentedCode(md) {
  const lines = md.split('\n');
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const body = buf.map((l) => l.replace(/^ {4}/, '')).join('\n');
    out.push('```', body, '```');
    buf = [];
  };
  for (const line of lines) {
    if (/^ {4,}\S/.test(line) || (buf.length && /^ {4}/.test(line))) {
      buf.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}
