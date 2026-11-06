# harness service (SPEC §2): API + chat + batch runner + LLM proxy in one process, serves web/dist.
# Build context: repo root (docker compose sets it). Layout under /app mirrors the repo:
# /app/harness (code), /app/web/dist (UI), /app/bundle, /app/versions, /app/config (mounted).

FROM node:25.8.2-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:25.8.2-bookworm-slim AS deps
WORKDIR /app/harness
COPY harness/package.json harness/package-lock.json harness/.npmrc ./
RUN npm ci --omit=dev

FROM node:25.8.2-bookworm-slim
# python3: the official scorer runs as a subprocess (stdlib only).
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/harness
COPY --from=deps /app/harness/node_modules ./node_modules
COPY harness/package.json ./
COPY harness/src ./src
COPY --from=web /app/web/dist /app/web/dist
COPY harness/bin/harness /usr/local/bin/harness
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATE_DIR=/app/state IO_DIR=/io PYTHON=python3
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=12 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/harness/src/server/main.ts"]
