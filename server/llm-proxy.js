/**
 * 服务端 LLM 代理（Vite dev / preview 中间件）
 *
 * 为什么需要它：
 *  1. 浏览器直连 api.deepseek.com 会遇到 CORS，且 API Key 会被写进 localStorage、暴露给任何脚本；
 *  2. 放在服务端后，密钥只存在于 .env，前端只知道"代理可用"，拿不到密钥；
 *  3. 顺带解决流式响应的缓冲问题，并统一错误结构。
 *
 * 暴露的接口：
 *  GET  /api/llm/status  -> { configured, baseUrl, provider, allowOverride }
 *  GET  /api/llm/models  -> { data: [{id, name, context_window}] }
 *  POST /api/llm/chat    -> SSE 透传（OpenAI 兼容格式）
 *
 * 若用户自己填了 Key，可通过 x-llm-key / x-llm-base 覆盖（静态部署时也能用）。
 */

import path from 'node:path';
import fs from 'node:fs';
import { createTokenizer } from './tokenizer.js';
import { createStyleStore } from './style-profile.js';
import { compressPayload, STRENGTHS } from './ctx-compress.js';

const DEFAULT_BASE = 'https://api.deepseek.com/v1';

/* ---------------- 个性化压缩：进程级状态 ---------------- */
const CORTEX_DIR = process.env.CORTEX_DIR || path.join(process.cwd(), '.cortex');
const tokenizer = createTokenizer({ file: path.join(CORTEX_DIR, 'tokenizer.json') });
const styleStore = createStyleStore({ dir: path.join(CORTEX_DIR, 'style') });
const seenUserText = new Map(); // 客户端每轮都会重发历史，只认「新出现的那句」
const STATS_FILE = path.join(CORTEX_DIR, 'compress-stats.json');
// 累计值落盘：dev server 一改服务端文件就重启，内存里的累计量会归零，
// 面板上「省了多少」跟着清零就变成假数字了。
function loadCompressStats() {
  const base = {
    strength: ['off', 'light', 'balanced', 'aggressive'].includes(process.env.CORTEX_COMPRESS)
      ? process.env.CORTEX_COMPRESS
      : 'balanced',
    styleEnabled: process.env.CORTEX_STYLE !== '0',
    requests: 0,
    beforeTokens: 0,
    afterTokens: 0,
    actualPrompt: 0,
    actualCacheHit: 0,
    recent: [], // 最近 30 次
  };
  try {
    const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return { ...base, ...saved, strength: base.strength, styleEnabled: base.styleEnabled };
  } catch {
    return base;
  }
}
const compressState = loadCompressStats();

let statsSaveTimer = null;
function saveCompressStatsSoon() {
  if (statsSaveTimer) return;
  statsSaveTimer = setTimeout(() => {
    statsSaveTimer = null;
    try {
      fs.mkdirSync(CORTEX_DIR, { recursive: true });
      fs.writeFileSync(
        STATS_FILE,
        JSON.stringify({
          requests: compressState.requests,
          beforeTokens: compressState.beforeTokens,
          afterTokens: compressState.afterTokens,
          actualPrompt: compressState.actualPrompt,
          actualCacheHit: compressState.actualCacheHit,
          recent: compressState.recent,
        }),
      );
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }, 800);
  statsSaveTimer.unref?.();
}

function recordCompression(rec) {
  compressState.requests += 1;
  compressState.beforeTokens += rec.beforeTokens;
  compressState.afterTokens += rec.afterTokens;
  compressState.recent.unshift(rec);
  if (compressState.recent.length > 30) compressState.recent.pop();
  saveCompressStatsSoon();
}

/**
 * 从上游 SSE 里抠出 usage。
 * DeepSeek 的 usage 里嵌着 prompt_tokens_details，`"usage":{...}` 用括号配平的正则会截断，
 * 所以这里直接抓三个数字字段；顺便抓缓存命中数（命中前缀缓存的那部分是打折的）。
 */
function scanUsage(chunk, buf) {
  const text = buf + chunk;
  const num = (re) => {
    const m = [...text.matchAll(re)].pop();
    return m ? Number(m[1]) : null;
  };
  const prompt = num(/"prompt_tokens"\s*:\s*(\d+)/g);
  const completion = num(/"completion_tokens"\s*:\s*(\d+)/g);
  const cacheHit = num(/"prompt_cache_hit_tokens"\s*:\s*(\d+)/g);
  const usage = prompt ? { prompt_tokens: prompt, completion_tokens: completion, cacheHit } : null;
  return { usage, buf: text.slice(-400) };
}

function readEnv() {
  return {
    key: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    base: (process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
    provider: process.env.LLM_PROVIDER || 'deepseek',
    allowOverride: process.env.LLM_ALLOW_OVERRIDE !== '0',
  };
}

/** 桌面版 / 本机：把密钥写进 CORTEX_ENV_DIR|.env，并热更新 process.env */
function credentialsEnvPath() {
  const dir = process.env.CORTEX_ENV_DIR || process.env.CORTEX_DIR || path.join(process.cwd(), '.cortex');
  return path.join(dir, '.env');
}

function upsertEnvFile(file, patch) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '# Cortex LLM credentials\n';
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    const line = `${k}=${String(v).replace(/\r?\n/g, '')}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text = `${text.trimEnd()}\n${line}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    process.env[k] = String(v);
  }
}

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function pickUpstream(req, env) {
  const key = (env.allowOverride && req.headers['x-llm-key']) || env.key;
  const base = ((env.allowOverride && req.headers['x-llm-base']) || env.base).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL 不合法');
  return { key, base };
}

export function llmProxyPlugin() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/llm/')) return next();

    const env = readEnv();
    const route = url.pathname.slice('/api/llm/'.length);

    /* ---------------- status ---------------- */
    if (route === 'status' && req.method === 'GET') {
      return sendJson(res, 200, {
        configured: Boolean(env.key),
        baseUrl: env.base,
        provider: env.provider,
        allowOverride: env.allowOverride,
        desktop: process.env.CORTEX_DESKTOP === '1',
        canSaveCredentials: true,
        envFile: credentialsEnvPath(),
        keyHint: env.key ? `${env.key.slice(0, 4)}…${env.key.slice(-4)}` : '',
      });
    }

    /* ---------------- credentials（本机保存 API Key，无需手改 .env） ---------------- */
    if (route === 'credentials' && req.method === 'POST') {
      return readBody(req)
        .then((body) => {
          const key = String(body.apiKey || body.key || '').trim();
          const base = String(body.baseUrl || body.base || env.base || DEFAULT_BASE)
            .trim()
            .replace(/\/+$/, '');
          const provider = String(body.provider || env.provider || 'deepseek').trim() || 'deepseek';
          if (!key) return sendJson(res, 400, { error: '请填写 API Key' });
          if (!/^https?:\/\//i.test(base)) return sendJson(res, 400, { error: 'Base URL 不合法' });
          const file = credentialsEnvPath();
          upsertEnvFile(file, {
            DEEPSEEK_API_KEY: key,
            LLM_API_KEY: key,
            LLM_BASE_URL: base,
            LLM_PROVIDER: provider,
            LLM_ALLOW_OVERRIDE: process.env.LLM_ALLOW_OVERRIDE || '1',
          });
          const next = readEnv();
          return sendJson(res, 200, {
            ok: true,
            configured: Boolean(next.key),
            baseUrl: next.base,
            provider: next.provider,
            envFile: file,
            keyHint: next.key ? `${next.key.slice(0, 4)}…${next.key.slice(-4)}` : '',
          });
        })
        .catch((err) => sendJson(res, 400, { error: err.message }));
    }

    /* ---------------- models ---------------- */
    if (route === 'models' && req.method === 'GET') {
      let upstream;
      try {
        upstream = pickUpstream(req, env);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      if (!upstream.key) return sendJson(res, 401, { error: '服务端未配置 API Key' });

      fetch(`${upstream.base}/models`, {
        headers: { Authorization: `Bearer ${upstream.key}` },
        signal: AbortSignal.timeout(15000),
      })
        .then(async (r) => {
          const text = await r.text();
          res.statusCode = r.status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(text);
        })
        .catch((err) => sendJson(res, 502, { error: `无法连接上游：${err.message}` }));
      return;
    }

    /* ---------------- 个性化压缩：统计与开关 ---------------- */
    if (route === 'compress' && req.method === 'GET') {
      const user = String(url.searchParams.get('user') || req.headers['x-cortex-user'] || 'local').slice(0, 64);
      return sendJson(res, 200, {
        config: { strength: compressState.strength, styleEnabled: compressState.styleEnabled, strengths: STRENGTHS },
        totals: {
          requests: compressState.requests,
          beforeTokens: compressState.beforeTokens,
          afterTokens: compressState.afterTokens,
          savedTokens: compressState.beforeTokens - compressState.afterTokens,
          savedPct: compressState.beforeTokens
            ? Math.round((1 - compressState.afterTokens / compressState.beforeTokens) * 1000) / 10
            : 0,
          actualPromptTokens: compressState.actualPrompt,
          actualCacheHitTokens: compressState.actualCacheHit,
        },
        recent: compressState.recent.slice(0, 12),
        tokenizer: tokenizer.stats(),
        style: compressState.styleEnabled ? styleStore.profile(user) : { user, samples: 0, card: '' },
      });
    }
    if (route === 'compress' && req.method === 'POST') {
      readBody(req).then((body) => {
        if (body.strength && STRENGTHS[body.strength]) compressState.strength = body.strength;
        if (typeof body.styleEnabled === 'boolean') compressState.styleEnabled = body.styleEnabled;
        // 返回**完整** config（含 strengths）：前端切完档要靠它重画按钮，
        // 少一个字段按钮就会退化成 off/light/balanced 这种英文 key（真出过）。
        sendJson(res, 200, {
          config: { strength: compressState.strength, styleEnabled: compressState.styleEnabled, strengths: STRENGTHS },
        });
      }).catch((err) => sendJson(res, 400, { error: err.message }));
      return;
    }
    if (route === 'style' && req.method === 'GET') {
      const user = String(url.searchParams.get('user') || req.headers['x-cortex-user'] || 'local').slice(0, 64);
      if (url.searchParams.get('reset') === '1') styleStore.reset(user);
      return sendJson(res, 200, styleStore.profile(user));
    }

    /* ---------------- chat（SSE 透传） ---------------- */
    if (route === 'chat' && req.method === 'POST') {
      (async () => {
        let upstream;
        try {
          upstream = pickUpstream(req, env);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        if (!upstream.key) {
          return sendJson(res, 401, {
            error: '服务端未配置 API Key：请在 .env 里设置 DEEPSEEK_API_KEY，或在设置里填入你自己的 Key',
            code: 'NO_SERVER_KEY',
          });
        }

        const payload = await readBody(req);
        const user = String(req.headers['x-cortex-user'] || 'local').slice(0, 64);

        // 文风画像：客户端每轮都会把历史一起发上来，所以只统计「新出现的那条用户消息」，
        // 避免同一句话被重复计入几十次
        const inMessages = Array.isArray(payload.messages) ? payload.messages : [];
        const lastUser = [...inMessages].reverse().find((m) => m.role === 'user');
        if (compressState.styleEnabled && lastUser) {
          const raw = lastUser.content;
          const txt = (
            typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? raw.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n')
                : ''
          ).trim();
          if (txt && seenUserText.get(user) !== txt) {
            styleStore.observe(user, txt);
            seenUserText.set(user, txt);
          }
        }

        // 主干压缩：在发给上游之前把「工具回传 / 老历史 / 重复内容」压掉
        const styleCard = compressState.styleEnabled ? styleStore.card(user) : '';
        const comp = compressPayload({
          messages: inMessages,
          strength: compressState.strength,
          tokenizer,
          styleCard,
          tools: payload.tools || null,
        });
        // 校准要用「真正发出去的那份」，否则估算器会把被砍掉的 schema 也算进去
        const toolsJson = payload.tools ? JSON.stringify(payload.tools) : '';
        const compressedMessages = comp.messages;
        if (Array.isArray(payload.messages)) payload.messages = compressedMessages;
        // 精简后的 tools 也要真的发出去（否则只是自欺欺人的统计）
        if (comp.tools && Array.isArray(payload.tools)) payload.tools = comp.tools;
        tokenizer.rememberPrediction(comp.stats.afterTokens);
        res.setHeader('X-Cortex-Compress', `${comp.stats.beforeTokens}->${comp.stats.afterTokens}`);

        const controller = new AbortController();
        // 客户端断开 -> 取消上游请求，省钱
        req.on('aborted', () => controller.abort());
        res.on('close', () => controller.abort());

        let upstreamRes;
        try {
          upstreamRes = await fetch(`${upstream.base}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${upstream.key}`,
              Accept: payload.stream ? 'text/event-stream' : 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted) return;
          return sendJson(res, 502, { error: `无法连接上游：${err.message}` });
        }

        if (!upstreamRes.ok) {
          const text = await upstreamRes.text().catch(() => '');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* ignore */
          }
          res.statusCode = upstreamRes.status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              error: parsed?.error?.message || text.slice(0, 500) || `上游返回 ${upstreamRes.status}`,
              code: parsed?.error?.code || upstreamRes.status,
            }),
          );
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', payload.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        // 记账 + 真实 usage 校准（流式/非流式共用一份，避免两套口径对不上）
        const settle = (u) => {
          if (u?.prompt_tokens) {
            tokenizer.observeMessages(compressedMessages, u.prompt_tokens, toolsJson);
            compressState.actualPrompt += u.prompt_tokens;
            compressState.actualCacheHit += u.cacheHit || 0;
          }
          recordCompression({
            at: Date.now(),
            user,
            strength: comp.stats.strength,
            beforeTokens: comp.stats.beforeTokens,
            afterTokens: comp.stats.afterTokens,
            savedPct: comp.stats.savedPct,
            stages: comp.stats.stages,
            notes: comp.stats.notes,
            actualPrompt: u?.prompt_tokens || null,
            actualCompletion: u?.completion_tokens || null,
            cacheHit: u?.cacheHit ?? null,
            estErrPct:
              u?.prompt_tokens && comp.stats.afterTokens
                ? Math.round((comp.stats.afterTokens / u.prompt_tokens - 1) * 1000) / 10
                : null,
          });
        };

        if (!payload.stream) {
          const body = await upstreamRes.text();
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* 上游给了非 JSON，原样透传 */
          }
          settle(
            parsed?.usage
              ? {
                  prompt_tokens: parsed.usage.prompt_tokens || 0,
                  completion_tokens: parsed.usage.completion_tokens || 0,
                  cacheHit: parsed.usage.prompt_cache_hit_tokens || parsed.usage.prompt_tokens_details?.cached_tokens || 0,
                }
              : null,
          );
          res.end(body);
          return;
        }

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        // 上游卡死看门狗：SSE 连接还开着、但 90 秒一个字节都不来（实测遇到过上游挂住，
        // 前端就一直转圈到天荒地老）→ 主动断开，前端会收到明确的错误并显示「重试」。
        const IDLE_MS = Number(process.env.CORTEX_LLM_IDLE_MS || 90000);
        let idleTimer = null;
        const armIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            try {
              res.write(`data: ${JSON.stringify({ error: { message: `上游 ${Math.round(IDLE_MS / 1000)} 秒没有返回任何数据，已主动断开（可重试）` } })}\n\n`);
            } catch {
              /* 连接可能已断 */
            }
            controller.abort();
          }, IDLE_MS);
        };
        let usageBuf = '';
        let upstreamUsage = null;
        try {
          armIdle();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            const text = decoder.decode(value, { stream: true });
            const scanned = scanUsage(text, usageBuf);
            usageBuf = scanned.buf;
            if (scanned.usage) upstreamUsage = scanned.usage;
            res.write(text);
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            res.write(`data: ${JSON.stringify({ error: { message: `流式传输中断：${err.message}` } })}\n\n`);
          }
        } finally {
          clearTimeout(idleTimer);
          res.end();
          // 记账 + 用真实 usage 校准估算器（这样「省了多少」是按真实 token 说话，不是自我估算）
          settle(upstreamUsage);
        }
      })().catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.end();
      });
      return;
    }

    sendJson(res, 404, { error: `未知代理路由 ${route}` });
  };

  return {
    name: 'cortex-llm-proxy',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
