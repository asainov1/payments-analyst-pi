#!/usr/bin/env bash
# Improver stage 1 (agreed): record v000's Sonnet val runs, then 1 generation with a $10 budget.
set -euo pipefail
cd "$(dirname "$0")/../harness"
node --env-file=../.env src/improver/seed.ts v000 b9-val-1-sonnet b9-val-2-sonnet
LLM_CONCURRENCY=24 node --env-file=../.env src/improver/main.ts --generations 1 --budget-usd 10 --no-new-generation-after 17:15
