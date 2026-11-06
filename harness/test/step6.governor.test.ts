// SPEC §6 step 6: Governor — concurrency, rate limit (adaptive on 429), retry, budget ledger, limits.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../src/db/db.ts";
import { BudgetExhausted, BudgetLedger } from "../src/runtime/budget.ts";
import { Governor, type LlmCall } from "../src/runtime/governor.ts";
import { RateLimiter } from "../src/runtime/limiter.ts";
import { LimitExceeded, TaskLimits, TurnLimits } from "../src/runtime/limits.ts";
import { HttpError, withRetry } from "../src/runtime/retry.ts";

const tmpDb = () => openDb(join(mkdtempSync(join(tmpdir(), "gov-")), "harness.db"));
const noSleep = async () => {};

describe("retry", () => {
  test("429 and 5xx are retried, then succeed", async () => {
    const errs = [new HttpError(429, "rate"), new HttpError(503, "busy")];
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      const e = errs.shift();
      if (e) throw e;
      return "ok";
    }, { sleep: noSleep });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  test("network errors (ECONNRESET) are retried", async () => {
    let calls = 0;
    await withRetry(async () => {
      if (calls++ === 0) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return 1;
    }, { sleep: noSleep });
    expect(calls).toBe(2);
  });

  test("400 is not retried", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new HttpError(400, "bad"); }, { sleep: noSleep })).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });

  test("gives up after max attempts and respects retry-after", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new HttpError(429, "rate", 2); }, { attempts: 4, sleep: async (ms) => { waits.push(ms); } }),
    ).rejects.toThrow("rate");
    expect(calls).toBe(4);
    expect(waits.every((w) => w >= 2000)).toBe(true);
  });
});

describe("rate limiter", () => {
  test("allows rpm requests per minute, then makes callers wait", () => {
    let now = 0;
    const rl = new RateLimiter({ rpm: 2, now: () => now });
    expect(rl.reserve("m")).toBe(0);
    expect(rl.reserve("m")).toBe(0);
    expect(rl.reserve("m")).toBeGreaterThan(0); // 3rd within the same minute must wait
    now = 60_000;
    expect(rl.reserve("m")).toBe(0);
  });

  test("429 halves the effective rate for a cooldown window", () => {
    let now = 0;
    const rl = new RateLimiter({ rpm: 60, now: () => now });
    rl.onRateLimited("m");
    expect(rl.effectiveRpm("m")).toBe(30);
    now = 61_000;
    expect(rl.effectiveRpm("m")).toBe(60);
  });
});

describe("budget ledger", () => {
  test("records spend and stops at the global cap", () => {
    const ledger = new BudgetLedger(tmpDb(), { capUsd: 0.01 });
    ledger.assertCanSpend();
    ledger.record({ scope: "solve", ref: "run1", costUsd: 0.006 });
    ledger.record({ scope: "solve", ref: "run1", costUsd: 0.006 });
    expect(ledger.spentUsd()).toBeCloseTo(0.012);
    expect(() => ledger.assertCanSpend()).toThrow(BudgetExhausted);
  });

  test("per-run budget is enforced independently of the global cap", () => {
    const ledger = new BudgetLedger(tmpDb(), { capUsd: 100 });
    ledger.record({ scope: "improve", ref: "imp1", costUsd: 0.5 });
    expect(() => ledger.assertCanSpend({ ref: "imp1", budgetUsd: 0.4 })).toThrow(BudgetExhausted);
    expect(() => ledger.assertCanSpend({ ref: "other", budgetUsd: 0.4 })).not.toThrow();
  });

  test("spend survives reopening the database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gov-")), "harness.db");
    new BudgetLedger(openDb(path), { capUsd: 1 }).record({ scope: "chat", ref: "s", costUsd: 0.25 });
    expect(new BudgetLedger(openDb(path), { capUsd: 1 }).spentUsd()).toBeCloseTo(0.25);
  });
});

describe("turn / task limits", () => {
  test("tool-call limit → limit_exceeded", () => {
    const t = new TurnLimits({ max_tool_calls: 2, max_turn_usd: 1, max_turn_s: 100 }, () => 0);
    t.onToolCall();
    t.onToolCall();
    expect(() => t.onToolCall()).toThrow(LimitExceeded);
    try { t.onToolCall(); } catch (e) { expect((e as LimitExceeded).kind).toBe("tool_calls"); }
  });

  test("turn $ and wall-clock limits", () => {
    let now = 0;
    const t = new TurnLimits({ max_tool_calls: 99, max_turn_usd: 0.1, max_turn_s: 10 }, () => now);
    expect(() => t.onLlmCost(0.11)).toThrow(/turn_usd/);
    const t2 = new TurnLimits({ max_tool_calls: 99, max_turn_usd: 1, max_turn_s: 10 }, () => now);
    now = 11_000;
    expect(() => t2.check()).toThrow(/turn_s/);
  });

  test("per-task $ accumulates across attempts", () => {
    const task = new TaskLimits({ max_task_usd: 0.3 });
    task.add(0.2);
    expect(() => task.add(0.2)).toThrow(/task_usd/);
  });
});

describe("governor (fake LLM)", () => {
  const fakeLlm = (cost: number, failures: number[] = []): LlmCall<string> => async () => {
    const s = failures.shift();
    if (s) throw new HttpError(s, `status ${s}`);
    return { value: "ok", costUsd: cost };
  };

  test("call: rate-limit + retry + ledger in one path", async () => {
    const ledger = new BudgetLedger(tmpDb(), { capUsd: 10 });
    const gov = new Governor({ ledger, concurrency: 2, rpm: 1000, sleep: noSleep });
    const r = await gov.call({ model: "m", scope: "solve", ref: "run1" }, fakeLlm(0.01, [429]));
    expect(r).toBe("ok");
    expect(ledger.spentUsd()).toBeCloseTo(0.01);
  });

  test("global cap $0.01 → budget_exhausted before the call is made", async () => {
    const ledger = new BudgetLedger(tmpDb(), { capUsd: 0.01 });
    const gov = new Governor({ ledger, concurrency: 2, rpm: 1000, sleep: noSleep });
    await gov.call({ model: "m", scope: "solve", ref: "r" }, fakeLlm(0.02));
    let made = false;
    const err = await gov.call({ model: "m", scope: "solve", ref: "r" }, async () => { made = true; return { value: "x", costUsd: 0 }; }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExhausted);
    expect((err as BudgetExhausted).code).toBe("budget_exhausted");
    expect(made).toBe(false);
  });

  test("concurrency is bounded", async () => {
    const ledger = new BudgetLedger(tmpDb(), { capUsd: 10 });
    const gov = new Governor({ ledger, concurrency: 2, rpm: 1000, sleep: noSleep });
    let inFlight = 0;
    let peak = 0;
    const slow: LlmCall<number> = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { value: 1, costUsd: 0 };
    };
    await Promise.all(Array.from({ length: 6 }, () => gov.call({ model: "m", scope: "solve", ref: "r" }, slow)));
    expect(peak).toBe(2);
  });

  test("429 feeds the adaptive limiter", async () => {
    const ledger = new BudgetLedger(tmpDb(), { capUsd: 10 });
    const gov = new Governor({ ledger, concurrency: 1, rpm: 100, sleep: noSleep });
    await gov.call({ model: "m", scope: "solve", ref: "r" }, fakeLlm(0, [429]));
    expect(gov.limiter.effectiveRpm("m")).toBe(50);
  });
});
