/**
 * 为 Electron ABI 重编原生模块。失败不阻断 npm install（Windows 常缺 Python/VS Build Tools）。
 * 发版前请手动跑：npm run rebuild:native
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let builderBin;
try {
  builderBin = require.resolve('electron-builder/cli.js');
} catch {
  process.exit(0);
}

const r = spawnSync(process.execPath, [builderBin, 'install-app-deps'], {
  stdio: 'inherit',
  shell: false,
  env: process.env,
});
if (r.status !== 0) {
  console.warn('[cortex] electron native rebuild 未完成（可稍后 npm run rebuild:native）。桌面发版需要 Python + VS Build Tools。');
}
process.exit(0);
