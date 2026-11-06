// SPEC §6 step 7: batch runner + `harness solve` (CLI → API), /io paths, resume, scoring, splits.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildServer } from "../src/api/server.ts";
import { solveCommand } from "../src/cli/harness.ts";
import { openDb } from "../src/db/db.ts";
import { BatchRunner, type Solver } from "../src/runs/batch.ts";
import { makeSplits } from "../src/runs/splits.ts";
import { BudgetExhausted } from "../src/runtime/budget.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TRAIN = join(ROOT, "bundle", "tasks", "train.jsonl");
const trainLines = readFileSync(TRAIN, "utf8").split("\n").filter(Boolean);

function env(nTasks = 10, { withAnswers = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "batch-"));
  const io = join(dir, "io");
  mkdirSync(io);
  const tasks = trainLines.slice(0, nTasks).map((l) => {
    const t = JSON.parse(l);
    if (!withAnswers) delete t.answer;
    return JSON.stringify(t);
  });
  writeFileSync(join(io, "tasks.jsonl"), `${tasks.join("\n")}\n`);
  return { dir, io, dbPath: join(dir, "harness.db"), tasksFile: join(io, "tasks.jsonl"), out: join(io, "answers.jsonl") };
}

const runnerFor = (e: ReturnType<typeof env>, solver: Solver, concurrency = 3) =>
  new BatchRunner({ db: openDb(e.dbPath), solver, concurrency, ioDir: e.io, repoRoot: ROOT });

const readAnswers = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { task_id: string; answer: string });

const seen: unknown[] = [];
const naSolver: Solver = async (task) => {
  seen.push(task);
  return { answer: "Not Applicable" };
};
afterEach(() => {
  seen.length = 0;
});

describe("batch runner", () => {
  test("solves 10 train tasks, writes one line per task, scores with the official scorer", async () => {
    const e = env(10);
    const runner = runnerFor(e, naSolver);
    const id = await runner.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out });
    const run = await runner.wait(id);
    expect(run.status).toBe("done");
    expect(readAnswers(e.out)).toHaveLength(10);
    expect(run.summary?.n).toBe(10);
    expect(run.summary?.missing).toBe(0);
    expect(typeof run.summary?.accuracy).toBe("number");
  });

  test("solver receives only question + guidelines", async () => {
    const e = env(3);
    const runner = runnerFor(e, naSolver);
    await runner.wait(await runner.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out }));
    for (const t of seen) expect(Object.keys(t as object).sort()).toEqual(["guidelines", "question"]);
  });

  test("tasks without `answer` (holdout) → done, scoring skipped", async () => {
    const e = env(4, { withAnswers: false });
    const runner = runnerFor(e, naSolver);
    const run = await runner.wait(await runner.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out }));
    expect(run.status).toBe("done");
    expect(run.summary).toBeNull();
    expect(readAnswers(e.out)).toHaveLength(4);
  });

  test("crash mid-run → restart resumes only unfinished tasks; torn last line is dropped", async () => {
    const e = env(10);
    let n = 0;
    const hangAfter4: Solver = async () => (++n <= 4 ? { answer: "Not Applicable" } : new Promise(() => {}));
    const r1 = runnerFor(e, hangAfter4, 1);
    await r1.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out });
    while (readAnswers(e.out).length < 4) await new Promise((r) => setTimeout(r, 5));
    appendFileSync(e.out, '{"task_id": "17'); // process died mid-write

    let calls = 0;
    const r2 = runnerFor(e, async () => {
      calls++;
      return { answer: "Not Applicable" };
    });
    const id2 = await r2.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out });
    const run = await r2.wait(id2);
    expect(run.status).toBe("done");
    expect(calls).toBe(6);
    const ans = readAnswers(e.out);
    expect(ans).toHaveLength(10);
    expect(new Set(ans.map((a) => a.task_id)).size).toBe(10);
  });

  test("failing task is retried, then answered 'Not Applicable' and marked error", async () => {
    const e = env(2);
    const runner = runnerFor(e, async (t) => {
      if (t.question === JSON.parse(trainLines[0]).question) throw new Error("boom");
      return { answer: "x" };
    });
    const run = await runner.wait(await runner.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out }));
    expect(run.status).toBe("done");
    expect(run.tasks.find((t) => t.status === "error")?.attempts).toBe(2);
    expect(readAnswers(e.out).find((a) => a.answer === "Not Applicable")).toBeDefined();
  });

  test("budget exhausted → run stopped_budget, remaining tasks stay pending (resumable)", async () => {
    const e = env(5);
    let n = 0;
    const runner = runnerFor(
      e,
      async () => {
        if (++n > 2) throw new BudgetExhausted("cap");
        return { answer: "Not Applicable" };
      },
      1,
    );
    const run = await runner.wait(await runner.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out }));
    expect(run.status).toBe("stopped_budget");
    expect(run.tasks.filter((t) => t.status === "pending").length).toBe(3);
  });

  test("paths outside /io and bundle/tasks are rejected; unknown version rejected", async () => {
    const e = env(1);
    const runner = runnerFor(e, naSolver);
    await expect(runner.startSolve({ tasksFile: "/etc/passwd", version: "v000", out: e.out })).rejects.toThrow(/tasks_file/);
    await expect(runner.startSolve({ tasksFile: e.tasksFile, version: "v000", out: join(e.dir, "x.jsonl") })).rejects.toThrow(/out/);
    await expect(runner.startSolve({ tasksFile: join(e.io, "../io/../../etc/x"), version: "v000", out: e.out })).rejects.toThrow(/tasks_file/);
    await expect(runner.startSolve({ tasksFile: e.tasksFile, version: "v999", out: e.out })).rejects.toThrow(/version/);
    const id = await runner.startSolve({ tasksFile: "bundle/tasks/val.jsonl", version: "best", out: e.out });
    expect(runner.get(id)?.run.version).toBe("v000"); // best → versions/BEST
  });
});

describe("API + CLI", () => {
  test("harness solve goes CLI → HTTP API → runner and prints the score", async () => {
    const e = env(3);
    const app = buildServer({ runner: runnerFor(e, naSolver) });
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const bad = await fetch(`${baseUrl}/api/runs/solve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tasks_file: "/etc/passwd", version: "v000", out: e.out }),
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe("invalid_request");

      const lines: string[] = [];
      const run = await solveCommand({ baseUrl, tasks: e.tasksFile, version: "v000", out: e.out, pollMs: 20, log: (s) => lines.push(s) });
      expect(run.status).toBe("done");
      expect(readAnswers(e.out)).toHaveLength(3);
      expect(lines.join("\n")).toMatch(/accuracy/);
    } finally {
      await app.close();
    }
  });
});

describe("splits", () => {
  test("deterministic, stratified by level, disjoint, covers all train ids, ids only", () => {
    const tasks = trainLines.map((l) => JSON.parse(l));
    const a = makeSplits(tasks, { seed: 42, holdoutFraction: 0.2 });
    expect(makeSplits(tasks, { seed: 42, holdoutFraction: 0.2 })).toEqual(a);
    const all = new Set([...a.improve, ...a.report_holdout]);
    expect(all.size).toBe(tasks.length);
    expect(a.improve.filter((id) => a.report_holdout.includes(id))).toEqual([]);
    expect(a.report_holdout.length).toBeGreaterThanOrEqual(36);
    const easyHold = a.report_holdout.filter((id) => tasks.find((t) => t.task_id === id).level === "easy").length;
    expect(easyHold).toBeGreaterThanOrEqual(6); // 35 easy × 0.2
    expect(JSON.stringify(a)).not.toMatch(/answer|question/);
  });
});

describe("crash recovery runs once per process and database", () => {
  test("a second BatchRunner on the same DB does not re-queue the first one's live run", async () => {
    const e = env(4);
    const db = openDb(e.dbPath);
    let release: () => void = () => {};
    const slow: Solver = () =>
      new Promise((r) => {
        release = () => r({ answer: "Not Applicable" });
      });
    const r1 = new BatchRunner({ db, solver: slow, concurrency: 1, ioDir: e.io, repoRoot: ROOT });
    const id = await r1.startSolve({ tasksFile: e.tasksFile, version: "v000", out: e.out });
    await new Promise((r) => setTimeout(r, 30));
    new BatchRunner({ db, solver: naSolver, concurrency: 1, ioDir: e.io, repoRoot: ROOT }); // e.g. the improver's next run
    const st = db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string };
    expect(st.status).toBe("running");
    expect((db.prepare("SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ? AND status = 'running'").get(id) as { n: number }).n).toBe(1);
    release();
  });
});
