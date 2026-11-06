// Improver loop (SPEC §3.4): per generation ANALYZE → PROPOSE → CURATE → LEAKCHK → SMOKE → VALIDATE (val ×3)
// → GATE → PROMOTE | REJECT. Every proposal becomes a version (rejected ones too). Budget-guarded.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { phaseBudgetGuard } from "../experiments/baseline-lib.ts";
import { BatchRunner } from "../runs/batch.ts";
import { runMetrics } from "../runs/metrics.ts";
import { mulberry32 } from "../runs/splits.ts";
import type { AppRuntime } from "../runtime/app.ts";
import { BudgetExhausted } from "../runtime/budget.ts";
import { curate } from "./curator.ts";
import { earlyStop, gateDecision, pairFlips, thresholdT } from "./gate.ts";
import { buildLeakContext, leakCheck } from "./leakcheck.ts";
import { buildReflectorPrompt, runReflector, type Trajectory } from "./reflector.ts";
import { createVersion, diffVersions, nextVersionId, readVersion, updateManifest, updateMetrics, versionFiles } from "./store.ts";

export const K = 3;
type Task = { task_id: string; level: string; question: string; guidelines: string; answer: string };

export interface ImproveOptions {
  generations: number;
  budgetUsd: number;
  improveRunId: string;
  onProgress?: (stage: string, info: Record<string, unknown>) => void;
  analyzeSize?: number;
  /** Local "HH:MM": no new generation starts after this time (a running one finishes). */
  noNewGenerationAfter?: string;
}

export function pastCutoff(hhmm: string | undefined, now = new Date()): boolean {
  if (!hhmm) return false;
  const [h, m] = hhmm.split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() > h * 60 + m;
}

/** Atomic BEST update (temp file + rename): a kill never leaves a half-written pointer. */
export function writeBest(repo: string, id: string): void {
  const tmp = join(repo, "versions", "BEST.tmp");
  writeFileSync(tmp, `${id}\n`);
  renameSync(tmp, join(repo, "versions", "BEST"));
}

/** Versions left as `candidate` by a killed run are marked rejected (interrupted); BEST is untouched. */
export function recoverInterrupted(repo: string): string[] {
  const out: string[] = [];
  for (const id of readdirSync(join(repo, "versions")).filter((d) => /^v\d{3}$/.test(d)).sort()) {
    const mp = join(repo, "versions", id, "manifest.json");
    if (!existsSync(mp)) continue;
    const m = JSON.parse(readFileSync(mp, "utf8"));
    if (m.status !== "candidate") continue;
    updateManifest(repo, id, { status: "rejected", reject_stage: "interrupted" });
    updateMetrics(repo, id, { reject_reason: "interrupted: the improve run stopped before this candidate was gated" });
    out.push(id);
  }
  return out;
}

const loadTasks = (repo: string, f: string): Task[] =>
  readFileSync(join(repo, "bundle", "tasks", f), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

export function correctMap(db: Db, runId: string): Map<string, boolean> {
  return new Map((db.prepare("SELECT task_id, correct FROM run_tasks WHERE run_id = ?").all(runId) as Array<{ task_id: string; correct: number }>).map((r) => [r.task_id, r.correct === 1]));
}

/** Aggregates k val runs into VersionMetrics (SPEC §3.1) and writes metrics.json. */
export function materializeValMetrics(app: AppRuntime, versionId: string, runIds: string[], levels: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ms = runIds.map((id) => runMetrics(app.db, id, levels));
  const n = ms[0]?.n ?? 0;
  const meanCorrect = ms.reduce((s, m) => s + (m.correct ?? 0), 0) / ms.length;
  const byLevel: Record<string, number> = {};
  for (const lv of Object.keys(ms[0]?.by_level ?? {})) {
    byLevel[lv] = ms.reduce((s, m) => s + m.by_level[lv].correct / m.by_level[lv].n, 0) / ms.length;
  }
  const ledger = app.db
    .prepare(`SELECT COALESCE(SUM(input),0) i, COALESCE(SUM(cache_read),0) cr, COALESCE(SUM(cache_write),0) cw FROM ledger WHERE ${runIds.map(() => "ref LIKE ? || '/%'").join(" OR ")}`)
    .get(...runIds) as { i: number; cr: number; cw: number };
  const lat = (
    app.db.prepare(`SELECT ms FROM run_tasks WHERE run_id IN (${runIds.map(() => "?").join(",")}) AND ms IS NOT NULL ORDER BY ms`).all(...runIds) as Array<{ ms: number }>
  ).map((r) => r.ms);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)] / 1000 : 0);
  const metrics = {
    val: { correct: Math.round(meanCorrect * 100) / 100, n, accuracy: n ? meanCorrect / n : 0, by_level: byLevel, runs: ms.map((m) => m.correct) },
    val_run_ids: runIds,
    cost_usd: ms.reduce((s, m) => s + m.cost_usd, 0),
    cost_per_task_usd: ms.reduce((s, m) => s + m.cost_per_task_usd, 0) / ms.length,
    cache_hit_rate: ledger.i + ledger.cr + ledger.cw ? ledger.cr / (ledger.i + ledger.cr + ledger.cw) : 0,
    latency_p50_s: q(0.5),
    latency_p95_s: q(0.95),
    ...extra,
  };
  updateMetrics(app.repoRoot, versionId, metrics);
  return metrics;
}

export async function improve(app: AppRuntime, o: ImproveOptions): Promise<{ promoted: string[]; rejected: string[]; spent_usd: number }> {
  const repo = app.repoRoot;
  const ioDir = join(repo, "io");
  const progress = o.onProgress ?? (() => {});
  const guard = phaseBudgetGuard(app.db, o.budgetUsd);
  const train = loadTasks(repo, "train.jsonl");
  const val = loadTasks(repo, "val.jsonl");
  const levels = Object.fromEntries([...train, ...val].map((t) => [t.task_id, t.level]));
  const splits = JSON.parse(readFileSync(join(repo, "config", "splits.json"), "utf8")) as { improve: string[] };
  const improveSet = new Set(splits.improve);
  const pool = train.filter((t) => improveSet.has(t.task_id));
  const leakCtx = buildLeakContext(repo);
  const startSpent = app.ledger.spentUsd();
  const promoted: string[] = [];
  const rejected: string[] = [];

  const writeTasks = (name: string, tasks: Task[]) => {
    const p = join(ioDir, `${name}.jsonl`);
    writeFileSync(p, `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
    return p;
  };
  const solve = async (label: string, tasks: Task[], version: string) => {
    const runner = new BatchRunner({ db: app.db, solver: app.solver({ guard }), concurrency: 12, ioDir, repoRoot: repo, warmup: true });
    const run = await runner.wait(await runner.startSolve({ tasksFile: writeTasks(label, tasks), version, out: join(ioDir, `${label}.answers.jsonl`) }));
    if (run.status === "stopped_budget") throw new BudgetExhausted(`improve budget $${o.budgetUsd} reached during ${label}`);
    return run;
  };
  const valRunsOf = async (version: string): Promise<string[]> => {
    const mp = join(repo, "versions", version, "metrics.json");
    const m = (existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {}) as { val_run_ids?: string[] };
    const ids = [...(m.val_run_ids ?? [])];
    while (ids.length < K) {
      progress("validate", { version, run: ids.length + 1 });
      ids.push((await solve(`${o.improveRunId}-${version}-val-${ids.length + 1}`, val, version)).id);
    }
    materializeValMetrics(app, version, ids, levels);
    return ids;
  };

  const recovered = recoverInterrupted(repo);
  if (recovered.length) progress("recovered", { interrupted: recovered });
  let parent = readFileSync(join(repo, "versions", "BEST"), "utf8").trim();
  const parentIds0 = await valRunsOf(parent);
  const T = thresholdT(pairFlips(parentIds0.map((id) => correctMap(app.db, id))), K);
  writeFileSync(join(repo, "config", "gate.json"), `${JSON.stringify({ k: K, T, from_version: parent, pair_flips: pairFlips(parentIds0.map((id) => correctMap(app.db, id))) }, null, 2)}\n`);
  progress("gate", { T, parent });

  let consecutiveRejects = 0;
  for (let gen = 1; gen <= o.generations && consecutiveRejects < 3; gen++) {
    if (pastCutoff(o.noNewGenerationAfter)) {
      progress("time_cutoff", { gen, after: o.noNewGenerationAfter });
      break;
    }
    const tag = `${o.improveRunId}-g${gen}`;
    try {
      // ANALYZE — domain-based priority: hard fee tasks of all formats first, then the rest.
      progress("analyze", { gen, parent });
      const rand = mulberry32(1000 + gen);
      const shuffled = [...pool].sort(() => rand() - 0.5);
      const fee = shuffled.filter((t) => t.level === "hard" && /fee/i.test(t.question));
      const rest = shuffled.filter((t) => !fee.includes(t));
      const sample = [...fee.slice(0, 30), ...rest.slice(0, (o.analyzeSize ?? 40) - Math.min(30, fee.length))];
      const ar = await solve(`${tag}-analyze`, sample, parent);
      const rows = app.db.prepare("SELECT task_id, correct, answer, ms, trace_json FROM run_tasks WHERE run_id = ?").all(ar.id) as Array<{
        task_id: string;
        correct: number;
        answer: string;
        ms: number;
        trace_json: string | null;
      }>;
      const byId = new Map(sample.map((t) => [t.task_id, t]));
      const traj = (r: (typeof rows)[number], verdict: Trajectory["verdict"]): Trajectory => {
        const t = byId.get(r.task_id) as Task;
        const a = Number(r.answer);
        const g = Number(t.answer);
        const hint =
          verdict === "wrong" && Number.isFinite(a) && Number.isFinite(g) && t.answer.trim() !== ""
            ? Math.abs(a - g) > Math.abs(g) * 0.5
              ? "far off"
              : a > g
                ? "too high"
                : "too low"
            : undefined;
        return { level: t.level, question: t.question, guidelines: t.guidelines, answer: r.answer, verdict, hint, ms: r.ms, steps: r.trace_json ? JSON.parse(r.trace_json).steps : [] };
      };
      const failures = rows.filter((r) => r.correct !== 1).map((r) => traj(r, "wrong"));
      const slow = rows.filter((r) => r.correct === 1 && r.ms > 60_000).map((r) => traj(r, "correct_but_slow"));
      const feedback = app.db
        .prepare("SELECT t.user_message AS question, t.answer, f.comment FROM feedback f JOIN turns t ON t.id = f.turn_id WHERE f.rating = 'down' AND f.consumed_by IS NULL")
        .all() as Array<{ question: string; answer: string; comment: string | null }>;
      const rejectedMem = rejected.map((id) => {
        const m = JSON.parse(readFileSync(join(repo, "versions", id, "manifest.json"), "utf8"));
        const met = JSON.parse(readFileSync(join(repo, "versions", id, "metrics.json"), "utf8"));
        return { id, summary: m.change_summary, reason: met.reject_reason ?? met.gate?.reason ?? "rejected" };
      });

      // PROPOSE
      progress("propose", { gen, failures: failures.length, slow: slow.length, feedback: feedback.length });
      guard();
      const parentContent = readVersion(repo, parent);
      const reflectRef = `improve/${o.improveRunId}/g${gen}/reflect`;
      const before = app.ledger.spentUsd(reflectRef);
      const refl = await runReflector({
        rt: app.rt,
        prices: app.prices,
        tracing: app.tracing,
        stateDir: app.stateDir,
        ref: reflectRef,
        improveRunId: o.improveRunId,
        prompt: buildReflectorPrompt({ parent: parentContent, failures: failures.slice(0, 10), slow: slow.slice(0, 4), feedback, rejected: rejectedMem }),
      });
      const reflectCost = app.ledger.spentUsd(reflectRef) - before;
      const summary = (refl.proposal?.rationale ?? "").slice(0, 240);
      if (!refl.proposal) {
        const id = createVersion(repo, { parent, content: parentContent, status: "rejected", change_summary: "reflector returned no valid proposal", reflectCostUsd: reflectCost, rejectStage: "curator", rejectReason: `invalid_proposal: ${refl.error}` });
        rejected.push(id);
        consecutiveRejects++;
        continue;
      }

      // CURATE
      progress("curate", { gen });
      const nextId = nextVersionId(repo);
      const cur = curate(parentContent, refl.proposal, nextId);
      if (!cur.ok) {
        const id = createVersion(repo, { parent, content: parentContent, status: "rejected", change_summary: summary, curation: cur.curation, reflectCostUsd: reflectCost, rejectStage: "curator", rejectReason: cur.reason });
        rejected.push(id);
        consecutiveRejects++;
        continue;
      }

      // LEAKCHK — on the changed files only
      const pf = versionFiles(parentContent);
      const changed = Object.entries(versionFiles(cur.content))
        .filter(([p, body]) => pf[p] !== body)
        .map(([, body]) => body)
        .join("\n");
      const leak = leakCheck(changed, leakCtx);
      if (!leak.ok) {
        const redactedDiff = leakCheck(diffVersions(parentContent, cur.content), leakCtx).redacted;
        const id = createVersion(repo, {
          parent,
          content: cur.content,
          status: "rejected",
          change_summary: leakCheck(summary, leakCtx).redacted,
          curation: cur.curation,
          reflectCostUsd: reflectCost,
          rejectStage: "leakcheck",
          rejectReason: `leak: ${leak.reasons.join(", ")}`,
          diffOverride: redactedDiff,
        });
        rejected.push(id);
        consecutiveRejects++;
        continue;
      }
      const cand = createVersion(repo, { parent, content: cur.content, status: "candidate", change_summary: summary, curation: cur.curation, reflectCostUsd: reflectCost });

      // SMOKE — failures ∪ up to 15 passed tasks of the analyze sample
      progress("smoke", { gen, version: cand });
      const passed = rows.filter((r) => r.correct === 1).slice(0, 15);
      const smokeTasks = [...rows.filter((r) => r.correct !== 1), ...passed].map((r) => byId.get(r.task_id) as Task);
      const sr = await solve(`${tag}-smoke`, smokeTasks, cand);
      const sm = correctMap(app.db, sr.id);
      const fixed = rows.filter((r) => r.correct !== 1 && sm.get(r.task_id)).length;
      const broken = passed.filter((r) => !sm.get(r.task_id)).length;
      const need = failures.length >= 4 ? 2 : 1;
      updateMetrics(repo, cand, { smoke: { fixed, broken, need, run_id: sr.id } });
      if (fixed - broken < need) {
        updateManifest(repo, cand, { status: "rejected", reject_stage: "smoke" });
        updateMetrics(repo, cand, { reject_reason: `smoke: fixed ${fixed} − broken ${broken} < ${need}` });
        rejected.push(cand);
        consecutiveRejects++;
        continue;
      }

      // VALIDATE (early stop after the first run) + GATE
      const parentIds = await valRunsOf(parent);
      const parentMean = parentIds.reduce((s, id) => s + [...correctMap(app.db, id).values()].filter(Boolean).length, 0) / parentIds.length;
      progress("validate", { version: cand, run: 1 });
      const first = await solve(`${o.improveRunId}-${cand}-val-1`, val, cand);
      const firstCorrect = [...correctMap(app.db, first.id).values()].filter(Boolean).length;
      updateMetrics(repo, cand, { val_run_ids: [first.id] });
      if (earlyStop(firstCorrect, parentMean, T)) {
        materializeValMetrics(app, cand, [first.id], levels);
        updateManifest(repo, cand, { status: "rejected", reject_stage: "gate" });
        updateMetrics(repo, cand, { reject_reason: `gate early stop: first val run ${firstCorrect} < parent mean ${parentMean.toFixed(2)} − T=${T}` });
        progress("gate", { gen, version: cand, decision: "reject", reason: "early_stop" });
        rejected.push(cand);
        consecutiveRejects++;
        continue;
      }
      const candIds = await valRunsOf(cand);
      const pm = JSON.parse(readFileSync(join(repo, "versions", parent, "metrics.json"), "utf8"));
      const cm = JSON.parse(readFileSync(join(repo, "versions", cand, "metrics.json"), "utf8"));
      const decision = gateDecision({
        parent: { runs: parentIds.map((id) => correctMap(app.db, id)), costPerTask: pm.cost_per_task_usd },
        cand: { runs: candIds.map((id) => correctMap(app.db, id)), costPerTask: cm.cost_per_task_usd },
        levels,
        T,
      });
      updateMetrics(repo, cand, { gate: decision });
      progress("gate", { gen, version: cand, decision: decision.decision, reason: decision.reason });
      if (decision.decision === "promote") {
        updateManifest(repo, cand, { status: "promoted" });
        writeBest(repo, cand);
        app.db.prepare("UPDATE feedback SET consumed_by = ? WHERE consumed_by IS NULL").run(cand);
        promoted.push(cand);
        parent = cand;
        consecutiveRejects = 0;
      } else {
        updateManifest(repo, cand, { status: "rejected", reject_stage: "gate" });
        updateMetrics(repo, cand, { reject_reason: `gate: ${decision.reason}` });
        rejected.push(cand);
        consecutiveRejects++;
      }
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        progress("stopped_budget", { gen, message: e.message });
        break;
      }
      throw e;
    }
  }
  return { promoted, rejected, spent_usd: app.ledger.spentUsd() - startSpent };
}

