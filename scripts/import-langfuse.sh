#!/usr/bin/env bash
# Load an archive from export-langfuse.sh into this compose project's (empty) Langfuse volumes.
# Usage: scripts/import-langfuse.sh langfuse-export.tar.gz   then: docker compose up -d
# Set COMPOSE_PROJECT_NAME to import into a different project (e.g. a clean check stack).
set -euo pipefail
cd "$(dirname "$0")/.."
IN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
VOLUMES=(langfuse_postgres_data langfuse_clickhouse_data langfuse_minio_data langfuse_redis_data)

docker compose stop langfuse-web langfuse-worker postgres clickhouse minio redis 2>/dev/null || true
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -C "$TMP" -xzf "$IN"
for v in "${VOLUMES[@]}"; do
  docker volume create "${PROJECT}_${v}" >/dev/null
  docker run --rm -v "${PROJECT}_${v}:/dst" -v "$TMP:/src:ro" alpine:3.20 sh -c "find /dst -mindepth 1 -delete && tar -C /dst -xzf /src/${v}.tar.gz"
done
echo "imported $IN into project ${PROJECT}; run: docker compose up -d"
