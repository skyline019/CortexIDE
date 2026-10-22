/**
 * 提示词 / 技能 API。
 *
 * 前端不保存任何一份「提示词副本」：它每次改动后重新拉 /api/prompt/compose，
 * 于是「界面上看到的合成结果」与「真正发给模型的文本」永远是同一份。
 */
import { readPrompts, writePrompt, composeSystemPrompt, listSkills, setSkillEnabled, upsertWorkspaceSkill, deleteWorkspaceSkill, MODES, MODE_ORDER } from './prompts.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) reject(new Error('请求体过大'));
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

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function skillsApiPlugin({ workspace }) {
  const root = () => workspace() || process.cwd();

  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/prompt') && !p.startsWith('/api/skills')) return next();

    const handle = async () => {
      /* ---------------- 提示词 ---------------- */
      if (p === '/api/prompt' && req.method === 'GET') {
        return sendJson(res, 200, await readPrompts(root()));
      }
      if (p === '/api/prompt' && req.method === 'POST') {
        const body = await readBody(req);
        const scope = body.scope === 'system' ? 'system' : 'workspace';
        const r = await writePrompt(root(), scope, body.text);
        const after = await composeSystemPrompt({ root: root(), mode: body.mode || 'agent' });
        return sendJson(res, 200, { ok: true, ...r, compose: after });
      }
      if (p === '/api/prompt/compose' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const mode = String(body.mode || url.searchParams.get('mode') || 'agent');
        const skills = Array.isArray(body.skills)
          ? body.skills
          : url.searchParams.get('skills')
            ? url.searchParams.get('skills').split(',').filter(Boolean)
            : undefined;
        const composed = await composeSystemPrompt({
          root: root(),
          mode,
          skills,
          withSkills: body.withSkills !== false,
        });
        return sendJson(res, 200, composed);
      }

      /* ---------------- 技能 ---------------- */
      if (p === '/api/skills' && req.method === 'GET') {
        const list = await listSkills(root());
        return sendJson(res, 200, { ...list, modes: MODES, order: MODE_ORDER });
      }
      if (p === '/api/skills' && req.method === 'POST') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (action === 'toggle') {
          await setSkillEnabled(root(), String(body.id || ''), Boolean(body.enabled));
        } else if (action === 'save') {
          const r = await upsertWorkspaceSkill(root(), body.skill || body);
          const list = await listSkills(root());
          return sendJson(res, 200, { ok: true, ...r, ...list });
        } else if (action === 'delete') {
          const r = await deleteWorkspaceSkill(root(), String(body.id || ''));
          const list = await listSkills(root());
          return sendJson(res, 200, { ok: true, ...r, ...list });
        } else {
          return sendJson(res, 400, { error: `未知操作：${action}` });
        }
        const list = await listSkills(root());
        return sendJson(res, 200, { ok: true, ...list });
      }

      return sendJson(res, 404, { error: `未知路由 ${req.method} ${p}` });
    };

    handle().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  };

  return {
    name: 'cortex-skills-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default skillsApiPlugin;
