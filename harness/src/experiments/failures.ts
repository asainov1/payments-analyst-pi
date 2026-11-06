// Failure breakdown for a batch run (SPEC §3.4 ANALYZE categories), deterministic:
//   limit      — a turn limit fired or the task errored
//   format     — answer accepted without passing format validation
//   na_misuse  — "Not Applicable"/empty where gold has a value, or a value where gold is NA/empty
//   near       — wrong number within 5 % of gold (proxy for formula / rounding mistakes)
//   far        — wrong number off by > 5 %, wrong list/set or wrong name (proxy for filter mistakes)
// Telling filter from formula for sure needs the trajectory; near/far is an honest proxy.
//   node --env-file=../.env src/experiments/failures.ts <run-label> [--per-task]
// --per-task prints individual failures — use it on improve-train only, never on val (val is the gate).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/db.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
export type Category = "limit" | "format" | "na_misuse" | "near" | "far";

const isNA = (s: string) => s.trim() === "" || s.trim().toLowerCase() === "not applicable";
const num = (s: string) => {
  const m = /^-?\d+(\.\d+)?$/.exec(s.trim().replace(/,/g, ""));
  return m ? Number(m[0]) : null;
};

export function classify(answer: string, gold: string, meta: { limit?: string; valid?: boolean; status?: string }): Category {
  if ((meta.limit && meta.limit !== "none") || meta.status === "error") return "limit";
  if (meta.valid === false) return "format";
  if (isNA(answer) !== isNA(gold)) return "na_misuse";
  const a = num(answer);
  const g = num(gold);
  if (a !== null && g !== null && Math.abs(a - g) <= Math.max(Math.abs(g) * 0.05, 1e-9)) return "near";
  return "far";
}

async function agentMeta(runId: string): Promise<Map<string, { limit?: string; valid?: boolean; tool_calls?: number }>> {
  const base = process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000";
  const auth = `Basic ${Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
  const out = new Map<string, { limit?: string; valid?: boolean; tool_calls?: number }>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ sessionId: runId, type: "AGENT", limit: "100", fields: "core,basic,metadata" });
    if (cursor) q.set("cursor", cursor);
    const r = await fetch(`${base}/api/public/v2/observations?${q}`, { headers: { Authorization: auth } });
    if (!r.ok) break;
    const body = (await r.json()) as { data: Array<{ metadata?: Record<string, unknown> }>; meta?: { cursor?: string } };
    for (const o of body.data) {
      const m = o.metadata ?? {};
      if (m.task_id !== undefined) out.set(String(m.task_id), { limit: String(m.limit ?? "none"), valid: m.valid === true || m.valid === "true", tool_calls: Number(m.tool_calls ?? 0) });
    }
    cursor = body.meta?.cursor;
    if (!cursor || body.data.length === 0) break;
  }
  return out;
}

async function main(): Promise<void> {
  const [label, flag] = process.argv.slice(2);
  if (!label) throw new Error("usage: failures.ts <run-label> [--per-task]");
  if (flag === "--per-task" && label.includes("val")) throw new Error("per-task failure listing on val is not allowed (val is the promotion gate)");
  const db = openDb(join(ROOT, "state", "harness.db"));
  const run = db.prepare("SELECT id, tasks_file FROM runs WHERE out_path LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%/${label}.answers.jsonl`) as
    | { id: string; tasks_file: string }
    | undefined;
  if (!run) throw new Error(`no run for ${label}`);
  const gold = new Map(
    readFileSync(run.tasks_file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((t) => [String(t.task_id), t as { answer: string; level: string; question: string }]),
  );
  const rows = db.prepare("SELECT task_id, status, answer, correct FROM run_tasks WHERE run_id = ?").all(run.id) as Array<{
    task_id: string;
    status: string;
    answer: string | null;
    correct: number | null;
  }>;
  const meta = await agentMeta(run.id);
  const table: Record<string, Record<string, number>> = {};
  const levels = new Map<string, { n: number; correct: number }>();
  const detail: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const g = gold.get(r.task_id);
    if (!g) continue;
    const lv = levels.get(g.level) ?? { n: 0, correct: 0 };
    lv.n++;
    if (r.correct === 1) lv.correct++;
    levels.set(g.level, lv);
    if (r.correct === 1) continue;
    const m = meta.get(r.task_id) ?? {};
    const c = classify(r.answer ?? "", g.answer, { ...m, status: r.status });
    table[c] ??= {};
    table[c][g.level] = (table[c][g.level] ?? 0) + 1;
    detail.push({ task: r.task_id, level: g.level, category: c, answer: (r.answer ?? "").slice(0, 60), gold: g.answer.slice(0, 60), tools: m.tool_calls });
  }
  console.log(`run ${label} (${run.id}); trace metadata for ${meta.size}/${rows.length} tasks`);
  console.table(Object.fromEntries([...levels].map(([k, v]) => [k, { ...v, accuracy: (v.correct / v.n).toFixed(3) }])));
  console.table(table);
  if (flag === "--per-task") console.table(detail);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
