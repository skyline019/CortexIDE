/**
 * 嵌入 Worker：在独立线程里跑 transformers.js，主线程不卡。
 * 模型首次使用时从 HuggingFace 下载并缓存（Cache API），之后离线可用。
 */
let extractor = null;
let loading = null;

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

async function loadTransformers() {
  // 浏览器端用 CDN 的 ESM 构建：不参与打包，避免 onnxruntime-node 之类的原生依赖问题
  // @vite-ignore 让 Vite 保持这个绝对 URL 不动
  return await import(/* @vite-ignore */ CDN);
}

async function init(model) {
  if (extractor) return;
  if (loading) return loading;
  loading = (async () => {
    const mod = await loadTransformers();
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
    extractor = await mod.pipeline('feature-extraction', model, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && typeof p.progress === 'number') {
          self.postMessage({ type: 'progress', value: p.progress / 100, file: p.file });
        }
      },
    });
    self.postMessage({ type: 'ready', model });
  })();
  return loading;
}

self.onmessage = async (e) => {
  const { type, id, texts, prefix = '', model } = e.data || {};
  if (type === 'init') {
    try {
      await init(model);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err).slice(0, 300) });
    }
    return;
  }
  if (type === 'embed') {
    try {
      if (!extractor) await init(model || 'Xenova/bge-small-zh-v1.5');
      const input = texts.map((t) => prefix + t);
      const out = await extractor(input, { pooling: 'mean', normalize: true });
      const [n, dim] = out.dims;
      const flat = Array.from(out.data);
      const vectors = [];
      for (let i = 0; i < n; i++) vectors.push(flat.slice(i * dim, (i + 1) * dim));
      self.postMessage({ type: 'result', id, vectors, dim });
    } catch (err) {
      self.postMessage({ type: 'fail', id, message: String(err?.message || err).slice(0, 300) });
    }
  }
};
