// Step 20 helpers (run on the host, from harness/):
//   node --env-file=../.env src/improver/finalize.ts holdout     report-holdout run of BEST → metrics.json
//   node --env-file=../.env src/improver/finalize.ts report-md   versions table → REPORT.md / README.md markers
//   node --env-file=../.env src/improver/finalize.ts key-spend   key spend from x-litellm-key-spend (1-token call)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport } from "../cli/harness.ts";
import { BatchRunner } from "../runs/batch.ts";
import { runMetrics } from "../runs/metrics.ts";
import { createRuntime } from "../runtime/app.ts";
import { VersionsService } from "../versions/service.ts";
import { assertRunOk } from "./loop.ts";
import { updateMetrics } from "./store.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const START = "<!-- versions:start -->";
const END = "<!-- versions:end -->";

async function holdout(): Promise<void> {
  const best = readFileSync(join(ROOT, "versions", "BEST"), "utf8").trim();
  const ids = new Set((JSON.parse(readFileSync(join(ROOT, "config", "splits.json"), "utf8")) as { report_holdout: string[] }).report_holdout);
  const tasks = readFileSync(join(ROOT, "bundle", "tasks", "train.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l && ids.has(JSON.parse(l).task_id));
  const file = join(ROOT, "io", `${best}-report-holdout.jsonl`);
  writeFileSync(file, `${tasks.join("\n")}\n`);
  const app = await createRuntime({ repoRoot: ROOT });
  try {
    const runner = new BatchRunner({ db: app.db, solver: app.solver(), concurrency: 12, ioDir: join(ROOT, "io"), repoRoot: ROOT, warmup: true });
    const run = await runner.wait(await runner.startSolve({ tasksFile: file, version: best, out: join(ROOT, "io", `${best}-report-holdout.answers.jsonl`) }));
    assertRunOk(run, "report-holdout");
    const m = runMetrics(app.db, run.id);
    updateMetrics(ROOT, best, { report_holdout: { run_id: run.id, correct: m.correct, n: m.n, cost_per_task_usd: m.cost_per_task_usd } });
    console.log(JSON.stringify({ version: best, report_holdout: `${m.correct}/${m.n}`, cost_per_task_usd: m.cost_per_task_usd }));
  } finally {
    await app.close();
  }
}

function replaceBetween(path: string, body: string): void {
  const s = readFileSync(path, "utf8");
  const i = s.indexOf(START);
  const j = s.indexOf(END);
  if (i < 0 || j < 0) throw new Error(`${path}: markers ${START} / ${END} missing`);
  writeFileSync(path, `${s.slice(0, i + START.length)}\n${body}\n${s.slice(j)}`);
}

function reportMd(): void {
  const md = renderReport(new VersionsService(ROOT).list() as never, "md");
  for (const f of ["REPORT.md", "README.md"]) replaceBetween(join(ROOT, f), md);
  console.log(md);
}

async function keySpend(): Promise<void> {
  const base = (process.env.LITELLM_BASE_URL ?? "").replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.LITELLM_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
  });
  const spend = Number(res.headers.get("x-litellm-key-spend"));
  const max = Number(res.headers.get("x-litellm-key-max-budget"));
  console.log(JSON.stringify({ key_spend_usd: spend, key_max_budget_usd: max, remaining_usd: max - spend, ok_for_holdout_and_demo: max - spend >= 18 }));
}

const cmd = process.argv[2];
const run = cmd === "holdout" ? holdout() : cmd === "report-md" ? Promise.resolve(reportMd()) : cmd === "key-spend" ? keySpend() : Promise.reject(new Error("usage: finalize.ts holdout | report-md | key-spend"));
run.catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
