// `harness` CLI — a thin HTTP client of the harness service (SPEC §2), so batch runs share the
// service's governor (rate limit, budget) with the UI and MCP.
//   harness solve --tasks <file.jsonl> --version best --out <answers.jsonl>
//   harness splits                      (writes config/splits.json)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RunRow } from "../runs/batch.ts";
import { makeSplits } from "../runs/splits.ts";

const TERMINAL = new Set(["done", "stopped_budget", "failed"]);

export async function solveCommand(o: {
  baseUrl: string;
  tasks: string;
  version: string;
  out: string;
  pollMs?: number;
  log?: (s: string) => void;
}): Promise<RunRow> {
  const log = o.log ?? console.log;
  const res = await fetch(`${o.baseUrl}/api/runs/solve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks_file: o.tasks, version: o.version, out: o.out }),
  });
  const body = (await res.json()) as { run_id?: string; error?: { code: string; message: string } };
  if (!res.ok || !body.run_id) throw new Error(`solve rejected (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  log(`run ${body.run_id} started (version ${o.version})`);

  let last = "";
  for (;;) {
    const r = (await (await fetch(`${o.baseUrl}/api/runs/${body.run_id}`)).json()) as {
      run: RunRow;
      progress: { done: number; total: number; correct: number | null };
    };
    const line = `${r.progress.done}/${r.progress.total} ${r.run.status}`;
    if (line !== last) {
      last = line;
      log(line);
    }
    if (TERMINAL.has(r.run.status)) {
      if (r.run.summary) log(`accuracy ${r.run.summary.accuracy} (${r.run.summary.correct}/${r.run.summary.n})`);
      else if (r.run.status === "done") log("no gold answers in tasks file — scoring skipped");
      if (r.run.error) log(`error: ${r.run.error}`);
      return r.run;
    }
    await new Promise((s) => setTimeout(s, o.pollMs ?? 1000));
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  if (cmd === "solve") {
    const { values } = parseArgs({
      args: rest,
      options: { tasks: { type: "string" }, version: { type: "string", default: "best" }, out: { type: "string" } },
    });
    if (!values.tasks || !values.out) throw new Error("usage: harness solve --tasks <file.jsonl> --version best --out <answers.jsonl>");
    const run = await solveCommand({
      baseUrl: process.env.HARNESS_URL ?? "http://localhost:8080",
      tasks: values.tasks,
      version: values.version ?? "best",
      out: values.out,
    });
    return run.status === "done" ? 0 : 1;
  }
  if (cmd === "splits") {
    const train = readFileSync(join(repoRoot, "bundle", "tasks", "train.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const splits = makeSplits(train, { seed: 42, holdoutFraction: 0.2 });
    writeFileSync(join(repoRoot, "config", "splits.json"), `${JSON.stringify(splits, null, 2)}\n`);
    console.log(`improve ${splits.improve.length}, report_holdout ${splits.report_holdout.length}`);
    return 0;
  }
  console.error("usage: harness <solve|splits> …");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
}
