# py-sandbox (SPEC §4.5): runs model-written Python. No network (internal compose network),
# read-only root fs, uid 65534, memory/pids limits — set in docker-compose.yml.
FROM python:3.12.14-slim-bookworm
RUN pip install --no-cache-dir pandas==3.0.6 duckdb==1.5.6
COPY server.py /app/server.py
USER 65534:65534
ENV PORT=8000 DATA_DIR=/data VERSIONS_DIR=/versions WORK_DIR=/work
EXPOSE 8000
CMD ["python3", "/app/server.py"]
