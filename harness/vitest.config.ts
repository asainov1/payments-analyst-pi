import { defineConfig } from "vitest/config";

// test/live/* call the real LLM proxy (cost money) — `npm run test:live` only.
// test/docker/* need `docker compose up` — `npm run test:docker` only.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/live/**", "test/docker/**", "node_modules/**"] } });
