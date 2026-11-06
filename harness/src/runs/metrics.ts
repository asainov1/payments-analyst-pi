// Per-run metrics (SPEC §3.1 VersionMetrics): accuracy, cost, cache hit, latency — from run_tasks
// and the proxy ledger (refs `<runId>/<taskId>`).
import type { Db } from "../db/db.ts";

export interface RunMetrics {
  run_id: string;
  n: number;
  correct: number | null;
  accuracy: number | null;
  by_level: Record<string, { n: number; correct: number }>;
  cost_usd: number;
  cost_per_task_usd: number;
  cost_per_correct_usd: number | null;
  cache_hit_rate: number;
  llm_calls: number;
  latency_p50_s: number;
  latency_p95_s: number;
  errors: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export function runMetrics(db: Db, runId: string, levels: Record<string, string> = {}): RunMetrics {
  const tasks = db.prepare("SELECT task_id, status, correct, ms FROM run_tasks WHERE run_id = ?").all(runId) as Array<{
    task_id: string;
    status: string;
    correct: number | null;
    ms: number | null;
  }>;
  const l = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls, COALESCE(SUM(input),0) AS input,
              COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_write),0) AS cw
       FROM ledger WHERE ref LIKE ? || '/%'`,
    )
    .get(runId) as { cost: number; calls: number; input: number; cr: number; cw: number };
  const scored = tasks.some((t) => t.correct !== null);
  const correct = scored ? tasks.filter((t) => t.correct === 1).length : null;
  const ms = tasks
    .map((t) => t.ms)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const by_level: RunMetrics["by_level"] = {};
  for (const t of tasks) {
    const lv = levels[t.task_id] ?? "all";
    by_level[lv] ??= { n: 0, correct: 0 };
    by_level[lv].n++;
    if (t.correct === 1) by_level[lv].correct++;
  }
  const n = tasks.length;
  const prompt = l.input + l.cr + l.cw;
  return {
    run_id: runId,
    n,
    correct,
    accuracy: correct === null || !n ? null : correct / n,
    by_level,
    cost_usd: l.cost,
    cost_per_task_usd: n ? l.cost / n : 0,
    cost_per_correct_usd: correct ? l.cost / correct : null,
    cache_hit_rate: prompt ? l.cr / prompt : 0,
    llm_calls: l.calls,
    latency_p50_s: quantile(ms, 0.5) / 1000,
    latency_p95_s: quantile(ms, 0.95) / 1000,
    errors: tasks.filter((t) => t.status === "error").length,
  };
}
