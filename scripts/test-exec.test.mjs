/**
 * 命令执行层的单元测试（node:test，不联网、不启服务）
 *
 * 这一层的失败最阴险：命令被**静默改写**，Agent 在界面上贴的命令看着完全正常，
 * 结果却对不上。真机测试里就是这样发现 `\n` 被吞掉、`s.split('\n')` 变成 `s.split('n')`，
 * 于是「文件 619 行」被答成「792 行」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { tokenize, checkCommand } from '../server/exec-api.js';

test('tokenize：双引号里的 \\n 必须原样保留（不能变成 n）', () => {
  const argv = tokenize(`node -e "console.log('a\\\\nb'.split('\\\\n').length)"`);
  assert.deepEqual(argv.slice(0, 2), ['node', '-e']);
  assert.ok(argv[2].includes("split('\\n')"), `反斜杠被吃掉了：${argv[2]}`);
  assert.ok(!argv[2].includes("split('n')"), '\\n 被降级成了 n');
});

test('tokenize：真跑一遍，确认结果和预期一致（不是只看字符串）', () => {
  const argv = tokenize(`node -e "console.log('a\\\\nb'.split('\\\\n').length)"`);
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '2', `实际输出：${JSON.stringify(r.stdout)} ${r.stderr}`);
});

test('tokenize：转义的双引号照常工作', () => {
  const cmd = `node -e "console.log(\\"hi\\")"`;
  const argv = tokenize(cmd);
  assert.equal(argv[2], 'console.log("hi")');
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'hi'); // console.log("hi") 打印的是 hi，引号只是 JS 语法
});

test('tokenize：单引号里的一切都是字面量（含 $ 和空格）', () => {
  assert.deepEqual(tokenize(`echo 'a $HOME b'`), ['echo', 'a $HOME b']);
});

test('tokenize：空参数不会被吞掉', () => {
  assert.deepEqual(tokenize(`echo "" x`), ['echo', '', 'x']);
});

test('checkCommand：引号内的元字符放行，引号外的一律拒绝', () => {
  const root = process.cwd();
  assert.equal(checkCommand(`node -e "const a = [1,2]; console.log(a.length)"`, root).ok, true, '引号内的分号被误拦');
  assert.equal(checkCommand('node -e "console.log(1)" && rm -rf /', root).ok, false, '引号外的 && 没被拦');
  assert.equal(checkCommand('echo hi; rm -rf /', root).ok, false, '引号外的分号没被拦');
  assert.equal(checkCommand('node -e "console.log(1)" > out.txt', root).ok, false, '重定向没被拦');
  assert.equal(checkCommand(`node -e "console.log($(whoami))"`, root).ok, true, '引号内的 $( ) 属于被执行的程序，允许');
});

test('checkCommand：引号没闭合直接拒绝（否则没法判断边界）', () => {
  const r = checkCommand('node -e "console.log(1)', process.cwd());
  assert.equal(r.ok, false);
  assert.match(r.reason, /引号/);
});

test('DENY 是字符串级匹配：连引号里的 rm 文字也会被拦（宁可误伤）', () => {
  assert.equal(checkCommand('echo "rm -rf /"', process.cwd()).ok, false);
});

test('已知取舍：白名单放行 `node *`，等价于允许任意代码执行（这不是沙箱）', () => {
  // 写成一个测试而不是只写在文档里：免得哪天有人以为「有白名单 = 安全」。
  // 真正的隔离靠执行沙箱（docker / 副本目录），README 里已如实标注降级路径。
  const r = checkCommand(`node -e "require('fs').rmSync('x', {recursive:true})"`, process.cwd());
  assert.equal(r.ok, true, '如果这里变成 false，说明白名单收紧了，请同步更新文档');
});

test('checkCommand：白名单之外的一律拒绝', () => {
  const r = checkCommand('python3 -c "print(1)"', process.cwd());
  assert.equal(r.ok, false);
  assert.match(r.reason, /白名单/);
});

test('负向：危险删除模式 DENY', () => {
  const root = process.cwd();
  assert.equal(checkCommand('rm -rf /', root).ok, false);
  assert.equal(checkCommand('del /s /q C:\\Windows', root).ok, false);
});

test('负向：管道与命令替换在引号外拒绝', () => {
  const root = process.cwd();
  assert.equal(checkCommand('echo hi | cat', root).ok, false);
  assert.equal(checkCommand('echo $(whoami)', root).ok, false);
});
