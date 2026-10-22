/**
 * 音视频预览的纯逻辑（不碰 DOM，全部可单测）
 *
 * 播放器本身要读浏览器的实时状态，但「怎么显示时长」「波形怎么画」「解码失败怎么说」
 * 这些判断没有任何理由和 React 绑在一起 —— 抽出来才能一条条钉住。
 */

export const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv']);
export const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba']);

/** 浏览器能直接播的容器（其余的会明确提示「容器/编码可能不支持」而不是白屏） */
export const WELL_SUPPORTED = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'weba']);
/** Chromium 系默认不带这些编码（H.264/AAC 属专利编解码器），要如实说明 */
export const CODEC_RISKY = new Set(['mov', 'mkv', 'flac']);

export function extOf(path = '') {
  const base = String(path).split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** @returns {'video'|'audio'|null} */
export function mediaKindOf(path) {
  const ext = extOf(path);
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

export const PLAYBACK_RATES = [0.5, 1, 1.5, 2];

/**
 * 秒 → `0:03` / `1:02:03`。
 * 视频进度条上带一位小数（`0:03.4`），因为短片段看整秒分不出拖动有没有生效。
 */
export function formatTime(sec, { decimals = 0 } = {}) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return decimals ? '0:00.0' : '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const frac = decimals > 0 ? `.${Math.floor((s - total) * 10 ** decimals).toString().padStart(decimals, '0')}` : '';
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}${frac}`;
  return `${m}:${String(rest).padStart(2, '0')}${frac}`;
}

/** 字节 / 秒 → `1.2 Mbps` / `320 kbps`；拿不到时长就返回空串，不编数字 */
export function formatBitrate(bytes, seconds) {
  const b = Number(bytes);
  const s = Number(seconds);
  if (!Number.isFinite(b) || !Number.isFinite(s) || s <= 0) return '';
  const bits = b * 8;
  const bps = bits / s;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 波形抽点：把解码后的 PCM 压成 N 个桶，每桶取**绝对值的峰值**。
 * 用峰值而不是均值 —— 均值会把鼓点、瞬态全抹平，看起来像一条毛线。
 */
export function peaksFromSamples(samples, buckets = 160) {
  const n = Math.max(1, Math.floor(buckets));
  const len = samples?.length || 0;
  const peaks = new Array(n).fill(0);
  if (!len) return peaks;
  const per = len / n;
  for (let b = 0; b < n; b += 1) {
    const from = Math.floor(b * per);
    const to = Math.min(len, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = from; i < to; i += 1) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    peaks[b] = peak;
  }
  // 归一化到 0..1：静音段本来全是 0，归一化后仍然全是 0，不会被放大成噪声
  const max = Math.max(...peaks);
  return max > 0 ? peaks.map((p) => p / max) : peaks;
}

/**
 * 多声道交错数据 → 单声道（取各声道平均）。
 * decodeAudioData 给的是 planar 的 AudioBuffer，这里兼容传进来的是已经拍平的交错数组。
 */
export function downmixToMono(channels) {
  const list = (channels || []).filter((c) => c && c.length);
  if (!list.length) return new Float32Array(0);
  if (list.length === 1) return list[0];
  const n = Math.min(...list.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    for (const c of list) s += c[i];
    out[i] = s / list.length;
  }
  return out;
}

/**
 * 波形 SVG path：上下对称的柱状（比折线更像音频软件的观感）。
 * 纯字符串，无 DOM，测试里可以直接断言点数与边界。
 */
export function waveformPath(peaks, width = 600, height = 120, { gap = 1 } = {}) {
  const n = peaks?.length || 0;
  if (!n || width <= 0 || height <= 0) return '';
  const mid = height / 2;
  const slot = width / n;
  const barW = Math.max(0.6, slot - gap);
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const amp = Math.max(0.02, Math.min(1, peaks[i])) * (mid - 2);
    const x = (i * slot + (slot - barW) / 2).toFixed(2);
    const w = barW.toFixed(2);
    // 每根柱子是一个矩形：M x top h w amp v -2amp h -w Z（用圆弧太花，矩形足够）
    parts.push(`M${x} ${(mid - amp).toFixed(2)}h${w}v${(amp * 2).toFixed(2)}h-${w}Z`);
  }
  return parts.join(' ');
}

/** 播放进度比例 → 时间（点击波形 / 进度条时用），夹在 0..duration */
export function timeFromRatio(ratio, duration) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  return r * d;
}

/** HTMLMediaElement.error.code → 说实话的中文说明 */
export function mediaErrorText(code, ext = '') {
  const risky = CODEC_RISKY.has(String(ext).toLowerCase()) ? '（.mov/.mkv 这类容器在 Chromium 里常常没有对应解码器）' : '';
  switch (Number(code)) {
    case 1:
      return '播放被中断（MEDIA_ERR_ABORTED）：多半是切换文件时把加载取消了。';
    case 2:
      return '读取失败（MEDIA_ERR_NETWORK）：文件在读取过程中断了，刷新页面或重新打开试试。';
    case 3:
      return `解码失败（MEDIA_ERR_DECODE）：文件头能读，但数据解不开，可能已损坏或编码不被支持${risky}。`;
    case 4:
      return `这个格式浏览器不支持（MEDIA_ERR_SRC_NOT_SUPPORTED）：容器或编解码器不在当前浏览器的支持列表里${risky}。`;
    default:
      return '播放器报了一个未分类的错误。';
  }
}

/** 「容器/编码可能不支持」的提前提示（不是错误，只是把风险说在前面） */
export function codecHint(ext) {
  if (CODEC_RISKY.has(String(ext).toLowerCase())) {
    return '这个容器在 Chromium 里经常缺少解码器；如果下面的播放器报「格式不支持」，请用系统播放器打开（右侧可下载）。';
  }
  if (!WELL_SUPPORTED.has(String(ext).toLowerCase())) {
    return '这个扩展名不在浏览器默认支持清单里，能不能播取决于系统装了哪些解码器。';
  }
  return '';
}
