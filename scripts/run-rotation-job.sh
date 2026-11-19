#!/usr/bin/env bash
# 洛克阵容 48 小时轮换 · 一键任务
#
#   ./scripts/run-rotation-job.sh              # 定时任务用：没到 nextRotationAt 就什么都不做
#   FORCE=1 ./scripts/run-rotation-job.sh      # 手动立刻轮换
#   DRY_RUN=1 FORCE=1 ./scripts/run-rotation-job.sh   # 只跑 rotate + verify + build，不部署不推送
#
# 需要的环境变量（只在 env 里给，绝不写进仓库）：
#   CLOUDFLARE_API_TOKEN   具备 Workers 与 Pages 权限的 API Token
#   CLOUDFLARE_ACCOUNT_ID  Cloudflare Account ID
set -euo pipefail

export PATH=/workspace/.local/node/bin:/workspace/.local/bin:$PATH
cd "$(dirname "$0")/.."

round_of() {
  node -e "try{process.stdout.write(String(require('./src/data/team-rotation.json').round))}catch(e){process.stdout.write('0')}"
}

round_before="$(round_of)"

if [ "${FORCE:-0}" = "1" ]; then
  npm run rotate:teams
else
  npm run rotate:teams -- --if-due
fi

round_after="$(round_of)"
if [ "$round_before" = "$round_after" ]; then
  echo "[rotation] 未到轮换时间（仍在第 ${round_after} 轮），跳过校验与部署。"
  exit 0
fi

echo "[rotation] 第 ${round_before} 轮 → 第 ${round_after} 轮"

# 1) 数据与文案校验（任何一条引用不到图鉴就中止，不部署坏数据）
npm run verify:teams
npm run verify:tactics

# 2) 构建
npm run build

# 3) 部署静态站
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[rotation] DRY_RUN=1：跳过 wrangler 部署与 git push。"
  exit 0
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN 未设置}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID 未设置}"
npx wrangler pages deploy dist --project-name=locke-world-battle-ai --branch=main

# 4) 提交（只提交两份轮换数据；其它改动保持不动）
git add src/data/team-rotation.json src/data/rotation-history.json
if git diff --cached --quiet; then
  echo "[rotation] 没有需要提交的更改。"
else
  summary="$(node -e "const r=require('./src/data/team-rotation.json');process.stdout.write(r.round+' 轮 · '+r.teams.map(t=>t.archetypeLabel).join(' / '))")"
  git -c user.name='locke-rotation-bot' -c user.email='rotation@locke.local' \
    commit -m "阵容轮换：${summary}"
  git push origin main
fi

echo "[rotation] 完成：第 ${round_after} 轮已上线（下次 $(node -e "process.stdout.write(require('./src/data/team-rotation.json').nextRotationAt)")）。"
