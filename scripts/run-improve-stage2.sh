#!/usr/bin/env bash
# Improver stage 2 (agreed): 5 generations, $60 total ($4.65 spent before the reflector fix → $55), no new generation after 17:15.
set -euo pipefail
cd "$(dirname "$0")/../harness"
LLM_CONCURRENCY=24 node --env-file=../.env src/improver/main.ts --generations 5 --budget-usd 55 --no-new-generation-after 17:15
