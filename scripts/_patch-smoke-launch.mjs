import fs from 'node:fs';

const path = 'scripts/smoke.mjs';
let s = fs.readFileSync(path, 'utf8');
const re = /const browser = await chromium\.launch\(\{[\s\S]*?\n\}\);/;
if (!re.test(s)) {
  console.error('NO MATCH for chromium.launch block');
  process.exit(1);
}
const rep = `async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--renderer-process-limit=2',
    '--js-flags=--max-old-space-size=320',
    '--disable-background-networking',
    '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
  ];
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ headless: true, args, ...opts });
    } catch {
      /* try next */
    }
  }
  throw new Error('无法启动浏览器：请安装 Chrome，或 npx playwright install chromium');
}
const browser = await launchBrowser();`;
fs.writeFileSync(path, s.replace(re, rep));
console.log('patched', path);
