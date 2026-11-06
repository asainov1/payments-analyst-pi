#!/usr/bin/env bash
# Step 20 — finalisation, in three phases (run from the repo root after the improver has stopped):
#   scripts/finalize.sh prepare   report-holdout of BEST, versions table into REPORT/README, key spend
#   (review and commit versions/, REPORT.md, README.md)
#   scripts/finalize.sh freeze    state → harness container, /api/budget check, container improve
#                                 start check ($0.01, no new version), tag best-frozen, clean-clone test
#   scripts/finalize.sh export    Langfuse export (stops the stack briefly) — last
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"

no_improver_running() {
  if pgrep -f "src/improver/main.ts" >/dev/null; then echo "an improver process is still running — stop it first" >&2; exit 1; fi
}

case "${1:-}" in
  prepare)
    no_improver_running
    (cd harness && node --env-file=../.env src/improver/finalize.ts holdout)
    (cd harness && node --env-file=../.env src/improver/finalize.ts report-md)
    (cd harness && node --env-file=../.env src/improver/finalize.ts key-spend)
    echo "prepare done — review and commit versions/, REPORT.md, README.md, then: scripts/finalize.sh freeze"
    ;;

  freeze)
    no_improver_running
    if [[ -n "$(git status --porcelain versions config REPORT.md README.md)" ]]; then
      echo "uncommitted changes in versions/ config/ REPORT.md README.md — commit them first" >&2; exit 1
    fi
    # 1. host state → the harness container's volume (WAL checkpoint first, so nothing is left in -wal)
    docker compose stop harness
    sqlite3 state/harness.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
    UID_IN="$(docker run --rm --entrypoint id zimran-task/harness:local -u)"
    docker run --rm -v "$PWD/state:/src:ro" -v "${PROJECT}_harness_state:/dst" alpine:3.20 \
      sh -c "rm -f /dst/harness.db /dst/harness.db-wal /dst/harness.db-shm /dst/harness.lock && cp /src/harness.db /dst/harness.db && chown ${UID_IN}:${UID_IN} /dst/harness.db"
    docker compose up -d harness
    curl -fsS --retry 30 --retry-all-errors --retry-delay 2 -o /dev/null http://localhost:8080/api/health
    # 2. the UI header now shows the real spend
    BUDGET="$(curl -fsS http://localhost:8080/api/budget)"
    HOST_SPENT="$(sqlite3 state/harness.db "SELECT ROUND(SUM(cost_usd), 4) FROM ledger;")"
    echo "container /api/budget: ${BUDGET}  host ledger: ${HOST_SPENT}"
    # 3. improve starts in the container: reads BEST + gate.json, finds val runs, stops on budget, no new version
    BEFORE="$(ls versions | sort | tr '\n' ' ')"
    docker compose exec -T harness harness improve --generations 1 --budget-usd 0.01 || true
    AFTER="$(ls versions | sort | tr '\n' ' ')"
    if [[ "$BEFORE" != "$AFTER" ]]; then echo "container improve created a version: $BEFORE → $AFTER" >&2; exit 1; fi
    echo "container improve: started and stopped on budget, no new version"
    # 4. freeze
    git tag -f best-frozen
    echo "tagged best-frozen at $(git rev-parse --short HEAD) (BEST = $(cat versions/BEST))"
    # 5. clean clone
    scripts/clean-clone-test.sh
    ;;

  export)
    scripts/export-langfuse.sh langfuse-export.tar.gz
    ;;

  *)
    echo "usage: scripts/finalize.sh prepare | freeze | export" >&2; exit 2
    ;;
esac
