/**
 * 行级 diff（LCS + 重叠优化），零依赖
 * 输出：{ hunks: [{ type:'equal'|'add'|'del', lines:[{text, aLine, bLine}] }], stats }
 * 大文件自动降级为「按行号对齐的粗粒度 diff」，避免 O(n²) 卡死。
 */

const MAX_LINES = 4000;

function lcsMatrix(a, b) {
  const n = a.length;
  const m = b.length;
  // 滚动数组省内存，只保留方向需要的信息：用 Uint8Array 存回溯方向
  const dir = new Uint8Array((n + 1) * (m + 1));
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        dir[i * (m + 1) + j] = 1; // 对角
      } else if (prev[j] >= cur[j - 1]) {
        cur[j] = prev[j];
        dir[i * (m + 1) + j] = 2; // 上
      } else {
        cur[j] = cur[j - 1];
        dir[i * (m + 1) + j] = 3; // 左
      }
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return dir;
}

/** 计算两段文本的行 diff */
export function diffLines(before = '', after = '') {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return coarseDiff(a, b);

  const dir = lcsMatrix(a, b);
  const m = b.length;
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    const d = i > 0 && j > 0 ? dir[i * (m + 1) + j] : 0;
    if (d === 1) {
      ops.push({ type: 'equal', text: a[i - 1], aLine: i, bLine: j });
      i--;
      j--;
    } else if (d === 2 || j === 0) {
      ops.push({ type: 'del', text: a[i - 1], aLine: i });
      i--;
    } else {
      ops.push({ type: 'add', text: b[j - 1], bLine: j });
      j--;
    }
  }
  ops.reverse();

  // 把连续同一类型合并成 hunk
  const hunks = [];
  for (const op of ops) {
    const last = hunks[hunks.length - 1];
    if (last && last.type === op.type) last.lines.push(op);
    else hunks.push({ type: op.type, lines: [op] });
  }

  const added = ops.filter((o) => o.type === 'add').length;
  const removed = ops.filter((o) => o.type === 'del').length;
  return {
    hunks: collapseEqual(hunks),
    stats: { added, removed, aLines: a.length, bLines: b.length, coarse: false },
  };
}

/** 大文件降级：逐行比较，够用且线性 */
function coarseDiff(a, b) {
  const hunks = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) hunks.push({ type: 'equal', lines: [{ type: 'equal', text: av ?? '', aLine: i + 1, bLine: i + 1 }] });
    else {
      if (av !== undefined) hunks.push({ type: 'del', lines: [{ type: 'del', text: av, aLine: i + 1 }] });
      if (bv !== undefined) hunks.push({ type: 'add', lines: [{ type: 'add', text: bv, bLine: i + 1 }] });
    }
  }
  return {
    hunks,
    stats: {
      added: hunks.filter((h) => h.type === 'add').length,
      removed: hunks.filter((h) => h.type === 'del').length,
      aLines: a.length,
      bLines: b.length,
      coarse: true,
    },
  };
}

/** 折叠过长的未变更区域：只保留变更点前后 3 行 */
function collapseEqual(hunks, context = 3) {
  const out = [];
  for (const h of hunks) {
    if (h.type !== 'equal' || h.lines.length <= context * 2 + 1) {
      out.push(h);
      continue;
    }
    out.push({ type: 'equal', lines: h.lines.slice(0, context), folded: true, foldedCount: h.lines.length - context * 2 });
    out.push({ type: 'equal', lines: h.lines.slice(-context) });
  }
  return out;
}

/** 极简统计串：+12 −3 */
export function diffSummary(diff) {
  if (!diff?.stats) return '';
  return `+${diff.stats.added} −${diff.stats.removed}`;
}
