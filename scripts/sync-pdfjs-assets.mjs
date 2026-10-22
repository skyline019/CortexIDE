/**
 * 把 pdfjs-dist 的 cmaps / standard_fonts 拷到 public/pdfjs，
 * 供离线 Electron / Vite 以稳定 URL 加载（避免 ?url 只打包单个文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'node_modules', 'pdfjs-dist');

function copyDir(from, to) {
  if (!fs.existsSync(from)) {
    console.warn('skip missing', from);
    return 0;
  }
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) n += copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      n += 1;
    }
  }
  return n;
}

if (!fs.existsSync(srcRoot)) {
  console.warn('pdfjs-dist not installed, skip sync-pdfjs-assets');
  process.exit(0);
}

const cmaps = copyDir(path.join(srcRoot, 'cmaps'), path.join(root, 'public', 'pdfjs', 'cmaps'));
const fonts = copyDir(path.join(srcRoot, 'standard_fonts'), path.join(root, 'public', 'pdfjs', 'standard_fonts'));
console.log(`pdfjs assets: ${cmaps} cmaps, ${fonts} fonts → public/pdfjs/`);
