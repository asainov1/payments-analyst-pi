// Batch runner (SPEC §3.2 runs/batch): concurrent, resumable `solve` runs persisted in SQLite.
// The solver only ever sees { question, guidelines } — gold answers stay inside the runner/scorer.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { BudgetExhausted } from "../runtime/budget.ts";
import { appendAnswer, repairAnswers } from "./answers.ts";
import { confinePath, RequestError, resolveVersion } from "./paths.ts";
import { type ScoreSummary, score } from "./score.ts";

export type Solver = (
  task: { question: string; guidelines: string },
  ctx: { runId: string; taskId: string; version: string },
) => Promise<{ answer: string; trace?: unknown }>;

export type RunStatus = "queued" | "running" | "done" | "stopped_budget" | "failed";

export interface RunRow {
  id: string;
  kind: string;
  version: string;
  tasks_file: string;
  out_path: string;
  status: RunStatus;
  summary: ScoreSummary | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RunTaskRow {
  task_id: string;
  idx: number;
  status: "pending" | "running" | "done" | "error";
  attempts: number;
  answer: string | null;
  correct: boolean | null;
}

interface TaskLine {
  task_id: string;
  question: string;
  guidelines: string;
  answer?: string;
}

export interface BatchRunnerOptions {
  db: Db;
  solver: Solver;
  concurrency: number;
  ioDir: string;
  repoRoot: string;
  maxAttempts?: number;
  /** Run the first task alone so it writes the prompt-cache prefix, then fan out (SPEC step 9, з). */
  warmup?: boolean;
}

const recovered = new WeakSet<Db>();

export class BatchRunner {
  private readonly o: Required<BatchRunnerOptions>;
  private readonly active = new Map<string, Promise<void>>();

  constructor(opts: BatchRunnerOptions) {
    this.o = { maxAttempts: 2, warmup: false, ...opts };
    // Crash recovery: whatever was in flight when the previous process died is pending again.
    // Once per process and database — later runners (e.g. the improver's next run) must not
    // re-queue runs that are live in this process.
    if (!recovered.has(this.o.db)) {
      recovered.add(this.o.db);
      this.o.db.exec("UPDATE run_tasks SET status = 'pending' WHERE status = 'running'");
      this.o.db.exec("UPDATE runs SET status = 'queued' WHERE status = 'running'");
    }
  }

  async startSolve(req: { tasksFile: string; version: string; out: string }): Promise<string> {
    const { repoRoot, ioDir, db } = this.o;
    const tasksFile = confinePath(req.tasksFile, [ioDir, join(repoRoot, "bundle", "tasks")], "tasks_file", repoRoot);
    const out = confinePath(req.out, [ioDir], "out", repoRoot);
    const version = resolveVersion(req.version, repoRoot);
    if (!existsSync(tasksFile)) throw new RequestError("invalid_request", 400, `tasks_file not found: ${req.tasksFile}`);

    const unfinished = db
      .prepare("SELECT id FROM runs WHERE out_path = ? AND status != 'done' ORDER BY created_at DESC LIMIT 1")
      .get(out) as { id: string } | undefined;
    if (unfinished && this.active.has(unfinished.id)) return unfinished.id; // already running: reattach
    let id = unfinished?.id;

    if (!id) {
      const tasks = loadTasks(tasksFile);
      id = randomUUID();
      const scorable = tasks.every((t) => typeof t.answer === "string") ? 1 : 0;
      db.exec("BEGIN");
      db.prepare("INSERT INTO runs (id, kind, version, tasks_file, out_path, status, scorable) VALUES (?, 'solve', ?, ?, ?, 'queued', ?)").run(
        id,
        version,
        tasksFile,
        out,
        scorable,
      );
      const ins = db.prepare("INSERT INTO run_tasks (run_id, task_id, idx, status) VALUES (?, ?, ?, 'pending')");
      tasks.forEach((t, i) => {
        ins.run(id as string, t.task_id, i);
      });
      db.exec("COMMIT");
      writeFileSync(out, ""); // a new run owns its answers file
    }

    const runId = id;
    const p = this.process(runId)
      .catch((e) => {
        db.prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(String(e), runId);
      })
      .finally(() => this.active.delete(runId));
    this.active.set(runId, p);
    return runId;
  }

  get(id: string): { run: RunRow; tasks: RunTaskRow[] } | undefined {
    const r = this.o.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as (Omit<RunRow, "summary"> & { summary_json: string | null }) | undefined;
    if (!r) return undefined;
    const { summary_json, ...rest } = r;
    const run = { ...rest, summary: summary_json ? (JSON.parse(summary_json) as ScoreSummary) : null } as RunRow;
    const tasks = (this.o.db.prepare("SELECT task_id, idx, status, attempts, answer, correct FROM run_tasks WHERE run_id = ? ORDER BY idx").all(id) as Array<
      Omit<RunTaskRow, "correct"> & { correct: number | null }
    >).map((t) => ({ ...t, correct: t.correct === null ? null : t.correct === 1 }));
    return { run, tasks };
  }

  async wait(id: string): Promise<RunRow & { tasks: RunTaskRow[] }> {
    await this.active.get(id);
    const v = this.get(id);
    if (!v) throw new Error(`unknown run ${id}`);
    return { ...v.run, tasks: v.tasks };
  }

  private async process(runId: string): Promise<void> {
    const { db, solver, concurrency, maxAttempts, warmup } = this.o;
    const run = db.prepare("SELECT version, tasks_file, out_path, scorable FROM runs WHERE id = ?").get(runId) as {
      version: string;
      tasks_file: string;
      out_path: string;
      scorable: number;
    };
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);

    // Reconcile DB with the answers file (the file is the source of truth for what was written).
    const written = repairAnswers(run.out_path);
    const markDone = db.prepare("UPDATE run_tasks SET status = 'done', answer = ? WHERE run_id = ? AND task_id = ?");
    for (const [taskId, answer] of written) markDone.run(answer, runId, taskId);
    const pendingIds = new Set(
      (db.prepare("SELECT task_id FROM run_tasks WHERE run_id = ? AND status != 'error'").all(runId) as Array<{ task_id: string }>)
        .map((r) => r.task_id)
        .filter((tid) => !written.has(tid)),
    );
    const queue = loadTasks(run.tasks_file).filter((t) => pendingIds.has(t.task_id));

    let stopped = false;
    const setTask = db.prepare("UPDATE run_tasks SET status = ?, attempts = ?, answer = ?, ms = ? WHERE run_id = ? AND task_id = ?");

    const setTrace = db.prepare("UPDATE run_tasks SET trace_json = ? WHERE run_id = ? AND task_id = ?");
    const solveOne = async (t: TaskLine) => {
      const row = db.prepare("SELECT attempts FROM run_tasks WHERE run_id = ? AND task_id = ?").get(runId, t.task_id) as { attempts: number };
      let attempts = row.attempts;
      const started = Date.now();
      for (;;) {
        attempts++;
        setTask.run("running", attempts, null, null, runId, t.task_id);
        try {
          const { answer, trace } = await solver({ question: t.question, guidelines: t.guidelines }, { runId, taskId: t.task_id, version: run.version });
          appendAnswer(run.out_path, t.task_id, answer);
          setTask.run("done", attempts, answer, Date.now() - started, runId, t.task_id);
          if (trace !== undefined) setTrace.run(JSON.stringify(trace), runId, t.task_id);
          return;
        } catch (e) {
          if (e instanceof BudgetExhausted) {
            stopped = true;
            setTask.run("pending", attempts - 1, null, null, runId, t.task_id);
            return;
          }
          if (attempts >= maxAttempts) {
            appendAnswer(run.out_path, t.task_id, "Not Applicable");
            setTask.run("error", attempts, "Not Applicable", Date.now() - started, runId, t.task_id);
            return;
          }
        }
      }
    };
    const worker = async () => {
      for (let t = queue.shift(); t && !stopped; t = queue.shift()) await solveOne(t);
    };
    if (warmup && queue.length > 1) {
      const first = queue.shift();
      if (first) await solveOne(first);
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

    if (stopped) {
      db.prepare("UPDATE runs SET status = 'stopped_budget' WHERE id = ?").run(runId);
      return;
    }
    let summary: ScoreSummary | null = null;
    if (run.scorable) {
      const r = score({ scorerDir: join(this.o.repoRoot, "bundle", "scorer"), tasksFile: run.tasks_file, answersFile: run.out_path });
      summary = r.summary;
      const setCorrect = db.prepare("UPDATE run_tasks SET correct = ? WHERE run_id = ? AND task_id = ?");
      for (const d of r.details) setCorrect.run(d.correct ? 1 : 0, runId, String(d.task_id));
    }
    db.prepare("UPDATE runs SET status = 'done', summary_json = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
      summary ? JSON.stringify(summary) : null,
      runId,
    );
  }
}

function loadTasks(path: string): TaskLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const t = JSON.parse(l);
      return { ...t, task_id: String(t.task_id) } as TaskLine;
    });
}
