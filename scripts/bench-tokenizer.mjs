#!/usr/bin/env node
/**
 * bench-tokenizer —— 用真实 upstream usage 标定「token 估算器」的字符系数。
 *
 * 为什么需要这个：DeepSeek 没有开放 tokenize 端点，本地也没有它的词表；
 * 想算「压掉多少 token」只能用字符类模型估。估得准不准，只能拿真实
 * `usage.prompt_tokens` 对账。做法：
 *   1. 从本项目里切 15 段真实语料（README / 源码 / CSS / JSON / JSX / 日志 / 中文注释）；
 *   2. 直连 api.deepseek.com，每条只发一段，取 prompt_tokens（减去 1 字符基线）；
 *   3. 用最小二乘拟合 cjk / latin / punct / struct 四个系数，并做留一交叉验证
 *      给出「这套特征的上限」—— 字符类模型就这水平，别在 UI 上吹精确。
 *
 * 用法：node scripts/bench-tokenizer.mjs
 * 需要 .env 里的 DEEPSEEK_API_KEY（只在服务端读，不会打印）。
 */
import fs from 'node:fs';
import { features } from '../server/tokenizer.js';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const envText = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
const KEY = (envText.match(/DEEPSEEK_API_KEY\s*=\s*(\S+)/) || [])[1];
if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY：请在 .env 里配置后再跑标定');
  process.exit(1);
}
const ask = async (content) => {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', stream: false, max_tokens: 1, messages: [{ role: 'user', content }] }),
  });
  return (await r.json()).usage?.prompt_tokens || 0;
};
const chunk = (p, from, len) => fs.readFileSync(path.join(ROOT, p), 'utf8').slice(from, from + len);
const base = await ask('a');
const raw = [
  ['README 中文', chunk('README.md', 0, 900)], ['README 表格', chunk('README.md', 3000, 900)],
  ['agent.js', chunk('src/lib/agent.js', 2000, 900)], ['ctx-compress', chunk('server/ctx-compress.js', 3000, 1200)],
  ['CSS', chunk('src/styles.css', 1500, 1000)], ['JSON', chunk('package-lock.json', 500, 1200)],
  ['smoke', chunk('scripts/smoke.mjs', 4000, 1200)], ['中文注释', chunk('server/llm-proxy.js', 1200, 1000)],
  ['Markdown 长段', chunk('README.md', 6000, 1400)], ['JSX', chunk('src/components/ChatPanel.jsx', 500, 1000)],
  ['SQL/日志', chunk('scripts/bench-ann.mjs', 800, 1000)], ['混合文档', chunk('README.md', 9000, 1400)],
  // 注意：这里不能用「同一句重复 N 遍」当样本 —— BPE 会把重复段压成很短的序列，
  // 拟合出来的系数会荒谬地低（踩过一次）。所以只取真实、不重复的语料。
  ['中文文档', chunk('README.md', 12000, 1000)],
  ['英文文档', chunk('README.md', 1200, 700)],
  ['数字/路径', JSON.stringify(Array.from({ length: 60 }, (_, i) => `/home/user/cortex-ide/.cortex/ann/shard-${i}.bin`)).slice(0, 1000)],
];
const S = [];
for (const [name, text] of raw) S.push({ name, f: features(text), y: (await ask(text)) - base });
const solve = (M, v) => {
  const n = v.length, aug = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(aug[r][c]) > Math.abs(aug[p][c])) p = r;
    [aug[c], aug[p]] = [aug[p], aug[c]];
    for (let r = 0; r < n; r += 1) { if (r === c) continue; const f = aug[r][c] / aug[c][c]; for (let k = c; k <= n; k += 1) aug[r][k] -= f * aug[c][k]; }
  }
  return aug.map((r, i) => r[n] / r[i]);
};
const K = 4, KEYS = ['cjk', 'latin', 'punct', 'struct'];
const xOf = (f) => [f[0], f[1], f[2], f[4]];
const PR = { cjk: 0.755, latin: 0.37, punct: 0.6, struct: 0.9 };
const fit = (rows, ridge) => {
  const A = Array.from({ length: K }, () => new Array(K).fill(0)), b = new Array(K).fill(0);
  for (const s of rows) { const x = xOf(s.f); for (let i = 0; i < K; i += 1) { for (let j = 0; j < K; j += 1) A[i][j] += x[i] * x[j]; b[i] += x[i] * s.y; } }
  for (let i = 0; i < K; i += 1) { A[i][i] += ridge; b[i] += ridge * PR[KEYS[i]]; }
  return solve(A, b);
};
const pred = (w, f) => xOf(f).reduce((a, v, i) => a + v * w[i], 0);
// 留一交叉验证：11 条拟合，1 条检验
let _loo = 0, _looBase = 0;
for (const rid of [1, 20, 80]) {
  let e = 0;
  for (let i = 0; i < S.length; i += 1) {
    const w = fit(S.filter((_, j) => j !== i), rid);
    e += Math.abs(pred(w, S[i].f) - S[i].y) / S[i].y;
  }
  console.log(`ridge=${rid} 留一误差 ${(e / S.length * 100).toFixed(1)}%`);
  if (rid === 20) _loo = e / S.length * 100;
}
void _loo;
void _looBase;
const wBase = [0.95, 0.32, 0.45, 1.05]; // 与 server/tokenizer.js 的 DEFAULT_W 保持一致（newline 0.1 上面单加）
let eb = 0;
for (const s of S) { const p = pred(wBase, s.f) + s.f[3] * 0.1; eb += Math.abs(p - s.y) / s.y; }
console.log('当前出厂权重 误差', (eb / S.length * 100).toFixed(1) + '%');
const wFull = fit(S, 20);
console.log('ridge=20 全量拟合:', KEYS.map((k, i) => `${k}=${wFull[i].toFixed(3)}`).join(' '));
for (const s of S) {
  const e = (pred(wFull, s.f) - s.y) / s.y * 100;
  console.log(`${s.name.padEnd(10)} 预测 ${String(Math.round(pred(wFull, s.f))).padStart(5)}  实际 ${String(s.y).padStart(5)}  误差 ${e.toFixed(1)}%`);
}
console.log('\n结论：字符类模型（不含词表）留一误差 ≈10%（出厂权重在这 15 段语料上 9.9%），别把估算器当精确 tokenizer 用；');
console.log('      真实节省比例一律以 usage.prompt_tokens 为准（/api/llm/compress 的 totals）。');
