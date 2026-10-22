#!/bin/bash
# 真机阶梯测试的跑法：**每个用例一个进程**。
#
# 为什么这么麻烦：这台机器只有 2 GB 内存，一个 chromium 吃到 1 GB 就会把整机拖死
# （真出过：25 分钟内任何命令都执行不了）。逐用例起进程，跑完就退，内存不累积。
# 用法：npm run e2e ｜ npm run e2e -- A5 B7 ｜ CORTEX_URL=http://localhost:5173 npm run e2e
set -u
cd "$(dirname "$0")/.." || exit 1
IDS="${*:-A1 A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14 A15 B1 B2 B3 B4 B5 B6 B7 B8 B9 B10 B11 B12}"
mkdir -p .cache/e2e/cases
fail=0
for id in $IDS; do
  E2E_HARD_MS=280000 timeout 320 node scripts/e2e-ladder.mjs --only="$id" --keep 2>&1 | grep -E "^(▶|✅|❌|⏱)" || fail=$((fail+1))
  sleep 2
done
node scripts/e2e-report.mjs
