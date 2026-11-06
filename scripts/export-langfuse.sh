#!/usr/bin/env bash
# Export all Langfuse data (Postgres, ClickHouse, MinIO, Redis volumes) to one archive.
# Usage: scripts/export-langfuse.sh [out.tar.gz]   (default: langfuse-export.tar.gz)
# Stops the Langfuse services for a consistent snapshot, then starts them again.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(cd "$(dirname "${1:-langfuse-export.tar.gz}")" && pwd)/$(basename "${1:-langfuse-export.tar.gz}")"
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
VOLUMES=(langfuse_postgres_data langfuse_clickhouse_data langfuse_minio_data langfuse_redis_data)
SERVICES=(langfuse-web langfuse-worker postgres clickhouse minio redis)

docker compose stop "${SERVICES[@]}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; docker compose start "${SERVICES[@]}" >/dev/null' EXIT
for v in "${VOLUMES[@]}"; do
  docker run --rm -v "${PROJECT}_${v}:/src:ro" -v "$TMP:/dst" alpine:3.20 tar -C /src -czf "/dst/${v}.tar.gz" .
done
tar -C "$TMP" -czf "$OUT" .
echo "exported → $OUT ($(du -h "$OUT" | cut -f1))"
