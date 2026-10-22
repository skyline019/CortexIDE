/**
 * 精确 token 估算器（用于压缩前后计量 + 预算控制）
 *
 * 为什么要自己算：DeepSeek 没有公开 tokenizer 接口，而每次请求的 usage 只有在
 * 流结束后才拿得到 —— 想「先压缩到预算内再发」就必须在本地提前知道 token 数。
 *
 * 做法：不硬编码拍脑袋的系数，而是用**真实返回的 usage.prompt_tokens** 在线做
 * 最小二乘拟合（带岭正则，防止样本少时系数飘）：
 *
 *   tokens ≈ a·汉字数 + b·拉丁字符数 + c·标点数 + d·换行数 + e·（每条消息固定开销）
 *
 * 每次请求结束都会拿到 (本地上一次估的特征向量, 上游真实 prompt_tokens) 这一对样本，
 * 累加进正规方程 A^T A / A^T y，然后解 5×5 线性方程组。样本 < 8 时用经验初值，
 * 之后自动收敛。界面里会显示「平均绝对误差」，估算飘了能一眼看出来。
 *
 * 校准数据放在 .cortex/tokenizer.json —— 纯派生物，删掉会退回经验初值重学。
 */
import fs from 'node:fs';
import path from 'node:path';

// 出厂权重不是拍脑袋估的：用 15 段真实语料（README/源码/CSS/JSON/JSX/日志/中文注释）
// 直连 api.deepseek.com 量 prompt_tokens 做最小二乘拟合，见 scripts/bench-tokenizer.mjs。
// 字符类模型的极限就在这里：留一交叉验证 ≈15%，别在 UI 上吹「精确」。
const DEFAULT_W = {
  cjk: 0.95, // 汉字/假名/韩文
  latin: 0.32, // 英文字母/数字/标识符
  punct: 0.45, // 自然语言标点
  newline: 0.1,
  struct: 1.05, // JSON 结构符 { } [ ] " : , < > 在工具回传里非常密
  perMsg: 4.2, // 每条消息的角色标记 + 分隔符
};
const KEYS = ['cjk', 'latin', 'punct', 'newline', 'struct'];
const MIN_SAMPLES = 8;
const RIDGE = 30; // 岭正则强度：样本少时把系数往初值方向拉

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/;

/** 把文本拆成 4 个计数特征 */
export function features(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let latin = 0;
  let punct = 0;
  let newline = 0;
  let struct = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\n') newline += 1;
    else if (CJK.test(ch)) cjk += 1;
    else if (ch === ' ' || ch === '\t') continue; // 空格基本被合并，忽略
    else if (/[A-Za-z0-9_$]/.test(ch)) latin += 1;
    else if ('{}[]":,<>'.includes(ch)) struct += 1; // JSON / 代码结构符
    else punct += 1;
  }
  return [cjk, latin, punct, newline, struct];
}

/** n 元线性方程组求解（高斯-约当，带部分主元） */
function solveN(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-9) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col];
    for (let c = col; c <= n; c += 1) M[col][c] /= p;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

export function createTokenizer({ file = null } = {}) {
  const state = {
    file,
    w: { ...DEFAULT_W },
    n: 0, // 样本数
    ata: Array.from({ length: KEYS.length + 1 }, () => new Array(KEYS.length + 1).fill(0)),
    aty: new Array(KEYS.length + 1).fill(0),
    absErrSum: 0,
    relErrSum: 0,
    lastPredict: 0,
    lastActual: 0,
    updatedAt: 0,
  };

  const load = () => {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Number.isFinite(j.n)) {
        state.n = j.n;
        state.w = { ...DEFAULT_W, ...j.w };
        state.ata = j.ata;
        state.aty = j.aty;
        state.absErrSum = j.absErrSum || 0;
        state.relErrSum = j.relErrSum || 0;
        state.updatedAt = j.updatedAt || 0;
      }
    } catch {
      /* 没有就是没学过，用初值 */
    }
  };
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify(
          { w: state.w, n: state.n, ata: state.ata, aty: state.aty, absErrSum: state.absErrSum, relErrSum: state.relErrSum, updatedAt: state.updatedAt },
          null,
          0,
        ),
      );
    } catch {
      /* 缓存写不了不影响主流程 */
    }
  };
  load();

  /** 文本 → token 估算 */
  const estimate = (text) => {
    const f = features(text);
    const w = state.w;
    return f[0] * w.cjk + f[1] * w.latin + f[2] * w.punct + f[3] * w.newline + f[4] * w.struct;
  };

  /**
   * 整段 messages → token 估算（含角色/分隔符固定开销与 JSON 结构开销）
   * 返回 { total, byIndex: number[] }
   */
  const estimateMessages = (messages, extraText = '') => {
    const byIndex = [];
    let total = extraText ? estimate(extraText) + state.w.perMsg : 0; // tools / response_format 之类也要算进去
    for (const m of messages || []) {
      const parts = [typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')];
      for (const c of m.tool_calls || []) parts.push(c.function?.name || '', c.function?.arguments || '');
      const t = estimate(parts.join('\n')) + state.w.perMsg;
      byIndex.push(t);
      total += t;
    }
    return { total, byIndex };
  };

  /** 把一个真实样本喂进正规方程 */
  const observe = (featVec, actual) => {
    if (!Number.isFinite(actual) || actual <= 0) return;
    const x = [...featVec, 1]; // 最后一维固定为 1（每条消息开销 → 常数项）
    const n = x.length;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) state.ata[i][j] += x[i] * x[j];
      state.aty[i] += x[i] * actual;
    }
    state.n += 1;
    // 岭正则：往初值方向拉
    const prior = [...KEYS.map((k) => DEFAULT_W[k]), DEFAULT_W.perMsg];
    const A = state.ata.map((row, i) => row.map((v, j) => (i === j ? v + RIDGE : v)));
    const b = state.aty.map((v, i) => v + RIDGE * prior[i]);
    const w = solveN(A, b);
    if (w && w.every((v) => Number.isFinite(v) && v > 0.02 && v < 3)) {
      state.w = { ...Object.fromEntries(KEYS.map((k, i) => [k, w[i]])), perMsg: w[KEYS.length] };
    }
    if (state.lastPredict) {
      state.absErrSum += Math.abs(state.lastPredict - actual) / actual;
      state.relErrSum += (state.lastPredict - actual) / actual;
    }
    state.lastActual = actual;
    state.updatedAt = Date.now();
    if (state.n % 5 === 0) save();
  };

  /** 累计整段 messages 的特征向量，供 observe 使用 */
  const featuresOfMessages = (messages) => {
    const agg = KEYS.map(() => 0);
    let count = 0;
    for (const m of messages || []) {
      const parts = [typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')];
      for (const c of m.tool_calls || []) parts.push(c.function?.name || '', c.function?.arguments || '');
      const f = features(parts.join('\n'));
      for (let i = 0; i < KEYS.length; i += 1) agg[i] += f[i];
      count += 1;
    }
    return { agg, count };
  };

  const rememberPrediction = (predicted) => {
    state.lastPredict = predicted;
  };

  const stats = () => ({
    samples: state.n,
    calibrated: state.n >= MIN_SAMPLES,
    weights: Object.fromEntries(Object.entries(state.w).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    meanAbsErr: state.n ? Math.round((state.absErrSum / state.n) * 1000) / 10 : null, // %
    meanSignedErr: state.n ? Math.round((state.relErrSum / state.n) * 1000) / 10 : null, // %（正=高估）
    lastPredict: Math.round(state.lastPredict),
    lastActual: state.lastActual,
    updatedAt: state.updatedAt,
  });

  /** 校准用的观测：真实 usage 回来后，用「发送时那版 messages」的特征喂进去 */
  const observeMessages = (messages, actual, extraText = '') => {
    const { agg } = featuresOfMessages(messages);
    if (extraText) {
      const f = features(extraText);
      for (let i = 0; i < KEYS.length; i += 1) agg[i] += f[i];
    }
    observe(agg, actual);
    save();
  };

  return { estimate, estimateMessages, observe, observeMessages, featuresOfMessages, rememberPrediction, stats, save };
}
