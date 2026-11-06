// Dev: `/api` is proxied to API_TARGET — the mock (`npm run mock`, :8787) or the real harness (:8080).
// Build output goes to web/dist; serving it from the harness is the harness's job (SPEC §5).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.API_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target, changeOrigin: true } } },
  build: { outDir: "dist", emptyOutDir: true },
});
