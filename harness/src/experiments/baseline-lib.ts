// Helpers for the step-9 baseline experiment.
import type { Db } from "../db/db.ts";
import { mulberry32 } from "../runs/splits.ts";
import { BudgetExhausted } from "../runtime/budget.ts";

/** Deterministic sample of `n` ids from `ids`, keeping the easy/hard proportion. */
export function stratifiedSample(tasks: Array<{ task_id: string; level?: string }>, ids: string[], n: number, seed: number): string[] {
  const level = new Map(tasks.map((t) => [t.task_id, t.level ?? "unknown"]));
  const groups = new Map<string, string[]>();
  for (const id of [...ids].sort()) groups.set(level.get(id) ?? "unknown", [...(groups.get(level.get(id) ?? "unknown") ?? []), id]);
  const rand = mulberry32(seed);
  const out: string[] = [];
  const keys = [...groups.keys()].sort();
  keys.forEach((k, i) => {
    const g = groups.get(k) ?? [];
    for (let j = g.length - 1; j > 0; j--) {
      const r = Math.floor(rand() * (j + 1));
      [g[j], g[r]] = [g[r], g[j]];
    }
    const take = i === keys.length - 1 ? n - out.length : Math.round((n * g.length) / ids.length);
    out.push(...g.slice(0, take));
  });
  return out.sort((a, b) => Number(a) - Number(b));
}

/** Throws BudgetExhausted once ledger spend recorded after this call exceeds `limitUsd`. */
export function phaseBudgetGuard(db: Db, limitUsd: number): () => void {
  const { maxId } = db.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM ledger").get() as { maxId: number };
  const q = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ledger WHERE id > ?");
  return () => {
    const { s } = q.get(maxId) as { s: number };
    if (s > limitUsd) throw new BudgetExhausted(`phase budget $${limitUsd} exceeded (spent $${s.toFixed(4)})`);
  };
}
