/**
 * 提示词 / 技能的客户端封装。
 *
 * 原则：**前端不缓存、不止一份副本**。每次发请求前都重新问服务端要合成结果，
 * 于是「设置里改的提示词」和「这一刻真正发给模型的文本」永远是同一份。
 * 单次合成是本地文件读 + 字符串拼接（<1ms），没有性能顾虑。
 */

const j = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

/** 合成当前生效的系统提示词 */
export async function composePrompt({ mode = 'agent', skills, withSkills = true } = {}) {
  const res = await fetch('/api/prompt/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, skills, withSkills }),
  });
  return j(res);
}

/** 提示词原文（系统基座 / 覆盖稿 / 当前工作区） */
export async function fetchPrompts() {
  return j(await fetch('/api/prompt'));
}

export async function savePrompt({ scope, text, mode }) {
  return j(
    await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, text, mode }),
    }),
  );
}

/** 技能列表（系统 + 当前） */
export async function fetchSkills() {
  return j(await fetch('/api/skills'));
}

export async function toggleSkill(id, enabled) {
  return j(
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', id, enabled }),
    }),
  );
}

export async function saveSkill(skill) {
  return j(
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', skill }),
    }),
  );
}

export async function deleteSkill(id) {
  return j(
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 工作流                                                              */
/* ------------------------------------------------------------------ */

export async function fetchWorkflows() {
  return j(await fetch('/api/workflow'));
}

export async function fetchWorkflow(id) {
  return j(await fetch(`/api/workflow/get?id=${encodeURIComponent(id)}`));
}

export async function saveWorkflow(workflow) {
  return j(
    await fetch('/api/workflow/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow }),
    }),
  );
}

export async function deleteWorkflow(id) {
  return j(
    await fetch('/api/workflow/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
  );
}

export async function validateWorkflow(workflow) {
  return j(
    await fetch('/api/workflow/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow }),
    }),
  );
}

export async function fetchRuns(limit = 20) {
  return j(await fetch(`/api/workflow/runs?limit=${limit}`));
}

/**
 * 跑一次工作流，边跑边回调事件（SSE over POST）。
 * 返回最终结果（含产物文本）。
 */
export async function runWorkflow({ workflow, id, input, onEvent, signal }) {
  const res = await fetch('/api/workflow/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workflow ? { workflow, input } : { id, input }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final = { ok: false, output: '' };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === 'run-done') final = { ok: true, output: ev.output || '', ms: ev.ms, chars: ev.chars };
      if (ev.type === 'run-error') final = { ok: false, error: ev.error };
      if (ev.type === 'end') final.ok = final.ok && ev.ok !== false;
      onEvent?.(ev);
    }
  }
  return final;
}
