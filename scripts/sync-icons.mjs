/**
 * Sync Cortex icons from desktop/build/icon.png → all packaging / web targets.
 * Also writes a multi-size Windows .ico when possible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const master = path.join(root, 'desktop', 'build', 'icon.png');
const brand = path.join(root, 'public', 'brand.svg');

if (!fs.existsSync(master)) {
  console.error('Missing master icon:', master);
  process.exit(1);
}

const targets = [
  path.join(root, 'public', 'icon.png'),
  path.join(root, 'desktop', 'build', 'icon-256.png'),
];

const buf = fs.readFileSync(master);
for (const t of targets) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, buf);
  console.log('synced', path.relative(root, t), `(${buf.length} bytes)`);
}

// favicon.svg ← brand.svg
if (fs.existsSync(brand)) {
  fs.copyFileSync(brand, path.join(root, 'public', 'favicon.svg'));
  console.log('synced public/favicon.svg ← brand.svg');
}

// Optional: multi-size ICO via sharp if installed (dev optional)
async function tryIco() {
  try {
    const require = createRequire(import.meta.url);
    const sharp = require('sharp');
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngs = await Promise.all(
      sizes.map((s) => sharp(buf).resize(s, s).png().toBuffer()),
    );
    // Write size variants for installer / docs
    for (let i = 0; i < sizes.length; i++) {
      const out = path.join(root, 'desktop', 'build', `icon-${sizes[i]}.png`);
      fs.writeFileSync(out, pngs[i]);
    }
    // Prefer to-ico if present
    try {
      const toIco = require('to-ico');
      const ico = await toIco(pngs.filter((_, i) => [16, 32, 48, 256].includes(sizes[i])));
      fs.writeFileSync(path.join(root, 'desktop', 'build', 'icon.ico'), ico);
      console.log('wrote desktop/build/icon.ico');
    } catch {
      console.log('to-ico not installed; electron-builder will derive ICO from icon.png');
    }
  } catch {
    console.log('sharp not installed; using master PNG only (electron-builder converts)');
  }
}

await tryIco();
console.log('icon sync done');
