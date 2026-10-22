/**
 * 生成 demo/ 里的音视频素材（真文件，不是占位）。
 *
 * 优先用系统 ffmpeg（VP9 + Opus / PCM WAV，带真实 duration 元数据）。
 * 没有 ffmpeg 时回退：Chromium MediaRecorder（WebM）+ Node 手写 WAV。
 *
 * 运行：node scripts/make-media.mjs [--force] [文件名片段]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const OUT = path.join(process.cwd(), 'demo');
const DURATION = 2.4; // 秒

/* ---------------- WAV：手写 PCM（无 ffmpeg 时仍确定可复现） ---------------- */

export function wavBuffer({ seconds = 3, rate = 44100, freq = 440, sample = (t) => Math.sin(2 * Math.PI * freq * t) } = {}) {
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const fade = Math.min(1, t / 0.02, (seconds - t) / 0.02);
    const v = Math.max(-1, Math.min(1, sample(t))) * fade;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const chord = (t) => {
  const env = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 0.8 * t));
  return env * (Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 330 * t) * 0.3 + Math.sin(2 * Math.PI * 440 * t) * 0.2);
};

/* ---------------- 探测系统 ffmpeg ---------------- */

export function findFfmpeg() {
  const fromEnv = process.env.FFMPEG_PATH || process.env.CORTEX_FFMPEG;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['ffmpeg'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch {
    /* not on PATH */
  }
  return null;
}

function runFfmpeg(bin, args) {
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`ffmpeg 失败（exit ${r.status}）：${(r.stderr || r.stdout || '').trim() || '无输出'}`);
  }
}

/** lavfi 测试源 + 正弦音 → VP9/Opus WebM（带真实 duration 元数据） */
function ffmpegVideo(bin, dest, { seconds = DURATION, width = 480, height = 270 } = {}) {
  const withText = [
    '-f', 'lavfi', '-i', `color=c=0x12324a:s=${width}x${height}:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=44100:duration=${seconds}`,
    '-vf', `drawbox=x=0:y=ih-6:w='iw*t/${seconds}':h=6:color=0x2dd4bf:t=fill,drawtext=text='Cortex preview':x=28:y=48:fontsize=32:fontcolor=white:font=Arial,drawtext=text='%{pts\\\\:hms}':x=28:y=h-36:fontsize=20:fontcolor=0x2dd4bf:font=Arial`,
    '-c:v', 'libvpx-vp9', '-b:v', '700k', '-c:a', 'libopus', '-b:a', '64k',
    '-shortest', dest,
  ];
  const plain = [
    '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=44100:duration=${seconds}`,
    '-c:v', 'libvpx-vp9', '-b:v', '700k', '-c:a', 'libopus', '-b:a', '64k',
    '-shortest', dest,
  ];
  try {
    runFfmpeg(bin, withText);
  } catch {
    runFfmpeg(bin, plain);
  }
}

function ffmpegAudioOnly(bin, dest, { seconds = 2 } = {}) {
  runFfmpeg(bin, [
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=44100:duration=${seconds}`,
    '-c:a', 'libopus', '-b:a', '96k',
    dest,
  ]);
}

function ffmpegWav(bin, dest, { seconds = 3 } = {}) {
  // 三音叠加近似 chord：用 amix
  runFfmpeg(bin, [
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=44100:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=44100:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
    '-filter_complex', '[0][1][2]amix=inputs=3:duration=longest,volume=0.7,afade=t=in:st=0:d=0.02,afade=t=out:st=' + (seconds - 0.02) + ':d=0.02',
    '-c:a', 'pcm_s16le',
    dest,
  ]);
}

/* ---------------- WebM：Chromium 录（无 ffmpeg 时） ---------------- */

async function recordWebm({ width = 480, height = 270, seconds = DURATION, audio = true, audioOnly = false }) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body style="margin:0"><canvas id="c" width="480" height="270"></canvas></body></html>');
    const res = await page.evaluate(
      async ({ width: w, height: h, seconds: sec, audio: withAudio, audioOnly: onlyAudio }) => {
        const c = document.getElementById('c');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const stream = onlyAudio ? new MediaStream() : c.captureStream(25);
        let ac = null;
        let osc = null;
        if (withAudio) {
          ac = new AudioContext();
          osc = ac.createOscillator();
          const dest = ac.createMediaStreamDestination();
          const gain = ac.createGain();
          gain.gain.value = 0.12;
          osc.type = 'sine';
          osc.frequency.value = 330;
          osc.connect(gain).connect(dest);
          osc.start();
          for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
        }
        const candidates = onlyAudio
          ? ['audio/webm;codecs=opus', 'audio/webm']
          : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        const mime = candidates.find((t) => MediaRecorder.isTypeSupported(t));
        const rec = new MediaRecorder(stream, {
          mimeType: mime,
          ...(onlyAudio ? { audioBitsPerSecond: 96000 } : { videoBitsPerSecond: 700000, audioBitsPerSecond: 64000 }),
        });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const stopped = new Promise((r) => {
          rec.onstop = r;
        });
        rec.start(200);
        const t0 = performance.now();
        await new Promise((resolve) => {
          if (onlyAudio) {
            setTimeout(resolve, sec * 1000);
            return;
          }
          const draw = () => {
            const t = (performance.now() - t0) / 1000;
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, `hsl(${200 + t * 40} 60% 18%)`);
            g.addColorStop(1, `hsl(${280 + t * 40} 55% 30%)`);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = 'rgba(45,212,191,0.9)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let x = 0; x <= w; x += 4) {
              const phase = x / 40 + t * 3;
              const y = h * 0.55 + Math.sin(phase) * 30;
              if (x === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.fillStyle = '#e6edf7';
            ctx.font = 'bold 34px sans-serif';
            ctx.fillText('Cortex 媒体预览', 28, 62);
            ctx.font = '20px monospace';
            ctx.fillText(`t = ${t.toFixed(2)}s`, 28, h - 30);
            ctx.fillStyle = 'rgba(45,212,191,0.9)';
            ctx.fillRect(0, h - 6, (w * t) / sec, 6);
            if (t < sec) requestAnimationFrame(draw);
            else resolve();
          };
          draw();
        });
        rec.stop();
        await stopped;
        if (osc) osc.stop();
        if (ac) await ac.close();
        const buf = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 1) s += String.fromCharCode(buf[i]);
        return { mime, size: buf.length, b64: btoa(s) };
      },
      { width, height, seconds, audio, audioOnly },
    );
    return { ...res, bytes: Buffer.from(res.b64, 'base64') };
  } finally {
    await browser.close();
  }
}

/* ---------------- 主流程 ---------------- */

const ffmpeg = findFfmpeg();
if (ffmpeg) console.log(`使用系统 ffmpeg：${ffmpeg}`);
else console.log('未找到系统 ffmpeg，回退 MediaRecorder / 手写 WAV（可设 FFMPEG_PATH）');

const targets = [
  {
    file: 'sample.wav',
    make: async (dest) => {
      if (ffmpeg) {
        ffmpegWav(ffmpeg, dest, { seconds: 3 });
        return fs.readFileSync(dest);
      }
      const bytes = wavBuffer({ seconds: 3, sample: (t) => chord(t) });
      fs.writeFileSync(dest, bytes);
      return bytes;
    },
  },
  {
    file: 'sample.webm',
    make: async (dest) => {
      if (ffmpeg) {
        ffmpegVideo(ffmpeg, dest, { seconds: DURATION });
        return fs.readFileSync(dest);
      }
      const bytes = (await recordWebm({})).bytes;
      fs.writeFileSync(dest, bytes);
      return bytes;
    },
  },
  {
    file: 'sample-audio.webm',
    make: async (dest) => {
      if (ffmpeg) {
        ffmpegAudioOnly(ffmpeg, dest, { seconds: 2 });
        return fs.readFileSync(dest);
      }
      const bytes = (await recordWebm({ seconds: 2, audioOnly: true })).bytes;
      fs.writeFileSync(dest, bytes);
      return bytes;
    },
  },
];

const only = process.argv.slice(2).find((a) => !a.startsWith('-'));
const force = process.argv.includes('--force');

for (const t of targets) {
  if (only && !t.file.includes(only)) continue;
  const dest = path.join(OUT, t.file);
  if (fs.existsSync(dest) && !force) {
    console.log(`跳过 ${t.file}（已存在，加 --force 覆盖）`);
    continue;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = await t.make(dest);
  console.log(`✓ ${t.file}  ${(bytes.length / 1024).toFixed(1)} KB${ffmpeg ? '  [ffmpeg]' : '  [fallback]'}`);
}
