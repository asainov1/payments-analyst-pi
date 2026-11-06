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

describe("val runs must exist in this state DB", () => {
  test("ids missing from the runs table → clear error, before any metrics are rewritten", async () => {
    const { assertRunsInDb } = await import("../src/improver/loop.ts");
    const db = openDb(join(mkdtempSync(join(tmpdir(), "vr-")), "h.db"));
    expect(() => assertRunsInDb(db, ["nope-1"], "v000")).toThrow(/val runs of v000 not in this state DB: nope-1/);
    expect(() => assertRunsInDb(db, [], "v000")).not.toThrow();
  });
});

describe("generation start needs a minimum budget", () => {
  test("remaining < $1 → no generation starts (no reflect, no new version)", async () => {
    const { canStartGeneration, MIN_GENERATION_USD } = await import("../src/improver/loop.ts");
    expect(MIN_GENERATION_USD).toBe(1);
    expect(canStartGeneration(0.01)).toBe(false);
    expect(canStartGeneration(1.5)).toBe(true);
  });
});

describe("stage-2 pre-filter settings (agreed after stage 2)", () => {
  test("SMOKE needs fixed − broken ≥ 1; the loop stops after 5 consecutive rejections; parse failures do not count", async () => {
    const { SMOKE_MIN_NET_FIXED, MAX_CONSECUTIVE_REJECTS, countsAsReject } = await import("../src/improver/loop.ts");
    expect(SMOKE_MIN_NET_FIXED).toBe(1);
    expect(MAX_CONSECUTIVE_REJECTS).toBe(5);
    expect(countsAsReject("parse")).toBe(false);
    expect(countsAsReject("smoke")).toBe(true);
    expect(countsAsReject("gate")).toBe(true);
  });
});

describe("routing candidates in SMOKE (v008 fix)", () => {
  test("routing passes SMOKE with broken = 0 even when nothing is fixed; content still needs fixed − broken ≥ 1", async () => {
    const { smokePasses } = await import("../src/improver/loop.ts");
    expect(smokePasses({ kind: "routing", fixed: 0, broken: 0 })).toBe(true);
    expect(smokePasses({ kind: "routing", fixed: 3, broken: 1 })).toBe(false);
    expect(smokePasses({ kind: "content", fixed: 0, broken: 0 })).toBe(false);
    expect(smokePasses({ kind: "content", fixed: 1, broken: 0 })).toBe(true);
  });
});
