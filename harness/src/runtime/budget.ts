// Budget ledger (SPEC §3.1 LedgerEntry): every LLM cost is recorded; global cap and per-run budgets
// are checked before a call is made.
import type { Db } from "../db/db.ts";

export class BudgetExhausted extends Error {
  readonly code = "budget_exhausted";
}

export type LedgerScope = "chat" | "solve" | "improve" | "mcp" | "probe";

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

  record(e: { scope: LedgerScope; ref: string; costUsd: number }): void {
    this.db.prepare("INSERT INTO ledger (scope, ref, cost_usd) VALUES (?, ?, ?)").run(e.scope, e.ref, e.costUsd);
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
