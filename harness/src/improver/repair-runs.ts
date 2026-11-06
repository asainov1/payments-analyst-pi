// Repair val runs hit by an infrastructure failure (py-sandbox restart): re-solve ONLY the tasks whose
// trace shows sandbox connection errors — selected by the failure, not by correctness — with the
// same version, then write answer/correct back into the original run_tasks rows. Shares the state
// DB with a live improver: no state lock, no crash recovery.
//   node --env-file=../.env src/improver/repair-runs.ts <version> <runId>…
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BatchRunner } from "../runs/batch.ts";
import { createRuntime } from "../runtime/app.ts";
import { assertRunOk, materializeValMetrics } from "./loop.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const INFRA = "(t.trace_json LIKE '%fetch failed%' OR t.trace_json LIKE '%ECONNREFUSED%')";

async function main(): Promise<void> {
  const [version, ...runIds] = process.argv.slice(2);
  if (!version || !runIds.length) throw new Error("usage: repair-runs.ts <version> <runId>…");
  const app = await createRuntime({ repoRoot: ROOT, sharedState: true });
  const val = new Map(
    readFileSync(join(ROOT, "bundle", "tasks", "val.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [JSON.parse(l).task_id as string, l]),
  );
  try {
    for (const runId of runIds) {
      const hit = (app.db.prepare(`SELECT t.task_id, t.correct FROM run_tasks t WHERE t.run_id = ? AND ${INFRA}`).all(runId) as Array<{ task_id: string; correct: number }>);
      if (!hit.length) continue;
      const file = join(ROOT, "io", `repair-${runId.slice(0, 8)}.jsonl`);
      writeFileSync(file, `${hit.map((h) => val.get(h.task_id)).join("\n")}\n`);
      const runner = new BatchRunner({ db: app.db, solver: app.solver(), concurrency: 4, ioDir: join(ROOT, "io"), repoRoot: ROOT, recover: false });
      const r = await runner.wait(await runner.startSolve({ tasksFile: file, version, out: join(ROOT, "io", `repair-${runId.slice(0, 8)}.answers.jsonl`) }));
      assertRunOk(r, `repair ${runId}`);
      const upd = app.db.prepare("UPDATE run_tasks SET answer = ?, correct = ?, trace_json = ?, ms = ? WHERE run_id = ? AND task_id = ?");
      const rows = app.db.prepare("SELECT task_id, answer, correct, trace_json, ms FROM run_tasks WHERE run_id = ?").all(r.id) as Array<{ task_id: string; answer: string; correct: number; trace_json: string; ms: number }>;
      for (const x of rows) upd.run(x.answer, x.correct, x.trace_json, x.ms, runId, x.task_id);
      const before = hit.filter((h) => h.correct === 1).length;
      const after = rows.filter((x) => x.correct === 1).length;
      console.log(`${runId}: re-solved ${hit.length} infra-hit tasks (repair run ${r.id}): correct ${before} → ${after}`);
    }
    const m = JSON.parse(readFileSync(join(ROOT, "versions", version, "metrics.json"), "utf8")) as { val_run_ids: string[] };
    const levels = Object.fromEntries([...val.values()].map((l) => JSON.parse(l)).map((t) => [t.task_id, t.level]));
    const out = materializeValMetrics(app, version, m.val_run_ids, levels, { val_repair: { reason: "py-sandbox restart ~15:59 during val runs 2/3", runs: runIds } });
    console.log(JSON.stringify((out as { val: unknown }).val));
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
