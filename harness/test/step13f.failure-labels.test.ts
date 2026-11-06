// Deterministic failure labels (SPEC §3.4 ANALYZE clustering): no LLM, from trace features only.
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { labelFailure } from "../src/improver/labels.ts";
import { buildReflectorPrompt, type Trajectory } from "../src/improver/reflector.ts";
import { readVersion } from "../src/improver/store.ts";

const base = { maxTurnS: 180 };
describe("labelFailure", () => {
  test.each([
    [{ answer: "Not Applicable", gold: "12.5", ms: 181_000, trace: { limit: "turn_s", valid: null, steps: [] } }, "timeout"],
    [{ answer: "x", gold: "12.5", ms: 9_000, trace: { limit: null, valid: false, steps: [] } }, "invalid_format"],
    [{ answer: "12.50", gold: "12.5", ms: 9_000, trace: { limit: null, valid: true, steps: [{ tool: "submit_answer", output: '{"ok":false,"reason":"r"}' }] } }, "invalid_format"],
    [{ answer: "Not Applicable", gold: "12.5", ms: 9_000, trace: { limit: null, valid: true, steps: [] } }, "not_applicable"],
    [{ answer: "15.1", gold: "12.5", ms: 9_000, trace: { limit: null, valid: true, steps: [] } }, "numeric_high"],
    [{ answer: "3", gold: "12.5", ms: 9_000, trace: { limit: null, valid: true, steps: [] } }, "numeric_low"],
    [{ answer: "A, B", gold: "A, C", ms: 9_000, trace: { limit: null, valid: true, steps: [] } }, "other"],
  ])("%# → %s", (row, label) => {
    expect(labelFailure({ ...row, ...base })).toBe(label);
  });
});

describe("reflector prompt clusters", () => {
  test("failures grouped by label, largest cluster first, with counts", () => {
    const t = (label: Trajectory["label"], q: string): Trajectory => ({ level: "hard", question: q, guidelines: "g", answer: "a", verdict: "wrong", ms: 1, steps: [], label });
    const p = buildReflectorPrompt({
      parent: readVersion(join(import.meta.dirname, "..", ".."), "v000"),
      failures: [t("other", "q1"), t("numeric_high", "q2"), t("numeric_high", "q3"), t("timeout", "q4")],
      slow: [],
      feedback: [],
      rejected: [],
    });
    expect(p).toContain("Failure clusters: numeric_high 2, other 1, timeout 1");
    expect(p).toContain("fix the largest cluster with one general rule");
    expect(p.indexOf("### Cluster numeric_high")).toBeLessThan(p.indexOf("### Cluster other"));
  });
});
