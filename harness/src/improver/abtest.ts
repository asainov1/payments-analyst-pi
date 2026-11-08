// Process A/B on unscored tasks: parent vs parent + one python tool_description, same tasks, one run each.
// Measures turn time, limit hits and Python failures (no gold answers needed).
//   node --env-file=../.env src/improver/abtest.ts <tasks.jsonl>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BatchRunner } from "../runs/batch.ts";
import { createRuntime } from "../runtime/app.ts";
import { createVersion, readVersion } from "./store.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PY_DESC =
  "Run Python 3.12 (pandas, duckdb available) in a sandbox. Files: data/ (payments.csv, fees.json, merchant_data.json, " +
  "merchant_category_codes.csv, acquirer_countries.csv, manual.md) and skills/ (helper scripts of this harness version). " +
  "No network. Print what you need; output is truncated at 8 KB. " +
  "EACH CALL IS A FRESH PROCESS: variables, imports and DataFrames from earlier calls do NOT exist. Write one self-contained " +
  "script per call (load data, compute, print), or save intermediates to files (e.g. df.to_parquet('x.parquet')) and load them " +
  "in the next call; files persist within this conversation. A call is killed after 60 s: vectorise with pandas/duckdb, never " +
  "loop over every transaction × fee rule in pure Python.";

async function main(): Promise<void> {
  const tasksFile = process.argv[2];
  const parent = readFileSync(join(ROOT, "versions", "BEST"), "utf8").trim();
  const src = readVersion(ROOT, parent);
  const cand = createVersion(ROOT, {
    parent,
    content: { ...src, manifest: { ...src.manifest, tool_descriptions: { ...src.manifest.tool_descriptions, python: PY_DESC } } },
    status: "candidate",
    change_summary: "python tool description: each call is a fresh process (no variables between calls), 60 s per call, vectorise",
    reflectCostUsd: 0,
  });
  const app = await createRuntime({ repoRoot: ROOT });
  try {
    const one = async (version: string) => {
      const runner = new BatchRunner({ db: app.db, solver: app.solver(), concurrency: 12, ioDir: join(ROOT, "io"), repoRoot: ROOT, warmup: true });
      const r = await runner.wait(await runner.startSolve({ tasksFile, version, out: join(ROOT, "io", `ab-${version}.answers.jsonl`) }));
      const rows = app.db.prepare("SELECT task_id, ms, answer, trace_json FROM run_tasks WHERE run_id = ?").all(r.id) as Array<{ task_id: string; ms: number; answer: string; trace_json: string | null }>;
      let py = 0, pyFail = 0, nameErr = 0, pyTimeout = 0, limit = 0, na = 0, ms = 0, cost = 0;
      for (const row of rows) {
        const t = JSON.parse(row.trace_json ?? "{}") as { steps?: Array<{ tool?: string; output?: unknown; error?: unknown }>; limit?: string | null; costUsd?: number };
        for (const s of t.steps ?? []) {
          if (s.tool !== "python") continue;
          py++;
          const o = `${s.output ?? ""}${s.error ?? ""}`;
          if (o.includes("Traceback") || o.includes("timed out") || s.error) pyFail++;
          if (o.includes("NameError")) nameErr++;
          if (o.includes("timed out")) pyTimeout++;
        }
        if (t.limit) limit++;
        if (/not applicable/i.test(row.answer ?? "")) na++;
        ms += row.ms;
        cost += t.costUsd ?? 0;
      }
      return { version, tasks: rows.length, turn_limit_hits: limit, not_applicable: na, avg_turn_s: Math.round(ms / rows.length / 1000), python_calls: py, python_failed: pyFail, name_errors: nameErr, python_timeouts: pyTimeout, cost_usd: Math.round(cost * 100) / 100, answers: rows.map((x) => `${x.task_id}=${x.answer}`) };
    };
    const [a, b] = await Promise.all([one(parent), one(cand)]);
    console.log(JSON.stringify(a));
    console.log(JSON.stringify(b));
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
