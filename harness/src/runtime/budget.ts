// Budget ledger (SPEC §3.1 LedgerEntry): every LLM cost is recorded; global cap and per-run budgets
// are checked before a call is made.
import type { Db } from "../db/db.ts";

export class BudgetExhausted extends Error {
  readonly code = "budget_exhausted";
}

export type LedgerScope = "chat" | "solve" | "improve" | "mcp" | "probe";
export const LEDGER_SCOPES: readonly LedgerScope[] = ["chat", "solve", "improve", "mcp", "probe"];

export interface LedgerRecord {
  scope: LedgerScope;
  ref: string;
  costUsd: number;
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costSource?: "header" | "usage";
  providerCostUsd?: number | null;
  aborted?: boolean;
  estimated?: boolean;
  ms?: number;
}

export class BudgetLedger {
  private readonly db: Db;
  private readonly opts: { capUsd: number };
  constructor(db: Db, opts: { capUsd: number }) {
    this.db = db;
    this.opts = opts;
  }

  get capUsd(): number {
    return this.opts.capUsd;
  }

  record(e: LedgerRecord): void {
    this.db
      .prepare(
        `INSERT INTO ledger (scope, ref, cost_usd, model, input, output, cache_read, cache_write, cost_source, provider_cost_usd, aborted, estimated, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.scope,
        e.ref,
        e.costUsd,
        e.model ?? null,
        e.usage?.input ?? null,
        e.usage?.output ?? null,
        e.usage?.cacheRead ?? null,
        e.usage?.cacheWrite ?? null,
        e.costSource ?? null,
        e.providerCostUsd ?? null,
        e.aborted ? 1 : 0,
        e.estimated ? 1 : 0,
        e.ms ?? null,
      );
  }

  spentUsd(ref?: string): number {
    const row = (ref === undefined
      ? this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ledger").get()
      : this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ledger WHERE ref = ?").get(ref)) as { s: number };
    return row.s;
  }

  assertCanSpend(run?: { ref: string; budgetUsd: number | null | undefined }): void {
    const spent = this.spentUsd();
    if (spent >= this.opts.capUsd) throw new BudgetExhausted(`global budget cap $${this.opts.capUsd} reached (spent $${spent.toFixed(4)})`);
    if (run?.budgetUsd != null) {
      const runSpent = this.spentUsd(run.ref);
      if (runSpent >= run.budgetUsd) throw new BudgetExhausted(`run ${run.ref} budget $${run.budgetUsd} reached (spent $${runSpent.toFixed(4)})`);
    }
  }
}
