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

export async function improveCommand(o: {
  baseUrl: string;
  generations: number;
  budgetUsd: number;
  pollMs?: number;
  log?: (s: string) => void;
}): Promise<{ status: string; result?: unknown }> {
  const log = o.log ?? console.log;
  const res = await fetch(`${o.baseUrl}/api/runs/improve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generations: o.generations, budget_usd: o.budgetUsd }),
  });
  const body = (await res.json()) as { run_id?: string; error?: { message: string } };
  if (!res.ok || !body.run_id) throw new Error(`improve rejected (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  log(`improve run ${body.run_id} started: ${o.generations} generation(s), budget $${o.budgetUsd}`);
  let last = "";
  for (;;) {
    const r = (await (await fetch(`${o.baseUrl}/api/runs/${body.run_id}`)).json()) as {
      run: { status: string; stage: string; gen: number; last: Record<string, unknown>; result?: { promoted: string[]; rejected: string[]; spent_usd: number }; error?: string };
    };
    const line = `gen ${r.run.gen} ${r.run.stage} ${JSON.stringify(r.run.last)}`;
    if (line !== last) {
      last = line;
      log(line);
    }
    if (TERMINAL.has(r.run.status)) {
      if (r.run.result) log(`${r.run.status}: promoted [${r.run.result.promoted.join(", ")}], rejected [${r.run.result.rejected.join(", ")}], spent $${r.run.result.spent_usd.toFixed(3)}`);
      if (r.run.error) log(`error: ${r.run.error}`);
      return { status: r.run.status, result: r.run.result };
    }
    await new Promise((s) => setTimeout(s, o.pollMs ?? 2000));
  }
}

type VersionsList = {
  best: string;
  versions: Array<{
    id: string;
    status: string;
    parent: string | null;
    change_summary: string;
    models?: { analyst: string };
    metrics: null | {
      val: null | { correct: number; n: number; accuracy: number; by_level?: Record<string, number>; runs?: number[] };
      cost_per_task_usd?: number;
      cache_hit_rate?: number;
      latency_p50_s?: number;
      latency_p95_s?: number;
      reflect_cost_usd?: number;
      reject_reason?: string;
      gate?: { reason: string };
    };
  }>;
};

const pct = (x: number | undefined) => (x === undefined ? "-" : `${(x * 100).toFixed(1)}%`);

export function renderReport(list: VersionsList, format: "md" | "text"): string {
  const head = ["version", "status", "parent", "model", "val (mean)", "acc", "easy", "hard", "runs", "$/task", "cache hit", "p50/p95 s", "reflect $", "what changed / why rejected"];
  const rows = list.versions.map((v) => {
    const m = v.metrics;
    const val = m?.val;
    return [
      `${v.id}${v.id === list.best ? " ★" : ""}`,
      v.status,
      v.parent ?? "-",
      v.models?.analyst ?? "-",
      val ? `${val.correct}/${val.n}` : "-",
      val ? pct(val.accuracy) : "-",
      pct(val?.by_level?.easy),
      pct(val?.by_level?.hard),
      val?.runs ? val.runs.join(" / ") : "-",
      m?.cost_per_task_usd !== undefined ? m.cost_per_task_usd.toFixed(4) : "-",
      pct(m?.cache_hit_rate),
      m?.latency_p50_s !== undefined ? `${m.latency_p50_s.toFixed(1)} / ${(m.latency_p95_s ?? 0).toFixed(1)}` : "-",
      m?.reflect_cost_usd !== undefined ? m.reflect_cost_usd.toFixed(3) : "-",
      `${v.change_summary}${m?.reject_reason ? ` — ${m.reject_reason}` : ""}`.replace(/\|/g, "\\|").slice(0, 160),
    ];
  });
  if (format === "md") return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [head, ...rows].map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}

export async function reportCommand(o: { baseUrl: string; md: boolean; log?: (s: string) => void }): Promise<void> {
  const res = await fetch(`${o.baseUrl}/api/versions`);
  if (!res.ok) throw new Error(`GET /api/versions → ${res.status}`);
  (o.log ?? console.log)(renderReport((await res.json()) as VersionsList, o.md ? "md" : "text"));
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
  if (cmd === "improve") {
    const { values } = parseArgs({ args: rest, options: { generations: { type: "string", default: "1" }, "budget-usd": { type: "string", default: "10" } } });
    const r = await improveCommand({ baseUrl: process.env.HARNESS_URL ?? "http://localhost:8080", generations: Number(values.generations), budgetUsd: Number(values["budget-usd"]) });
    return r.status === "done" ? 0 : 1;
  }
  if (cmd === "report") {
    const { values } = parseArgs({ args: rest, options: { md: { type: "boolean", default: false } } });
    await reportCommand({ baseUrl: process.env.HARNESS_URL ?? "http://localhost:8080", md: values.md ?? false });
    return 0;
  }
  if (cmd === "splits") {
    const train = readFileSync(join(repoRoot, "bundle", "tasks", "train.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const splits = makeSplits(train, { seed: 42, holdoutFraction: 0.2 });
    writeFileSync(join(repoRoot, "config", "splits.json"), `${JSON.stringify(splits, null, 2)}\n`);
    console.log(`improve ${splits.improve.length}, report_holdout ${splits.report_holdout.length}`);
    return 0;
  }
  console.error("usage: harness <solve|improve|report|splits> …");
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
