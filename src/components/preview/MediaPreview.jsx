/**
 * 视频 / 音频预览播放器
 *
 * 为什么不用浏览器原生 `controls`：
 *  1. 原生控件不给码率 / 分辨率 / 播放速度这些信息，用户没法判断「这文件是不是坏的」；
 *  2. 各浏览器原生控件长得完全不同，和这套深色 UI 也对不上；
 *  3. 出错时原生控件只给一个灰色感叹号，说不出 MEDIA_ERR_DECODE 还是 SRC_NOT_SUPPORTED。
 *
 * 这里自己画控件，但**播放本身仍交给浏览器**（<video>/<audio>），不自己解封装 ——
 * 自己写解码器那是另一个项目，而且做不好更糟。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  extOf,
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
} from '../../lib/media.js';

const rawUrl = (path, extra = '') => `/api/fs/raw?path=${encodeURIComponent(path)}${extra}`;

export function download(path) {
  const a = document.createElement('a');
  a.href = rawUrl(path, '&download=1');
  a.download = String(path).split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * 文件大小：用 HEAD /api/fs/raw 读 Content-Length。
 * 打开编辑器时拿到的 file 对象未必带 size（目录树节点才有），
 * 码率又必须靠它算 —— 与其显示「未知」，不如直接问一次服务端。
 */
function useFileSize(path, hint) {
  const [size, setSize] = useState(Number(hint) || 0);
  useEffect(() => {
    if (Number(hint) > 0) {
      setSize(Number(hint));
      return undefined;
    }
    let alive = true;
    fetch(rawUrl(path), { method: 'HEAD' })
      .then((r) => Number(r.headers.get('content-length')) || 0)
      .then((n) => alive && setSize(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, hint]);
  return size;
}

/* ------------------------------------------------------------------ */
/* 播放状态                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把 <video>/<audio> 的实时状态镜像成 React state。
 * 播放中用 rAF 更新进度（timeupdate 一秒只来 4 次，进度条看着一顿一顿的）；
 * 暂停时停掉 rAF，不白白占一个动画帧。
 */
function useMediaPlayback(filePath) {
  const ref = useRef(null);
  const rafRef = useRef(0);
  const probing = useRef(false); // 正在用「跳到极大时间」的办法逼浏览器算出真实时长
  const [state, setState] = useState({
    playing: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    muted: false,
    rate: 1,
    loop: false,
    errorCode: 0,
    ready: false,
    meta: { width: 0, height: 0 },
  });

  const patch = useCallback((p) => setState((s) => ({ ...s, ...p })), []);

  const stopRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  const tickRef = useRef(() => {});
  tickRef.current = () => {
    const el = ref.current;
    if (!el) return;
    let buf = 0;
    try {
      for (let i = 0; i < el.buffered.length; i += 1) {
        if (el.buffered.start(i) <= el.currentTime + 0.5) buf = Math.max(buf, el.buffered.end(i));
      }
    } catch {
      /* 某些格式 buffered 访问会抛 */
    }
    setState((s) => ({ ...s, currentTime: el.currentTime, buffered: buf, playing: !el.paused && !el.ended }));
    if (!el.paused && !el.ended) rafRef.current = requestAnimationFrame(() => tickRef.current());
  };

  const startRaf = useCallback(() => {
    stopRaf();
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, []);

  // 换文件时把所有状态清干净，否则上一个文件的时长会残留
  useEffect(() => {
    stopRaf();
    setState((s) => ({
      ...s,
      playing: false,
      currentTime: 0,
      duration: 0,
      buffered: 0,
      errorCode: 0,
      ready: false,
      meta: { width: 0, height: 0 },
    }));
    return stopRaf;
  }, [filePath]);

  /**
   * MediaRecorder / 直播流录出来的 WebM，元数据里**没有 duration**（是 Infinity）。
   * 浏览器自己的做法是把它当成「未知长度」：进度条没有总长，拖不动。
   * 通用的破法是先跳到极大时间，让解封装把整条流索引完，durationchange 一响就拿到真实时长，
   * 然后立刻把播放位置还原到 0 —— 用户全程看不到这次「偷偷的跳转」。
   */
  const probeDuration = (el) => {
    if (probing.current || !el) return;
    probing.current = true;
    try {
      el.currentTime = 1e7;
    } catch {
      probing.current = false;
    }
  };

  const onLoadedMetadata = () => {
    const el = ref.current;
    if (!el) return;
    const known = Number.isFinite(el.duration);
    if (!known) probeDuration(el);
    setState((s) => ({
      ...s,
      ready: true,
      duration: known ? el.duration : s.duration,
      meta: { width: el.videoWidth || 0, height: el.videoHeight || 0 },
      errorCode: 0,
    }));
  };

  const onDurationChange = () => {
    const el = ref.current;
    if (!el) return;
    if (!Number.isFinite(el.duration)) return;
    setState((s) => ({
      ...s,
      ready: true,
      duration: el.duration,
      meta: { width: el.videoWidth || 0, height: el.videoHeight || 0 },
      currentTime: probing.current ? 0 : s.currentTime,
    }));
    if (probing.current) {
      probing.current = false;
      try {
        el.currentTime = 0;
      } catch {
        /* 忽略 */
      }
    }
  };

  const actions = {
    toggle: () => {
      const el = ref.current;
      if (!el) return;
      if (el.paused) el.play().catch(() => {/* 自动播放策略拒绝时什么都不做，用户再点一次即可 */});
      else el.pause();
    },
    seek: (t) => {
      const el = ref.current;
      if (!el) return;
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      const next = Math.max(0, Math.min(d || t, t));
      try {
        el.currentTime = next;
      } catch {
        /* 元数据还没到，忽略 */
      }
      patch({ currentTime: next });
    },
    skip: (delta) => {
      const el = ref.current;
      if (!el) return;
      actions.seek((el.currentTime || 0) + delta);
    },
    setVolume: (v) => {
      const el = ref.current;
      if (!el) return;
      const vol = Math.max(0, Math.min(1, v));
      el.volume = vol;
      el.muted = vol === 0;
      patch({ volume: vol, muted: vol === 0 });
    },
    toggleMute: () => {
      const el = ref.current;
      if (!el) return;
      el.muted = !el.muted;
      patch({ muted: el.muted });
    },
    setRate: (r) => {
      const el = ref.current;
      if (!el) return;
      el.playbackRate = r;
      patch({ rate: r });
    },
    toggleLoop: () => {
      const el = ref.current;
      if (!el) return;
      el.loop = !el.loop;
      patch({ loop: el.loop });
    },
  };

  return {
    ref,
    state,
    patch,
    actions,
    startRaf,
    handlers: {
      onLoadedMetadata,
      onDurationChange,
      onPlay: startRaf,
      onPause: () => {
        stopRaf();
        patch({ playing: false });
        tick();
      },
      onEnded: () => {
        stopRaf();
        patch({ playing: false });
      },
      onTimeUpdate: () => tick(),
      onProgress: () => tick(),
      onError: () => {
        const el = ref.current;
        patch({ errorCode: el?.error?.code || 4, ready: false });
      },
      onVolumeChange: () => {
        const el = ref.current;
        if (el) patch({ volume: el.volume, muted: el.muted });
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 进度条（可点可拖）                                                  */
/* ------------------------------------------------------------------ */

function SeekBar({ duration, currentTime, buffered, onSeek, variant = 'video' }) {
  const barRef = useRef(null);
  const dragging = useRef(false);

  const ratioAt = (clientX) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || !r.width) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const handle = (clientX) => onSeek(timeFromRatio(ratioAt(clientX), duration));

  return (
    <div
      ref={barRef}
      className={`mp-seek ${variant}`}
      role="slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration) || 0}
      aria-valuenow={Math.round(currentTime) || 0}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        handle(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) handle(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(Math.min(duration, currentTime + 5));
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, currentTime - 5));
      }}
    >
      <span className="mp-seek-track" />
      <span className="mp-seek-buffer" style={{ width: `${duration ? Math.min(100, (buffered / duration) * 100) : 0}%` }} />
      <span className="mp-seek-played" style={{ width: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%` }} />
      <span className="mp-seek-knob" style={{ left: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 控件条                                                              */
/* ------------------------------------------------------------------ */

function Controls({ state, actions, duration, extra = null, showVolume = true }) {
  const { playing, currentTime, buffered, muted, volume, rate, loop } = state;
  const [ratesOpen, setRatesOpen] = useState(false);
  return (
    <div className="mp-controls">
      <button type="button" className="mp-btn play" onClick={actions.toggle} title={playing ? '暂停（空格）' : '播放（空格）'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="mp-time">
        {formatTime(currentTime, { decimals: 1 })} / {formatTime(duration, { decimals: 1 })}
      </span>
      <SeekBar duration={duration} currentTime={currentTime} buffered={buffered} onSeek={actions.seek} />
      <div className="mp-rates">
        <button type="button" className="mp-btn" onClick={() => setRatesOpen((v) => !v)} title="播放速度">
          {rate}×
        </button>
        {ratesOpen && (
          <div className="mp-pop">
            {PLAYBACK_RATES.map((r) => (
              <button
                key={r}
                type="button"
                className={`mp-pop-item ${rate === r ? 'on' : ''}`}
                onClick={() => {
                  actions.setRate(r);
                  setRatesOpen(false);
                }}
              >
                {r}×
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className={`mp-btn ${loop ? 'on' : ''}`} onClick={actions.toggleLoop} title="循环播放">
        ⟲
      </button>
      {showVolume && (
        <>
          <button type="button" className="mp-btn" onClick={actions.toggleMute} title={muted ? '取消静音' : '静音'}>
            {muted || volume === 0 ? '🔇' : '🔈'}
          </button>
          <input
            className="mp-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => actions.setVolume(Number(e.target.value))}
            aria-label="音量"
          />
        </>
      )}
      {extra}
    </div>
  );
}

/** 键盘快捷键：只有焦点在这个预览里才接管，别抢全局 */
function useMediaKeys(containerRef, actions) {
  useEffect(() => {
    const onKey = (e) => {
      const box = containerRef.current;
      if (!box || !box.contains(document.activeElement)) return;
      if (e.target?.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          actions.toggle();
          break;
        case 'ArrowRight':
          e.preventDefault();
          actions.skip(5);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          actions.skip(-5);
          break;
        case 'm':
          actions.toggleMute();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [containerRef, actions]);
}

function MediaFailure({ path, code, ext }) {
  return (
    <div className="pv-center pv-fail">
      <div className="pv-fail-icon">⚠</div>
      <div className="pv-fail-title">这个媒体文件没法在这里播放</div>
      <div className="pv-fail-msg">{mediaErrorText(code, ext)}</div>
      <div className="pv-fail-hint">
        浏览器只解码它认识的容器/编码；Cortex 不会偷偷转码你的文件。文件本身仍然完好，可以用系统播放器打开。
      </div>
      <button type="button" className="btn" onClick={() => download(path)}>
        下载原文件
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 视频                                                                */
/* ------------------------------------------------------------------ */

export function VideoPreview({ path, size: sizeHint }) {
  const size = useFileSize(path, sizeHint);
  const videoRef = useRef(null);
  const boxRef = useRef(null);
  const { ref, state, actions, handlers } = useMediaPlayback(path);
  const ext = extOf(path);
  const hint = codecHint(ext);
  const bitrate = formatBitrate(size, state.duration);
  useMediaKeys(boxRef, actions);

  const canPip = typeof document !== 'undefined' && document.pictureInPictureEnabled;
  // 只有音轨的容器（.webm 里只塞了 opus 之类）不该给一块黑屏 —— 直接按音频播，并说明原因
  const audioOnly = state.ready && !state.meta.width;

  if (audioOnly) {
    return <AudioPreview path={path} size={size} note="这个容器只有音轨、没有视频画面（常见于只有声音的 .webm/.mp4），已按音频播放。" />;
  }

  return (
    <div className="pv pv-media" ref={boxRef} tabIndex={0}>
      <div className="pv-bar">
        <span className="pv-badge video">视频</span>
        <span className="pv-meta">{String(path).split('/').pop()}</span>
        <span className="pv-meta dim">
          {state.meta.width ? `${state.meta.width}×${state.meta.height}` : '—'}
          {state.duration ? ` · ${formatTime(state.duration)}` : ''}
          {formatBytes(size) ? ` · ${formatBytes(size)}` : ''}
          {bitrate ? ` · ${bitrate}` : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => download(path)}>
          下载
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            const el = boxRef.current;
            if (!el) return;
            if (document.fullscreenElement) document.exitFullscreen?.();
            else el.requestFullscreen?.();
          }}
        >
          全屏
        </button>
      </div>

      {hint ? <div className="mp-hint">{hint}</div> : null}

      <div className="mp-stage">
        <video
          ref={(el) => {
            ref.current = el;
            videoRef.current = el;
          }}
          className="mp-video"
          src={rawUrl(path)}
          preload="metadata"
          playsInline
          {...handlers}
        />
        {state.errorCode ? (
          <div className="mp-overlay">
            <MediaFailure path={path} code={state.errorCode} ext={ext} />
          </div>
        ) : null}
        {!state.ready && !state.errorCode ? <div className="mp-loading">读取媒体信息…</div> : null}
      </div>

      <Controls
        state={state}
        actions={actions}
        duration={state.duration}
        extra={
          canPip ? (
            <button
              type="button"
              className="mp-btn"
              title="画中画"
              onClick={async () => {
                const el = videoRef.current;
                if (!el) return;
                try {
                  if (document.pictureInPictureElement) await document.exitPictureInPicture();
                  else await el.requestPictureInPicture();
                } catch {
                  /* 部分环境不支持，静默 */
                }
              }}
            >
              ⧉
            </button>
          ) : null
        }
      />
      <div className="mp-foot">空格 播放/暂停 · ←/→ ±5 秒 · m 静音 · 拖动进度条会发 HTTP Range 请求（服务器回 206）</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 音频（真实波形）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 波形取自浏览器解码后的 PCM（decodeAudioData），不是假的随机条。
 * 解码失败时如实退回系统 <audio controls>，并说明为什么没有波形。
 */
function useWaveform(path) {
  const [wave, setWave] = useState({ loading: true, peaks: [], error: null, sampleRate: 0, channels: 0, seconds: 0 });
  useEffect(() => {
    let alive = true;
    setWave({ loading: true, peaks: [], error: null, sampleRate: 0, channels: 0, seconds: 0 });
    (async () => {
      try {
        const r = await fetch(rawUrl(path));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bytes = await r.arrayBuffer();
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error('这个浏览器没有 WebAudio，无法解析波形');
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(bytes.slice(0));
        const channels = [];
        for (let c = 0; c < audio.numberOfChannels; c += 1) channels.push(audio.getChannelData(c));
        const mono = downmixToMono(channels);
        const peaks = peaksFromSamples(mono, 180);
        if (alive) {
          setWave({ loading: false, peaks, error: null, sampleRate: audio.sampleRate, channels: audio.numberOfChannels, seconds: audio.duration });
        }
        await ctx.close();
      } catch (err) {
        // 关键：不假装画一条随机波形。解不开就是解不开，同时退回原生控件继续能听
        if (alive) setWave({ loading: false, peaks: [], error: err.message || '解码失败', sampleRate: 0, channels: 0, seconds: 0 });
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);
  return wave;
}

export function AudioPreview({ path, size: sizeHint, note = '' }) {
  const size = useFileSize(path, sizeHint);
  const boxRef = useRef(null);
  const { ref, state, actions, handlers } = useMediaPlayback(path);
  const wave = useWaveform(path);
  const waveRef = useRef(null);
  const ext = extOf(path);
  const W = 720;
  const H = 140;
  const d = useMemo(() => waveformPath(wave.peaks, W, H), [wave.peaks]);
  const progress = state.duration ? Math.min(1, state.currentTime / state.duration) : 0;
  useMediaKeys(boxRef, actions);

  const seekAt = (clientX) => {
    const r = waveRef.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    actions.seek(timeFromRatio((clientX - r.left) / r.width, state.duration));
  };

  return (
    <div className="pv pv-media pv-audio" ref={boxRef} tabIndex={0}>
      <div className="pv-bar">
        <span className="pv-badge audio">音频</span>
        <span className="pv-meta">{String(path).split('/').pop()}</span>
        <span className="pv-meta dim">
          {wave.sampleRate ? `${(wave.sampleRate / 1000).toFixed(1)} kHz · ${wave.channels} 声道` : ext.toUpperCase()}
          {state.duration ? ` · ${formatTime(state.duration)}` : ''}
          {formatBytes(size) ? ` · ${formatBytes(size)}` : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => download(path)}>
          下载
        </button>
      </div>

      {note ? <div className="mp-hint">{note}</div> : null}

      {state.errorCode ? (
        <MediaFailure path={path} code={state.errorCode} ext={ext} />
      ) : (
        <div className="mp-audio-body">
          <div
            ref={waveRef}
            className="mp-wave"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              seekAt(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) seekAt(e.clientX);
            }}
            title="点一下跳转 / 按住拖动"
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mp-wave-svg" role="img" aria-label="音频波形">
              <defs>
                <clipPath id="mp-wave-clip">
                  <rect x="0" y="0" width={progress * W} height={H} />
                </clipPath>
              </defs>
              <path className="mp-wave-base" d={d} />
              <path className="mp-wave-done" d={d} clipPath="url(#mp-wave-clip)" />
              <line x1={progress * W} y1="0" x2={progress * W} y2={H} className="mp-wave-head" />
            </svg>
            {wave.loading ? <div className="mp-wave-note">解析波形中…</div> : null}
            {wave.error ? (
              <div className="mp-wave-note err">波形解析失败：{wave.error}（不影响播放，下面用系统控件继续听）</div>
            ) : null}
          </div>

          <Controls state={state} actions={actions} duration={state.duration} />

          {wave.error ? (
            // 波形拿不到时仍然给一个原生控件，保证「能听」这件事不打折
            <audio ref={ref} src={rawUrl(path)} preload="metadata" controls className="mp-audio-native" {...handlers} />
          ) : (
            <audio ref={ref} src={rawUrl(path)} preload="metadata" {...handlers} />
          )}
          <div className="mp-foot centered">
            波形来自浏览器解码后的 PCM（{wave.peaks.length} 个峰值点），不是装饰；
            {state.duration ? ` 码率约 ${formatBitrate(size, state.duration) || '未知'}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}
