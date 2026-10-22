import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { authApiPlugin } from './server/auth.js';
import { llmProxyPlugin } from './server/llm-proxy.js';
import { fsApiPlugin } from './server/fs-api.js';
import { terminalPlugin } from './server/terminal.js';
import { memoryApiPlugin } from './server/memory-api.js';
import { watchPlugin } from './server/watch.js';
import { execApiPlugin } from './server/exec-api.js';
import { sshApiPlugin } from './server/ssh-api.js';
import { skillsApiPlugin } from './server/skills-api.js';
import { workflowApiPlugin } from './server/workflow.js';
import { attachApiPlugin } from './server/attach-api.js';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 桌面版：优先读 %APPDATA%\Cortex\.env；开发仍可读仓库根 .env
  const envDir = process.env.CORTEX_ENV_DIR || process.cwd();
  const env = {
    ...loadEnv(mode, process.cwd(), ''),
    ...loadEnv(mode, envDir, ''),
  };
  process.env.LLM_API_KEY = env.LLM_API_KEY || env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
  process.env.LLM_BASE_URL = env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
  process.env.LLM_PROVIDER = env.LLM_PROVIDER || 'deepseek';
  process.env.LLM_ALLOW_OVERRIDE = env.LLM_ALLOW_OVERRIDE || '1';
  if (env.CORTEX_WORKSPACE) process.env.CORTEX_WORKSPACE = env.CORTEX_WORKSPACE;
  // 鉴权相关（公网暴露时必填其一）
  for (const k of ['CORTEX_AUTH_TOKEN', 'CORTEX_AUTH_TOKENS', 'CORTEX_AUTH_DEFAULT_USER', 'CORTEX_AUTH_TRUST_USER_HEADER', 'CORTEX_ANN_ENGINE']) {
    if (env[k] !== undefined && env[k] !== '') process.env[k] = env[k];
  }

  // 终端与文件 API 共用同一个工作区根目录
  const workspace = () => process.env.CORTEX_WORKSPACE || process.cwd();
  // 桌面外壳只绑本机回环，避免局域网误扫
  const desktop = process.env.CORTEX_DESKTOP === '1';
  const host = desktop ? '127.0.0.1' : '0.0.0.0';

  return {
    plugins: [
      react(),
      // 鉴权必须最先挂上 /api，否则后面的中间件会先处理未授权请求
      authApiPlugin(),
      llmProxyPlugin(),
      fsApiPlugin(),
      terminalPlugin({ workspace }),
      memoryApiPlugin({ workspace }),
      watchPlugin({ workspace }),
      execApiPlugin({ workspace }),
      sshApiPlugin(),
      skillsApiPlugin({ workspace }),
      workflowApiPlugin({ workspace }),
      attachApiPlugin(),
    ],
    server: {
      host,
      port: 5173,
      // 允许在沙箱预览域名（*.e2b.app）与常见隧道域名下访问
      allowedHosts: true,
    },
    preview: {
      host,
      port: 4173,
      allowedHosts: true,
    },
    build: {
      chunkSizeWarningLimit: 1400,
    },
  };
});
