import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, persistState, STORAGE_KEY } from '../state/store.jsx';
import { useToast } from '../state/toast.jsx';
import { checkServerLLM, listServerModels, saveServerCredentials } from '../lib/agent.js';
import { subscribe as subscribeVector, getState as getVectorState, clearIndex, ensureIndex, clearEmbeddingCache } from '../lib/retrieval.js';
import { fsClient } from '../lib/fsClient.js';
import { IconClose, IconGear, IconDownload, IconUpload, IconTrash } from './Icons.jsx';
import MemoryBackendPanel from './MemoryBackendPanel.jsx';
import PersonalizePanel from './PersonalizePanel.jsx';

const PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
  },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'moonshot', label: 'Moonshot', base: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k'] },
  { id: 'custom', label: '自定义', base: '', models: [] },
];

/** 白名单查看 / 增删 */
function ExecAllowEditor() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [input, setInput] = useState('');
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/exec/allowlist');
      const json = await res.json();
      setList(json.allowlist || []);
    } catch {
      setList([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const mutate = async (body) => {
    const res = await fetch('/api/exec/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setList(json.allowlist || []);
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          className="txt"
          placeholder="新增白名单，例如 vitest *"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          className="btn sm"
          onClick={async () => {
            if (!input.trim()) return;
            await mutate({ add: input.trim() });
            setInput('');
            toast('已加入白名单', 'ok');
          }}
        >
          添加
        </button>
      </div>
      <div className="allow-list">
        {(list || []).map((p) => (
          <span key={p} className="allow-chip">
            <code>{p}</code>
            <button
              title="移除"
              onClick={async () => {
                await mutate({ remove: p });
              }}
            >
              ×
            </button>
          </span>
        ))}
        {list && !list.length && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>白名单为空，所有命令都会被拒绝</span>}
      </div>
    </div>
  );
}

export default function SettingsModal({ onClose }) {
  const { state, dispatch, ops } = useApp();
  const { settings } = state;
  const toast = useToast();
  const [tab, setTab] = useState('model');
  const [server, setServer] = useState(null);
  const [models, setModels] = useState([]);
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [vector, setVector] = useState(() => getVectorState());
  const [term, setTerm] = useState(null);
  const [rootInput, setRootInput] = useState(settings.root || '');
  const [serverKey, setServerKey] = useState('');
  const [serverBase, setServerBase] = useState('https://api.deepseek.com/v1');
  const [savingKey, setSavingKey] = useState(false);
  const fileRef = useRef(null);

  const set = (patch) => dispatch({ type: 'settings/set', patch });

  useEffect(() => {
    checkServerLLM().then((s) => {
      setServer(s);
      if (s?.baseUrl) setServerBase(s.baseUrl);
    });
    fsClient.terminalInfo().then(setTerm);
    setRootInput(state.workspace.root || '');
    return subscribeVector(setVector);
  }, [state.workspace.root]);

  const saveServerKey = async () => {
    if (!serverKey.trim()) {
      toast('请填写 API Key', 'err');
      return;
    }
    setSavingKey(true);
    try {
      const r = await saveServerCredentials({
        apiKey: serverKey.trim(),
        baseUrl: serverBase.trim() || 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      setServer({ ...server, ...r, available: true });
      setServerKey('');
      set({ mode: 'api', provider: 'server' });
      toast(`API Key 已保存${r.envFile ? `（${r.envFile}）` : ''}`, 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    } finally {
      setSavingKey(false);
    }
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const list = await listServerModels();
      setModels(list);
      toast(`拉到 ${list.length} 个可用模型`);
      if (list.length && !list.some((m) => m.id === settings.model)) set({ model: list[0].id });
    } catch (err) {
      toast(`拉取模型失败：${err.message}`, 'err');
    } finally {
      setLoadingModels(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await fetch(settings.provider === 'server' ? '/api/llm/chat' : `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.provider === 'server'
            ? settings.accessToken
              ? { Authorization: `Bearer ${settings.accessToken}` }
              : {}
            : { Authorization: `Bearer ${settings.apiKey}` }),
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: 'user', content: '只回复两个字：就绪' }],
          max_tokens: 16,
          stream: false,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const text = json.choices?.[0]?.message?.content?.trim();
      toast(`连接成功 · ${json.model || settings.model} 回复「${text || '空'}」`);
    } catch (err) {
      toast(`连接失败：${err.message}`, 'err');
    } finally {
      setTesting(false);
    }
  };

  const backup = () => {
    const payload = persistState(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cortex-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出工作区备份');
  };

  const restore = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      dispatch({ type: 'state/import', data });
      toast('工作区已恢复');
    } catch (err) {
      toast(`恢复失败：${err.message}`, 'err');
    }
    e.target.value = '';
  };

  const usingServer = settings.mode === 'api' && settings.provider === 'server';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(720px, 94vw)' }}>
        <div className="modal-head">
          <h2>
            <IconGear size={16} /> 设置
          </h2>
          <span className={`pill ${server?.available ? '' : 'warn'}`}>
            <span className="dot" />
            {server === null ? '检测中…' : server.available ? '服务端密钥已配置' : '服务端未配置密钥'}
          </span>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>
        <div className="mem-tabs" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
          {[
            ['model', '模型与 Agent'],
            ['memory', '记忆与向量'],
            ['personal', '个性化 · 省 token'],
            ['exec', '命令与监听'],
            ['workspace', '工作区与终端'],
            ['data', '数据与持久化'],
          ].map(([id, label]) => (
            <button key={id} className={`mem-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === 'model' && (
            <>
              <div className="form-row">
                <label>运行模式</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={`btn ${settings.mode === 'api' ? 'primary' : ''}`} onClick={() => set({ mode: 'api' })}>
                    真实模型（DeepSeek）
                  </button>
                  <button className={`btn ${settings.mode === 'local' ? 'primary' : ''}`} onClick={() => set({ mode: 'local' })}>
                    本地规则引擎（离线兜底）
                  </button>
                </div>
                <div className="hint">
                  推荐「服务端代理」：在下方填写 API Key 点保存即可（桌面版写入 %APPDATA%\Cortex\.env）。
                  浏览器直连则把 Key 存在本机 localStorage。请求经 <code>/api/llm/chat</code> 代理时无 CORS 问题。
                </div>
              </div>

              {settings.mode === 'api' && (
                <>
                  <div className="form-row">
                    <label>密钥来源</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className={`btn ${settings.provider === 'server' ? 'primary' : ''}`} onClick={() => set({ provider: 'server' })}>
                        服务端代理（推荐）
                      </button>
                      <button className={`btn ${settings.provider === 'custom' ? 'primary' : ''}`} onClick={() => set({ provider: 'custom' })}>
                        浏览器直连（自填 Key）
                      </button>
                    </div>
                    {settings.provider === 'server' && (
                      <div className="hint">
                        {server?.available || server?.configured
                          ? `已配置 · ${server.baseUrl || serverBase}${server.keyHint ? ` · ${server.keyHint}` : ''}`
                          : '尚未配置上游密钥。在下方填写后点「保存到本机」，桌面版会写入 %APPDATA%\\Cortex\\.env。'}
                      </div>
                    )}
                  </div>

                  {settings.provider === 'server' && (
                    <div className="form-row llm-cred-box">
                      <label>上游 API Key（必填）</label>
                      <div className="grid2">
                        <div className="form-row" style={{ margin: 0 }}>
                          <label>Base URL</label>
                          <input
                            value={serverBase}
                            onChange={(e) => setServerBase(e.target.value)}
                            placeholder="https://api.deepseek.com/v1"
                          />
                        </div>
                        <div className="form-row" style={{ margin: 0 }}>
                          <label>API Key</label>
                          <input
                            type="password"
                            value={serverKey}
                            onChange={(e) => setServerKey(e.target.value)}
                            placeholder={server?.keyHint ? `已保存 ${server.keyHint}，留空不改` : 'sk-...'}
                            autoComplete="off"
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <button type="button" className="btn primary" disabled={savingKey} onClick={saveServerKey}>
                          {savingKey ? '保存中…' : '保存到本机'}
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            setServerBase('https://api.deepseek.com/v1');
                            set({ model: 'deepseek-flash', provider: 'server', mode: 'api' });
                          }}
                        >
                          DeepSeek 默认（含视觉）
                        </button>
                      </div>
                      <div className="hint">
                        密钥只写在本机环境文件里（{server?.envFile || '%APPDATA%\\Cortex\\.env'}），不会进浏览器 localStorage。
                        保存后可点下方「测试连接」。
                      </div>
                    </div>
                  )}

                  <div className="form-row">
                    <label>访问令牌（公网鉴权）</label>
                    <input
                      type="password"
                      value={settings.accessToken || ''}
                      onChange={(e) => set({ accessToken: e.target.value })}
                      placeholder="服务端 CORTEX_AUTH_TOKEN 相同时填写"
                      autoComplete="off"
                    />
                    <div className="hint">
                      与上游 LLM Key 无关。服务端设置了 <code>CORTEX_AUTH_TOKEN</code> / <code>CORTEX_AUTH_TOKENS</code> 时必填；
                      仅靠 <code>x-cortex-user</code> 不能通过鉴权。本地未开鉴权时可留空。
                    </div>
                  </div>

                  {settings.provider === 'custom' && (
                    <>
                      <div className="form-row">
                        <label>服务商预设</label>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {PRESETS.filter((p) => p.base).map((p) => (
                            <button
                              key={p.id}
                              className={`btn sm ${settings.baseUrl === p.base ? 'primary' : ''}`}
                              onClick={() => set({ baseUrl: p.base, model: p.models[0] })}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="grid2">
                        <div className="form-row">
                          <label>Base URL</label>
                          <input value={settings.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
                        </div>
                        <div className="form-row">
                          <label>API Key</label>
                          <input
                            type="password"
                            value={settings.apiKey}
                            onChange={(e) => set({ apiKey: e.target.value })}
                            placeholder="sk-..."
                          />
                        </div>
                      </div>
                      <div className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
                        直连模式下密钥保存在本机 localStorage，仅在你填写的端点使用；如果上游不允许浏览器跨域，请改用服务端代理。
                      </div>
                    </>
                  )}

                  <div className="form-row">
                    <label>模型 ID（可自由填写，不限 DeepSeek）</label>
                    <div className="sel-model">
                      <input
                        list="settings-model-suggestions"
                        value={settings.model}
                        onChange={(e) => set({ model: e.target.value })}
                        placeholder="deepseek-flash / gpt-4o-mini / 任意兼容 ID"
                        style={{ flex: 1, minWidth: 160 }}
                      />
                      <datalist id="settings-model-suggestions">
                        {[...new Set([settings.model, 'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner', ...models.map((m) => m.id)])]
                          .filter(Boolean)
                          .map((id) => (
                            <option key={id} value={id} />
                          ))}
                      </datalist>
                      <button className="btn sm" onClick={fetchModels} disabled={loadingModels}>
                        {loadingModels ? '拉取中…' : '拉取模型列表'}
                      </button>
                      <button className="btn sm primary" onClick={testConnection} disabled={testing}>
                        {testing ? '测试中…' : '测试连接'}
                      </button>
                    </div>
                    <div className="hint">Base URL + API Key 决定上游；模型名按该端点文档填写即可。</div>
                  </div>

                  <div className="grid2">
                    <div className="form-row">
                      <label>温度（temperature）：{Number(settings.temperature ?? 0.3).toFixed(1)}</label>
                      <input
                        type="range"
                        min="0"
                        max="1.5"
                        step="0.1"
                        value={settings.temperature ?? 0.3}
                        onChange={(e) => set({ temperature: Number(e.target.value) })}
                      />
                      <div className="hint">写代码建议 0.2–0.4；头脑风暴可以调到 0.8+。</div>
                    </div>
                    <div className="form-row">
                      <label>单轮最大工具调用轮数：{settings.maxToolRounds ?? 8}</label>
                      <input
                        type="range"
                        min="2"
                        max="16"
                        step="1"
                        value={settings.maxToolRounds ?? 8}
                        onChange={(e) => set({ maxToolRounds: Number(e.target.value) })}
                      />
                      <div className="hint">每轮可以并行调用多个工具，超过上限会停下来等你追加指令。</div>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'workspace' && (
            <>
              <div className="form-row">
                <label>工作区来源</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className={`btn ${state.workspace.mode === 'real' ? 'primary' : ''}`}
                    onClick={async () => {
                      await dispatch({ type: 'ws/set', patch: { mode: 'real' } });
                      await ops.connect({ mode: 'real', root: state.workspace.root || undefined });
                      toast('已切换到真实目录模式', 'ok');
                    }}
                  >
                    真实目录（磁盘 + 终端）
                  </button>
                  <button
                    className={`btn ${state.workspace.mode === 'virtual' ? 'primary' : ''}`}
                    onClick={() => {
                      dispatch({ type: 'ws/set', patch: { mode: 'virtual' } });
                      dispatch({ type: 'state/reset' });
                      toast('已切换到浏览器沙盒（演示文件）');
                    }}
                  >
                    浏览器沙盒
                  </button>
                </div>
                <div className="hint">
                  真实目录模式下，文件读写、搜索、终端和 Agent 的 read_file / write_file 全部作用于服务器的真实文件系统；
                  沙盒模式则完全在浏览器内存里跑，适合演示。
                </div>
              </div>

              <div className="form-row">
                <label>工作区根目录</label>
                <div className="sel-model">
                  <input value={rootInput} onChange={(e) => setRootInput(e.target.value)} placeholder="/home/you/project" />
                  <button
                    className="btn sm primary"
                    onClick={async () => {
                      const ok = await ops.connect({ root: rootInput, mode: 'real' });
                      toast(ok ? `已连接到 ${rootInput}` : '连接失败，检查路径', ok ? 'ok' : 'err');
                    }}
                  >
                    连接
                  </button>
                </div>
                <div className="hint">
                  当前：<code>{state.workspace.root || '未连接'}</code>
                  {state.workspace.error ? ` · ${state.workspace.error}` : ''}
                  <br />
                  所有路径都会被校验，越出根目录的请求会被服务端拒绝。
                </div>
              </div>

              <div className="form-row">
                <label>终端</label>
                <div className="hint">
                  {term
                    ? `shell: ${term.shell} · ${term.pty ? 'node-pty 已启用（完整交互）' : '降级为管道模式'} · ${term.platform}`
                    : '终端服务不可用'}
                  <br />
                  走 WebSocket（<code>/api/term</code>），支持 ANSI 颜色、resize、Ctrl+C，窗口关闭时自动回收进程。
                </div>
              </div>
            </>
          )}

          {tab === 'personal' && <PersonalizePanel userId={settings.userId || 'local'} />}
          {tab === 'memory' && (
            <>
              <label className="switch">
                <input type="checkbox" checked={settings.autoMemory} onChange={(e) => set({ autoMemory: e.target.checked })} />
                自动记忆：从对话中蒸馏事实 / 偏好 / 待办（模型也会主动调用 remember 工具）
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.autoSessionSummary}
                  onChange={(e) => set({ autoSessionSummary: e.target.checked })}
                />
                会话归档时生成情节记忆
              </label>
              <div className="form-row" style={{ marginTop: 14 }}>
                <label>每轮注入的记忆条数（topK）：{settings.topK}</label>
                <input type="range" min="2" max="12" value={settings.topK} onChange={(e) => set({ topK: Number(e.target.value) })} />
                <div className="hint">
                  检索分数 = 0.62·向量相似度 + 0.18·重要度 + 0.12·新鲜度 + 0.08·频次；分数最高的若干条会被拼进 system prompt。
                </div>
              </div>

              <div className="form-row" style={{ marginTop: 16 }}>
                <label>检索模式</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    ['hybrid', '混合（BM25 + 向量 · RRF）'],
                    ['vector', '只用向量'],
                    ['bm25', '只用 BM25'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={`btn sm ${settings.retrievalMode === id ? 'primary' : ''}`}
                      onClick={() => set({ retrievalMode: id })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="hint">
                  混合检索把「向量 KNN 名次」和「BM25 名次」用 RRF（1/(60+rank) 求和）融合，
                  专有名词、命令、文件名这类字面长尾 query 靠 BM25 兜住，语义改写靠向量兜住。
                  记忆库里的每条召回都会标注 <code>V3 B1</code>（向量第 3 / BM25 第 1）。
                </div>
              </div>

              <MemoryBackendPanel />

              <div className="form-row" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
                <label>向量化方案</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    ['auto', '自动（推荐）'],
                    ['neural', '神经嵌入 bge-small-zh'],
                    ['lexical', '本地哈希向量'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={`btn sm ${settings.embedProvider === id ? 'primary' : ''}`}
                      onClick={() => {
                        set({ embedProvider: id });
                        clearIndex();
                        ensureIndex(state.memories, { force: true, provider: id });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="hint">
                  神经嵌入在 Web Worker 里跑 <code>bge-small-zh-v1.5</code>（q8，约 24MB，首次使用从 HuggingFace 下载并缓存），
                  512 维、中文语义效果好；不可用时自动回落到本地哈希向量（256 维、离线可用）。
                </div>
              </div>

              <div className="ins-section" style={{ marginTop: 10 }}>
                <div className="kv">
                  <span className="k">当前引擎</span>
                  <span className="v">{vector.provider === 'neural' ? '神经嵌入 512d' : vector.provider === 'lexical' ? '哈希向量 256d' : '未初始化'}</span>
                </div>
                <div className="kv">
                  <span className="k">已索引</span>
                  <span className="v">
                    {vector.count} / {state.memories.length} 条{vector.state === 'building' ? ` · ${vector.progress}%` : ''}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">索引占用</span>
                  <span className="v">{vector.stats?.memoryMb ?? 0} MB · 缓存 {vector.cache} 条</span>
                </div>
                <div className="kv">
                  <span className="k">建索引耗时</span>
                  <span className="v">{vector.embedMs ? `${vector.embedMs}ms` : '—'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      clearIndex();
                      await ensureIndex(state.memories, { force: true, provider: settings.embedProvider });
                      toast('索引已重建', 'mem');
                    }}
                  >
                    重建索引
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => {
                      clearEmbeddingCache();
                      clearIndex();
                      toast('嵌入缓存已清空');
                    }}
                  >
                    清空嵌入缓存
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'exec' && (
            <>
              <div className="form-row">
                <label>当前用户（记忆隔离）</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(state.backend.users.length ? state.backend.users : [{ id: 'local' }])
                    .filter((u) => !String(u.id).startsWith('__'))
                    .map((u) => (
                    <button
                      key={u.id}
                      className={`btn sm ${settings.userId === u.id ? 'primary' : ''}`}
                      onClick={async () => {
                        const n = await ops.switchUser(u.id);
                        toast(`已切换到 ${u.id}（${n} 条记忆）`, 'mem');
                      }}
                    >
                      {u.id}
                      {u.memories !== undefined ? ` · ${u.memories}` : ''}
                    </button>
                  ))}
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const id = prompt('新用户 ID（只允许字母/数字/-/_）：');
                      if (!id) return;
                      if (!/^[\w-]{1,32}$/.test(id)) return toast('ID 不合法', 'err');
                      const n = await ops.switchUser(id);
                      toast(`已创建并切换到 ${id}`, 'mem');
                      return n;
                    }}
                  >
                    + 新建用户
                  </button>
                </div>
                <div className="hint">
                  记忆分区用 <code>x-cortex-user</code>（SQL 强制 user + workspace）；公网暴露时还必须带访问令牌，
                  禁止只靠用户头冒充。多用户令牌表（<code>CORTEX_AUTH_TOKENS</code>）下身份由令牌决定。
                  不同用户的记忆物理隔离在同一个 <code>.cortex/memory.db</code> 里，互不可见。
                </div>
              </div>

              <div className="ins-section" style={{ marginTop: 14 }}>
                <div className="kv">
                  <span className="k">向量后端</span>
                  <span className="v">
                    {state.backend.status?.backend || '未连接'}
                    {state.backend.status?.partitionKey ? ` · 分区键 ${state.backend.status.partitionKey}` : ''}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">BM25 / FTS5</span>
                  <span className="v">{state.backend.status?.bm25 ? '已启用（hybrid）' : '不可用（仅向量）'}</span>
                </div>
                <div className="kv">
                  <span className="k">服务端记忆</span>
                  <span className="v">
                    {state.backend.status ? `${state.backend.status.total} 条 · ${state.backend.status.vectors} 向量` : '—'}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">数据库</span>
                  <span className="v" style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>
                    {state.backend.status?.dbPath || '—'}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">同步状态</span>
                  <span className="v">{state.backend.syncing ? '同步中…' : state.backend.lastSync?.error ? `失败：${state.backend.lastSync.error}` : state.backend.lastSync?.at ? `已同步 ${state.backend.lastSync.pushed} 条` : '空闲'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const ok = await ops.connectMemory({ user: settings.userId });
                      toast(ok ? '已连接 sqlite-vec' : '服务端记忆库不可用，已回落到本地索引', ok ? 'mem' : 'err');
                    }}
                  >
                    重新连接
                  </button>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await ops.syncMemories(state.memories);
                      toast('已全量推送本地记忆到服务端', 'mem');
                    }}
                  >
                    全量同步
                  </button>
                </div>
              </div>

              <div className="form-row" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
                <label>命令执行</label>
                <div className="hint" style={{ marginTop: 0 }}>
                  Agent 调用 <code>run_command</code> 时会弹确认卡：显示命令、命中的白名单规则和风险提示。
                  选「始终允许」会把该命令写法追加进 <code>.cortex/exec-allowlist.json</code>。
                  服务端另有硬拦截：shell 拼接/重定向（<code>; | &amp; &gt; &lt; ` $(</code>）、<code>rm</code>、<code>sudo</code>、<code>dd</code>、<code>curl</code>、<code>-delete</code> 等一律拒绝；
                  命令以 argv 形式执行（不经过 shell），超时 120s，输出上限 256KB。
                </div>
                <ExecAllowEditor />
              </div>

              <div className="ins-section" style={{ marginTop: 10 }}>
                <div className="kv">
                  <span className="k">文件监听</span>
                  <span className="v">{state.workspace.watch === 'connected' ? 'WebSocket 已连接（chokidar）' : '未连接'}</span>
                </div>
                <div className="kv">
                  <span className="k">最近事件</span>
                  <span className="v">
                    {state.workspace.lastFsEvent
                      ? `${state.workspace.lastFsEvent.count} 个 · ${new Date(state.workspace.lastFsEvent.at).toLocaleTimeString()}`
                      : '—'}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">监听根目录</span>
                  <span className="v" style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>{state.workspace.watchRoot || state.workspace.root || '—'}</span>
                </div>
              </div>
            </>
          )}

          {tab === 'data' && (
            <>
              <div className="form-row">
                <label>持久化</label>
                <div className="hint">
                  所有文件、对话、记忆、设置都写在浏览器 <code>localStorage</code>（key: <code>{STORAGE_KEY}</code>），
                  每次修改后 350ms 防抖落盘，刷新 / 重开浏览器后自动恢复。
                  <br />
                  当前：{state.files.length} 个文件 · {state.messages.length} 条消息 · {state.memories.length} 条记忆 ·{' '}
                  {(new Blob([localStorage.getItem(STORAGE_KEY) || '']).size / 1024).toFixed(1)} KB
                  {usingServer && (
                    <>
                      <br />
                      <span className="badge-ok">✓ 密钥未写入浏览器</span>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={backup}>
                  <IconDownload size={12} /> 导出工作区
                </button>
                <button className="btn" onClick={() => fileRef.current?.click()}>
                  <IconUpload size={12} /> 导入工作区
                </button>
                <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={restore} />
                <button
                  className="btn danger"
                  onClick={() => {
                    if (!confirm('确定要清空所有文件、对话与记忆吗？此操作不可撤销。')) return;
                    dispatch({ type: 'state/reset' });
                    toast('已恢复出厂状态', 'err');
                  }}
                >
                  <IconTrash size={12} /> 重置全部数据
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
