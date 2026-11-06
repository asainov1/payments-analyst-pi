// Re-test a previous candidate's change as a NEW version with fresh val runs (all 3 in parallel) and
// the current gate. Used once, for v013's fee skill under the easy-regression rule revised before this run.
//   LLM_CONCURRENCY=72 node --env-file=../.env src/improver/replicate.ts v013
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BatchRunner } from "../runs/batch.ts";
import { createRuntime } from "../runtime/app.ts";
import { gateDecision } from "./gate.ts";
import { assertRunOk, correctMap, materializeValMetrics, writeBest } from "./loop.ts";
import { createVersion, readVersion, updateManifest, updateMetrics } from "./store.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function main(): Promise<void> {
  const source = process.argv[2];
  if (!source) throw new Error("usage: replicate.ts <version>");
  const app = await createRuntime({ repoRoot: ROOT });
  try {
    const parent = readFileSync(join(ROOT, "versions", "BEST"), "utf8").trim();
    const src = readVersion(ROOT, source);
    const content = { ...src, manifest: { ...src.manifest } };
    const cand = createVersion(ROOT, {
      parent,
      content,
      status: "candidate",
      change_summary: `re-test of ${source}'s change with fresh val runs under the easy-regression rule revised before this run (≥ 2 of 3 drop). ${src.manifest.change_summary.slice(0, 160)}`,
      reflectCostUsd: 0,
    });
    console.log(`candidate ${cand} (copy of ${source}) vs parent ${parent}`);
    const val = readFileSync(join(ROOT, "bundle", "tasks", "val.jsonl"), "utf8");
    const levels = Object.fromEntries(val.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((t) => [t.task_id, t.level]));
    const tasksFile = join(ROOT, "bundle", "tasks", "val.jsonl");
    const runs = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const runner = new BatchRunner({ db: app.db, solver: app.solver(), concurrency: 30, ioDir: join(ROOT, "io"), repoRoot: ROOT, warmup: true });
        const r = await runner.wait(await runner.startSolve({ tasksFile, version: cand, out: join(ROOT, "io", `${cand}-val-${n}.answers.jsonl`) }));
        assertRunOk(r, `${cand}-val-${n}`);
        console.log(`${cand}-val-${n}: ${r.summary?.correct}/${r.summary?.n}`);
        return r.id;
      }),
    );
    const cm = materializeValMetrics(app, cand, runs, levels) as { cost_per_task_usd: number };
    const pm = JSON.parse(readFileSync(join(ROOT, "versions", parent, "metrics.json"), "utf8")) as { val_run_ids: string[]; cost_per_task_usd: number };
    const T = (JSON.parse(readFileSync(join(ROOT, "config", "gate.json"), "utf8")) as { T: number }).T;
    const d = gateDecision({
      parent: { runs: pm.val_run_ids.map((id) => correctMap(app.db, id)), costPerTask: pm.cost_per_task_usd },
      cand: { runs: runs.map((id) => correctMap(app.db, id)), costPerTask: cm.cost_per_task_usd },
      levels,
      T,
    });
    updateMetrics(ROOT, cand, { gate: d });
    if (d.decision === "promote") {
      updateManifest(ROOT, cand, { status: "promoted" });
      writeBest(ROOT, cand);
    } else {
      updateManifest(ROOT, cand, { status: "rejected", reject_stage: "gate" });
      updateMetrics(ROOT, cand, { reject_reason: `gate: ${d.reason}` });
    }
    console.log(`GATE ${JSON.stringify(d)}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
