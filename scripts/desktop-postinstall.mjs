/**
 * npm install 后：保证 **Node ABI**（Vite / 测试默认）。
 * Electron ABI 只在桌面启动或打包前切换（见 rebuild:native / predesktop）。
 *
 * 旧行为在此直接 install-app-deps → 开发时加载 Electron 编的 .node → 堆损坏。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'ensure-native-abi.mjs');

const r = spawnSync(process.execPath, [script, '--target=node', '--quiet'], {
  stdio: 'inherit',
  cwd: path.resolve(here, '..'),
  env: process.env,
});
process.exit(r.status === null ? 0 : r.status);
