#!/usr/bin/env bash
# Improver stage 2, extra window (agreed): restart right after the 5-generation run ends before 17:15,
# $25 budget, 3 generations, same cut-off. Gate, T and pre-filters unchanged.
set -euo pipefail
cd "$(dirname "$0")/../harness"
LLM_CONCURRENCY=24 node --env-file=../.env src/improver/main.ts --generations 3 --budget-usd 25 --no-new-generation-after 17:15
