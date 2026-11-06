import { defineConfig } from "vitest/config";

// test/live/* call the real LLM proxy (costs money) — run them only via `npm run test:live`.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/live/**", "node_modules/**"] } });
