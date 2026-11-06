// Governor (SPEC §3.2): the single gate every LLM call goes through — budget check, bounded
// concurrency, per-model rate limit, retry of transient errors, and cost recording.
import type { BudgetLedger, LedgerScope } from "./budget.ts";
import { RateLimiter } from "./limiter.ts";
import { HttpError, withRetry } from "./retry.ts";

export type LlmCall<T> = () => Promise<{ value: T; costUsd: number }>;

export interface CallContext {
  model: string;
  scope: LedgerScope;
  ref: string; // run id / session id — ledger key for per-run budgets
  budgetUsd?: number | null;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    return () => {
      this.active--;
      this.queue.shift()?.();
    };
  }
}

export interface GovernorOptions {
  ledger: BudgetLedger;
  concurrency: number;
  rpm: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class Governor {
  readonly limiter: RateLimiter;
  private readonly sem: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly opts: GovernorOptions;

  constructor(opts: GovernorOptions) {
    this.opts = opts;
    this.limiter = new RateLimiter({ rpm: opts.rpm, now: opts.now });
    this.sem = new Semaphore(opts.concurrency);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T>(ctx: CallContext, fn: LlmCall<T>): Promise<T> {
    this.opts.ledger.assertCanSpend({ ref: ctx.ref, budgetUsd: ctx.budgetUsd });
    const release = await this.sem.acquire();
    try {
      const { value, costUsd } = await withRetry(
        async () => {
          const wait = this.limiter.reserve(ctx.model);
          if (wait > 0) await this.sleep(wait);
          try {
            return await fn();
          } catch (e) {
            if (e instanceof HttpError && e.status === 429) this.limiter.onRateLimited(ctx.model);
            throw e;
          }
        },
        { sleep: this.sleep },
      );
      this.opts.ledger.record({ scope: ctx.scope, ref: ctx.ref, costUsd });
      return value;
    } finally {
      release();
    }
  }
}
