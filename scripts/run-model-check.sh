#!/usr/bin/env bash
# Step 9 model check on improve-train: Sonnet vs the baseline's Haiku run (rule fixed in advance,
# see baseline.ts `check`); switches to Sonnet + val ×2 only if the rule says so. Phase guard $10.
set -euo pipefail
cd "$(dirname "$0")/../harness"
node --env-file=../.env src/experiments/baseline.ts check
