/**
 * ANN 粗筛的工作线程：把 1M × 512bit 的 Hamming 扫描劈成两半，主线程和这个线程各扫一半。
 *
 * 输入全是共享内存（SharedArrayBuffer），不拷贝 64MB 的位图：
 *   sigs  —— 位索引平铺的 Uint32Array
 *   dist  —— 粗筛距离输出（Uint16Array，每条一个数）
 *   hist  —— 本线程负责那一段的距离直方图
 * 干完把 done 置 1 并 notify，主线程用 Atomics.wait 同步等（Node 主线程允许阻塞等待）。
 */
import { parentPort } from 'node:worker_threads';

const PC8 = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) PC8[i] = (i & 1) + PC8[i >> 1];
const PC16 = new Uint8Array(65536);
for (let i = 0; i < 65536; i += 1) PC16[i] = PC8[i & 255] + PC8[i >>> 8];

parentPort.on('message', (m) => {
  try {
    const sigs = new Uint32Array(m.sigs);
    const alive = new Uint8Array(m.alive);
    const dist = new Uint16Array(m.dist);
    const hist = new Uint32Array(m.hist);
    const done = new Int32Array(m.done);
    const q = new Uint32Array(m.q);
    const { W, cw, start, end } = m;
    hist.fill(0);
    for (let r = start; r < end; r += 1) {
      if (!alive[r]) continue;
      const base = r * W;
      let d = 0;
      for (let k = 0; k < cw; k += 2) {
        const x = sigs[base + k] ^ q[k];
        const y = sigs[base + k + 1] ^ q[k + 1];
        d += PC16[x & 65535] + PC16[x >>> 16] + PC16[y & 65535] + PC16[y >>> 16];
      }
      dist[r] = d;
      hist[d] += 1;
    }
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
  } catch (err) {
    try {
      const done = new Int32Array(m.done);
      Atomics.store(done, 0, 2); // 2 = 出错，主线程自己兜底
      Atomics.notify(done, 0);
    } catch {
      /* 连错误都写不进去就让它超时兜底 */
    }
    parentPort.postMessage({ error: String(err && err.message) });
  }
});
