/**
 * ANN 二值索引的落盘格式 —— v3：**支持增量写**
 *
 * 设计目标：改一条记忆只写一条记忆的字节，而不是把 66MB 位图整份重写。
 *
 * ```
 * 0     magic 'CANN'
 * 4     version = 3            u32
 * 8     dim                   u32
 * 12    words                 u32  每行 uint32 个数（512 维 = 16）
 * 16    size                  i32  当前有效行数（末尾可追加）
 * 20    dead                  i32  墓碑数
 * 24    seq                   f64  vec_seq 水位
 * 32    builtAt               f64
 * 40    savedAt               f64
 * 48    crcHeader             u32  头部自校验
 * 52    sigsOff               u32
 * 56    capacity              i32  预留槽位（够尾部追加，不够才扩容重写）
 * 60    blockRows             u16  CRC 分块行数 + u16 保留
 * ---- 64 ----
 * ids     i32 × capacity
 * alive   u8  × capacity
 * (pad 8)
 * crc     u32 × ceil(capacity / blockRows)   每块 sigs 的 CRC32（只覆盖有效行）
 * (pad 8)
 * sigs    u32 × capacity × words
 * ```
 *
 * 三种写：
 *   ① 全量（writeFull）—— 首次 / 扩容 / 压缩：tmp 写入 + rename，原子替换
 *   ② 尾部追加（writeDelta 的 tail 段）—— 新记忆：ids/alive/sigs 依次往末尾写
 *   ③ 就地更新（writeDelta 的 dirty 段）—— 改向量 / 打墓碑：只 pwrite 那几行（sigs 每行 64B）
 *
 * 一致性：CRC 按块（默认 4096 行 = 256KB）存，增量写只重算被碰到的块，
 * 加载时用 zlib.crc32（4.6GB/s）全量校验，坏块即判失败 → 上层整库重建。
 * 也就是说：**这个文件永远只是缓存**，删得掉、坏了也能自愈。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = 'CANN';
const VERSION = 3;
const HEADER = 64;
const BLOCK_ROWS = 4096;
const align8 = (n) => (n + 7) & ~7;

/** 计算各段的偏移（capacity 变了就整体变，所以扩容必须整份重写） */
function layout(capacity, words) {
  const ids = HEADER;
  const alive = ids + capacity * 4;
  const crc = align8(alive + capacity);
  const nBlocks = Math.max(1, Math.ceil(capacity / BLOCK_ROWS));
  const sigs = align8(crc + nBlocks * 4);
  return { ids, alive, crc, sigs, nBlocks, total: sigs + capacity * words * 4 };
}

const crcOf = (buf) => zlib.crc32(buf) >>> 0;

export function annDir(dbPath) {
  const base = path.basename(dbPath).replace(/\.(db|sqlite|sqlite3)$/i, '');
  return path.join(path.dirname(dbPath), 'ann', base);
}

const safeName = (userId) =>
  String(userId)
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80) || 'default';

export function annFile(dbPath, userId, dim) {
  return path.join(annDir(dbPath), `u-${safeName(userId)}-${dim}d.v3.bin`);
}

function buildHeader({ dim, words, size, dead, seq, builtAt, sigsOff, capacity, blockRows }) {
  const head = Buffer.allocUnsafe(HEADER);
  head.write(MAGIC, 0, 4, 'ascii');
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(dim, 8);
  head.writeUInt32LE(words, 12);
  head.writeInt32LE(size, 16);
  head.writeInt32LE(dead, 20);
  head.writeDoubleLE(seq, 24);
  head.writeDoubleLE(builtAt || Date.now(), 32);
  head.writeDoubleLE(Date.now(), 40);
  head.writeUInt32LE(0, 48);
  head.writeUInt32LE(sigsOff, 52);
  head.writeInt32LE(capacity, 56);
  head.writeUInt16LE(blockRows, 60);
  head.writeUInt16LE(0, 62);
  // 头部自校验：0..48 + 56..64（跳过 crc 字段本身）
  head.writeUInt32LE(crcOf(Buffer.concat([head.subarray(0, 48), head.subarray(56, HEADER)])), 48);
  return head;
}

function parseHeader(head, dim, words) {
  if (head.length < HEADER) return { ok: false, reason: '文件过短' };
  if (head.toString('ascii', 0, 4) !== MAGIC) return { ok: false, reason: '魔数不对' };
  const version = head.readUInt32LE(4);
  if (version !== VERSION) return { ok: false, reason: `版本不匹配（${version}≠${VERSION}）` };
  const crcHeader = head.readUInt32LE(48);
  if (crcOf(Buffer.concat([head.subarray(0, 48), head.subarray(56, HEADER)])) !== crcHeader) {
    return { ok: false, reason: '头部校验失败' };
  }
  const fileDim = head.readUInt32LE(8);
  const fileWords = head.readUInt32LE(12);
  if (fileDim !== dim || fileWords !== words) return { ok: false, reason: `维度不匹配（${fileDim}≠${dim}）` };
  const size = head.readInt32LE(16);
  const dead = head.readInt32LE(20);
  const capacity = head.readInt32LE(56);
  const blockRows = head.readUInt16LE(60) || BLOCK_ROWS;
  if (size < 0 || capacity < size) return { ok: false, reason: `头部数值异常（size=${size} capacity=${capacity}）` };
  return {
    ok: true,
    version,
    dim: fileDim,
    words: fileWords,
    size,
    dead,
    seq: head.readDoubleLE(24),
    builtAt: head.readDoubleLE(32),
    savedAt: head.readDoubleLE(40),
    sigsOff: head.readUInt32LE(52),
    capacity,
    blockRows,
  };
}

/**
 * 算某一分块的 CRC，覆盖该块的 **ids + alive + sigs**（只算有效行 size 以内）。
 * 早先只校验 sigs，结果 ids 被改坏也发现不了（id 和签名错位 → 静默返回错误的记忆）。
 * zlib.crc32 支持传上一次的返回值续算，所以三段不用拼成一个 buffer。
 */
function blockCrc(bytes, lay, words, blockRows, block, size) {
  const from = block * blockRows;
  const to = Math.min(size, from + blockRows);
  if (to <= from) return 0;
  const ids = bytes.subarray(lay.ids + from * 4, lay.ids + to * 4);
  const alive = bytes.subarray(lay.alive + from, lay.alive + to);
  const sigs = bytes.subarray(lay.sigs + from * words * 4, lay.sigs + to * words * 4);
  return zlib.crc32(sigs, zlib.crc32(alive, zlib.crc32(ids))) >>> 0;
}

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

/**
 * @returns {{ok:boolean, ids?:Int32Array, alive?:Uint8Array, sigs?:Uint32Array, size?:number,
 *            dead?:number, seq?:number, capacity?:number, bytes?:number, loadMs?:number, reason?:string}}
 */
export function loadAnnFile(dbPath, userId, dim) {
  const t0 = performance.now();
  const file = annFile(dbPath, userId, dim);
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size < HEADER) return { ok: false, reason: '文件过短', path: file };
    const head = Buffer.allocUnsafe(HEADER);
    fs.readSync(fd, head, 0, HEADER, 0);
    const h = parseHeader(head, dim, Math.ceil(dim / 32));
    if (!h.ok) return { ok: false, reason: h.reason, path: file };
    const lay = layout(h.capacity, h.words);
    if (h.sigsOff !== lay.sigs || stat.size < lay.total) {
      return { ok: false, reason: `布局不一致（sigsOff=${h.sigsOff}/${lay.sigs}，size=${stat.size}/${lay.total}）`, path: file };
    }

    // 一次 pread 把整个文件读进共享内存：worker 线程能直接共享这块
    const bytes = new Uint8Array(new SharedArrayBuffer(stat.size));
    let off = 0;
    while (off < stat.size) {
      const n = fs.readSync(fd, bytes, off, stat.size - off, off);
      if (!n) break;
      off += n;
    }
    if (off !== stat.size) return { ok: false, reason: `读取不完整（${off}/${stat.size}）`, path: file };

    const ids = new Int32Array(bytes.buffer, bytes.byteOffset + lay.ids, h.size);
    const alive = new Uint8Array(bytes.buffer, bytes.byteOffset + lay.alive, h.size);
    const sigs = new Uint32Array(bytes.buffer, bytes.byteOffset + lay.sigs, h.size * h.words);
    const crcs = new Uint32Array(bytes.buffer, bytes.byteOffset + lay.crc, lay.nBlocks);

    // 分块校验（zlib.crc32 约 4.6GB/s，66MB 十几毫秒）
    for (let b = 0; b < lay.nBlocks; b += 1) {
      const from = b * h.blockRows;
      if (from >= h.size) break;
      const want = crcs[b];
      const got = blockCrc(bytes, lay, h.words, h.blockRows, b, h.size);
      if (got !== want) return { ok: false, reason: `第 ${b} 块 CRC 校验失败（文件损坏）`, path: file };
    }

    return {
      ok: true,
      ids,
      alive,
      sigs,
      size: h.size,
      dead: h.dead,
      seq: h.seq,
      builtAt: h.builtAt,
      savedAt: h.savedAt,
      capacity: h.capacity,
      bytes: stat.size,
      loadMs: Math.round(performance.now() - t0),
      path: file,
    };
  } catch (err) {
    return { ok: false, reason: `读取失败：${err.message}`, path: file };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 写                                                                  */
/* ------------------------------------------------------------------ */

export class AnnWriter {
  constructor(file, fd, dim, meta) {
    this.file = file;
    this.fd = fd;
    this.dim = dim;
    this.words = Math.ceil(dim / 32);
    this.capacity = meta.capacity;
    this.blockRows = meta.blockRows || BLOCK_ROWS;
    this.layout = layout(this.capacity, this.words);
    this.stats = { full: 0, append: 0, patch: 0, grew: 0, lastMs: 0, lastBytes: 0 };
  }

  /** 打开已有文件（头部校验通过才复用其容量与布局）；失败返回 null */
  static open(dbPath, userId, dim) {
    const file = annFile(dbPath, userId, dim);
    const words = Math.ceil(dim / 32);
    try {
      const fd = fs.openSync(file, 'r+');
      const head = Buffer.allocUnsafe(HEADER);
      fs.readSync(fd, head, 0, HEADER, 0);
      const h = parseHeader(head, dim, words);
      if (!h.ok) {
        fs.closeSync(fd);
        return null;
      }
      return new AnnWriter(file, fd, dim, h);
    } catch {
      return null;
    }
  }

  /** 新建一个空文件（capacity 预留 1.25×，扩容才整份重写） */
  static create(dbPath, userId, dim, sizeHint = 0) {
    const file = annFile(dbPath, userId, dim);
    const words = Math.ceil(dim / 32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const capacity = Math.max(64, Math.ceil(sizeHint * 1.25) + 1024);
    const fd = fs.openSync(file, 'w+');
    const lay = layout(capacity, words);
    fs.ftruncateSync(fd, lay.total);
    const w = new AnnWriter(file, fd, dim, { capacity, blockRows: BLOCK_ROWS, size: 0, dead: 0, seq: 0 });
    // 先把头写进去，保证空文件也是合法的
    w.writeHeader({ size: 0, dead: 0, seq: 0, builtAt: Date.now() });
    return w;
  }

  get total() {
    return layout(this.capacity, this.words).total;
  }

  writeHeader({ size, dead, seq, builtAt }) {
    const lay = layout(this.capacity, this.words);
    const head = buildHeader({
      dim: this.dim,
      words: this.words,
      size,
      dead,
      seq,
      builtAt,
      sigsOff: lay.sigs,
      capacity: this.capacity,
      blockRows: this.blockRows,
    });
    fs.writeSync(this.fd, head, 0, HEADER, 0);
  }

  /**
   * 全量写：首次、扩容、压缩都走它（tmp + rename 保证原子）。
   * headroom 是给「尾部追加」留的余量：默认 8%（1M 条 → 文件 66MB → 71MB），
   * 溢出后按 25% 重写一次，摊下来每次追加几乎都不用再重写。
   */
  writeFull({ ids, alive, sigs, size, dead, seq, builtAt, headroom = 0.08 }) {
    const t0 = performance.now();
    const words = this.words;
    const capacity = Math.max(64, Math.ceil(size * (1 + headroom)) + 1024);
    const lay = layout(capacity, words);
    const body = Buffer.allocUnsafe(lay.total);
    body.fill(0);
    const head = buildHeader({
      dim: this.dim,
      words,
      size,
      dead,
      seq,
      builtAt,
      sigsOff: lay.sigs,
      capacity,
      blockRows: this.blockRows,
    });
    head.copy(body, 0);
    Buffer.from(ids.buffer, ids.byteOffset, size * 4).copy(body, lay.ids);
    Buffer.from(alive.buffer, alive.byteOffset, size).copy(body, lay.alive);
    Buffer.from(sigs.buffer, sigs.byteOffset, size * words * 4).copy(body, lay.sigs);
    const crcs = new Uint32Array(lay.nBlocks);
    for (let b = 0; b < lay.nBlocks; b += 1) crcs[b] = blockCrc(body, lay, words, this.blockRows, b, size);
    Buffer.from(crcs.buffer, crcs.byteOffset, crcs.byteLength).copy(body, lay.crc);

    const tmp = `${this.file}.tmp-${process.pid}`;
    const tfd = fs.openSync(tmp, 'w');
    try {
      let off = 0;
      while (off < body.length) off += fs.writeSync(tfd, body, off, body.length - off, off);
    } finally {
      fs.closeSync(tfd);
    }
    // rename 会替换掉旧 inode，所以要重开 fd
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
    fs.renameSync(tmp, this.file);
    this.fd = fs.openSync(this.file, 'r+');
    this.capacity = capacity;
    this.layout = lay;
    this.stats.full += 1;
    this.stats.lastMs = Math.round(performance.now() - t0);
    this.stats.lastBytes = body.length;
    return { ok: true, mode: 'full', bytes: body.length, ms: this.stats.lastMs };
  }

  /**
   * 增量写：只碰变化的那几行。
   * @param {object} p
   * @param {number[]} p.dirtyRows 已存在但内容变了的行号（改向量 / 打墓碑）
   * @param {Int32Array} p.ids
   * @param {Uint8Array} p.alive
   * @param {Uint32Array} p.sigs
   * @param {number} p.persistedSize 文件里当前认为有效的行数
   * @param {number} p.size 索引里的最新行数（> persistedSize 的部分要尾部追加）
   */
  writeDelta({ dirtyRows = [], ids, alive, sigs, persistedSize, size, dead, seq }) {
    const t0 = performance.now();
    if (size > this.capacity) return { ok: false, reason: 'grow', need: size };
    const words = this.words;
    const lay = layout(this.capacity, words);
    const touchedBlocks = new Set();

    // ① 已存在的行：只 pwrite 那一行的 sigs（64B）与 alive（1B）
    const rows = [];
    for (const r of dirtyRows) if (r >= 0 && r < persistedSize) rows.push(r);
    rows.sort((a, b) => a - b);
    let bytesWritten = 0;
    for (let i = 0; i < rows.length; ) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j += 1;
      const from = rows[i];
      const to = rows[j] + 1;
      // ⚠️ sigs 是 Uint32Array：行偏移要换算成字节（×4），否则写错位置、CRC 立刻炸
      const sigBuf = Buffer.from(sigs.buffer, sigs.byteOffset + from * words * 4, (to - from) * words * 4);
      bytesWritten += fs.writeSync(this.fd, sigBuf, 0, sigBuf.length, lay.sigs + from * words * 4);
      const aliveBuf = Buffer.from(alive.buffer, alive.byteOffset + from, to - from);
      bytesWritten += fs.writeSync(this.fd, aliveBuf, 0, aliveBuf.length, lay.alive + from);
      for (let b = Math.floor(from / this.blockRows); b <= Math.floor((to - 1) / this.blockRows); b += 1) touchedBlocks.add(b);
      i = j + 1;
    }
    this.stats.patch += rows.length;

    // ② 新行：ids / alive / sigs 依次追加到末尾（连续一段，各一次 pwrite）
    if (size > persistedSize) {
      const from = persistedSize;
      const count = size - from;
      const idBuf = Buffer.from(ids.buffer, ids.byteOffset + from * 4, count * 4);
      fs.writeSync(this.fd, idBuf, 0, idBuf.length, lay.ids + from * 4);
      const aliveBuf = Buffer.from(alive.buffer, alive.byteOffset + from, count);
      fs.writeSync(this.fd, aliveBuf, 0, aliveBuf.length, lay.alive + from);
      const sigBuf = Buffer.from(sigs.buffer, sigs.byteOffset + from * words * 4, count * words * 4);
      fs.writeSync(this.fd, sigBuf, 0, sigBuf.length, lay.sigs + from * words * 4);
      bytesWritten += idBuf.length + aliveBuf.length + sigBuf.length;
      for (let b = Math.floor(from / this.blockRows); b <= Math.floor((size - 1) / this.blockRows); b += 1) touchedBlocks.add(b);
      this.stats.append += count;
    }

    // ③ 重算被碰到的块的 CRC（覆盖 ids + alive + sigs），写回那 4 字节。
    //    这里直接按「内存里的最新数组」算，等价于读回文件再算，但不用再读一遍。
    if (touchedBlocks.size) {
      const idsBytes = new Uint8Array(ids.buffer, ids.byteOffset, size * 4);
      const aliveBytes = new Uint8Array(alive.buffer, alive.byteOffset, size);
      const sigsBytes = new Uint8Array(sigs.buffer, sigs.byteOffset, size * words * 4);
      const crcBuf = Buffer.allocUnsafe(4);
      for (const b of touchedBlocks) {
        const from = b * this.blockRows;
        const to = Math.min(size, from + this.blockRows);
        let crc = zlib.crc32(idsBytes.subarray(from * 4, to * 4));
        crc = zlib.crc32(aliveBytes.subarray(from, to), crc);
        crc = zlib.crc32(sigsBytes.subarray(from * words * 4, to * words * 4), crc);
        crcBuf.writeUInt32LE(crc >>> 0, 0);
        fs.writeSync(this.fd, crcBuf, 0, 4, lay.crc + b * 4);
        bytesWritten += 4;
      }
    }

    // ④ 头部（size / dead / seq / savedAt）
    this.writeHeader({ size, dead, seq, builtAt: Date.now() });

    this.stats.lastMs = Math.round((performance.now() - t0) * 100) / 100;
    this.stats.lastBytes = bytesWritten;
    return { ok: true, mode: 'delta', rows: rows.length, appended: Math.max(0, size - persistedSize), bytes: bytesWritten, ms: this.stats.lastMs };
  }

  close() {
    try {
      fs.closeSync(this.fd);
      return true;
    } catch {
      return false;
    }
  }
}

export function deleteAnnFile(dbPath, userId, dim) {
  try {
    fs.rmSync(annFile(dbPath, userId, dim), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function annFileInfo(dbPath, userId, dim) {
  try {
    const file = annFile(dbPath, userId, dim);
    const st = fs.statSync(file);
    return { path: file, bytes: st.size, savedAt: st.mtimeMs };
  } catch {
    return null;
  }
}

export { HEADER as ANN_HEADER, BLOCK_ROWS as ANN_BLOCK_ROWS };
