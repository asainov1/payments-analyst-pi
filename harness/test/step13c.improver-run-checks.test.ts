// Review fixes before stage 1: a failed batch run must never count as "0 correct";
// VALIDATE starts only when the remaining budget covers K val runs (×1.3).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../src/db/db.ts";
import { phaseBudgetGuard } from "../src/experiments/baseline-lib.ts";
import { assertRunOk, canAffordValidation, RunFailed } from "../src/improver/loop.ts";
import { BudgetExhausted, BudgetLedger } from "../src/runtime/budget.ts";

describe("assertRunOk", () => {
  test("done passes; stopped_budget → BudgetExhausted; failed → RunFailed (id must not be recorded)", () => {
    expect(() => assertRunOk({ id: "r", status: "done", error: null }, "x")).not.toThrow();
    expect(() => assertRunOk({ id: "r", status: "stopped_budget", error: null }, "x")).toThrow(BudgetExhausted);
    expect(() => assertRunOk({ id: "r", status: "failed", error: "scorer crashed" }, "x")).toThrow(RunFailed);
    expect(() => assertRunOk({ id: "r", status: "failed", error: "scorer crashed" }, "x")).toThrow(/scorer crashed/);
  });
});

describe("validation affordability", () => {
  test("remaining ≥ K × parent cost per val run × 1.3", () => {
    expect(canAffordValidation({ remainingUsd: 6, parentCostPerRunUsd: 1.5, k: 3 })).toBe(true); // needs 5.85
    expect(canAffordValidation({ remainingUsd: 5.8, parentCostPerRunUsd: 1.5, k: 3 })).toBe(false);
  });

  test("phase guard exposes spend since the phase started", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "pg-")), "h.db"));
    const ledger = new BudgetLedger(db, { capUsd: 100 });
    ledger.record({ scope: "solve", ref: "before", costUsd: 3 });
    const guard = phaseBudgetGuard(db, 10);
    ledger.record({ scope: "solve", ref: "x", costUsd: 2.5 });
    expect(guard.spent()).toBeCloseTo(2.5);
  });
});
