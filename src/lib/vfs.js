/** 虚拟文件系统：内存中的工作区 + 持久化到 localStorage */

export const LANG_BY_EXT = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  svg: 'html',
  txt: 'plaintext',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  py: 'python',
  rs: 'rust',
  go: 'go',
};

export const LANG_LABEL = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  markdown: 'Markdown',
  css: 'CSS',
  html: 'HTML',
  plaintext: '纯文本',
  yaml: 'YAML',
  toml: 'TOML',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
};

export function extOf(path) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path || '');
  return m ? m[1].toLowerCase() : '';
}

export function langOf(path) {
  return LANG_BY_EXT[extOf(path)] || 'plaintext';
}

export function baseName(path) {
  return (path || '').split('/').filter(Boolean).pop() || path;
}

export function dirOf(path) {
  const parts = (path || '').split('/');
  parts.pop();
  return parts.join('/');
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
}

export function fileIcon(path) {
  const e = extOf(path);
  if (['jsx', 'tsx', 'js', 'mjs', 'ts'].includes(e)) return { glyph: e === 'ts' || e === 'tsx' ? 'TS' : 'JS', color: '#f7df1e' };
  if (e === 'json') return { glyph: '{}', color: '#8be9a8' };
  if (e === 'md') return { glyph: 'M↓', color: '#7dd3fc' };
  if (e === 'css') return { glyph: '#', color: '#c084fc' };
  if (e === 'html') return { glyph: '<>', color: '#fb923c' };
  return { glyph: '·', color: '#94a3b8' };
}

const now = Date.now();

export function seedFiles() {
  return [
    {
      id: 'f_readme',
      path: 'README.md',
      content: `# Nimbus 任务看板

一个使用 **React 19 + Vite** 构建的内部任务看板。

## 约定
- 组件放在 \`src/components/\`，一律函数式组件 + hooks
- 数据请求统一走 \`src/lib/api.ts\`
- 提交信息使用中文，禁止 emoji
- 所有新组件必须提供 loading / empty / error 三种状态

## 启动
\`\`\`bash
npm install
npm run dev
\`\`\`

## 待办
- [ ] 看板拖拽排序
- [ ] 任务详情抽屉
- [ ] 与 /api/v2 后端联调
`,
      updatedAt: now - 86400000 * 3,
      savedAt: now - 86400000 * 3,
    },
    {
      id: 'f_app',
      path: 'src/App.jsx',
      content: `import { useEffect, useState } from 'react';
import TaskList from './components/TaskList.jsx';
import { fetchTasks } from './lib/api.js';

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let alive = true;
    fetchTasks()
      .then((data) => alive && (setTasks(data), setState('ready')))
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
    };
  }, []);

  if (state === 'loading') return <p className="muted">加载中…</p>;
  if (state === 'error') return <p className="error">加载失败，请重试</p>;

  return (
    <main className="board">
      <h1>任务看板</h1>
      <TaskList tasks={tasks} />
    </main>
  );
}
`,
      updatedAt: now - 3600000 * 5,
      savedAt: now - 3600000 * 5,
    },
    {
      id: 'f_tasklist',
      path: 'src/components/TaskList.jsx',
      content: `export default function TaskList({
  tasks = [],
  loading = false,
  error = null,
  onToggle,
  onDelete,
}) {
  // 加载中：优先于空状态，避免闪一下"还没有任务"
  if (loading) {
    return (
      <div className="task-state" role="status" aria-live="polite">
        <p className="muted">加载任务中…</p>
      </div>
    );
  }

  // 错误状态：把后端错误原样透出，方便排查
  if (error) {
    return (
      <div className="task-state" role="alert">
        <p className="error">任务加载失败：{error.message || String(error)}</p>
      </div>
    );
  }

  // 空状态：没有任务时给出提示，而不是渲染一个空列表
  if (!tasks.length) {
    return (
      <div className="task-empty">
        <p className="muted">还没有任务</p>
        <p className="muted small">新建一个任务，或者从别处导入。</p>
      </div>
    );
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.id} className={task.done ? 'done' : ''}>
          <label>
            <input
              type="checkbox"
              checked={Boolean(task.done)}
              onChange={() => onToggle?.(task.id)}
            />
            {task.title}
          </label>
          <button
            type="button"
            className="task-del"
            title="删除任务"
            aria-label={\`删除任务：\${task.title}\`}
            disabled={!onDelete}
            onClick={(e) => {
              // 阻止冒泡，避免触发未来可能加上的整行点击
              e.stopPropagation();
              onDelete?.(task.id);
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
`,
      updatedAt: now - 3600000 * 9,
      savedAt: now - 3600000 * 9,
    },
    {
      id: 'f_api',
      path: 'src/lib/api.js',
      content: `const BASE = '/api/v2';

export async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();
}

export const fetchTasks = () => request('/tasks');
export const updateTask = (id, patch) =>
  request(\`/tasks/\${id}\`, { method: 'PATCH', body: JSON.stringify(patch) });
`,
      updatedAt: now - 3600000 * 26,
      savedAt: now - 3600000 * 26,
    },
    {
      id: 'f_arch',
      path: 'docs/architecture.md',
      content: `# 架构说明

## 前端
- React 19 + Vite，无状态管理库，注意 Context 只用于主题
- 所有请求走 \`src/lib/api.js\` 的 \`request\` 封装，禁止直接 fetch

## 后端
- 基础路径 \`/api/v2\`，鉴权使用 Bearer Token
- 任务表主键为 uuid，软删除字段 \`deleted_at\`

## 决策记录
- 2026-03-02 放弃 Redux，改用 hooks + 局部 Context
- 2026-04-18 拖拽排序选用 dnd-kit，而非 react-beautiful-dnd
`,
      updatedAt: now - 86400000,
      savedAt: now - 86400000,
    },
    {
      id: 'f_pkg',
      path: 'package.json',
      content: `{
  "name": "nimbus-board",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  }
}
`,
      updatedAt: now - 86400000 * 6,
      savedAt: now - 86400000 * 6,
    },
  ];
}

export function newFileTemplate(path) {
  const lang = langOf(path);
  const name = baseName(path).replace(/\.[^.]+$/, '');
  switch (lang) {
    case 'javascript':
      if (/\.(jsx|tsx)$/.test(path)) {
        return `export default function ${name}() {
  return (
    <div>
      <p>${name}</p>
    </div>
  );
}
`;
      }
      return `export function ${name}() {\n  // TODO\n}\n`;
    case 'json':
      return `{\n  "name": "${name}"\n}\n`;
    case 'markdown':
      return `# ${name}\n\n`;
    case 'css':
      return `/* ${name} */\n`;
    case 'html':
      return `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8" /><title>${name}</title></head>\n<body></body>\n</html>\n`;
    default:
      return '';
  }
}
