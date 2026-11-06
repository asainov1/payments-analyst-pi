// Variant A (agreed): the reflector sees only gold-independent runtime telemetry of the parent
// (turn-limit hits, > 60 s, p95) on train and val — never val task ids, questions or correctness.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../src/db/db.ts";
import { runtimeTelemetry } from "../src/improver/loop.ts";
import { buildReflectorPrompt } from "../src/improver/reflector.ts";
import { readVersion } from "../src/improver/store.ts";
import { BatchRunner, type Solver } from "../src/runs/batch.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const val = readFileSync(join(ROOT, "bundle", "tasks", "val.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("runtime telemetry", () => {
  test("counts limit hits, > 60 s and p95 per run from run_tasks.ms only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tel-"));
    const io = join(dir, "io");
    mkdirSync(io);
    writeFileSync(join(io, "t.jsonl"), `${val.slice(0, 4).map((t) => JSON.stringify(t)).join("\n")}\n`);
    const db = openDb(join(dir, "h.db"));
    const solver: Solver = async () => ({ answer: "Not Applicable" });
    const r = new BatchRunner({ db, solver, concurrency: 1, ioDir: io, repoRoot: ROOT });
    const run = await r.wait(await r.startSolve({ tasksFile: join(io, "t.jsonl"), version: "v000", out: join(io, "a.jsonl") }));
    const ms = [5_000, 70_000, 181_000, 182_000];
    run.tasks.forEach((t, i) => {
      db.prepare("UPDATE run_tasks SET ms = ? WHERE run_id = ? AND task_id = ?").run(ms[i], run.id, t.task_id);
    });
    expect(runtimeTelemetry(db, [run.id], 180)).toEqual({ runs: 1, tasks_per_run: 4, limit_hits_per_run: 2, over_60s_per_run: 3, p95_s: 182 });
  });
});

describe("reflector prompt with telemetry", () => {
  test("contains only the counters — no val task ids, no val question text, no correctness", () => {
    const parent = readVersion(ROOT, "v000");
    const p = buildReflectorPrompt({
      parent,
      failures: [],
      slow: [],
      feedback: [],
      rejected: [],
      telemetry: {
        val: { runs: 3, tasks_per_run: 91, limit_hits_per_run: 14, over_60s_per_run: 20, p95_s: 180 },
        train: { runs: 1, tasks_per_run: 40, limit_hits_per_run: 0, over_60s_per_run: 0, p95_s: 21 },
      },
    });
    expect(p).toContain("14 of 91");
    expect(p).toContain("max_turn_s");
    for (const t of val) {
      expect(p).not.toContain(t.question.slice(0, 60));
      expect(p).not.toMatch(new RegExp(`\\b${t.task_id}\\b`));
    }
    expect(p).not.toMatch(/correct|accuracy|wrong/i);
  });
});
