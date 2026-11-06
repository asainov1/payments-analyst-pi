// Step-9 baseline experiment (SPEC §6). Runs on the host against the live LiteLLM proxy.
//   node --env-file=../.env src/experiments/baseline.ts pick
//     20 stratified improve-train tasks on Sonnet and Haiku (v000 prompt), rule fixed in advance:
//     Haiku if its correct count is at most 2 below Sonnet's, else Sonnet.
//   node --env-file=../.env src/experiments/baseline.ts full <model>
//     v000 on val ×2, improve-train, report-holdout with <model>; refuses if the estimate > $25
//     and stops (stopped_budget, resumable) once the phase spends > $25.
// Results: state/experiments/*.json (+ printed tables).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BatchRunner } from "../runs/batch.ts";
import { type RunMetrics, runMetrics } from "../runs/metrics.ts";
import { createRuntime } from "../runtime/app.ts";
import { phaseBudgetGuard, stratifiedSample } from "./baseline-lib.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PHASE_LIMIT_USD = 25;
const CONCURRENCY = Number(process.env.BASELINE_CONCURRENCY ?? 12);
const MODELS = { sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" } as const;

type Task = { task_id: string; level: string; question: string; guidelines: string; answer: string };
const load = (f: string): Task[] =>
  readFileSync(join(ROOT, "bundle", "tasks", f), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const train = load("train.jsonl");
const val = load("val.jsonl");
const levels = Object.fromEntries([...train, ...val].map((t) => [t.task_id, t.level]));
const splits = JSON.parse(readFileSync(join(ROOT, "config", "splits.json"), "utf8")) as { improve: string[]; report_holdout: string[] };

const ioDir = join(ROOT, "io");
const expDir = join(ROOT, "state", "experiments");
mkdirSync(ioDir, { recursive: true });
mkdirSync(expDir, { recursive: true });

function writeTasks(name: string, tasks: Task[]): string {
  const p = join(ioDir, `${name}.jsonl`);
  writeFileSync(p, `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
  return p;
}

const fmt = (m: RunMetrics) => ({
  correct: `${m.correct}/${m.n}`,
  acc: m.accuracy?.toFixed(3),
  "$/task": m.cost_per_task_usd.toFixed(4),
  "$/correct": m.cost_per_correct_usd?.toFixed(4) ?? "-",
  p50_s: m.latency_p50_s.toFixed(1),
  p95_s: m.latency_p95_s.toFixed(1),
  cache_hit: `${(m.cache_hit_rate * 100).toFixed(1)}%`,
  calls: m.llm_calls,
  errors: m.errors,
  cost: m.cost_usd.toFixed(3),
});

async function main(): Promise<void> {
  const [phase, modelArg] = process.argv.slice(2);
  const app = await createRuntime({ repoRoot: ROOT });
  const runOne = async (label: string, tasksFile: string, modelOverride: string | undefined, guard?: () => void) => {
    const runner = new BatchRunner({ db: app.db, solver: app.solver({ modelOverride, guard }), concurrency: CONCURRENCY, ioDir, repoRoot: ROOT, warmup: true });
    const run = await runner.wait(await runner.startSolve({ tasksFile, version: "v000", out: join(ioDir, `${label}.answers.jsonl`) }));
    const m = runMetrics(app.db, run.id, levels);
    console.log(`[${new Date().toISOString()}] ${label}: ${run.status} ${JSON.stringify(fmt(m))}`);
    return { label, run_id: run.id, status: run.status, model: modelOverride ?? "v000", metrics: m };
  };

  try {
    if (phase === "pick") {
      const ids = new Set(stratifiedSample(train, splits.improve, 20, 7));
      const file = writeTasks("b9-pick", train.filter((t) => ids.has(t.task_id)));
      const sonnet = await runOne("b9-pick-sonnet", file, MODELS.sonnet);
      const haiku = await runOne("b9-pick-haiku", file, MODELS.haiku);
      const s = sonnet.metrics.correct ?? 0;
      const h = haiku.metrics.correct ?? 0;
      const chosen = s - h <= 2 ? MODELS.haiku : MODELS.sonnet;
      const result = { rule: "Haiku if (sonnet_correct - haiku_correct) <= 2 of 20, else Sonnet", sonnet, haiku, chosen, task_ids: [...ids] };
      writeFileSync(join(expDir, "b9-pick.json"), `${JSON.stringify(result, null, 2)}\n`);
      console.table({ sonnet: fmt(sonnet.metrics), haiku: fmt(haiku.metrics) });
      console.log(`CHOSEN ${chosen}`);
      return;
    }

    if (phase === "full") {
      const model = modelArg;
      if (!model) throw new Error("usage: baseline.ts full <model>");
      const pick = JSON.parse(readFileSync(join(expDir, "b9-pick.json"), "utf8"));
      const perTask = model === MODELS.sonnet ? pick.sonnet.metrics.cost_per_task_usd : pick.haiku.metrics.cost_per_task_usd;
      const plan = [
        { label: "b9-val-1", tasks: val },
        { label: "b9-val-2", tasks: val },
        { label: "b9-improve-train", tasks: train.filter((t) => splits.improve.includes(t.task_id)) },
        { label: "b9-report-holdout", tasks: train.filter((t) => splits.report_holdout.includes(t.task_id)) },
      ];
      const n = plan.reduce((s, p) => s + p.tasks.length, 0);
      const estimate = perTask * n;
      console.log(`estimate: ${n} tasks × $${perTask.toFixed(4)} = $${estimate.toFixed(2)} (limit $${PHASE_LIMIT_USD})`);
      if (estimate > PHASE_LIMIT_USD) {
        console.log("ESTIMATE_OVER_LIMIT — not starting");
        process.exitCode = 3;
        return;
      }
      const guard = phaseBudgetGuard(app.db, PHASE_LIMIT_USD);
      const results = [];
      for (const p of plan) {
        const r = await runOne(p.label, writeTasks(p.label, p.tasks), model, guard);
        results.push(r);
        writeFileSync(join(expDir, "b9-full.json"), `${JSON.stringify({ model, estimate, results }, null, 2)}\n`);
        if (r.status !== "done") {
          console.log(`STOPPED at ${p.label}: ${r.status}`);
          return;
        }
      }
      // Noise between two identical val runs → gate threshold T (SPEC §3.4).
      const correctOf = (runId: string) =>
        new Map((app.db.prepare("SELECT task_id, correct FROM run_tasks WHERE run_id = ?").all(runId) as Array<{ task_id: string; correct: number }>).map((r) => [r.task_id, r.correct]));
      const [a, b] = [correctOf(results[0].run_id), correctOf(results[1].run_id)];
      const flips = [...a.keys()].filter((k) => a.get(k) !== b.get(k)).length;
      const c1 = results[0].metrics.correct ?? 0;
      const c2 = results[1].metrics.correct ?? 0;
      const noise = { c1, c2, flips, T: Math.max(2, Math.abs(c1 - c2) + 1) };
      writeFileSync(join(expDir, "b9-full.json"), `${JSON.stringify({ model, estimate, results, noise }, null, 2)}\n`);
      console.table(Object.fromEntries(results.map((r) => [r.label, fmt(r.metrics)])));
      console.log(`NOISE ${JSON.stringify(noise)}`);
      return;
    }
    if (phase === "check") {
      // Rule fixed before the run: keep Haiku if its improve-train accuracy is at most 5 pp below
      // Sonnet's AND it is cheaper per correct answer; otherwise switch v000 to Sonnet and re-run val ×2.
      const full = JSON.parse(readFileSync(join(expDir, "b9-full.json"), "utf8"));
      const haiku = full.results.find((r: { label: string }) => r.label === "b9-improve-train");
      if (!haiku) throw new Error("no Haiku improve-train run in b9-full.json");
      const guard = phaseBudgetGuard(app.db, 10);
      const file = writeTasks("b9-improve-train", train.filter((t) => splits.improve.includes(t.task_id)));
      const sonnet = await runOne("b9-improve-train-sonnet", file, MODELS.sonnet, guard);
      const h = haiku.metrics as RunMetrics;
      const s = sonnet.metrics;
      const gapPp = ((s.accuracy ?? 0) - (h.accuracy ?? 0)) * 100;
      const keepHaiku = gapPp <= 5 && (h.cost_per_correct_usd ?? Infinity) < (s.cost_per_correct_usd ?? Infinity);
      const result: Record<string, unknown> = {
        rule: "keep Haiku if (sonnet_acc - haiku_acc) <= 5 pp AND haiku $/correct < sonnet $/correct; else Sonnet + val x2",
        haiku: { run_id: haiku.run_id, metrics: h },
        sonnet: { run_id: sonnet.run_id, status: sonnet.status, metrics: s },
        gap_pp: gapPp,
        chosen: keepHaiku ? MODELS.haiku : MODELS.sonnet,
      };
      console.table({ haiku: fmt(h), sonnet: fmt(s) });
      console.log(`gap ${gapPp.toFixed(1)} pp → CHOSEN ${result.chosen}`);
      if (!keepHaiku && sonnet.status === "done") {
        const v1 = await runOne("b9-val-1-sonnet", writeTasks("b9-val", val), MODELS.sonnet, guard);
        const v2 = await runOne("b9-val-2-sonnet", writeTasks("b9-val", val), MODELS.sonnet, guard);
        const correctOf = (runId: string) =>
          new Map((app.db.prepare("SELECT task_id, correct FROM run_tasks WHERE run_id = ?").all(runId) as Array<{ task_id: string; correct: number }>).map((r) => [r.task_id, r.correct]));
        const [a, b] = [correctOf(v1.run_id), correctOf(v2.run_id)];
        const c1 = v1.metrics.correct ?? 0;
        const c2 = v2.metrics.correct ?? 0;
        result.val = [v1, v2];
        result.noise = { c1, c2, flips: [...a.keys()].filter((k) => a.get(k) !== b.get(k)).length, T: Math.max(2, Math.abs(c1 - c2) + 1) };
        console.log(`NOISE ${JSON.stringify(result.noise)}`);
      }
      writeFileSync(join(expDir, "b9-check.json"), `${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    throw new Error("usage: baseline.ts pick | full <model> | check");
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
