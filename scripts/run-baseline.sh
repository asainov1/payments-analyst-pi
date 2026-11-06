#!/usr/bin/env bash
# Step 9 baseline: model pick on 20 tasks, then the full baseline on the chosen model
# (the full phase refuses to start if its estimate > $25 and stops once it spends > $25).
set -euo pipefail
cd "$(dirname "$0")/../harness"
node --env-file=../.env src/experiments/baseline.ts pick
MODEL="$(node -e "console.log(require('../state/experiments/b9-pick.json').chosen)")"
echo "chosen model: ${MODEL}"
node --env-file=../.env src/experiments/baseline.ts full "${MODEL}"
