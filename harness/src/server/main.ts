// harness service entrypoint (SPEC §2): one process owns all LLM calls — API, chat, batch runs.
//   node --env-file=../.env src/server/main.ts
// Env: PORT (8080), HOST (127.0.0.1; 0.0.0.0 in a container), STATE_DIR (../state), IO_DIR (../io).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../api/server.ts";
import { ChatService } from "../chat/service.ts";
import { BatchRunner } from "../runs/batch.ts";
import { createRuntime } from "../runtime/app.ts";
import { VersionsService } from "../versions/service.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function main(): Promise<void> {
  const env = process.env;
  const app = await createRuntime({ repoRoot: ROOT, stateDir: env.STATE_DIR });
  const ioDir = env.IO_DIR ?? join(ROOT, "io");
  mkdirSync(ioDir, { recursive: true });
  const runner = new BatchRunner({ db: app.db, solver: app.solver(), concurrency: Number(env.BATCH_CONCURRENCY ?? 12), ioDir, repoRoot: ROOT, warmup: true });
  const chat = new ChatService({ db: app.db, repoRoot: ROOT, factory: app.chatFactory, baseTools: app.chatTools, onUsage: app.onUsage, tracing: app.tracing });
  const server = buildServer({
    runner,
    chat,
    versions: new VersionsService(ROOT),
    ledger: app.ledger,
    db: app.db,
    webDist: env.WEB_DIST ?? join(ROOT, "web", "dist"),
  });
  const url = await server.listen({ port: Number(env.PORT ?? 8080), host: env.HOST ?? "127.0.0.1" });
  console.log(`harness listening on ${url} (state ${app.stateDir}, tracing ${app.tracing ? "on" : "off"}, python ${app.pythonUrl ?? "off"})`);
  const shutdown = async () => {
    await server.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
