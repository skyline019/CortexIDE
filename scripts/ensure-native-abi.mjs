/**
 * 原生模块 ABI 闸门（根治 Vite 堆损坏）
 *
 * 根因：postinstall 若把 better-sqlite3 / node-pty 编成 Electron ABI，
 * 再用 Node 跑 Vite/测试，dlopen 错 ABI → 0xC0000374 拖死进程。
 *
 * 策略：
 *   - 默认 / --target=node：保证当前 Node 能加载（开发、测试、vite）
 *   - --target=electron：electron-builder install-app-deps（桌面 / 打包前）
 *   - 探测放在子进程：错 ABI 崩的是子进程，不会拖死本进程
 *
 * 用法：
 *   node scripts/ensure-native-abi.mjs --target=node
 *   node scripts/ensure-native-abi.mjs --target=electron --force
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const quiet = args.has('--quiet');
const targetArg = [...args].find((a) => a.startsWith('--target='));
const target = (targetArg?.split('=')[1] || 'node').toLowerCase();

const NATIVE_PKGS = ['better-sqlite3', 'node-pty'];

function log(...xs) {
  if (!quiet) console.log('[cortex-native]', ...xs);
}

/** 子进程探测：当前 Node 能否安全加载原生模块 */
function probeNodeLoad() {
  const code = `
    try {
      require('better-sqlite3');
      require('node-pty');
      process.exit(0);
    } catch (e) {
      console.error(e && e.message ? e.message : e);
      process.exit(2);
    }
  `;
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: process.env,
  });
  if (r.signal || r.status === null) {
    return { ok: false, reason: `probe crashed (${r.signal || 'null status'})` };
  }
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200) };
  }
  return { ok: true };
}

function rebuildForNode() {
  log('rebuild for Node', process.version, 'modules=' + process.versions.modules);
  const r = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['rebuild', ...NATIVE_PKGS],
    { cwd: root, stdio: quiet ? 'pipe' : 'inherit', shell: true, env: process.env, timeout: 600000 },
  );
  if (r.status !== 0) {
    throw new Error(`npm rebuild ${NATIVE_PKGS.join(' ')} failed (exit ${r.status})`);
  }
}

function rebuildForElectron() {
  let builderBin;
  try {
    builderBin = require.resolve('electron-builder/cli.js');
  } catch {
    throw new Error('electron-builder 未安装，无法编 Electron ABI');
  }
  log('rebuild for Electron (install-app-deps)');
  const r = spawnSync(process.execPath, [builderBin, 'install-app-deps'], {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    shell: false,
    env: process.env,
    timeout: 600000,
  });
  if (r.status !== 0) {
    throw new Error(`electron-builder install-app-deps failed (exit ${r.status})`);
  }
}

function main() {
  if (target !== 'node' && target !== 'electron') {
    console.error(`unknown --target=${target} (use node|electron)`);
    process.exit(2);
  }

  if (target === 'electron') {
    if (!force) {
      // 桌面路径总是切到 Electron；探测 Electron 加载成本高，直接编
    }
    try {
      rebuildForElectron();
      log('Electron ABI ready');
      process.exit(0);
    } catch (err) {
      console.warn('[cortex-native]', err.message);
      console.warn('[cortex-native] 可稍后手动：npm run rebuild:native（需 Python + VS Build Tools）');
      // postinstall / predesktop 不因缺编译器失败阻断
      process.exit(args.has('--strict') ? 1 : 0);
    }
  }

  // target=node
  const probe = force ? { ok: false, reason: 'forced' } : probeNodeLoad();
  if (probe.ok) {
    log('Node ABI ok', process.version);
    process.exit(0);
  }
  log('Node ABI mismatch or unloadable:', probe.reason);
  try {
    rebuildForNode();
    const again = probeNodeLoad();
    if (!again.ok) {
      console.warn('[cortex-native] rebuild 后仍无法加载：', again.reason);
      process.exit(args.has('--strict') ? 1 : 0);
    }
    log('Node ABI restored');
    process.exit(0);
  } catch (err) {
    console.warn('[cortex-native]', err.message);
    process.exit(args.has('--strict') ? 1 : 0);
  }
}

main();
