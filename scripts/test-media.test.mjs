/**
 * 第十六轮：图片 / 视频 / 音频预览的单测。
 *
 * 两半：
 *   ① 前端纯逻辑（src/lib/media.js）：时间格式、码率、波形抽点、SVG path、错误文案
 *   ② 服务端 Range 解析（server/fs-api.js）：视频拖进度条全靠它，错了就是「拖不动」
 *
 * 波形那几条特别值钱：真机上最容易糊弄的地方就是「随机画一排条，看着像波形」，
 * 这里从采样数据反推，能算出「峰值位置对不对」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  VIDEO_EXT,
  AUDIO_EXT,
  mediaKindOf,
  formatTime,
  formatBitrate,
  formatBytes,
  peaksFromSamples,
  downmixToMono,
  waveformPath,
  timeFromRatio,
  mediaErrorText,
  codecHint,
  PLAYBACK_RATES,
  extOf,
} from '../src/lib/media.js';
import { previewKind, KIND_LABEL } from '../src/lib/preview-kind.js';
import { parseRange, MIME_TYPES } from '../server/fs-api.js';

/* ---------------- 类型判定 ---------------- */

test('媒体类型：常见视频/音频扩展名都认得，代码文件不会被误判成媒体', () => {
  for (const f of ['a.mp4', 'b.webm', 'c.mov', 'd.mkv', 'e.M4V', 'f.ogv']) assert.equal(mediaKindOf(f), 'video', f);
  for (const f of ['a.mp3', 'b.wav', 'c.m4a', 'd.flac', 'e.ogg', 'f.opus', 'g.weba']) assert.equal(mediaKindOf(f), 'audio', f);
  for (const f of ['a.js', 'b.png', 'c.pdf', 'd', 'e.']) assert.equal(mediaKindOf(f), null, f);
  assert.equal(extOf('x/y/Z.WEBM'), 'webm');
  assert.ok(VIDEO_EXT.has('webm') && AUDIO_EXT.has('wav'));
});

test('预览分发：音视频排在「二进制兜底」之前，不会被当成不支持', () => {
  assert.equal(previewKind('demo/sample.webm', { binary: true }), 'video');
  assert.equal(previewKind('demo/sample.wav', { binary: true }), 'audio');
  assert.equal(previewKind('demo/sample.png', { binary: true }), 'image');
  assert.equal(previewKind('demo/sample.pdf', { binary: true }), 'pdf');
  // 未知二进制仍然老老实实兜底
  assert.equal(previewKind('demo/archive.zip', { binary: true }), 'binary');
  assert.equal(KIND_LABEL.video, '视频');
  assert.equal(KIND_LABEL.audio, '音频');
});

test('MIME：视频/音频的回包类型必须对（写错浏览器就拒播）', () => {
  assert.equal(MIME_TYPES.webm, 'video/webm');
  assert.equal(MIME_TYPES.mp4, 'video/mp4');
  assert.equal(MIME_TYPES.wav, 'audio/wav');
  assert.equal(MIME_TYPES.mp3, 'audio/mpeg');
  assert.equal(MIME_TYPES.flac, 'audio/flac');
  assert.equal(MIME_TYPES.opus, 'audio/ogg');
});

/* ---------------- 时间 / 码率 ---------------- */

test('时间格式：秒、分、时都补零，超短片段带一位小数', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(3.4), '0:03');
  assert.equal(formatTime(3.46, { decimals: 1 }), '0:03.4');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  // 坏数据不抛异常，给 0:00（播放器里 duration 常常先是 NaN）
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-5), '0:00');
  assert.equal(formatTime('abc', { decimals: 1 }), '0:00.0');
});

test('码率：能从「字节 + 时长」反推，拿不到时长就不编数字', () => {
  assert.equal(formatBitrate(121685, 2.37), '411 kbps');
  assert.equal(formatBitrate(15_000_000, 10), '12.0 Mbps');
  assert.equal(formatBitrate(0, 10), '0 kbps');
  assert.equal(formatBitrate(1000, 0), '', '时长为 0 时不能编一个数');
  assert.equal(formatBitrate(1000, NaN), '');
  assert.equal(formatBytes(258_400), '252.3 KB');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatBytes(0), '');
});

/* ---------------- 波形 ---------------- */

test('波形抽点：能定位到真实峰值所在的桶（不是随便画）', () => {
  // 前四分之一静音、中间一段满幅、后面静音
  const n = 4000;
  const samples = new Float32Array(n);
  for (let i = n * 0.25; i < n * 0.5; i += 1) samples[i] = i % 2 ? 1 : -1;
  const peaks = peaksFromSamples(samples, 40);
  assert.equal(peaks.length, 40);
  assert.equal(peaks[0], 0, '开头静音应该没有峰值');
  assert.equal(peaks[peaks.length - 1], 0, '结尾静音应该没有峰值');
  const loudest = peaks.indexOf(Math.max(...peaks));
  assert.ok(loudest >= 10 && loudest < 20, `峰值出现在第 ${loudest} 个桶（应落在 10..19）`);
  assert.equal(Math.max(...peaks), 1, '要归一化到 1');
});

test('波形抽点：全静音不会放大成噪声；空输入返回全 0', () => {
  const silent = peaksFromSamples(new Float32Array(1000), 20);
  assert.equal(silent.length, 20);
  assert.ok(silent.every((v) => v === 0), '静音被放大了');
  assert.ok(peaksFromSamples(null, 8).every((v) => v === 0));
  assert.equal(peaksFromSamples(new Float32Array(0), 8).length, 8);
});

test('多声道：取平均而不是只取第一条（否则右声道独奏时会画成静音）', () => {
  const left = new Float32Array([0, 0, 0, 0]);
  const right = new Float32Array([1, 1, 1, 1]);
  const mono = downmixToMono([left, right]);
  assert.deepEqual([...mono], [0.5, 0.5, 0.5, 0.5]);
  const single = downmixToMono([left]);
  assert.equal(single, left, '单声道应该原样返回，不做多余拷贝');
  assert.equal(downmixToMono([]).length, 0);
});

test('波形 path：每个峰值对应一个闭合矩形，坐标不出界', () => {
  const peaks = [0, 0.5, 1, 0.25];
  const d = waveformPath(peaks, 400, 100);
  const segs = d.split('M').filter(Boolean);
  assert.equal(segs.length, 4);
  // 注意：path 里的 `h-${w}` 是**相对位移**，会出现「-99」这种数，不能当绝对坐标检查。
  // 真正要保证的是每根柱子的四个绝对坐标落在画布内。
  for (const m of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)h([\d.]+)v([\d.]+)h-([\d.]+)Z/g)) {
    const [x, top, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    assert.ok(x >= 0 && x + w <= 400 + 0.01, `柱子 x 越界：${m[0]}`);
    assert.ok(top >= -0.01 && top + h <= 100.01, `柱子 y 越界：${m[0]}`);
  }
  // 0 峰值也要给一个最小高度，否则静音段在图上完全消失（drawHeight >= 2*0.02*48 ≈ 1.9）
  const height0 = Number((segs[0].match(/v([\d.]+)/) || [])[1]);
  assert.ok(height0 >= 1.5, `静音柱高度只有 ${height0}，看不见`);
  assert.equal(waveformPath([], 100, 50), '');
  assert.equal(waveformPath([1], 0, 50), '');
});

test('点击跳转：比例换成时间，越界被夹住', () => {
  assert.equal(timeFromRatio(0.5, 3), 1.5);
  assert.equal(timeFromRatio(2, 3), 3);
  assert.equal(timeFromRatio(-1, 3), 0);
  assert.equal(timeFromRatio(0.5, 0), 0);
  assert.equal(timeFromRatio(NaN, 3), 0);
  assert.deepEqual(PLAYBACK_RATES, [0.5, 1, 1.5, 2]);
});

test('错误文案：四种 MEDIA_ERR 各自说清楚，并提示可疑容器', () => {
  assert.match(mediaErrorText(1), /中断/);
  assert.match(mediaErrorText(2), /读取失败/);
  assert.match(mediaErrorText(3), /解码失败/);
  assert.match(mediaErrorText(4), /不支持/);
  // 可疑容器在细分的两档里都会带上提示
  assert.ok(mediaErrorText(3, 'mkv').includes('.mov/.mkv'), '可疑容器应给出提示');
  assert.match(mediaErrorText(4, 'mov'), /解码器/);
  assert.match(mediaErrorText(99), /未分类/);
  assert.equal(codecHint('webm'), '');
  assert.match(codecHint('mkv'), /解码器/);
  assert.match(codecHint('xyz'), /不在浏览器默认支持清单/);
});

/* ---------------- Range（视频拖动的命门） ---------------- */

test('Range：正常区间 / 开区间 / 末尾 N 字节都解析对', () => {
  assert.deepEqual(parseRange('bytes=0-1023', 121685), { start: 0, end: 1023 });
  assert.deepEqual(parseRange('bytes=1024-', 121685), { start: 1024, end: 121684 });
  assert.deepEqual(parseRange('bytes=-500', 121685), { start: 121185, end: 121684 });
  // 请求比文件还长：裁到文件末尾，而不是报错
  assert.deepEqual(parseRange('bytes=0-999999', 1000), { start: 0, end: 999 });
});

test('Range：没有头 = 整份发送；坏头 / 越界 = 416', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('', 1000), null);
  for (const bad of ['bytes=1000-', 'bytes=abc-def', 'bytes=-', 'bytes=5-1', 'items=0-5']) {
    assert.equal(parseRange(bad, 1000)?.invalid, true, `${bad} 应该被判非法`);
  }
  assert.equal(parseRange('bytes=0-0', 0)?.invalid, true, '空文件不接受区间请求');
});

/* ---------------- 素材本身 ---------------- */

test('demo 里的媒体素材是真文件，且容器魔数对得上', () => {
  const dir = path.join(process.cwd(), 'demo');
  const wav = fs.readFileSync(path.join(dir, 'sample.wav'));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.ok(wav.length > 100_000, `WAV 太小：${wav.length}`);
  // 44 字节头 + 16bit mono
  const seconds = (wav.length - 44) / 2 / 44100;
  assert.ok(Math.abs(seconds - 3) < 0.05, `时长算出来是 ${seconds}s`);

  for (const name of ['sample.webm', 'sample-audio.webm']) {
    const webm = fs.readFileSync(path.join(dir, name));
    // EBML 魔数 0x1A45DFA3
    assert.deepEqual([...webm.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], `${name} 不是 WebM`);
    assert.ok(webm.length > 10_000, `${name} 太小`);
  }
});
