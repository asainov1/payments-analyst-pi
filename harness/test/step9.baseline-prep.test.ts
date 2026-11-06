// SPEC §6 step 9 (preparation, no LLM): cache warm-up before fan-out, run metrics,
// stratified task sample, phase budget guard.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../src/db/db.ts";
import { phaseBudgetGuard, stratifiedSample } from "../src/experiments/baseline-lib.ts";
import { BatchRunner, type Solver } from "../src/runs/batch.ts";
import { runMetrics } from "../src/runs/metrics.ts";
import { BudgetExhausted, BudgetLedger } from "../src/runtime/budget.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const trainLines = readFileSync(join(ROOT, "bundle", "tasks", "train.jsonl"), "utf8").split("\n").filter(Boolean);

function env(n: number) {
  const dir = mkdtempSync(join(tmpdir(), "b9-"));
  const io = join(dir, "io");
  mkdirSync(io);
  writeFileSync(join(io, "t.jsonl"), `${trainLines.slice(0, n).join("\n")}\n`);
  return { db: openDb(join(dir, "h.db")), io, tasks: join(io, "t.jsonl"), out: join(io, "a.jsonl") };
}

describe("cache warm-up before fan-out (з)", () => {
  test("with warmup the first task finishes before any other starts; then runs in parallel", async () => {
    const e = env(6);
    const log: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const solver: Solver = async (_t, ctx) => {
      log.push(`start ${ctx.taskId}`);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      log.push(`end ${ctx.taskId}`);
      return { answer: "Not Applicable" };
    };
    const r = new BatchRunner({ db: e.db, solver, concurrency: 4, ioDir: e.io, repoRoot: ROOT, warmup: true });
    await r.wait(await r.startSolve({ tasksFile: e.tasks, version: "v000", out: e.out }));
    expect(log[0]).toMatch(/^start/);
    expect(log[1]).toMatch(/^end/); // nothing else started while the first task was running
    expect(peak).toBe(4);
  });
});

describe("run metrics", () => {
  test("accuracy, $/task, $/correct, p50/p95 latency, cache hit from ledger + run tasks", async () => {
    const e = env(4);
    const ledger = new BudgetLedger(e.db, { capUsd: 10 });
    let i = 0;
    const solver: Solver = async (_t, ctx) => {
      const k = i++;
      await new Promise((r) => setTimeout(r, 10 * (k + 1)));
      ledger.record({ scope: "solve", ref: `${ctx.runId}/${ctx.taskId}`, costUsd: 0.01, model: "m", usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0 } });
      return { answer: "Not Applicable" };
    };
    const r = new BatchRunner({ db: e.db, solver, concurrency: 1, ioDir: e.io, repoRoot: ROOT });
    const run = await r.wait(await r.startSolve({ tasksFile: e.tasks, version: "v000", out: e.out }));
    const m = runMetrics(e.db, run.id);
    expect(m.n).toBe(4);
    expect(m.correct).toBe(run.summary?.correct);
    expect(m.cost_usd).toBeCloseTo(0.04);
    expect(m.cost_per_task_usd).toBeCloseTo(0.01);
    expect(m.cache_hit_rate).toBeCloseTo(0.9);
    expect(m.llm_calls).toBe(4);
    expect(m.latency_p50_s).toBeGreaterThan(0);
    expect(m.latency_p95_s).toBeGreaterThanOrEqual(m.latency_p50_s);
    expect(m.cost_per_correct_usd === null || m.cost_per_correct_usd > 0).toBe(true);
  });
});

describe("stratified sample", () => {
  const tasks = trainLines.map((l) => JSON.parse(l));
  test("deterministic, keeps the easy/hard ratio, only from the given ids", () => {
    const ids = JSON.parse(readFileSync(join(ROOT, "config", "splits.json"), "utf8")).improve as string[];
    const a = stratifiedSample(tasks, ids, 20, 7);
    expect(stratifiedSample(tasks, ids, 20, 7)).toEqual(a);
    expect(a).toHaveLength(20);
    expect(a.every((id) => ids.includes(id))).toBe(true);
    const easy = a.filter((id) => tasks.find((t) => t.task_id === id).level === "easy").length;
    const ratio = ids.filter((id) => tasks.find((t) => t.task_id === id).level === "easy").length / ids.length;
    expect(Math.abs(easy - Math.round(20 * ratio))).toBeLessThanOrEqual(1);
  });
});

describe("phase budget guard", () => {
  test("throws BudgetExhausted once spend since the phase start exceeds the limit", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "pg-")), "h.db"));
    const ledger = new BudgetLedger(db, { capUsd: 100 });
    ledger.record({ scope: "solve", ref: "old", costUsd: 50 }); // before the phase: not counted
    const guard = phaseBudgetGuard(db, 1.0);
    expect(() => guard()).not.toThrow();
    ledger.record({ scope: "solve", ref: "x", costUsd: 1.2 });
    expect(() => guard()).toThrow(BudgetExhausted);
  });
});
