/**
 * 极简 ZIP 读取器（零依赖）—— docx / xlsx / pptx 本质就是一个 zip 包。
 *
 * 只做「读」：解析中央目录（EOCD → central directory → local header），
 * 压缩方式 0（store）直接拿，8（deflate）用浏览器/Node 都自带的 DecompressionStream('deflate-raw') 解。
 * 不做写、不做加密、不支持 zip64 —— 遇到就直接报错说明原因，不假装成功。
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const u16 = (dv, off) => dv.getUint16(off, true);
const u32 = (dv, off) => dv.getUint32(off, true);

/** 从尾部往前找 EOCD（注释最长 64KB） */
function findEocd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (u32(dv, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 解析 zip 的目录结构。
 * @param {Uint8Array} bytes
 * @returns {{name:string, method:number, compressedSize:number, size:number, offset:number}[]}
 */
export function listEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录结尾）');
  const count = u16(dv, eocd + 10);
  const cenOffset = u32(dv, eocd + 16);
  if (cenOffset === 0xffffffff) throw new Error('暂不支持 zip64（超大文件）');

  const entries = [];
  let p = cenOffset;
  for (let n = 0; n < count; n += 1) {
    if (u32(dv, p) !== CEN_SIG) break;
    const method = u16(dv, p + 10);
    const compressedSize = u32(dv, p + 20);
    const size = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const offset = u32(dv, p + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持 DecompressionStream，无法解压');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * 读取 zip 里某个文件的原始字节。
 * @param {Uint8Array} bytes 整个 zip
 * @param {{method:number, compressedSize:number, offset:number}} entry
 */
export async function readEntry(bytes, entry) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u32(dv, entry.offset) !== LOC_SIG) throw new Error(`本地文件头损坏：${entry.name}`);
  const nameLen = u16(dv, entry.offset + 26);
  const extraLen = u16(dv, entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}（${entry.name}）`);
}

/**
 * 一次性读成 Map<路径, 文本>，只取给定后缀的文件（docx/xlsx 里 XML 都不大）。
 * @param {Uint8Array} bytes
 * @param {(name:string)=>boolean} filter
 */
export async function readTextEntries(bytes, filter) {
  const entries = listEntries(bytes).filter((e) => filter(e.name));
  const out = new Map();
  for (const e of entries) {
    out.set(e.name, new TextDecoder('utf-8').decode(await readEntry(bytes, e)));
  }
  return out;
}
