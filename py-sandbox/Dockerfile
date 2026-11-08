# py-sandbox (SPEC §4.5): runs model-written Python. No network (internal compose network),
# read-only root fs, uid 65534, memory/pids limits — set in docker-compose.yml.
# Build context: repo root (only bundle/data and config/data-schema.sql are copied — never tasks/ or scorer/).
FROM python:3.12.14-slim-bookworm AS base
RUN pip install --no-cache-dir pandas==3.0.6 duckdb==1.5.6

# The same tables/views as the harness `sql` tool, built once from the shared schema. Root-owned and
# read-only in the final image, so model code cannot alter what other sessions read.
FROM base AS db
COPY bundle/data /build/data
COPY config/data-schema.sql /build/data-schema.sql
COPY py-sandbox/build_db.py /build/build_db.py
RUN python3 /build/build_db.py /build/data-schema.sql /build/data /build/payments.duckdb

FROM base
COPY py-sandbox/server.py /app/server.py
COPY --from=db /build/payments.duckdb /opt/db/payments.duckdb
RUN chmod 0555 /opt/db && chmod 0444 /opt/db/payments.duckdb
USER 65534:65534
ENV PORT=8000 DATA_DIR=/data VERSIONS_DIR=/versions WORK_DIR=/work DB_FILE=/opt/db/payments.duckdb
EXPOSE 8000
CMD ["python3", "/app/server.py"]
