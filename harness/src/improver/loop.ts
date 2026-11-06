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
import { labelFailure } from "./labels.ts";
import { buildLeakContext, leakCheck } from "./leakcheck.ts";
import { buildReflectorPrompt, runReflector, type Trajectory } from "./reflector.ts";
import { buildIdentifierAllowList, unknownIdentifiers } from "./schemacheck.ts";
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

export interface RuntimeTelemetry {
  runs: number;
  tasks_per_run: number;
  limit_hits_per_run: number;
  over_60s_per_run: number;
  p95_s: number;
}

/** Gold-independent runtime telemetry of runs (SPEC §7, variant A): turn-limit hits, > 60 s, p95 —
 *  from wall time only, never from correctness. */
export function runtimeTelemetry(db: Db, runIds: string[], maxTurnS: number): RuntimeTelemetry {
  if (!runIds.length) return { runs: 0, tasks_per_run: 0, limit_hits_per_run: 0, over_60s_per_run: 0, p95_s: 0 };
  const ms = (db.prepare(`SELECT ms FROM run_tasks WHERE run_id IN (${runIds.map(() => "?").join(",")}) AND ms IS NOT NULL ORDER BY ms`).all(...runIds) as Array<{ ms: number }>).map((r) => r.ms);
  const per = (n: number) => Math.round((n / runIds.length) * 10) / 10;
  return {
    runs: runIds.length,
    tasks_per_run: per(ms.length),
    limit_hits_per_run: per(ms.filter((x) => x >= maxTurnS * 1000 - 1000).length),
    over_60s_per_run: per(ms.filter((x) => x > 60_000).length),
    p95_s: ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)] / 1000) : 0,
  };
}

/** A batch run that did not finish as `done` must never be counted (a failed run would look like 0 correct). */
export class RunFailed extends Error {}

export function assertRunOk(run: { id: string; status: string; error: string | null }, label: string): void {
  if (run.status === "done") return;
  if (run.status === "stopped_budget") throw new BudgetExhausted(`budget reached during ${label}`);
  throw new RunFailed(`run ${label} (${run.id}) ended as ${run.status}: ${run.error ?? "no error recorded"}`);
}

/** Recorded val runs of a version must be in this state DB (e.g. not the case in a fresh container
 *  volume) — otherwise its metrics.json would be recomputed from nothing and overwritten. */
export function assertRunsInDb(db: Db, ids: string[], version: string): void {
  const missing = ids.filter((id) => !(db.prepare("SELECT 1 FROM runs WHERE id = ? AND status = 'done'").get(id)));
  if (missing.length) throw new RunFailed(`val runs of ${version} not in this state DB: ${missing.join(", ")} — copy the state DB that produced them or run from it`);
}

/** Pre-filter settings, changed after stage 2 (3 rejects: 2 parse bugs, 1 SMOKE with fixed = 1);
 *  the val gate and T are unchanged. */
export const SMOKE_MIN_NET_FIXED = 1;
export const MAX_CONSECUTIVE_REJECTS = 5;
/** A reflector reply that cannot be parsed is an infrastructure failure, not a bad idea. */
export const countsAsReject = (stage: string) => stage !== "parse";

/** Smallest spend a generation can make before anything is stored (reflection + SMOKE). */
export const MIN_GENERATION_USD = 1;
export function canStartGeneration(remainingUsd: number): boolean {
  return remainingUsd >= MIN_GENERATION_USD;
}

/** VALIDATE starts only if the remaining improve budget covers K val runs at the parent's cost ×1.3. */
export function canAffordValidation(o: { remainingUsd: number; parentCostPerRunUsd: number; k: number }): boolean {
  return o.remainingUsd >= o.k * o.parentCostPerRunUsd * 1.3;
}

export function pastCutoff(hhmm: string | undefined, now = new Date()): boolean {
  if (!hhmm) return false;
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`cut-off must be HH:MM, got ${hhmm}`);
  const [h, m] = hhmm.split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() > h * 60 + m;
}

/** Negative memory from disk (survives restarts): rejected children of `parent`. */
export function rejectedMemory(repo: string, parent: string): Array<{ id: string; summary: string; reason: string }> {
  return readdirSync(join(repo, "versions"))
    .filter((d) => /^v\d{3}$/.test(d) && existsSync(join(repo, "versions", d, "manifest.json")))
    .sort()
    .map((id) => ({ id, m: JSON.parse(readFileSync(join(repo, "versions", id, "manifest.json"), "utf8")) }))
    .filter(({ m }) => m.status === "rejected" && m.parent === parent)
    .map(({ id, m }) => {
      const mp = join(repo, "versions", id, "metrics.json");
      const met = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {};
      return { id, summary: String(m.change_summary ?? ""), reason: String(met.reject_reason ?? met.gate?.reason ?? "rejected") };
    });
}

/** The gate threshold is computed once (from v000) and then read from config/gate.json (SPEC §3.4). */
export function frozenT(repo: string): { k: number; T: number; from_version: string } | null {
  const p = join(repo, "config", "gate.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
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
  const identifiers = await buildIdentifierAllowList(repo, app.data);
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
    assertRunOk(run, label);
    return run;
  };
  const valRunsOf = async (version: string): Promise<string[]> => {
    const mp = join(repo, "versions", version, "metrics.json");
    const m = (existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {}) as { val_run_ids?: string[] };
    const ids = [...(m.val_run_ids ?? [])];
    assertRunsInDb(app.db, ids, version);
    // Missing runs go in parallel: the long tail of slow tasks overlaps; the shared governor keeps RPM.
    const missing = Array.from({ length: Math.max(0, K - ids.length) }, (_, i) => ids.length + i + 1);
    if (missing.length) progress("validate", { version, runs: missing });
    const done = await Promise.all(missing.map((n) => solve(`${version}-val-${n}`, val, version)));
    ids.push(...done.map((r) => r.id));
    materializeValMetrics(app, version, ids, levels);
    return ids;
  };

  const recovered = recoverInterrupted(repo);
  if (recovered.length) progress("recovered", { interrupted: recovered });
  let parent = readFileSync(join(repo, "versions", "BEST"), "utf8").trim();
  // T from the parent's runs that already exist (≥ 2); its missing val runs proceed in the background
  // during ANALYZE / reflect / SMOKE and are awaited before VALIDATE.
  const pm0 = JSON.parse(readFileSync(join(repo, "versions", parent, "metrics.json"), "utf8")) as { val_run_ids?: string[] };
  const existing = pm0.val_run_ids ?? [];
  let parentReady: Promise<string[]> = valRunsOf(parent);
  parentReady.catch(() => {}); // awaited later; avoid an unhandled rejection if it fails first
  pastCutoff(o.noNewGenerationAfter); // validates the format up front
  const frozen = frozenT(repo);
  let T: number;
  if (frozen) {
    T = frozen.T;
    progress("gate", { T, from_version: frozen.from_version, frozen: true });
  } else {
    const tRuns = existing.length >= 2 ? existing : await parentReady;
    const flips = pairFlips(tRuns.map((id) => correctMap(app.db, id)));
    T = thresholdT(flips, K);
    writeFileSync(join(repo, "config", "gate.json"), `${JSON.stringify({ k: K, T, from_version: parent, pair_flips: flips }, null, 2)}\n`);
    progress("gate", { T, parent, pair_flips: flips });
  }

  let consecutiveRejects = 0;
  for (let gen = 1; gen <= o.generations && consecutiveRejects < MAX_CONSECUTIVE_REJECTS; gen++) {
    if (pastCutoff(o.noNewGenerationAfter)) {
      progress("time_cutoff", { gen, after: o.noNewGenerationAfter });
      break;
    }
    if (!canStartGeneration(o.budgetUsd - guard.spent())) {
      progress("stopped_budget", { gen, message: `remaining $${(o.budgetUsd - guard.spent()).toFixed(2)} < $${MIN_GENERATION_USD} for a generation` });
      break;
    }
    const tag = `${o.improveRunId}-g${gen}`;
    try {
      // ANALYZE — the whole improve split once per parent (+ a 2nd run of its hard part to find
      // unstable tasks), cached in the parent's metrics.json until the next promotion.
      progress("analyze", { gen, parent });
      const pmA = JSON.parse(readFileSync(join(repo, "versions", parent, "metrics.json"), "utf8")) as { analyze_run_ids?: string[] };
      let analyzeIds = pmA.analyze_run_ids ?? [];
      if (analyzeIds.length < 2) {
        const [full, hard2] = await Promise.all([
          solve(`${tag}-analyze-full`, pool, parent),
          solve(`${tag}-analyze-hard2`, pool.filter((t) => t.level === "hard"), parent),
        ]);
        analyzeIds = [full.id, hard2.id];
        updateMetrics(repo, parent, { analyze_run_ids: analyzeIds });
      }
      const ar = { id: analyzeIds[0] };
      type Row = { task_id: string; correct: number; answer: string; ms: number; trace_json: string | null };
      const q = app.db.prepare("SELECT task_id, correct, answer, ms, trace_json FROM run_tasks WHERE run_id = ?");
      const rows = q.all(analyzeIds[0]) as Row[];
      const rows2 = new Map((q.all(analyzeIds[1]) as Row[]).map((r) => [r.task_id, r]));
      const byId = new Map(pool.map((t) => [t.task_id, t]));
      const traj = (r: Row, verdict: Trajectory["verdict"], note?: string): Trajectory => {
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
        const trace = r.trace_json ? JSON.parse(r.trace_json) : null;
        const label = verdict === "wrong" ? labelFailure({ answer: r.answer ?? "", gold: t.answer, ms: r.ms, maxTurnS: readVersion(repo, parent).manifest.limits.max_turn_s, trace }) : undefined;
        return { level: t.level, question: t.question, guidelines: t.guidelines, answer: r.answer, verdict, hint: [hint, note].filter(Boolean).join("; ") || undefined, label, ms: r.ms, steps: trace?.steps ?? [] };
      };
      // Unstable: the two runs disagree. Show the failing trajectory, plus only the tool sequence of
      // the successful one (no outputs, no final answer → no gold value reaches the reflector).
      const unstable: Trajectory[] = [];
      for (const r of rows) {
        const r2 = rows2.get(r.task_id);
        if (!r2 || (r.correct === 1) === (r2.correct === 1)) continue;
        const [bad, good] = r.correct === 1 ? [r2, r] : [r, r2];
        const goodTools = good.trace_json
          ? (JSON.parse(good.trace_json).steps as Array<{ tool?: string; args?: string }>)
              .filter((s) => s.tool && s.tool !== "submit_answer")
              .map((s) => `${s.tool}(${s.args})`)
              .join(" → ")
          : "";
        unstable.push(traj(bad, "wrong", `UNSTABLE: another run of the same version got it right using: ${goodTools.slice(0, 900)}`));
      }
      const unstableIds = new Set(unstable.map((u) => u.question));
      const failures = [
        ...unstable,
        ...[...rows, ...[...rows2.values()].filter((r) => !rows.some((x) => x.task_id === r.task_id))]
          .filter((r) => r.correct !== 1 && !unstableIds.has(byId.get(r.task_id)?.question ?? ""))
          .map((r) => traj(r, "wrong")),
      ];
      const slow = rows.filter((r) => r.correct === 1 && r.ms > 60_000).map((r) => traj(r, "correct_but_slow"));
      progress("analyze_done", { gen, tasks: rows.length, failures: failures.length, unstable: unstable.length, slow: slow.length });
      const feedback = app.db
        .prepare("SELECT t.user_message AS question, t.answer, f.comment FROM feedback f JOIN turns t ON t.id = f.turn_id WHERE f.rating = 'down' AND f.consumed_by IS NULL")
        .all() as Array<{ question: string; answer: string; comment: string | null }>;
      const rejectedMem = rejectedMemory(repo, parent);

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
        prompt: buildReflectorPrompt({
          parent: parentContent,
          failures: failures.slice(0, 12),
          slow: slow.slice(0, 4),
          feedback,
          rejected: rejectedMem,
          schema: await app.data.schema(),
          telemetry: {
            val: runtimeTelemetry(app.db, await parentReady, parentContent.manifest.limits.max_turn_s),
            train: runtimeTelemetry(app.db, [ar.id], parentContent.manifest.limits.max_turn_s),
          },
        }),
      });
      const reflectCost = app.ledger.spentUsd(reflectRef) - before;
      const summary = (refl.proposal?.rationale ?? "").slice(0, 240);
      if (!refl.proposal) {
        const id = createVersion(repo, {
          parent,
          content: parentContent,
          status: "rejected",
          change_summary: "reflector returned no valid proposal",
          reflectCostUsd: reflectCost,
          rejectStage: "parse",
          rejectReason: `invalid_proposal: ${refl.error}`,
        });
        rejected.push(id);
        if (countsAsReject("parse")) consecutiveRejects++;
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

      // unknown_column — snake_case identifiers in natural-language parts must exist (before any spend)
      const prose = [
        ...cur.content.playbook.rules.map((r) => r.text),
        ...Object.values(cur.content.skills).map((f) => f["SKILL.md"] ?? ""),
        ...Object.values(cur.content.manifest.tool_descriptions ?? {}),
      ].join("\n");
      const unknown = unknownIdentifiers(prose, new Set([...identifiers, ...Object.keys(cur.content.skills)]));
      if (unknown.length) {
        const id = createVersion(repo, {
          parent,
          content: cur.content,
          status: "rejected",
          change_summary: summary,
          curation: cur.curation,
          reflectCostUsd: reflectCost,
          rejectStage: "curator",
          rejectReason: `unknown_column: ${unknown.join(", ")}`,
        });
        rejected.push(id);
        consecutiveRejects++;
        continue;
      }

      // LEAKCHK — over everything the improver can edit (playbook, skills, tool descriptions), so
      // literal tables cannot accumulate past the limit across generations; system.md is hand-written.
      const changed = Object.entries(versionFiles(cur.content))
        .filter(([p]) => p !== "system.md")
        .map(([p, body]) => (p === "manifest.json" ? JSON.stringify(cur.content.manifest.tool_descriptions ?? {}) : body))
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
      // problem = wrong in at least one analyze run; passed = right in both (15, deterministic draw)
      const isProblem = (r: Row) => r.correct !== 1 || rows2.get(r.task_id)?.correct === 0;
      const problem = rows.filter(isProblem);
      const rand = mulberry32(1000 + Number(cand.slice(1)));
      const passed = rows
        .filter((r) => !isProblem(r))
        .map((r) => ({ r, k: rand() }))
        .sort((x, y) => x.k - y.k)
        .slice(0, 15)
        .map((x) => x.r);
      const smokeTasks = [...problem, ...passed].map((r) => byId.get(r.task_id) as Task);
      const sr = await solve(`${tag}-smoke`, smokeTasks, cand);
      const sm = correctMap(app.db, sr.id);
      const fixed = problem.filter((r) => sm.get(r.task_id)).length;
      const broken = passed.filter((r) => !sm.get(r.task_id)).length;
      const need = SMOKE_MIN_NET_FIXED;
      updateMetrics(repo, cand, { smoke: { fixed, broken, need, run_id: sr.id } });
      if (fixed - broken < need) {
        updateManifest(repo, cand, { status: "rejected", reject_stage: "smoke" });
        updateMetrics(repo, cand, { reject_reason: `smoke: fixed ${fixed} − broken ${broken} < ${need}` });
        rejected.push(cand);
        consecutiveRejects++;
        continue;
      }

      // VALIDATE (early stop after the first run) + GATE
      const parentIds = await parentReady;
      const pmNow = JSON.parse(readFileSync(join(repo, "versions", parent, "metrics.json"), "utf8")) as { cost_usd: number };
      const perRun = pmNow.cost_usd / parentIds.length;
      if (!canAffordValidation({ remainingUsd: o.budgetUsd - guard.spent(), parentCostPerRunUsd: perRun, k: K })) {
        updateManifest(repo, cand, { status: "rejected", reject_stage: "budget" });
        updateMetrics(repo, cand, { reject_reason: `not validated: remaining $${(o.budgetUsd - guard.spent()).toFixed(2)} < ${K} × $${perRun.toFixed(2)} × 1.3` });
        rejected.push(cand);
        progress("stopped_budget", { gen, version: cand, message: "not enough budget left for validation" });
        break;
      }
      const parentMean = parentIds.reduce((s, id) => s + [...correctMap(app.db, id).values()].filter(Boolean).length, 0) / parentIds.length;
      progress("validate", { version: cand, run: 1 });
      const first = await solve(`${cand}-val-1`, val, cand);
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
        parentReady = Promise.resolve(candIds);
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
  // Never leave the parent's background val run behind: it is needed by the next run anyway.
  await parentReady.catch((e) => progress("parent_val_failed", { message: String(e) }));
  return { promoted, rejected, spent_usd: app.ledger.spentUsd() - startSpent };
}

