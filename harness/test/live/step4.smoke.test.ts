// Live smoke (SPEC §6 step 4): 3 easy improve-split train tasks through BatchRunner → analyst
// (Pi) → proxy → LiteLLM, on v000 (Sonnet) and the same tasks on Haiku. Ledger cap $0.50.
// Run: node --env-file=../.env --test test/live/step4.smoke.test.ts
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
import { LlmProxy, type LlmUsageEvent } from "../../src/llm/proxy.ts";
import { BatchRunner } from "../../src/runs/batch.ts";
import { BudgetLedger } from "../../src/runtime/budget.ts";
import { Governor } from "../../src/runtime/governor.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DATA = join(ROOT, "bundle", "data");
const TASK_IDS = ["1014", "1037", "1041"]; // first 3 easy tasks of config/splits.json improve
const CAP = 0.5;

const dir = mkdtempSync(join(tmpdir(), "smoke-"));
const io = join(dir, "io");
mkdirSync(io);
const train = readFileSync(join(ROOT, "bundle", "tasks", "train.jsonl"), "utf8").split("\n").filter(Boolean);
writeFileSync(join(io, "tasks.jsonl"), `${train.filter((l) => TASK_IDS.includes(JSON.parse(l).task_id)).join("\n")}\n`);

const state = openDb(join(dir, "harness.db"));
const ledger = new BudgetLedger(state, { capUsd: CAP });
const governor = new Governor({ ledger, concurrency: 3, rpm: 50 });
const prices = loadPrices(join(ROOT, "config", "prices.json"));
const proxy = new LlmProxy({ upstream: process.env.LITELLM_BASE_URL ?? "", apiKey: process.env.LITELLM_API_KEY ?? "", governor, prices });
const usage: LlmUsageEvent[] = [];
proxy.on("usage", (e) => usage.push(e));
let rt: PiRuntime;
let data: DataDb;

before(async () => {
  assert.ok(process.env.LITELLM_API_KEY, "LITELLM_API_KEY missing (.env)");
  rt = await createPiRuntime({ proxyUrl: await proxy.start(), prices, stateDir: dir });
  data = await openDataDb(DATA);
});
after(async () => {
  data?.close();
  await proxy.stop();
});

async function smoke(label: string, modelOverride?: string) {
  const traces = new Map<string, SolveTrace>();
  const solver = createAnalystSolver(
    {
      rt,
      db: data,
      dataDir: DATA,
      repoRoot: ROOT,
      workDir: join(dir, "work"),
      prices,
      modelOverride,
      onUsage: (fn) => {
        proxy.on("usage", fn);
        return () => proxy.off("usage", fn);
      },
    },
    (id, t) => traces.set(id, t),
  );
  const runner = new BatchRunner({ db: state, solver, concurrency: 1, ioDir: io, repoRoot: ROOT });
  const run = await runner.wait(await runner.startSolve({ tasksFile: join(io, "tasks.jsonl"), version: "v000", out: join(io, `${label}.jsonl`) }));
  const ev = usage.filter((e) => e.ref.startsWith(run.id));
  const tok = (k: "input" | "cacheRead" | "cacheWrite") => ev.reduce((s, e) => s + e.usage[k], 0);
  const hit = tok("cacheRead") / (tok("input") + tok("cacheRead") + tok("cacheWrite"));
  console.log(`\n== ${label}: ${run.summary?.correct}/${run.summary?.n} correct, $${ledger.spentUsd().toFixed(4)} spent so far, cache hit ${(hit * 100).toFixed(1)}%, ${ev.length} LLM calls`);
  console.table(
    run.tasks.map((t) => {
      const tr = traces.get(t.task_id);
      return { task: t.task_id, answer: (t.answer ?? "").slice(0, 60), correct: t.correct, valid: tr?.valid, tools: tr?.toolCalls, usd: tr?.costUsd.toFixed(4), limit: tr?.limit };
    }),
  );
  return { run, hit, traces };
}

// Criterion (agreed): every answer passes format validation and ≥ 2/3 are correct on each model.
// LLM answers are not deterministic; run-to-run variance is measured on val in step 9.
test("smoke: v000 on Sonnet and Haiku — all answers valid, ≥ 2/3 correct on each", async () => {
  for (const [label, override] of [["sonnet", undefined], ["haiku", "claude-haiku-5-5"]] as const) {
    const { run, traces } = await smoke(label, override);
    assert.equal(run.status, "done", label);
    assert.equal(traces.size, 3, `${label}: every task produced a trace`);
    for (const [id, t] of traces) assert.equal(t.valid, true, `${label} ${id}: answer must pass format validation`);
    assert.ok((run.summary?.correct ?? 0) >= 2, `${label}: ≥ 2/3 correct, got ${run.summary?.correct}`);
  }
  assert.ok(ledger.spentUsd() < CAP);
});
