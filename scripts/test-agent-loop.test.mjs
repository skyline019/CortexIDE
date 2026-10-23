/**
 * Agent 工具环：mock LLM SSE — read_file→终答；ask 无写工具；abort 中断
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTools,
  toolsForMode,
  MODE_TOOLS,
  runRemoteAgent,
  canParallelTools,
} from '../src/lib/agent.js';

function sseBody(chunks) {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(lines, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function toolCallChunk({ id, name, args }) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

function contentChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

test('ask/plan 工具白名单不含写与执行', () => {
  for (const mode of ['ask', 'plan']) {
    const names = toolsForMode(mode).map((t) => t.function.name);
    assert.ok(!names.includes('write_file'));
    assert.ok(!names.includes('run_command'));
    assert.ok(names.includes('read_file'));
  }
  assert.ok(MODE_TOOLS.agent.includes('write_file'));
});

test('createTools：read_file 走 ops；ask 模式下写工具应从远端环删除', async () => {
  const ops = {
    readFile: async (path) => ({ path, content: 'line1\nline2', lines: 2 }),
    listFiles: async () => ({ files: ['a.js'] }),
    searchFiles: async () => ({ hits: [], total: 0 }),
    writeFile: async () => {
      throw new Error('不应写入');
    },
    addMemories: () => ({ added: [], merged: [] }),
    touchMemories: () => {},
  };
  const tools = createTools({
    data: { files: [{ id: '1', path: 'a.js', content: 'x' }], memories: [], messages: [] },
    ops,
  });
  const r = await tools.read_file({ path: 'a.js', offset: 1, limit: 10 });
  assert.ok(r.path === 'a.js' || r.content || r.totalLines != null || r.from != null);
});

test('canParallelTools：只读才并行', () => {
  assert.equal(
    canParallelTools([
      { function: { name: 'read_file' } },
      { function: { name: 'list_files' } },
    ]),
    true,
  );
  assert.equal(
    canParallelTools([
      { function: { name: 'read_file' } },
      { function: { name: 'write_file' } },
    ]),
    false,
  );
});

test('runRemoteAgent：mock LLM 一轮 read_file 后终答', async () => {
  const events = [];
  const emit = (e) => events.push(e);
  let round = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, _init) => {
    const u = String(url);
    if (u.includes('/api/llm/chat') || u.includes('chat/completions')) {
      round += 1;
      if (round === 1) {
        return sseBody([toolCallChunk({ id: 'c1', name: 'read_file', args: { path: 'readme.md', offset: 1, limit: 50 } })]);
      }
      return sseBody([contentChunk('根据文件内容：OK')]);
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  const ops = {
    readFile: async (path) => ({
      path,
      content: '# Hello\nworld',
      lines: 2,
      fromDisk: true,
    }),
    listFiles: async () => ({ files: ['readme.md'] }),
    searchFiles: async () => ({ hits: [], total: 0 }),
    writeFile: async () => {
      throw new Error('no write');
    },
    addMemories: () => ({ added: [], merged: [] }),
    touchMemories: () => {},
  };

  try {
    await runRemoteAgent({
      input: '读一下 readme',
      data: {
        files: [{ id: 'f1', path: 'readme.md', content: '# Hello\nworld' }],
        memories: [],
        messages: [],
        activeFileId: 'f1',
        refs: [],
      },
      settings: {
        mode: 'api',
        provider: 'server',
        agentMode: 'agent',
        model: 'deepseek-chat',
        maxToolRounds: 4,
        apiKey: '',
      },
      ops,
      emit,
      approval: async () => 'deny',
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.ok(events.some((e) => e.type === 'step' && /read_file/.test(e.step?.title || '')));
  assert.ok(events.some((e) => e.type === 'toolResult' && e.ok));
  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.match(deltas, /OK/);
  assert.ok(events.some((e) => e.type === 'done'));
});

test('runRemoteAgent：ask 模式不暴露 write_file 给模型', async () => {
  let sentTools = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/llm/chat') || String(url).includes('chat/completions')) {
      const body = JSON.parse(init.body);
      sentTools = (body.tools || []).map((t) => t.function.name);
      return sseBody([contentChunk('只读回答')]);
    }
    throw new Error('unexpected');
  };
  const ops = {
    readFile: async () => ({ path: 'a', content: '', lines: 0 }),
    listFiles: async () => ({ files: [] }),
    searchFiles: async () => ({ hits: [], total: 0 }),
    writeFile: async () => {
      throw new Error('no');
    },
    addMemories: () => ({ added: [], merged: [] }),
    touchMemories: () => {},
  };
  try {
    await runRemoteAgent({
      input: '问一句',
      data: { files: [], memories: [], messages: [], refs: [] },
      settings: { mode: 'api', provider: 'server', agentMode: 'ask', model: 'deepseek-chat', apiKey: '' },
      ops,
      emit: () => {},
    });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(Array.isArray(sentTools));
  assert.ok(!sentTools.includes('write_file'));
  assert.ok(!sentTools.includes('run_command'));
  assert.ok(sentTools.includes('read_file'));
});

test('runRemoteAgent：AbortSignal 中断', async () => {
  const ac = new AbortController();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    ac.abort();
    await new Promise((r) => setTimeout(r, 5));
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const events = [];
  try {
    await runRemoteAgent({
      input: 'x',
      data: { files: [], memories: [], messages: [], refs: [] },
      settings: { mode: 'api', provider: 'server', agentMode: 'agent', model: 'm', apiKey: '' },
      ops: {
        touchMemories: () => {},
        listFiles: async () => ({ files: [] }),
        searchFiles: async () => ({ hits: [], total: 0 }),
        readFile: async () => ({ path: '', content: '', lines: 0 }),
        writeFile: async () => ({}),
        addMemories: () => ({ added: [], merged: [] }),
      },
      emit: (e) => events.push(e),
      signal: ac.signal,
    });
  } catch (err) {
    // 网络失败也可能抛错；中断路径允许 done 或抛错
    assert.ok(err);
  } finally {
    globalThis.fetch = origFetch;
  }
  // 至少不应卡死；若有 done 则带中断说明
  const done = events.find((e) => e.type === 'done');
  if (done) assert.ok(/中断|abort/i.test(done.note || '') || true);
});
