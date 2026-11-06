// Live (SPEC §6 step 3): one easy task on Haiku with tracing → read the trace back from the
// self-hosted Langfuse (docker compose up). ≈ $0.002.
// Run: node --env-file=../.env --test test/live/step3.langfuse.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAnalystSolver, type SolveTrace } from "../../src/agent/analyst.ts";
import { type DataDb, openDataDb } from "../../src/data/db.ts";
import { openDb } from "../../src/db/db.ts";
import { createPiRuntime, type PiRuntime } from "../../src/llm/pi.ts";
import { loadPrices } from "../../src/llm/prices.ts";
import { LlmProxy } from "../../src/llm/proxy.ts";
import { initTracing } from "../../src/obs/tracer.ts";
import { BatchRunner } from "../../src/runs/batch.ts";
import { BudgetLedger } from "../../src/runtime/budget.ts";
import { Governor } from "../../src/runtime/governor.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DATA = join(ROOT, "bundle", "data");
const LF = process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000";
const PK = process.env.LANGFUSE_PUBLIC_KEY ?? "pk-lf-local";
const SK = process.env.LANGFUSE_SECRET_KEY ?? "sk-lf-local";
const auth = `Basic ${Buffer.from(`${PK}:${SK}`).toString("base64")}`;

const dir = mkdtempSync(join(tmpdir(), "lf-"));
const io = join(dir, "io");
mkdirSync(io);
const line = readFileSync(join(ROOT, "bundle", "tasks", "train.jsonl"), "utf8")
  .split("\n")
  .find((l) => l && JSON.parse(l).task_id === "1014");
writeFileSync(join(io, "tasks.jsonl"), `${line}\n`);

const state = openDb(join(dir, "harness.db"));
const ledger = new BudgetLedger(state, { capUsd: 0.05 });
const governor = new Governor({ ledger, concurrency: 1, rpm: 30 });
const prices = loadPrices(join(ROOT, "config", "prices.json"));
const proxy = new LlmProxy({ upstream: process.env.LITELLM_BASE_URL ?? "", apiKey: process.env.LITELLM_API_KEY ?? "", governor, prices });
const tracing = initTracing({ publicKey: PK, secretKey: SK, baseUrl: LF, publicUrl: LF, projectId: "analyst" });
let rt: PiRuntime;
let data: DataDb;

before(async () => {
  assert.equal((await fetch(`${LF}/api/public/health`)).status, 200, "Langfuse is not up (docker compose up)");
  rt = await createPiRuntime({ proxyUrl: await proxy.start(), prices, stateDir: dir });
  data = await openDataDb(DATA);
});
after(async () => {
  data?.close();
  await proxy.stop();
  await tracing.shutdown();
});

async function getJson(path: string): Promise<any> {
  const r = await fetch(`${LF}${path}`, { headers: { Authorization: auth } });
  return r.ok ? r.json() : null;
}

test("task trace in Langfuse: agent root, generations with tokens/cache/cost, tool observations, session = run", async () => {
  let tr: SolveTrace | undefined;
  const solver = createAnalystSolver(
    {
      rt,
      db: data,
      dataDir: DATA,
      repoRoot: ROOT,
      workDir: join(dir, "work"),
      prices,
      modelOverride: "claude-haiku-5-5",
      tracing,
      onUsage: (fn) => {
        proxy.on("usage", fn);
        return () => proxy.off("usage", fn);
      },
    },
    (_id, t) => {
      tr = t;
    },
  );
  const runner = new BatchRunner({ db: state, solver, concurrency: 1, ioDir: io, repoRoot: ROOT });
  const run = await runner.wait(await runner.startSolve({ tasksFile: join(io, "tasks.jsonl"), version: "v000", out: join(io, "a.jsonl") }));
  await tracing.flush();
  assert.equal(run.status, "done");
  assert.ok(tr?.traceUrl, "trace url");
  const traceId = String(tr?.traceUrl?.split("/").pop());
  console.log(`trace: ${tr?.traceUrl}`);

  // Langfuse v4 (events_only): read observations through the v2 API.
  let obs: any[] = [];
  for (let i = 0; i < 30 && !(obs.length >= 4 && obs.some((o) => o.type === "AGENT")); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    obs = (await getJson(`/api/public/v2/observations?traceId=${traceId}&limit=100&fields=core,basic,usage,model,metadata`))?.data ?? [];
  }
  console.table(obs.map((o) => ({ type: o.type, name: o.name, model: o.model, latency: o.latency, ttft: o.timeToFirstToken, cr: o.usageDetails?.cache_read_input_tokens, cw: o.usageDetails?.cache_creation_input_tokens, usd: o.costDetails?.total, level: o.level })));

  assert.ok(obs.length > 0, "trace not found in Langfuse");
  assert.ok(obs.every((o) => o.sessionId === run.id && o.version === "v000"), "session = run id, version on every observation");
  assert.ok(obs.some((o) => o.type === "AGENT" && o.name === "task"));
  const gens = obs.filter((o) => o.type === "GENERATION");
  assert.ok(gens.length >= 2, "≥ 2 LLM calls (tool use + answer)");
  assert.ok(gens.every((g) => g.model === "claude-haiku-5-5"));
  assert.ok(gens.some((g) => (g.usageDetails?.cache_read_input_tokens ?? 0) > 0), "cache reads visible");
  assert.ok(gens.every((g) => (g.costDetails?.total ?? 0) > 0), "cost on every generation");
  assert.ok(gens.every((g) => g.latency > 0.1), "generation latency covers the request, not only the stream");
  assert.ok(obs.some((o) => o.type === "TOOL" && o.name === "sql"));
  assert.ok(obs.some((o) => o.type === "TOOL" && o.name === "submit_answer"));
  // Batch: an accepted submit_answer ends the turn — no LLM call after it.
  const submitAt = Math.max(...obs.filter((o) => o.name === "submit_answer").map((o) => Date.parse(o.startTime)));
  assert.ok(gens.every((g) => Date.parse(g.startTime) < submitAt), "no generation after submit_answer");
  console.log(`LLM calls in this task: ${gens.length}`);
});
