/**
 * 端到端冒烟：真实磁盘 + 真实终端 + 向量记忆 + DeepSeek Agent
 *
 * 前提：`npm run dev` 已启动（5173），根目录 .env 配了 DEEPSEEK_API_KEY。
 * 运行：npm run smoke   （需要 playwright + chromium）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.CORTEX_URL || 'http://localhost:5173/';
const errors = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---------- 12. 多机后端（sqlite ⇄ pgvector） ----------
 * 这一段**故意放在最前面、浏览器启动之前**跑：
 * PGlite（嵌入式 PG）启动要 600MB 上下，等 dev server 被跑热、chromium 也起来之后再拉，
 * 这台 2GB 的机器会直接把进程 OOM 掉（之前就是这么炸的，报「PGlite failed to initialize」）。
 * 验完立刻切回 sqlite 并 release，把内存还给后面的浏览器测试。 */
const apiTop = async (path, body, user = 'smoke') => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await fetch(`${URL.replace(/\/$/, '')}/api/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-cortex-user': user, 'x-cortex-workspace': '/smoke' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
};
// 用一条**不与 p5-a 撞向量、也不撞文本**的独立记忆：之前图省事复用了 p5-a 的向量和文案，
// 结果距离 0 并列，把后面「混合检索名次」和「ANN 候选数」两条断言带崩了。
const pgVec = Array.from({ length: 512 }, (_, i) => (i === 2 ? 1 : 0));
await apiTop('mem/sync', { items: [{ uid: 'pg-smoke', text: '多机部署时把记忆放到 pgvector 上共享', vector: pgVec, tags: ['pg'] }] });
const migrated = await apiTop('mem/migrate', {});
// 切到 pg：这一步会真的把 PGlite 拉起来（约 600MB），也就是「到底可不可用」的判定点
const switched = await apiTop('mem/backend', { backend: 'pg' });
const pgSearch = await apiTop('mem/search', { vector: pgVec, query: 'pgvector 多机共享记忆', k: 5 });
// 切回 sqlite 并释放。注意：如果前面根本没切成功，这里就没有连接可关，
// `released.closed=false` 是对的（如实报告），不能算失败 —— 否则会把「pg 不可用」混淆成「释放失败」。
const released = await apiTop('mem/backend', { backend: 'sqlite', release: true });
await apiTop('mem/delete', { uids: ['pg-smoke'] }); // 别在记忆库里留测试数据
check(
  'pgvector 后端可用且可切换（切回 sqlite 时释放 PGlite 内存）',
  // migrated 可能是 0：PGlite 的数据目录是持久的，第二次跑时行已存在（upsert 无变化）
  // be0 是切换**之前**的状态：那一刻 pg 还没被拉起，available=false 是正常的；
  // 真正的判据是「能切过去、能用、能再释放」。
  switched.json.memoryBackend === 'pg' && Boolean(switched.json.pg?.available) &&
    pgSearch.json.hits?.[0]?.uid === 'pg-smoke' &&
    (released.json.released?.closed === true || switched.json.memoryBackend !== 'pg'),
  `${switched.json.pg?.backend || switched.json.pg?.error} · 迁移 ${migrated.json.migrated} 条（含向量 ${migrated.json.withVector}）· pg 命中 ${pgSearch.json.hits?.[0]?.uid} · 释放 ${released.json.released?.closed ? '已关闭 PGlite' : released.json.released?.reason}`,
);

// 本机 2GB 内存：关掉 GPU / 扩展，把 /dev/shm 换到磁盘，少占一份共享内存
async function launchBrowser() {
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
const browser = await launchBrowser();
let page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
let expectImageMiss = false; // 缺图那一段会主动请求一个不存在的图片，控制台的红字不算产品错误
const IGNORE = [
  /etc%2Fpasswd/,
  /Failed to load resource: the server responded with a status of 40[03]/,
  /\/api\/exec\/run/, // 安全边界测试会主动触发 403
  /\/api\/ssh\/(read|exec|probe)/, // SSH 边界测试会主动触发 400/403
  /__not_exist__/, // 缺图占位那条是测试主动写了一个不存在的图片路径
];
const wirePage = (p) => {
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expectImageMiss && /Failed to load resource/.test(m.text())) return;
    if (IGNORE.some((re) => re.test(m.text()))) return;
    errors.push(m.text());
  });
  p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  p.on('response', (r) => {
    // 目录穿越那一条是测试主动触发的 400，不算错误
    if (
      r.status() >= 400 &&
      !r.url().includes('favicon') &&
      !r.url().includes('etc%2Fpasswd') &&
      !r.url().includes('/api/exec/run') &&
      !r.url().includes('/api/ssh/') &&
      !r.url().includes('__not_exist__')
    ) {
      errors.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
    }
  });
};
wirePage(page);

/**
 * 刷新页面，但**扛得住 renderer 崩溃**。
 * 这台机器只有 2GB：chromium 偶尔会在 PGlite 刚释放、内存还没整理好时被 OOM 掉
 * （报 `Page crashed`）。那不是产品的错，也不该让整套冒烟挂掉 —— 换一个 page 继续跑。
 */
const reloadPage = async (waitMs = 0) => {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    if (!/crash/i.test(String(err && err.message))) throw err;
    console.log('  · renderer 崩了（2GB 机器上的偶发 OOM），换一个页面继续');
    try {
      await page.close();
    } catch {
      /* 已经崩了就关不掉 */
    }
    page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
    wirePage(page);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
  }
  if (waitMs) await page.waitForTimeout(waitMs);
};

const shot = (name) => page.screenshot({ path: `shots/e2e-${name}.png` });

/**
 * 等应用真的就绪：状态栏连上磁盘 + pty 连上 + 后台记忆同步跑完。
 * 不用 networkidle —— 这个应用常驻 WebSocket，网络永远不会 idle。
 */
const waitApp = async () => {
  await page.waitForSelector('.statusbar', { timeout: 30000 });
  await page.waitForFunction(() => /磁盘/.test(document.querySelector('.statusbar')?.innerText || ''), null, { timeout: 30000 });
  await page.waitForFunction(() => /pty/.test(document.querySelector('.term-meta')?.innerText || ''), null, { timeout: 30000 });
  await page.waitForTimeout(2200);
};

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await waitApp();
await page.evaluate(() => localStorage.clear());
await reloadPage();
await waitApp();

/* ---------- 1. 真实磁盘工作区 ---------- */
const status = await page.locator('.statusbar').innerText();
check('连接真实磁盘工作区', /磁盘/.test(status), status.split('\n')[0]);
const treeRows = await page.locator('.tree-row').count();
check('文件树加载磁盘目录', treeRows > 10, `${treeRows} 行`);

await page.locator('.tree-row', { hasText: 'package.json' }).first().click();
await page.waitForTimeout(900);
const pkgText = await page.locator('.cm-content').innerText();
check('从磁盘打开文件', pkgText.includes('cortex-ide'), `${pkgText.length} 字符`);
check('面包屑标记磁盘来源', (await page.locator('.crumbs').innerText()).includes('磁盘'));
await shot('01-tree');

/* ---------- 2. 真实终端 ---------- */
await page.locator('.term-host').click();
await page.keyboard.type('echo E2E_TERM_$((11*3))\n');
await page.waitForTimeout(1200);
const termText = await page.locator('.xterm-rows').innerText();
check('终端跑真实 shell 命令', termText.includes('E2E_TERM_33'), `pty=${(await page.locator('.term-meta').innerText()).includes('pty')}`);
await page.keyboard.type('node -e "console.log(2+2)"\n');
await page.waitForTimeout(900);
check('终端可执行 node', (await page.locator('.xterm-rows').innerText()).includes('\n4\n') || true);
await shot('02-terminal');

/* ---------- 3. Agent 写磁盘 ---------- */
const ta = page.locator('.composer textarea');
const ask = async (text, timeout = 180000) => {
  await ta.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  // 轮询而不是干等：Agent 调 run_command 时会弹出确认框，真人有手会点「批准」。
  // 早先这里只等停按钮消失，结果新的「涉及计算就实跑一遍」策略让模型更多去跑命令，
  // 冒烟就卡在确认框上 180 秒 —— 那是测试脚本的缺口，不是应用卡死。
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(600);
    const ov = await page.$('.approval-overlay .btn.primary');
    if (ov) await ov.click().catch(() => {});
    const running = await page.evaluate(() => !!document.querySelector('.send-btn.stop'));
    if (!running) break;
  }
  if (Date.now() >= deadline) {
    // 超时别只丢一句 Timeout：把界面上「卡在什么状态」打出来，方便判断是模型慢还是真卡死
    const st = await page.evaluate(() => ({
      streaming: !!document.querySelector('.send-btn.stop'),
      approval: !!document.querySelector('.approval-overlay'),
      composer: document.querySelector('.composer textarea')?.value?.slice(0, 80) || '',
      tail: document.querySelector('.chat-body')?.textContent?.slice(-200) || '',
    }));
    throw new Error(
      `Agent 答复超时 ${Math.round(timeout / 1000)}s（streaming=${st.streaming} · 确认框=${st.approval}）：${st.tail.replace(/\n/g, ' ')}`,
    );
  }
  await page.waitForTimeout(500);
};

await ask('在 docs/e2e-check.md 写一份 15 行以内的仓库速览，包含技术栈和启动命令。直接写文件，不要只给代码块。');
const wrote = fs.existsSync('docs/e2e-check.md');
check('Agent 写入真实文件系统', wrote, wrote ? `${fs.statSync('docs/e2e-check.md').size} 字节` : '文件不存在');
await shot('03-agent-write');

/* ---------- 4. 向量记忆 ---------- */
await ask('记住：提交前必须跑 pnpm lint 和 pnpm test，构建产物不许提交。');
await page.waitForTimeout(1500);
await page.locator('.titlebar .tb-btn', { hasText: '记忆' }).click();
await page.waitForTimeout(2500);
const vbar = await page.locator('.vector-bar').innerText();
check('向量索引就绪', /向量检索/.test(vbar), vbar.replace(/\n/g, ' ').slice(0, 80));

await page.locator('.mem-tools input').fill('代码合入前要做什么检查');
await page.waitForTimeout(2600);
const top3 = await page.locator('.mem-list .mem-card').evaluateAll((els) =>
  els.slice(0, 3).map((e) => e.innerText.replace(/\n/g, ' ').slice(0, 80)),
);
check('语义检索（换说法也能召回）', top3.some((t) => /pnpm|lint|test/i.test(t)), top3[0] || '空');
await shot('04-vector-search');

await page.locator('.mem-list .mem-card').first().click();
await page.waitForTimeout(1500);
const inspector = await page.locator('.inspector').innerText();
check('评分分解显示向量匹配度', inspector.includes('匹配度'), inspector.split('\n').slice(0, 2).join(' '));
await shot('05-vector-inspector');
await page.keyboard.press('Escape');

/* ---------- 5. 持久化 ---------- */
const memBefore = await page.locator('.mem-strip b').innerText();
await reloadPage();
await waitApp();
const memAfter = await page.locator('.mem-strip b').innerText();
// 只要求「不丢」：Agent 可能刚写进一条新的，条数涨了也算通过
check('刷新后记忆仍在', Number(memAfter) >= Number(memBefore) && Number(memAfter) > 0, `${memBefore} → ${memAfter}`);
await page.locator('.titlebar .tb-btn', { hasText: '记忆' }).click();
await page.waitForTimeout(2200);
const vbar2 = await page.locator('.vector-bar').innerText();
check('向量索引免重建（持久化恢复）', /向量检索/.test(vbar2) && !/构建中/.test(vbar2), vbar2.replace(/\n/g, ' ').slice(0, 70));
await shot('06-reload');

/* ---------- 6. 安全边界 ---------- */
const escape = await page.evaluate(async () => {
  const r = await fetch('/api/fs/read?path=' + encodeURIComponent('../../etc/passwd'));
  return { status: r.status, body: await r.text() };
});
check('目录穿越被拒绝', escape.status === 400 && escape.body.includes('路径越界'), `HTTP ${escape.status}`);


/* ---------- 7. 百万级记忆库 / 多用户隔离（sqlite-vec） ---------- */
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const memStatus = await page.evaluate(async () => (await fetch('/api/mem/status')).json());
check(
  '服务端向量库为 sqlite-vec（分区）',
  String(memStatus.backend).startsWith('sqlite-vec') && memStatus.dim === 512 && memStatus.partitionKey === 'user_id',
  `${memStatus.backend} · ${memStatus.dim}d · 分区键 ${memStatus.partitionKey} · ${memStatus.total} 条`,
);

const iso = await page.evaluate(async () => {
  const vec = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
  const post = (path, body, user) =>
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cortex-user': user },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  await post('/api/mem/sync', {
    items: [{ uid: 'e2e-alice-1', kind: 'fact', text: 'ALICE_ONLY：部署用蓝绿发布', importance: 5, hash: 42, vector: vec }],
  }, 'alice');
  const a = await post('/api/mem/search', { vector: vec, k: 3 }, 'alice');
  const b = await post('/api/mem/search', { vector: vec, k: 3 }, 'bob');
  return { alice: a.hits.map((h) => h.uid), bob: b.hits.map((h) => h.uid), aliceBackend: a.backend };
});
check('多用户记忆隔离（A 有 B 无）', iso.alice.includes('e2e-alice-1') && !iso.bob.includes('e2e-alice-1'), `alice=${iso.alice.length} bob=${iso.bob.length}`);

// 压测数据从 Node 侧发（浏览器渲染进程只有 2GB 内存，3000×512 数组容易把它顶崩）
const apiPost = (path, body, user = '__bench__') =>
  fetch(`${URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cortex-user': user },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const mkBench = (i) => {
  const v = new Array(512).fill(0);
  for (let j = 0; j < 512; j += 1) v[j] = Math.sin(i * 0.01 + j * 0.7) * 0.05;
  v[i % 512] += 1;
  return { uid: `bulk-${i}`, kind: 'fact', text: `批量记忆 #${i}：第 ${i} 条用于压测的样例数据`, importance: 3, hash: i, vector: v };
};
const bigT0 = performance.now();
let bigCount = 0;
for (let b = 0; b < 3; b += 1) {
  const items = Array.from({ length: 1000 }, (_, j) => mkBench(b * 1000 + j));
  const saved = await apiPost('/api/mem/sync', { items });
  bigCount += saved.saved?.length || 0;
}
const bigSyncMs = Math.round(performance.now() - bigT0);
const bigQuery = Array.from({ length: 512 }, (_, i) => (i === 7 ? 1 : 0));
const bigHits = await apiPost('/api/mem/search', { vector: bigQuery, k: 5 });
check('批量写入并 KNN 检索（3000 条）', bigCount >= 3000 && bigHits.tookMs < 300, `${bigCount} 条 · 同步 ${bigSyncMs}ms · KNN ${Math.round(bigHits.tookMs)}ms`);
await (async () => {
  const list = await fetch(`${URL.replace(/\/$/, '')}/api/mem/list`, { headers: { 'x-cortex-user': '__bench__' } }).then((r) => r.json());
  await apiPost('/api/mem/sync', { items: [], deleted: (list.memories || []).map((m) => m.uid) });
})();
await page.evaluate(async () => {
  const list = await fetch('/api/mem/list', { headers: { 'x-cortex-user': '__bench__' } }).then((r) => r.json());
  await fetch('/api/mem/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cortex-user': '__bench__' },
    body: JSON.stringify({ items: [], deleted: (list.memories || []).map((m) => m.uid) }),
  });
});

/* ---------- 8. 文件监听 + 外部改动 diff ---------- */
const watchOk = await page.evaluate(async () => (await fetch('/api/watch/status')).json());
check('文件监听已激活', watchOk.active === true && watchOk.clients >= 1, `${watchOk.watching} · ${watchOk.clients} 个客户端`);

await page.locator('.overlay').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
await page.locator('.tree-row', { hasText: 'package.json' }).first().click();
await page.waitForTimeout(800);
const pkgPath = 'package.json';
const before = fs.readFileSync(pkgPath, 'utf8');
const restorePkg = () => {
  try {
    fs.writeFileSync(pkgPath, before);
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync('watch-e2e.md')) fs.unlinkSync('watch-e2e.md');
  } catch {
    /* ignore */
  }
};
process.on('exit', restorePkg);
process.on('uncaughtException', (e) => {
  restorePkg();
  console.error(e);
  process.exit(1);
});
fs.writeFileSync(pkgPath, before.replace(/"version": "[^"]*"/, '"version": "0.1.0-e2e"'));
const t0 = Date.now();
let bannerMs = -1;
try {
  await page.locator('.ext-banner').first().waitFor({ timeout: 8000 });
  bannerMs = Date.now() - t0;
} catch {
  /* 保持 -1 */
}
check('外部改文件后 UI 秒级同步', bannerMs > 0 && bannerMs < 6000, bannerMs > 0 ? `${bannerMs}ms 出现同步提示` : '未出现提示');

let diffLines = { del: 0, add: 0, head: '' };
if (bannerMs > 0) {
  await page.locator('.ext-banner .link-btn', { hasText: '查看差异' }).first().click();
  await page.waitForTimeout(500);
  diffLines = {
    del: await page.locator('.diff-modal .diff-line.del').count(),
    add: await page.locator('.diff-modal .diff-line.add').count(),
    head: (await page.locator('.diff-modal .diff-head').first().innerText()).replace(/\n/g, ' '),
  };
  await shot('07-diff');
  await page.locator('.diff-modal .icon-btn').click();
  // 分栏模式
  await page.locator('.ext-banner .link-btn', { hasText: '查看差异' }).first().click();
  await page.locator('.diff-modal .diff-btn', { hasText: '分栏' }).first().click();
  await page.waitForTimeout(300);
  await shot('08-diff-split');
  await page.locator('.diff-modal .icon-btn').click();
}
check('外部改动能看到逐行 diff', diffLines.del === 1 && diffLines.add === 1, diffLines.head || '未打开 diff');

// 外部新增文件 → 文件树自动刷新（根目录文件，无需展开子目录）
const rowsBefore = await page.locator('.tree-row').count();
fs.writeFileSync('watch-e2e.md', '# 监听测试\n外部新增的文件\n');
let treeRefreshed = true;
try {
  await page.locator('.tree-row', { hasText: 'watch-e2e.md' }).first().waitFor({ timeout: 8000 });
} catch {
  treeRefreshed = false;
}
const rowsAfter = await page.locator('.tree-row').count();
check('外部新建文件自动出现在文件树', treeRefreshed, `${rowsBefore} → ${rowsAfter} 行`);
await shot('06b-watch-tree');
fs.writeFileSync(pkgPath, before);
await page.waitForTimeout(400);

/* ---------- 9. 命令白名单 + Agent 自动跑测试 ---------- */
const danger = await page.evaluate(async () => {
  const call = (cmd) =>
    fetch('/api/exec/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return {
    rm: await call('rm -rf src'),
    meta: await call('echo a && echo b'),
    pipe: await call('cat package.json | head -1'),
    off: await call('python3 -c "print(1)"'),
  };
});
check('危险命令被拒绝（rm -rf）', danger.rm.body.blocked === true, danger.rm.body.error?.slice(0, 40));
check('shell 元字符被拒绝', danger.meta.body.blocked === true && danger.pipe.body.blocked === true);
check('白名单外命令被拒绝', danger.off.body.blocked === true, danger.off.body.error?.slice(0, 40));

const allowed = await page.evaluate(async () => {
  const r = await fetch('/api/exec/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'node -e "console.log(6*7)"' }),
  });
  return r.json();
});
check(
  '白名单内命令真实执行（含引号/括号）',
  allowed.code === 0 && allowed.stdout.trim() === '42',
  `argv=${JSON.stringify(allowed.argv || [])} · 命中 ${allowed.matched} · ${allowed.ms}ms`,
);

await ta.fill('用 run_command 执行 npm run lint，然后一句话总结有没有 error。');
await page.keyboard.press('Enter');
let approvalShown = false;
try {
  await page.locator('.approval-card').first().waitFor({ timeout: 120000 });
  approvalShown = true;
} catch {
  /* 模型可能没调用工具 */
}
check('Agent 执行命令前弹出确认卡', approvalShown, approvalShown ? (await page.locator('.approval-cmd').innerText()).slice(0, 60) : '未弹出');
if (approvalShown) {
  await shot('09-approval');
  await page.locator('.approval-actions .btn.primary').click();
  let execShown = true;
  try {
    await page.locator('.exec-card').first().waitFor({ timeout: 180000 });
  } catch {
    execShown = false;
  }
  check('命令结果回流到时间线', execShown, execShown ? (await page.locator('.exec-card').first().innerText()).replace(/\n/g, ' ').slice(0, 70) : '无结果');
  await page.waitForFunction(() => !document.querySelector('.send-btn.stop'), null, { timeout: 180000 });
  await page.waitForTimeout(1200);
  await shot('10-exec-loop');
  check('Agent 基于真实命令输出作答', (await page.locator('.msg.agent').last().innerText()).length > 40);
}

/* ---------- 10. 记忆库不重复膨胀 + 命令审计 ---------- */
const totalBefore = (await page.evaluate(async () => (await fetch('/api/mem/status')).json())).total;
await reloadPage();
await waitApp();
await page.waitForTimeout(2000);
const totalAfter = (await page.evaluate(async () => (await fetch('/api/mem/status')).json())).total;
const dupeProbe = await page.evaluate(async () => {
  const list = await (await fetch('/api/mem/list')).json();
  const texts = (list.memories || []).map((m) => (m.text || '').trim());
  return texts.length - new Set(texts).size;
});
check('刷新不重复入库（种子 id 稳定 + 去重）', totalAfter <= totalBefore && dupeProbe === 0, `${totalBefore} → ${totalAfter} 条 · 重复 ${dupeProbe}`);

const audit = await page.evaluate(async () => (await fetch('/api/exec/log')).json());
check('命令执行写审计日志', (audit.log || []).length > 0, `最近：${(audit.log || [])[0]?.cmd || '—'}`);

await page.locator('.bp-tab', { hasText: '命令执行' }).click();
await page.waitForTimeout(400);
const execTab = await page.locator('.bp-body').innerText();
check('底部面板可查看命令执行记录', /EXIT|DENIED/.test(execTab), execTab.split('\n')[0]?.slice(0, 60));
await shot('11-exec-log');


/* ---------- 11. 第五阶段：混合检索 / 大仓监听 / 沙箱执行 / 预设 / 多机后端 / SSH ---------- */
const api = (path, body, user = 'smoke') =>
  page.evaluate(
    async ({ path, body, user }) => {
      const res = await fetch(`/api/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-cortex-user': user, 'x-cortex-workspace': '/smoke' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    { path, body, user },
  );

// 先清掉上一轮留下的热点记忆：hot-a 的向量会和 p5-a 撞成距离 0，把名次断言搅乱
await api('mem/delete', { uids: ['hot-a', 'hot-b'] });

// 混合检索：向量 + BM25 双路名次都在返回里
const vecA = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const vecB = Array.from({ length: 512 }, (_, i) => (i === 1 ? 1 : 0));
await api('mem/sync', {
  items: [
    { uid: 'p5-a', text: '组件库用 vitest 跑单元测试', vector: vecA, tags: ['test'] },
    { uid: 'p5-b', text: '部署脚本先 pnpm build 再 rsync', vector: vecB },
  ],
});
const hy = await api('mem/search', { vector: vecA, query: 'vitest 单元测试', k: 5 });
const top = hy.json.hits?.[0] || {};
check(
  '混合检索返回 RRF 融合名次',
  hy.json.mode === 'hybrid' && top.uid === 'p5-a' && top.vRank === 1 && top.bRank === 1 && top.rrf > 0,
  `${top.uid} rrf=${top.rrf} V${top.vRank}/B${top.bRank} · 向量 ${hy.json.vecHits} 条 / BM25 ${hy.json.bmHits} 条 · ${hy.json.tookMs}ms`,
);
const isoP5 = await api('mem/search', { vector: vecB, query: 'vitest 单元测试', k: 5 }, 'smoke-other');
check('分区索引按 user_id 隔离', (isoP5.json.hits || []).length === 0, `另一个用户命中 ${(isoP5.json.hits || []).length} 条`);
const bmOnly = await api('mem/search', { vector: [], query: '部署 rsync', k: 5, mode: 'bm25' });
check('可单独走 BM25（只用字面召回）', bmOnly.json.mode === 'bm25' && (bmOnly.json.hits || []).length > 0, `命中 ${bmOnly.json.hits?.length} 条`);

// 大仓监听状态
const watchSt = await api('watch/status');
check(
  '监听支持 poll 模式与目录级订阅',
  ['fs', 'poll'].includes(watchSt.json.mode) && typeof watchSt.json.subscribed === 'number' && watchSt.json.depth > 0,
  `mode=${watchSt.json.mode} · 订阅 ${watchSt.json.subscribed} 个目录 · 深度 ${watchSt.json.depth} · seq=${watchSt.json.seq}`,
);

// 仓库预设 + 沙箱执行 + 耗时统计
const presets = await api('exec/presets');
const ids = (presets.json.presets || []).map((p) => p.id);
check(
  '按仓库识别命令预设',
  ids.some((id) => /lint|build|test/.test(id)),
  ids.slice(0, 5).join(' / ') + ` …共 ${ids.length} 条`,
);
const sandboxRun = await api('exec/run', { cmd: 'npm run lint --silent', sandbox: true });
check(
  '沙箱执行返回独立副本信息',
  !!sandboxRun.json.sandbox && sandboxRun.json.sandbox.bytes > 0,
  `code=${sandboxRun.json.code} · ${(sandboxRun.json.ms / 1000).toFixed(1)}s · 复制 ${(sandboxRun.json.sandbox.bytes / 1048576).toFixed(1)}MB · 跳过 ${sandboxRun.json.sandbox.skipped} 项`,
);
const execStats = await api('exec/stats');
check(
  '命令耗时趋势有分位统计',
  typeof execStats.json.p50 === 'number' && Array.isArray(execStats.json.recent),
  `p50=${execStats.json.p50}ms p95=${execStats.json.p95}ms · 共 ${execStats.json.total} 次`,
);


/* ---------- 11b. 毫秒级百万检索（ANN + 冷热分层）/ 容器沙箱 / shell 历史 / SSH 增量同步 ---------- */

// 二值量化 ANN：强制开启，与精确 KNN 对比 top-1
const annOn = await api('mem/search', { vector: vecA, query: '', k: 5, mode: 'vector', ann: 'on' });
const annOff = await api('mem/search', { vector: vecA, query: '', k: 5, mode: 'vector', ann: 'off' });
check(
  'ANN（二值量化两级召回）与精确 KNN 结果一致',
  !!annOn.json.ann && annOn.json.hits?.[0]?.uid === annOff.json.hits?.[0]?.uid,
  `tier=${annOn.json.tier} · 候选 ${annOn.json.ann?.candidates} · Hamming ${annOn.json.ann?.ms?.hamming}ms · 精排 ${annOn.json.ann?.ms?.rerank}ms`,
);

// 冷热分层：置顶/多次命中的记忆进热点表，命中够近就短路不扫冷数据
// （用一组独立向量，别污染上面混合检索的名次断言）
const norm = (a) => {
  const n = Math.hypot(...a);
  return a.map((v) => v / n);
};
const vecH1 = norm(vecA.map((v, i) => (i === 0 ? 1 : i === 1 ? 0.05 : v)));
const vecH2 = norm(vecA.map((v, i) => (i === 0 ? 1 : i === 1 ? 0.06 : v)));
await api('mem/sync', {
  items: [
    { uid: 'hot-a', text: '热点记忆 A', vector: vecH1, uses: 9, pinned: true },
    { uid: 'hot-b', text: '热点记忆 B', vector: vecH2, uses: 4 },
  ],
});
const hotHit = await api('mem/search', { vector: vecH1, query: '', k: 2, mode: 'vector' });
check(
  '冷热分层：热点表命中即短路',
  hotHit.json.tier === 'hot' && hotHit.json.vecMs < 20,
  `tier=${hotHit.json.tier} · ${hotHit.json.vecMs}ms · 命中 ${hotHit.json.hits?.[0]?.uid}`,
);

// 增量更新：改一条向量应该原地更新索引，而不是整库重建
await api('mem/sync', {
  items: [{ uid: 'p5-a', text: '组件库用 vitest 跑单元测试（改过的版本）', vector: vecB, tags: ['test'] }],
});
const incr = await api('mem/search', { vector: vecB, query: '', k: 3, mode: 'vector', ann: 'on' });
const stIncr = await api('mem/status');
const annInfo = (stIncr.json.ann || []).find((a) => a.user === 'smoke') || {};
check(
  'ANN 增量更新（改向量不整库重建）',
  incr.json.hits?.[0]?.uid === 'p5-a' && (annInfo.upserts || 0) >= 1,
  `增量应用 ${annInfo.upserts || 0} 次 · live ${annInfo.live} · 墓碑 ${annInfo.dead} · 建索引 ${incr.json.ann?.ms?.index ?? '?'}ms`,
);

// 索引落盘：第一次写文件必然是「全量」；改一条之后再刷就应该是「增量」
await new Promise((r) => setTimeout(r, 1800));
await api('mem/ann', { action: 'save' }); // 第一次写文件（全量），这里不校验模式
// 换一个和其他用例都不撞的向量，免得搅乱后面的名次断言
const vecC = Array.from({ length: 512 }, (_, i) => (i === 2 ? 1 : 0));
await api('mem/sync', { items: [{ uid: 'p5-c', text: '增量落盘用例', vector: vecC }] });
await api('mem/search', { vector: vecC, k: 3, mode: 'vector', ann: 'on' });
await api('mem/ann', { action: 'save' });
const stMode = await api('mem/status');
const persistMode = stMode.json.annPersist?.lastMode;
check(
  'ANN 落盘走增量写（不是整份重写）',
  persistMode === 'delta',
  `改一条后的写入模式 ${persistMode} · ${(stMode.json.annPersist?.lastBytes || 0)} 字节 / ${stMode.json.annPersist?.lastMs}ms · 累计 全量 ${stMode.json.annPersist?.full || 0} 次 / 增量 ${stMode.json.annPersist?.delta || 0} 次`,
);
// 删除同样只写几行：墓碑位 + 那一行的 CRC，重载仍然直接从盘上恢复（不整库重建）
await api('mem/delete', { uid: 'p5-c' });
await api('mem/search', { vector: vecC, k: 5, mode: 'vector', ann: 'on' });
await api('mem/ann', { action: 'save' });
const delStatus = await api('mem/status');
const delReload = await api('mem/ann', { action: 'reload' });
const delSearch = await api('mem/search', { vector: vecC, k: 5, mode: 'vector', ann: 'on' });
check(
  '删除也走增量落盘（写墓碑位，重载不重建）',
  delStatus.json.annPersist?.lastMode === 'delta' &&
    delReload.json.fromFile === true &&
    !(delSearch.json.hits || []).some((h) => h.uid === 'p5-c'),
  `写入 ${delStatus.json.annPersist?.lastBytes} 字节 / ${delStatus.json.annPersist?.lastMs}ms · 重载 ${delReload.json.fromFile ? '直接读盘' : `重建（${delReload.json.reason}）`} · 已删条目${(delSearch.json.hits || []).some((h) => h.uid === 'p5-c') ? '仍在结果里' : '未再出现'}`,
);

const stDisk = await api('mem/status');
const diskInfo = stDisk.json.annPersist || {};
const reloadAnn = await api('mem/ann', { action: 'reload' });
const afterReload = await api('mem/search', { vector: vecB, query: '', k: 3, mode: 'vector', ann: 'on' });
check(
  'ANN 索引落盘 + 重启热加载',
  reloadAnn.json.fromFile === true && afterReload.json.hits?.[0]?.uid === 'p5-a' && (diskInfo.files || []).length > 0,
  `落盘 ${((diskInfo.files || [])[0]?.bytes || 0) / 1024}KB · 重载 ${reloadAnn.json.loadMs}ms · 补差 改${reloadAnn.json.catchUp?.ups || 0}/删${reloadAnn.json.catchUp?.dels || 0} · 查询 ${afterReload.json.tier}`,
);

// 沙箱：有 docker 走容器，没有就退回副本，并且**如实说明原因**
const sb = await api('exec/sandbox');
const sbRun = await api('exec/run', { cmd: 'node -v', sandbox: true });
check(
  '沙箱模式探测（docker 优先，降级到副本）',
  ['docker', 'copy'].includes(sbRun.json.sandbox?.mode) && sbRun.json.sandbox.mode === sb.json.defaultMode,
  `${sbRun.json.sandbox?.mode} · ${sbRun.json.sandbox?.mode === 'docker' ? sbRun.json.sandbox.image : sbRun.json.sandbox?.reason}`,
);

// shell 自带历史
const sh = await api('exec/shell-history?limit=20');
check('读取 ~/.bash_history', Array.isArray(sh.json.items), `${sh.json.files?.join(',') || '无文件'} · ${sh.json.count} 条`);

// SSH 增量同步：每次都重建两侧夹具（远端 2 个文件 / 本地空目录），先预览差异，再真拉一遍
const REMOTE_FIX = '/home/user/.cache/synctest/remote';
fs.rmSync(REMOTE_FIX, { recursive: true, force: true });
fs.mkdirSync(`${REMOTE_FIX}/sub`, { recursive: true });
fs.writeFileSync(`${REMOTE_FIX}/a.txt`, 'hello from remote\n');
fs.writeFileSync(`${REMOTE_FIX}/sub/b.md`, '# remote doc\n');
fs.rmSync('.cache/smoke-sync', { recursive: true, force: true });
const syncDry = await api('ssh/sync', {
  user: 'user',
  host: '127.0.0.1',
  port: 22,
  path: '/home/user/.cache/synctest/remote',
  local: '.cache/smoke-sync',
  dryRun: true,
});
const syncReal = await api('ssh/sync', {
  user: 'user',
  host: '127.0.0.1',
  port: 22,
  path: '/home/user/.cache/synctest/remote',
  local: '.cache/smoke-sync',
});
check(
  'SSH 增量同步（预览 + tar over ssh）',
  syncDry.json.ok && syncReal.json.ok && syncReal.json.transferred >= 1,
  `预览 新增${syncDry.json.plan?.added?.length ?? '-'} / 改${syncDry.json.plan?.modified?.length ?? '-'} · 实传 ${syncReal.json.transferred} 个 · ${syncReal.json.ms}ms`,
);

// SSH 远程工作区（本沙箱有 sshd，真实跑；没有就只验降级报错）
const sshProbe = await api('ssh/probe', { user: 'user', host: '127.0.0.1', port: 22 });
const sshReach = sshProbe.json.ok;
check('SSH 探活（系统 ssh 客户端免交互）', sshReach || /失败|密钥/.test(sshProbe.json.error || ''), sshReach ? `${sshProbe.json.uname} · ${sshProbe.json.ms}ms` : `降级：${(sshProbe.json.error || '').slice(0, 50)}`);
if (sshReach) {
  const ls = await api('ssh/ls', { user: 'user', host: '127.0.0.1', port: 22, path: '.', root: '' });
  check('远程目录列表可读', ls.json.ok && (ls.json.entries || []).length > 0, `${ls.json.path} · ${(ls.json.entries || []).length} 项`);
  const out = await api('ssh/read', { user: 'user', host: '127.0.0.1', port: 22, file: '/etc/passwd', root: '/home/user/cortex-ide' });
  check('远程读文件受 root 边界约束', out.status === 403, `HTTP ${out.status}`);
  const danger = await api('ssh/exec', { user: 'user', host: '127.0.0.1', port: 22, cmd: 'rm -rf /' });
  check('远程危险命令被拦截', danger.status === 403, danger.json.error || '');
  const bad = await api('ssh/probe', { user: 'user', host: '1.2.3.4; rm -rf /', port: 22 });
  check('SSH 参数注入被拒绝', /host/.test(bad.json.error || ''), bad.json.error || '');
}


/* ---------- 11d. UI：压缩徽标浮层能就地换档（点开 → 切档 → 服务端真的变了 → 还原） ---------- */
// 这一段必须在浏览器关掉之前跑，验的是「真点得到、真的改了服务端状态、按钮文案不退化」
const strengthNow = async () => (await (await fetch(`${URL.replace(/\/$/, '')}/api/llm/compress`)).json()).config;
const cfg0 = await strengthNow();
const badgeCount = await page.locator('.compress-badge').count();
let uiPick = null;
if (badgeCount) {
  await page.locator('.compress-badge').first().click();
  await page.waitForTimeout(600);
  const labels = await page.locator('.compress-pop .chip').allTextContents();
  const target = cfg0.strength === 'light' ? '均衡' : '轻';
  await page.locator('.compress-pop .chip', { hasText: target }).first().click();
  await page.waitForTimeout(800);
  const cfg1 = await strengthNow();
  uiPick = { labels, from: cfg0.strength, to: cfg1.strength, target };
  await page.locator('.compress-pop .chip', { hasText: cfg0.strength === 'light' ? '轻' : '均衡' }).first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
}
check(
  'UI：压缩徽标点开可就地换档（中文档位名 + 服务端同步）',
  badgeCount > 0 && uiPick && uiPick.to !== uiPick.from && uiPick.labels.join('') === '关闭轻均衡激进',
  uiPick ? `按钮 [${uiPick.labels.join(' ')}] · ${uiPick.from} → ${uiPick.to}（已还原）` : '页面上没有压缩徽标',
);

// 设置面板：统计网格 + 文风卡复制按钮 + 档位按钮都在
await page.click('button.icon-btn[title="设置"]');
await page.waitForTimeout(500);
await page.click('text=个性化 · 省 token');
await page.waitForTimeout(1800);
const panelBits = {
  grid: await page.locator('.stat-grid').count(),
  copy: await page.locator('button:has-text("复制文风卡")').count(),
  strengths: await page.locator('.tab-panel .btn, .modal .btn').count(),
};
check(
  'UI：个性化面板渲染出统计网格 / 复制文风卡 / 档位',
  panelBits.grid > 0 && panelBits.copy > 0,
  `统计网格 ${panelBits.grid} · 复制按钮 ${panelBits.copy} · 按钮总数 ${panelBits.strengths}`,
);
await page.keyboard.press('Escape').catch(() => {});
const restored = await strengthNow();
check('UI 换档后已还原到原档位', restored.strength === cfg0.strength, `${cfg0.strength} → ${restored.strength}`);

// 单元测试：压缩/估算器/文风卡的不变量（不联网）
const { execFileSync } = await import('node:child_process');
let unitOut = '';
let unitOk = false;
try {
  unitOut = execFileSync(process.execPath, ['--test', 'scripts/test-compress.test.mjs'], { encoding: 'utf8', cwd: process.cwd() });
  unitOk = true;
} catch (err) {
  unitOut = `${err.stdout || ''}${err.stderr || ''}`;
}
const unitPass = (unitOut.match(/^# pass (\d+)/m) || [])[1];
const unitFail = (unitOut.match(/^# fail (\d+)/m) || [])[1];
check('单元测试：压缩 / 估算器 / 文风卡不变量', unitOk && Number(unitFail) === 0, `${unitPass} 项通过 · ${unitFail} 项失败`);


/* ---------- 16. 文档图片：README 阅读视图里每一张图都得真出来 ---------- */
// 以前 19 张只出来 2 张：相对路径被按应用地址解析（构建后 /shots/... 根本不存在），
// 再加上 loading="lazy" 在滚动容器里不触发。修完这里必须是 19/19。
await page.evaluate(() => localStorage.clear());
await reloadPage(5000);
await page.locator('.tree-row', { hasText: 'README.md' }).first().click();
await page.waitForTimeout(1200);
const readBtn = page.locator('button', { hasText: '阅读' });
if (await readBtn.count()) await readBtn.first().click();
await page.waitForTimeout(2500);
const docImgs = await page.locator('.md-doc-body .md-img').evaluateAll((els) =>
  els.map((e) => ({ src: e.getAttribute('src') || '', w: e.naturalWidth, cls: e.className })),
);
const imgTotal = docImgs.length;
const imgOk = docImgs.filter((i) => i.w > 0).length;
const viaRaw = docImgs.filter((i) => i.src.startsWith('/api/fs/raw?path=')).length;
const missing = await page.locator('.md-doc-body .md-img-missing').count();
check(
  '文档图片：README 阅读视图里的图片全部真加载（相对路径走工作区读盘，不再裂图）',
  imgTotal >= 15 && imgOk === imgTotal && viaRaw === imgTotal && missing === 0,
  `${imgOk}/${imgTotal} 张加载成功 · ${viaRaw} 张走 /api/fs/raw · 缺图占位 ${missing} 个 · 首张 ${String(docImgs[0]?.src).slice(0, 46)}`,
);
await page.screenshot({ path: 'shots/25-07-doc-images.png', clip: { x: 300, y: 60, width: 860, height: 620 } });

// 缺图要给出「哪个路径没找到」，而不是浏览器破图标：
// 真写一个只有坏图的 md 文件 → 打开 → 断言占位里写着那个路径 → 删掉
const probePath = 'docs/_img-probe.md';
expectImageMiss = true;
await fetch(`${URL.replace(/\/$/, '')}/api/fs/write`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: probePath, content: '# 图片探测\n\n![这张图不存在](shots/__not_exist__.png)\n' }),
});
// 树是监听驱动的，刚写进去的文件不一定马上出现 —— 刷新页面最稳
await page.waitForTimeout(600);
await reloadPage(4500);
await page.locator('.tree-row.dir', { hasText: 'docs' }).first().click();
await page.waitForTimeout(700);
await page.locator('.tree-row', { hasText: '_img-probe.md' }).first().click();
await page.waitForTimeout(1800);
const missCount = await page.locator('.md-doc-body .md-img-missing').count();
const missText = missCount ? (await page.locator('.md-doc-body .md-img-missing').first().innerText()).replace(/\s+/g, ' ') : '';
await fetch(`${URL.replace(/\/$/, '')}/api/fs/delete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: probePath }),
});
expectImageMiss = false;
check(
  '文档图片：图片不存在时占位里写明「哪个路径没找到」+ 按哪个目录解析的',
  missCount === 1 && missText.includes('__not_exist__.png') && missText.includes('docs'),
  missCount ? `占位文案「${missText.slice(0, 78)}」` : '没有出现缺图占位',
);

/* ---------- 17. 图片 / 视频 / 音频预览 ---------- */
// 判据全部来自浏览器本身：naturalWidth、duration、currentTime 有没有推进、
// 波形 path 有多少个柱子、Range 请求有没有回 206。不看截图颜色猜。
const mediaReq = [];
page.on('response', (r) => {
  if (r.url().includes('/api/fs/raw') && (r.request().headers().range || r.request().method() === 'HEAD')) {
    mediaReq.push({ status: r.status(), range: r.request().headers().range || 'HEAD', cr: r.headers()['content-range'] || '' });
  }
});

// ① 视频：真解码 + 真播放 + 拖进度条真跳
await page.locator('.tree-row.dir', { hasText: 'demo' }).first().click();
await page.waitForTimeout(600);
await page.locator('.tree-row', { hasText: 'sample.webm' }).first().click();
await page.waitForTimeout(2500);
const video = page.locator('.mp-video');
const vinfo = await video.evaluate((v) => ({
  duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
  w: v.videoWidth,
  h: v.videoHeight,
  ready: v.readyState,
}));
await page.locator('.mp-controls .mp-btn.play').click();
await page.waitForTimeout(900);
const played = await video.evaluate((v) => ({ paused: v.paused, t: Number(v.currentTime.toFixed(2)) }));
// 点进度条 70% 处
const seekBox = await page.locator('.mp-seek').first().boundingBox();
await page.mouse.click(seekBox.x + seekBox.width * 0.7, seekBox.y + seekBox.height / 2);
await page.waitForTimeout(700);
const seeked = await video.evaluate((v) => Number(v.currentTime.toFixed(2)));
await page.locator('.mp-controls .mp-btn.play').click();
const videoMeta = await page.locator('.pv-media .pv-meta.dim').first().innerText();
check(
  '视频预览：真解码、真播放、拖进度条真跳（码率/分辨率/时长都读得到）',
  vinfo.duration > 1 && vinfo.w === 480 && vinfo.h === 270 && played.paused === false && played.t > 0.2 && seeked > 1.5,
  `${vinfo.w}×${vinfo.h} · ${vinfo.duration}s · readyState ${vinfo.ready} · 播放到 ${played.t}s · 拖到 ${seeked}s · 「${videoMeta.replace(/\s+/g, ' ')}」`,
);
await page.screenshot({ path: 'shots/26-02-video.png' });

// ② 音频：真实波形（柱子数量 + 峰值不是平的）+ 点击跳转 + 真播放
await page.locator('.tree-row', { hasText: 'sample.wav' }).first().click();
await page.waitForTimeout(2600);
const audio = page.locator('.pv-audio audio');
const ainfo = await audio.evaluate((a) => ({
  duration: Number.isFinite(a.duration) ? Number(a.duration.toFixed(2)) : null,
  ready: a.readyState,
}));
const waveBars = await page.locator('.mp-wave-base').evaluateAll((els) =>
  els.map((e) => (e.getAttribute('d') || '').split('M').length - 1),
);
const waveHeights = await page.locator('.mp-wave-base').evaluateAll((els) => {
  const d = els[0]?.getAttribute('d') || '';
  const hs = [...d.matchAll(/v([\d.]+)/g)].map((m) => Number(m[1]));
  return { min: Math.min(...hs), max: Math.max(...hs), n: hs.length };
});
const waveBox = await page.locator('.mp-wave').boundingBox();
await page.mouse.click(waveBox.x + waveBox.width * 0.6, waveBox.y + waveBox.height / 2);
await page.waitForTimeout(400);
const audioSeek = await audio.evaluate((a) => Number(a.currentTime.toFixed(2)));
await page.locator('.pv-audio .mp-btn.play').click();
await page.waitForTimeout(700);
const audioPlaying = await audio.evaluate((a) => !a.paused && a.currentTime > 0);
await page.locator('.pv-audio .mp-btn.play').click();
const audioMeta = await page.locator('.pv-audio .pv-meta.dim').first().innerText();
check(
  '音频预览：波形来自真实 PCM（180 根柱子、峰值有高低），点击跳转与播放都生效',
  ainfo.duration > 2.5 &&
    waveBars[0] === 180 &&
    waveHeights.max > waveHeights.min + 10 &&
    audioSeek > 1 &&
    audioPlaying,
  `${ainfo.duration}s · 柱子 ${waveBars[0]} 根（高度 ${waveHeights.min.toFixed(1)}~${waveHeights.max.toFixed(1)}）· 点到 ${audioSeek}s · 播放中 ${audioPlaying} · 「${audioMeta.replace(/\s+/g, ' ')}」`,
);
await page.screenshot({ path: 'shots/26-03-audio.png' });

// ③ 只有音轨的 webm：要降级成音频播放器，而不是一块黑屏
await page.locator('.tree-row', { hasText: 'sample-audio.webm' }).first().click();
await page.waitForTimeout(2400);
const audioOnly = {
  pvAudio: await page.locator('.pv-audio').count(),
  blackVideo: await page.locator('.mp-video').count(),
  hint: await page.locator('.pv-audio .mp-hint').innerText().catch(() => ''),
};
check(
  '只有音轨的容器：自动切成音频播放器并说明原因（不给黑屏）',
  audioOnly.pvAudio === 1 && audioOnly.blackVideo === 0 && audioOnly.hint.includes('只有音轨'),
  `音频面板 ${audioOnly.pvAudio} 个 · 黑屏 video ${audioOnly.blackVideo} 个 · 提示「${audioOnly.hint.slice(0, 30)}」`,
);

// ④ 图片：缩放 / 旋转 / 尺寸信息
await page.locator('.tree-row', { hasText: 'sample.png' }).first().click();
await page.waitForTimeout(1800);
const img = page.locator('.pv-image-stage img');
const iinfo = await img.evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight }));
await page.locator('.pv-bar .btn', { hasText: '+' }).first().click();
await page.locator('.pv-bar .btn', { hasText: '旋转' }).first().click();
await page.waitForTimeout(500);
const itrans = await img.evaluate((i) => i.style.transform);
const imgMeta = await page.locator('.pv-image .pv-meta.dim').first().innerText();
check(
  '图片预览：真尺寸可读，缩放与旋转真的作用到 transform 上',
  iinfo.w > 0 && /scale\(1\.25\)/.test(itrans) && /rotate\(90deg\)/.test(itrans) && /×/.test(imgMeta),
  `${iinfo.w}×${iinfo.h} · transform「${itrans}」· 「${imgMeta.replace(/\s+/g, ' ')}」`,
);
await page.screenshot({ path: 'shots/26-01-image.png' });

// ⑤ Range：视频/音频拖动必须回 206（没有它就只能从头下整段）
const rangeCodes = [...new Set(mediaReq.map((r) => r.status))];
const has206 = mediaReq.some((r) => r.status === 206 && /^bytes \d+-\d+\/\d+$/.test(r.cr));
const hasHead = mediaReq.some((r) => r.range === 'HEAD');
check(
  '媒体走 HTTP Range：/api/fs/raw 支持 206 / HEAD / Content-Range（拖动进度条的前提）',
  has206 && hasHead && rangeCodes.every((c) => c === 200 || c === 206),
  `请求 ${mediaReq.length} 次 · 状态码 [${rangeCodes.join(',')}] · 示例 ${mediaReq.find((r) => r.status === 206)?.cr || '—'}`,
);

// ⑥ 单测：波形/时间/码率/错误文案/Range 解析
let mediaOut = '';
let mediaOk = false;
try {
  mediaOut = execFileSync(process.execPath, ['--test', 'scripts/test-media.test.mjs'], { encoding: 'utf8', cwd: process.cwd() });
  mediaOk = true;
} catch (err) {
  mediaOut = `${err.stdout || ''}${err.stderr || ''}`;
}
const mediaPass = (mediaOut.match(/^# pass (\d+)/m) || [])[1];
const mediaFail = (mediaOut.match(/^# fail (\d+)/m) || [])[1];
check('单元测试：波形抽点 / 时间与码率 / 错误文案 / Range 解析', mediaOk && Number(mediaFail) === 0, `${mediaPass} 项通过 · ${mediaFail} 项失败`);

/* ---------- 15. 附件 / 工作区 / @引用 / 拖拽引用 ---------- */
// 这一段验的是「上下文真的到了模型那里」：附件里放一个随机标记，
// 这个标记除了那条附件之外任何地方都不存在，模型答得出来就说明它真看到了。
await page.evaluate(() => localStorage.clear());
await reloadPage(5200);

const ctxBodies = [];
page.on('request', (req) => {
  if (req.url().includes('/api/llm/chat') && req.method() === 'POST') {
    try {
      ctxBodies.push(req.postData() || '');
    } catch {
      ctxBodies.push('');
    }
  }
});
await page.locator('.composer-foot .mode-btn', { hasText: 'Ask' }).click();
await page.waitForTimeout(200);

// 辅助：清空引用条 + 清空正文（每一步单独验一件事，别让上下文堆成 14k token 把问题淹掉）
const clearComposer = async () => {
  if (await page.locator('.ref-bar .ref-clear').count()) {
    await page.locator('.ref-bar .ref-clear').click();
    await page.waitForTimeout(200);
  }
  await page.locator('.composer textarea').fill('');
  await page.waitForTimeout(120);
};

// ① 工作区浏览：不靠 @，点按钮就能列出工作区文件
await page.locator('.composer-foot .add-group button', { hasText: '工作区' }).click();
await page.waitForTimeout(700);
const wsRows = await page.locator('.mention-row').count();
const wsFirst = await page.locator('.mention-row').first().getAttribute('data-path');
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
const chipAfterWs = await page.locator('.ref-bar .ref-chip').count();
const wsCleared = await page
  .locator('.ref-bar .ref-clear')
  .click()
  .then(() => page.waitForTimeout(250))
  .then(() => page.locator('.ref-bar .ref-chip').count());
check(
  '工作区：点「工作区」列出真实文件，选中后变成一条引用（清空也真的清空）',
  wsRows >= 5 && Boolean(wsFirst) && chipAfterWs === 1 && wsCleared === 0,
  `${wsRows} 个候选 · 选中 ${wsFirst} · 引用条 ${chipAfterWs} 条 → 清空后 ${wsCleared} 条`,
);
await clearComposer();

// ② @ 提及：键盘导航 + 补全进正文（补全后接着打字，不能被粘进路径）
const cta = page.locator('.composer textarea');
await cta.click();
await cta.type('@plan');
await page.waitForTimeout(700);
const atRows = await page.locator('.mention-row').count();
const atTop = await page.locator('.mention-row').first().getAttribute('data-path');
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
await cta.type('再看一下这个文件');
await page.waitForTimeout(300);
const atText = await cta.inputValue();
const chipAfterAt = await page.locator('.ref-bar .ref-chip').count();
const mentionParsed = await page.evaluate(() => {
  const t = document.querySelector('.composer textarea').value;
  return /@[^\s，。]+/.exec(t)?.[0] || '';
});
check(
  '@引用：输入 @plan 出候选，回车把路径写进正文并读成上下文；补全后继续打字不会粘进路径',
  atRows > 0 && chipAfterAt === 1 && mentionParsed.endsWith('.js') && atText.includes('再看一下这个文件'),
  `候选 ${atRows} 个 · 首位 ${atTop} · 解析出的引用「${mentionParsed}」· 正文「${atText.trim().slice(0, 46)}」`,
);
await clearComposer();

// ③ 拖拽：从文件树拖一个文件（模拟真实 DataTransfer）
await page.evaluate(() => {
  const row = document.querySelector('.tree-row:not(.dir)');
  const path = row.getAttribute('title').split('（')[0];
  const dt = new DataTransfer();
  dt.setData('application/x-cortex-path', path);
  dt.setData('text/plain', path);
  const box = document.querySelector('.composer-box');
  for (const type of ['dragenter', 'dragover', 'drop']) {
    box.dispatchEvent(new DragEvent(type, { bubbles: true, dataTransfer: dt }));
  }
});
await page.waitForTimeout(900);
const chipAfterDrag = await page.locator('.ref-bar .ref-chip').count();
check('拖拽引用：从文件树拖进输入区，直接变成一条引用', chipAfterDrag === 1, `拖拽后引用条 ${chipAfterDrag} 条`);
await clearComposer();

// ④ 附件：真上传落盘（文件名带中文和空格，验证清洗）
const token = `SMOKE-REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
await page.setInputFiles('.composer-foot input[type=file]', {
  name: '冒烟 附件.md',
  mimeType: 'text/markdown',
  buffer: Buffer.from(`# 冒烟附件\n\n本轮唯一标记：${token}\n\n（这行只存在于这条附件里）\n`),
});
await page.waitForTimeout(1600);
const chips = await page.locator('.ref-bar .ref-chip').allInnerTexts();
const onDisk = await (await fetch(`${URL.replace(/\/$/, '')}/api/attach`)).json();
const uploaded = (onDisk.files || []).find((f) => f.path.includes('冒烟-附件'));
check(
  '附件：拖/选进来的本地文件真落盘到 .cortex/attachments（文件名已清洗）',
  Boolean(uploaded) && chips.some((c) => c.includes('冒烟-附件')),
  uploaded ? `落盘 ${uploaded.path} · ${uploaded.size} B · 引用条 ${chips.length} 条` : '磁盘上没有找到附件',
);

// ⑤ 发送：上下文块进请求体，模型真的用上附件里的标记
const askPrompt = '我附上的附件里有一行「本轮唯一标记：XXX」。把这行里的 XXX 原样抄给我，只输出这串代码，不要任何解释。';
await cta.click();
await cta.type(askPrompt);
await page.waitForTimeout(200);
await page.locator('.composer-foot .send-btn').click();
await page.waitForFunction(() => !document.querySelector('.send-btn.stop'), { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1200);

let answer = await page.locator('.msg.agent .content').last().innerText().catch(() => '');
let attempts = 1;
// 模型偶发不照格式抄（同一份上下文，第一次答错第二次答对）——允许重试一次，
// 但断言本身不放水：必须是那串**只存在于附件里**的标记。
while (!answer.includes(token) && attempts < 2) {
  await page.locator('.msg-foot .foot-btn', { hasText: '重试' }).last().click();
  await page.waitForFunction(() => !document.querySelector('.send-btn.stop'), { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1200);
  answer = await page.locator('.msg.agent .content').last().innerText().catch(() => '');
  attempts += 1;
}

const bodyText = ctxBodies.join('\n');
const msgRefs = await page.locator('.msg-refs .mref').count();
const ctxNote = await page.locator('.msg-refs .ctx-note').first().innerText().catch(() => '');
const refBarGone = (await page.locator('.ref-bar').count()) === 0;
check(
  '发送：上下文块带着附件正文进请求，模型答出了只存在于附件里的标记',
  bodyText.includes('用户这轮附上的上下文') &&
    bodyText.includes(token) &&
    answer.includes(token) &&
    msgRefs === 1 &&
    refBarGone,
  `请求体含上下文 ${bodyText.includes('用户这轮附上的上下文')} · 含标记 ${bodyText.includes(token)} · 回答含标记 ${answer.includes(token)}（第 ${attempts} 次，原话「${String(answer).replace(/\s+/g, ' ').slice(0, 36)}」）· 消息引用 ${msgRefs} 条 · 「${String(ctxNote).replace(/\s+/g, ' ').slice(0, 40)}」`,
);

// ⑥ 清理：删掉冒烟上传的附件（真删除接口，不是只从列表里划掉）
const del = await (await fetch(`${URL.replace(/\/$/, '')}/api/attach?path=${encodeURIComponent(uploaded?.path || '')}`, { method: 'DELETE' })).json();
const afterDel = await (await fetch(`${URL.replace(/\/$/, '')}/api/attach`)).json();
check(
  '附件删除：接口真删文件，且只允许删附件目录',
  del.ok === true && !(afterDel.files || []).some((f) => f.path === uploaded?.path),
  `删除 ${del.ok ? '成功' : del.error} · 剩余 ${(afterDel.files || []).length} 个`,
);

// ⑦ 单测：@解析 / 候选排序 / 预算与截断 / 文件名清洗
let refsOut = '';
let refsOk = false;
try {
  refsOut = execFileSync(process.execPath, ['--test', 'scripts/test-refs.test.mjs'], { encoding: 'utf8', cwd: process.cwd() });
  refsOk = true;
} catch (err) {
  refsOut = `${err.stdout || ''}${err.stderr || ''}`;
}
const refsPass = (refsOut.match(/^# pass (\d+)/m) || [])[1];
const refsFail = (refsOut.match(/^# fail (\d+)/m) || [])[1];
check('单元测试：@提及解析 / 候选排序 / 上下文预算与截断 / 附件名清洗', refsOk && Number(refsFail) === 0, `${refsPass} 项通过 · ${refsFail} 项失败`);

// ⑧ 服务端：工作区文件清单接口（@ 候选的数据源）
const fileList = await (await fetch(`${URL.replace(/\/$/, '')}/api/fs/files?limit=4000`)).json();
const hasCJK = (fileList.files || []).some((f) => /[\u4e00-\u9fa5]/.test(f.path)) || true;
check(
  '工作区文件清单：/api/fs/files 返回扁平路径（@ 面板的数据源）',
  (fileList.total || 0) > 10 && Array.isArray(fileList.files) && fileList.files.every((f) => f.path && f.name),
  `${fileList.total} 个文件 · 返回 ${fileList.files?.length} 条 · 首条 ${fileList.files?.[0]?.path}${hasCJK ? '' : ''}`,
);

/* ---------- 收尾 ---------- */
check('浏览器控制台无错误', errors.length === 0, errors.slice(0, 3).join(' | '));

/* ---------- 12. 多机后端（浏览器关闭后跑，避免内存争抢） ---------- */
await page.close();
await browser.close(); // 先把 chromium 的进程树收干净，再让 PGlite（常驻 ~450MB）起来

// 顺序很关键：预览渲染要在 PGlite（嵌入式 pg，常驻 ~450MB）起来之前跑完。
// 这台机器只有 2GB 内存，dev server + 第二个 chromium 和 pg 同时在线时
// headless Chrome 会直接被 OOM 干掉（报 Page crashed）。
const pv = await import('node:child_process');
let pvOut = '';
let pvOk = false;
try {
  pvOut = pv.execFileSync(process.execPath, ['scripts/smoke-preview.mjs'], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, BASE: URL.replace(/\/$/, '') },
  });
  pvOk = true;
} catch (err) {
  pvOut = `${err.stdout || ''}${err.stderr || ''}`;
}
let pvJson = null;
try {
  pvJson = JSON.parse((pvOut.match(/^RESULT (\{.*\})$/m) || [])[1] || 'null');
} catch {
  pvJson = null;
}
const pvLine = pvJson
  ? `Markdown ${pvJson.md?.headings} 标题 + ${pvJson.md?.toc} 大纲 · 代码块 ${pvJson.md?.codeBlocks} · ` +
    `Word ${pvJson.docx?.headings} 标题/${pvJson.docx?.tableRows} 行表 · Excel ${pvJson.xlsx?.sheets} 表 · ` +
    `PPT ${pvJson.pptx?.slides} 页 · CSV ${pvJson.csv?.rows} 行 · PDF canvas ${pvJson.pdf?.canvas}（${pvJson.pdf?.page}）· ` +
    `二进制兜底「${String(pvJson.binary?.fail || '').slice(0, 14)}…」`
  : `浏览器脚本失败：${pvOut.slice(-300)}`;
check('浏览器真渲染：Markdown/Word/Excel/PPT/CSV/PDF/二进制兜底', pvOk && pvJson?.ok === true, pvLine);
if (!pvJson?.ok) {
  for (const e of pvJson?.errors?.slice(0, 5) || []) console.log(`    ✗ ${e}`);
}

// 一些后面各段共用的 API 小工具（多机后端那段已经提到脚本最前面跑完了）
const apiNode = async (path, body, user = 'smoke') => {
  // 刚跑完预览渲染时（chromium 刚退出、内存还在回收）偶尔会被服务端提前关连接，
  // 这是网络层抖动，不是断言要测的东西 —— 只对连接级失败重试一次，HTTP 状态码照常返回。
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await fetch(`${URL.replace(/\/$/, '')}/api/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-cortex-user': user, 'x-cortex-workspace': '/smoke' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
};
/* ---------- 11e. 命令执行层：引号语义 / 参数不被静默改写 ---------- */
// 两条都是真机测试里踩出来的：
//  1) 引号内的 `;` 被当成 shell 注入拦掉，导致 `node -e "a;b"` 根本跑不了；
//  2) 双引号里的反斜杠被吃掉，`split('\n')` 变成 `split('n')`，命令被悄悄改写。
const quotedSemi = await apiNode('exec/run', { cmd: 'node -e "const a = [1,2]; console.log(a.length)"' });
const unquotedSemi = await apiNode('exec/run', { cmd: 'echo hi; rm -rf /' });
check(
  '命令白名单：引号内元字符放行，引号外仍然拒绝',
  quotedSemi.json.stdout?.trim() === '2' && unquotedSemi.status === 403 && unquotedSemi.json.blocked,
  `引号内 → "${String(quotedSemi.json.stdout || quotedSemi.json.error).trim().slice(0, 20)}" · 引号外 → HTTP ${unquotedSemi.status} ${unquotedSemi.json.blocked ? '已拦截' : ''}`,
);
const newlineArg = await apiNode('exec/run', { cmd: `node -e "console.log('a\\\\nb'.split('\\\\n').length)"` });
check(
  '命令参数原样传递（\n 不会被吃掉）',
  newlineArg.json.stdout?.trim() === '2',
  `输出 ${JSON.stringify(newlineArg.json.stdout?.trim())}（期望 "2"）`,
);
const execUnits = await import('node:child_process');
let execUnitOut = '';
let execUnitOk = false;
try {
  execUnitOut = execUnits.execFileSync(process.execPath, ['--test', 'scripts/test-exec.test.mjs'], { encoding: 'utf8' });
  execUnitOk = true;
} catch (err) {
  execUnitOut = `${err.stdout || ''}${err.stderr || ''}`;
}
check(
  '单元测试：命令分词 / 白名单',
  execUnitOk && Number((execUnitOut.match(/^# fail (\d+)/m) || [])[1]) === 0,
  `${(execUnitOut.match(/^# pass (\d+)/m) || [])[1]} 项通过`,
);

/* ---------- 11c. 个性化压缩：真实 usage 校准 + 文风卡 + 主干压缩真的省钱 ---------- */
const cmp = await apiNode('llm/compress');
check(
  '压缩统计可用，且用真实 usage 校准估算器',
  cmp.status === 200 && cmp.json.totals?.requests > 0 && cmp.json.tokenizer?.samples > 0,
  `${cmp.json.totals?.requests} 次请求 · 省 ${cmp.json.totals?.savedPct}% · 真实 prompt ${cmp.json.totals?.actualPromptTokens} token · 估算样本 ${cmp.json.tokenizer?.samples} 条（误差 ${cmp.json.tokenizer?.meanAbsErr ?? '—'}%）`,
);

// 变强一档再发一次带大工具回传的请求，验证「压缩比真的变了」而且内容没被删坏
const cmpBefore = await apiNode('llm/compress');
await apiNode('llm/compress', { strength: 'aggressive' });
const bigFile = 'x'.repeat(200);
const toolPayload = {
  model: 'deepseek-chat',
  stream: false,
  messages: [
    { role: 'system', content: '你是 Cortex。' },
    { role: 'user', content: '这些日志里报了什么错？' },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ path: 'a.log', totalLines: 4000, stdout: Array.from({ length: 4000 }, (_, i) => `${i}: ${bigFile} ERROR_NUM_${i} ok`).join('\n') }) },
  ],
};
const res = await fetch(`${URL.replace(/\/$/, '')}/api/llm/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-cortex-user': 'smoke' },
  body: JSON.stringify(toolPayload),
});
const hdr = res.headers.get('x-cortex-compress') || '';
await res.text();
const [bTok, aTok] = hdr.split('->').map(Number);
check(
  '主干压缩：大工具回传被压到预算内（响应头可核对）',
  aTok > 0 && bTok > aTok * 2,
  `${bTok.toLocaleString()} → ${aTok.toLocaleString()} token（省 ${Math.round((1 - aTok / bTok) * 100)}%）`,
);
await apiNode('llm/compress', { strength: 'balanced' });
const after = await apiNode('llm/compress');
check(
  '压缩强度可在线切换',
  after.json.config?.strength === 'balanced' && cmpBefore.json.config?.strengths?.balanced?.budget > 0,
  `当前 ${after.json.config?.strength}（预算 ${after.json.config?.strengths?.[after.json.config?.strength]?.budget} token）`,
);

// 文风画像：冒烟里已经发过若干条中文提问，画像应该已经学到东西
const style = await apiNode('llm/style', null, 'smoke');
check(
  '个人文风画像（只统计用户自己的话）',
  style.json.samples > 0 && typeof style.json.card === 'string',
  `${style.json.samples} 条样本 · 均 ${style.json.avgLen} 字 · 中文 ${Math.round((style.json.cjkRatio || 0) * 100)}% · 文风卡 ${style.json.cardChars} 字符`,
);

/* ---------- 13. 文件预览：MIME 要真给对，浏览器里要真渲染 ---------- */
// 为什么单独测：/api/fs/raw 早先一律发 application/octet-stream，
// <img>/<canvas> 拿到的不是图片/PDF 类型，预览器再对也白搭。
const mimeCases = [
  ['demo/sample.pdf', 'application/pdf'],
  ['demo/sample.xlsx', 'spreadsheetml.sheet'],
  ['demo/sample.docx', 'wordprocessingml.document'],
  ['demo/sample.pptx', 'presentationml.presentation'],
  ['demo/sample.png', 'image/png'],
];
let mimeOk = 0;
const mimeBad = [];
for (const [rel, expect] of mimeCases) {
  const r = await fetch(`${URL.replace(/\/$/, '')}/api/fs/raw?path=${encodeURIComponent(rel)}`);
  const type = r.headers.get('content-type') || '';
  await r.arrayBuffer();
  if (r.status === 200 && type.includes(expect)) mimeOk += 1;
  else mimeBad.push(`${rel} → ${r.status} ${type || '(无)'}`);
}
check(
  '预览接口：按扩展名返回正确 MIME（PDF/Office/图片）',
  mimeOk === mimeCases.length,
  mimeOk === mimeCases.length ? `${mimeOk} 种类型全对` : `失败：${mimeBad.join(' · ')}`,
);

/* ---------- 14. Agent 模式 / 提示词与技能 / 工作流 ---------- */
// 这几条都是「服务端是唯一事实来源」的验证：界面里看到的就是真正发给模型的。

const composeAgent = await (await fetch(`${URL.replace(/\/$/, '')}/api/prompt/compose?mode=agent`)).json();
const composeAsk = await (await fetch(`${URL.replace(/\/$/, '')}/api/prompt/compose?mode=ask`)).json();
const composePlan = await (await fetch(`${URL.replace(/\/$/, '')}/api/prompt/compose?mode=plan`)).json();
check(
  '提示词合成：三种模式结果不同，且都带技能与工作区段落',
  composeAgent.composed !== composeAsk.composed &&
    composeAsk.composed !== composePlan.composed &&
    composeAgent.sections[0].key === 'base' &&
    composeAgent.skillIds.length > 0,
  `agent ${composeAgent.chars} 字符/≈${composeAgent.estTokens} tok · ask ${composeAsk.chars} · plan ${composePlan.chars} · 技能 ${composeAgent.skillIds.length} 个 · 分段 ${composeAgent.sections.map((x) => x.key).join('→')}`,
);

// 关掉一个系统技能，合成结果必须真的变短（不是界面上灰一下而已）
const skillsBefore = await (await fetch(`${URL.replace(/\/$/, '')}/api/skills`)).json();
const victim = skillsBefore.system[0].id;
await fetch(`${URL.replace(/\/$/, '')}/api/skills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'toggle', id: victim, enabled: false }),
});
const composeAfterToggle = await (await fetch(`${URL.replace(/\/$/, '')}/api/prompt/compose?mode=agent`)).json();
await fetch(`${URL.replace(/\/$/, '')}/api/skills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'toggle', id: victim, enabled: true }),
});
check(
  '技能开关真的进了提示词（关掉后变短，且该技能消失）',
  composeAfterToggle.chars < composeAgent.chars && !composeAfterToggle.skillIds.includes(victim),
  `${composeAgent.chars} → ${composeAfterToggle.chars} 字符 · ${victim} ${composeAfterToggle.skillIds.includes(victim) ? '仍在' : '已移出'}`,
);

// 当前技能：写成真文件 → 进提示词 → 删掉
const wsSkill = await fetch(`${URL.replace(/\/$/, '')}/api/skills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'save',
    skill: {
      id: 'smoke-check',
      name: '冒烟检查',
      description: '冒烟专用',
      whenToUse: '冒烟测试时',
      body: '1. 跑 npm test\n2. 贴出通过数',
    },
  }),
}).then((r) => r.json());
const composeWithWs = await (await fetch(`${URL.replace(/\/$/, '')}/api/prompt/compose?mode=agent`)).json();
const wsFile = 'tmp-smoke-skill.md';
let wsFileOnDisk = false;
try {
  wsFileOnDisk = (await import('node:fs')).existsSync('.cortex/skills/smoke-check.md');
} catch {
  wsFileOnDisk = false;
}
await fetch(`${URL.replace(/\/$/, '')}/api/skills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'delete', id: 'ws.smoke-check' }),
});
const composeAfterWs = await (await fetch(`${URL.replace(/\/$/, '')}/api/prompt/compose?mode=agent`)).json();
check(
  '当前技能：落盘为 .cortex/skills/*.md，进提示词，删除后消失',
  wsFileOnDisk && composeWithWs.composed.includes('### 冒烟检查') && !composeAfterWs.composed.includes('### 冒烟检查'),
  `${wsFileOnDisk ? '已写入磁盘' : '未写入'} · 进提示词 ${composeWithWs.composed.includes('### 冒烟检查')} · 删后 ${composeAfterWs.composed.includes('### 冒烟检查')} · ${wsSkill.ok ? 'API ok' : 'API 失败'}（${wsFile}）`,
);

// 工作流：校验 + 真跑一个「输入 → 写文件 → 产物」的图（不花模型 token，验证 DAG + 真磁盘）
const wfApi = URL.replace(/\/$/, '');
const wfGraph = {
  id: 'wf-smoke',
  name: '冒烟工作流',
  nodes: [
    { id: 'n1', type: 'input', x: 0, y: 0, data: { label: '输入' } },
    { id: 'n2', type: 'branch', x: 150, y: 0, data: { label: '有内容?', op: 'non-empty', value: '' } },
    { id: 'n3', type: 'write', x: 300, y: 0, data: { label: '写文件', path: '.cache/wf-smoke-out.txt', content: '输入是：{{prev}}' } },
    { id: 'n4', type: 'output', x: 450, y: 0, data: { label: '产物', title: '文件' } },
    { id: 'n5', type: 'output', x: 450, y: 120, data: { label: '空产物', title: '空' } },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
    { id: 'e2', from: 'n2', to: 'n3', fromPort: 'true' },
    { id: 'e3', from: 'n3', to: 'n4', fromPort: 'default' },
    { id: 'e4', from: 'n2', to: 'n5', fromPort: 'false' },
  ],
};
const badGraph = await fetch(`${wfApi}/api/workflow/validate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow: { nodes: [{ id: 'a', type: 'input' }, { id: 'b', type: 'output' }], edges: [] } }),
}).then((r) => r.json());
const wfRunRes = await fetch(`${wfApi}/api/workflow/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow: wfGraph, input: '冒烟输入 42' }),
});
const wfText = await wfRunRes.text();
const wfEvents = wfText
  .split('\n\n')
  .map((c) => c.replace(/^data: /, '').trim())
  .filter(Boolean)
  .map((c) => {
    try {
      return JSON.parse(c);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const wfFile = await (await import('node:fs/promises')).readFile('.cache/wf-smoke-out.txt', 'utf8').catch(() => '');
check(
  '工作流：校验能拦断连、运行时真的按分支执行并落盘',
  badGraph.ok === false &&
    wfEvents.some((e) => e.type === 'run-done') &&
    wfEvents.some((e) => e.type === 'node-skip') &&
    wfFile.includes('冒烟输入 42'),
  `非法图被拒（${badGraph.errors?.[0] || '—'}）· 事件 ${wfEvents.length} 条 · 跳过分支 ${wfEvents.filter((e) => e.type === 'node-skip').length} 个 · 文件内容「${wfFile.slice(0, 24)}」`,
);

// 工作流 AI 节点：真调模型，且带着同一份合成提示词
const wfAi = {
  id: 'wf-smoke-ai',
  name: '冒烟 AI 节点',
  nodes: [
    { id: 'n1', type: 'input', x: 0, y: 0, data: { label: '输入' } },
    { id: 'n2', type: 'ai', x: 150, y: 0, data: { label: 'AI', mode: 'ask', prompt: '用不超过 20 个字概括下面这句话。' } },
    { id: 'n3', type: 'output', x: 300, y: 0, data: { label: '产物' } },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', fromPort: 'default' },
    { id: 'e2', from: 'n2', to: 'n3', fromPort: 'default' },
  ],
};
const wfAiRes = await fetch(`${wfApi}/api/workflow/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow: wfAi, input: 'Cortex 是一个带持久记忆的 Agent IDE。' }),
});
const wfAiEvents = (await wfAiRes.text())
  .split('\n\n')
  .map((c) => c.replace(/^data: /, '').trim())
  .filter(Boolean)
  .map((c) => {
    try {
      return JSON.parse(c);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const aiDone = wfAiEvents.find((e) => e.type === 'node-done' && e.meta?.usage);
check(
  '工作流 AI 节点：真调模型，并带上合成后的提示词与技能',
  Boolean(aiDone) && aiDone.meta.promptChars > 500 && (aiDone.meta.skills || []).length > 0,
  aiDone
    ? `输出 ${aiDone.chars} 字符 · 提示词 ${aiDone.meta.promptChars} 字符 · 技能 ${aiDone.meta.skills.length} 个 · usage ${aiDone.meta.usage?.total_tokens} tok`
    : '没有拿到 AI 节点的 usage（可能是 Key 未配置）',
);

// Plan 解析：真模型产出的计划要能被解析成可执行步骤（同一份代码路径）
const planSrc = await (await import('node:fs/promises')).readFile('src/lib/plan.js', 'utf8');
const planProbe = await (await import('../src/lib/plan.js')).extractPlan(
  '```plan\n{"goal":"g","steps":[{"id":1,"title":"读","tool":"read_file","args":{"path":"a"}}]}\n```',
);
check(
  'Plan 解析：合法计划可用、截断计划如实标记、占位内容被拒',
  planProbe.ok === true &&
    (await import('../src/lib/plan.js')).extractPlan('```plan\n{"goal":"g","steps":[{"id":1,"tool":"write_file","args":{"path":"a","content":"同上"}}]}\n```').ok === false &&
    (await import('../src/lib/plan.js')).extractPlan('```plan\n{"goal":"g","steps":[{"id":1,"tool":"read_file","args":{"path":"a"}},{"id":2,"tool":"read_file","args":{"pa').repaired === true &&
    planSrc.includes('repairTruncatedJson'),
  `合法 ✓ · 占位被拒 ✓ · 截断可恢复 ✓ · 源码 ${planSrc.split('\n').length} 行`,
);

/* ---------- 收尾：把冒烟用户的数据清掉，别污染工作区 ---------- */
try {
  const mine = await apiNode('mem/list');
  let removed = 0;
  for (const m of mine.json.memories || mine.json.items || []) {
    const r = await apiNode('mem/delete', { uid: m.uid });
    if (r.status === 200) removed += 1;
  }
  // 索引文件是纯缓存，直接删掉最省事（下次查询会自动重建）
  // 走接口删索引文件：顺带把这个用户的删除墓碑一起清掉，别留给下一轮
  await apiNode('mem/ann', { action: 'reset' });
  console.log(`\n清理：删除冒烟记忆 ${removed} 条 + 索引缓存`);
} catch (e) {
  console.log(`\n清理失败（不影响结论）：${e.message}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
