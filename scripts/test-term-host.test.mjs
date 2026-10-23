/**
 * term-host 子进程：Vite 主进程不得直接加载 node-pty；宿主可 start/kill
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostScript = path.join(root, 'server', 'term-host.mjs');

describe('term-host', () => {
  it('start 后发出 ready，kill 后干净退出', async () => {
    const host = spawn(process.execPath, [hostScript], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    const rl = readline.createInterface({ input: host.stdout, crlfDelay: Infinity });

    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('term-host ready timeout')), 10000);
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            clearTimeout(timer);
            resolve(msg);
          } else if (msg.type === 'error') {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
      host.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      host.stdin.write(JSON.stringify({ op: 'start', cwd: root, cols: 80, rows: 24 }) + '\n');
    });

    assert.equal(typeof ready.shell, 'string');
    assert.equal(typeof ready.cwd, 'string');
    assert.equal(typeof ready.pty, 'boolean');

    const exitCode = await new Promise((resolve) => {
      host.on('exit', (code) => resolve(code));
      host.stdin.write(JSON.stringify({ op: 'kill' }) + '\n');
    });
    rl.close();
    assert.equal(exitCode, 0);
  });
});
