// SPEC §3.4 deterministic improver core: playbook render, curator, leak-check, gate, version store.
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { curate, LIMITS, type Proposal } from "../src/improver/curator.ts";
import { gateDecision, thresholdT } from "../src/improver/gate.ts";
import { buildLeakContext, leakCheck } from "../src/improver/leakcheck.ts";
import { emptyPlaybook, type Playbook, renderPlaybook } from "../src/improver/playbook.ts";
import { createVersion, nextVersionId, readVersion, type VersionContent } from "../src/improver/store.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function content(rules: string[] = []): VersionContent {
  const pb: Playbook = { next_id: rules.length + 1, rules: rules.map((t, i) => ({ id: `R${String(i + 1).padStart(3, "0")}`, text: t, added_in: "v000", updated_in: "v000" })) };
  return {
    manifest: JSON.parse(readFileSync(join(ROOT, "versions", "v000", "manifest.json"), "utf8")),
    system: "SYSTEM",
    playbook: pb,
    skills: {},
  };
}
const rule = (i: number) => `Rule number ${i}: when computing fees for merchant category ${i}, check account type and aci list ${i * 7}.`;

describe("playbook", () => {
  test("empty playbook renders exactly like v000's playbook.md (prompt cache unchanged)", () => {
    expect(`${renderPlaybook(emptyPlaybook())}\n`).toBe(readFileSync(join(ROOT, "versions", "v000", "playbook.md"), "utf8"));
  });
  test("rules render in id order with ids", () => {
    const md = renderPlaybook(content(["b rule", "a rule"]).playbook);
    expect(md.indexOf("[R001]")).toBeLessThan(md.indexOf("[R002]"));
  });
});

describe("curator", () => {
  const add = (text: string): Proposal => ({ kind: "content", rationale: "r", ops: [{ op: "playbook_add", text }] });

  test("add assigns the next id; edit/remove by rule_id; unknown id → invalid_op", () => {
    const r = curate(content(["first rule about fees"]), add("Monthly volume uses natural calendar months."), "v001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.playbook.rules.map((x) => x.id)).toEqual(["R001", "R002"]);
    expect(r.content.playbook.rules[1].added_in).toBe("v001");
    const bad = curate(content(["x"]), { kind: "content", rationale: "r", ops: [{ op: "playbook_edit", rule_id: "R099", text: "y" }] }, "v001");
    expect(bad).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid_op/) });
  });

  test("near-duplicate add is skipped and reported; nothing left → empty", () => {
    const r = curate(content(["Always use natural calendar months for monthly volume."]), add("always use natural calendar months for monthly volume"), "v001");
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/^empty/) });
    expect(r.curation.skipped_duplicates).toHaveLength(1);
  });

  test("merge ≥ 2 rules into one new rule with merged_from", () => {
    const r = curate(content(["rule alpha one", "rule beta two", "rule gamma three"]), { kind: "content", rationale: "r", ops: [{ op: "playbook_merge", rule_ids: ["R001", "R002"], text: "alpha and beta combined" }] }, "v001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.playbook.rules.map((x) => x.id)).toEqual(["R003", "R004"]);
    expect(r.content.playbook.rules[1].merged_from).toEqual(["R001", "R002"]);
  });

  test(`over_limit: the ${LIMITS.maxRules + 1}th rule is rejected`, () => {
    const parent = content(Array.from({ length: LIMITS.maxRules }, (_, i) => rule(i)));
    expect(curate(parent, add("one more unique rule about refused transactions"), "v001")).toMatchObject({ ok: false, reason: expect.stringMatching(/^over_limit|^growth_under_pressure/) });
  });

  test("growth_under_pressure: parent at ≥ 80 % → +1 rule rejected, merge 2→1 passes", () => {
    const parent = content(Array.from({ length: 32 }, (_, i) => rule(i)));
    expect(curate(parent, add("a brand new rule about fraud ratio"), "v001")).toMatchObject({ ok: false, reason: expect.stringMatching(/^growth_under_pressure/) });
    const merged = curate(parent, { kind: "content", rationale: "r", ops: [{ op: "playbook_merge", rule_ids: ["R001", "R002"], text: "merged rule" }] }, "v001");
    expect(merged.ok).toBe(true);
  });

  test("routing: allow-list model / thinking / max_turn_s ∈ [120, 300]", () => {
    const ok = curate(content(), { kind: "routing", rationale: "r", ops: [{ op: "routing", max_turn_s: 240 }] }, "v001");
    expect(ok.ok && ok.content.manifest.limits.max_turn_s).toBe(240);
    for (const op of [{ max_turn_s: 400 }, { model: "gpt-6.1-sol" }, { thinking: "xhigh" }]) {
      expect(curate(content(), { kind: "routing", rationale: "r", ops: [{ op: "routing", ...op }] } as Proposal, "v001").ok).toBe(false);
    }
  });

  test("skills: name/file/size/count limits; tool descriptions only for known tools", () => {
    const ok = curate(content(), { kind: "content", rationale: "r", ops: [{ op: "skill_upsert", name: "fee_match", skill_md: "# Fee matching\nUse helper.", files: { "match.py": "def f():\n  return 1\n" } }] }, "v001");
    expect(ok.ok && Object.keys(ok.content.skills.fee_match)).toEqual(["SKILL.md", "match.py"]);
    expect(curate(content(), { kind: "content", rationale: "r", ops: [{ op: "skill_upsert", name: "../x", skill_md: "x", files: {} }] }, "v001").ok).toBe(false);
    expect(curate(content(), { kind: "content", rationale: "r", ops: [{ op: "skill_upsert", name: "big", skill_md: "x", files: { "a.py": "x".repeat(LIMITS.maxSkillFileBytes + 1) } }] }, "v001").ok).toBe(false);
    expect(curate(content(), { kind: "content", rationale: "r", ops: [{ op: "tool_description", tool: "bash", text: "x" }] }, "v001").ok).toBe(false);
    const td = curate(content(), { kind: "content", rationale: "r", ops: [{ op: "tool_description", tool: "sql", text: "Better sql description." }] }, "v001");
    expect(td.ok && td.content.manifest.tool_descriptions.sql).toBe("Better sql description.");
  });
});

describe("leak-check", () => {
  const ctx = buildLeakContext(ROOT);
  const val = readFileSync(join(ROOT, "bundle", "tasks", "val.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const longGold = val.find((t) => /^\d+\.\d{6}$/.test(t.answer))?.answer as string;
  const q = val[0].question as string;

  test("gold literal → reject with redaction; domain tokens (GlobalCard, Not Applicable) pass", () => {
    const r = leakCheck(`Remember: the average fee is ${longGold} for this case.`, ctx);
    expect(r.ok).toBe(false);
    expect(r.redacted).not.toContain(longGold);
    expect(r.redacted).toContain("[REDACTED:gold]");
    expect(leakCheck("Card schemes are GlobalCard, NexPay. Answer 'Not Applicable' when no merchant matches. Rafa_AI is a merchant.", ctx).ok).toBe(true);
  });

  test("question 8-gram, task ids and tasks/scorer paths → reject", () => {
    expect(leakCheck(`Note: ${q.split(" ").slice(0, 10).join(" ")}`, ctx).ok).toBe(false);
    expect(leakCheck("For task_id 1234 use the other merchant.", ctx).ok).toBe(false);
    expect(leakCheck("open('bundle/tasks/val.jsonl')", ctx).ok).toBe(false);
  });

  test("literal table of > 10 name→number pairs → reject; 10 pairs and computing SQL pass", () => {
    const table = (n: number) => `VOL = {${Array.from({ length: n }, (_, i) => `'merchant_${i}': ${100 + i}.5`).join(", ")}}`;
    expect(leakCheck(table(11), ctx)).toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.stringMatching(/literal_table/)]) });
    expect(leakCheck(table(10), ctx).ok).toBe(true);
    expect(leakCheck("SELECT merchant, SUM(eur_amount) FROM payments_m WHERE month = 1 GROUP BY merchant", ctx).ok).toBe(true);
  });
});

describe("gate (mean of k runs)", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
  const levels = Object.fromEntries(ids.map((id, i) => [id, i < 2 ? "easy" : "hard"]));
  const runs = (correct: string[][]) => correct.map((c) => new Map(ids.map((id) => [id, c.includes(id)])));

  test("T from flips between identical runs: σ_run = √(F/2), T_k = max(2, ⌈2σ√(2/k)⌉)", () => {
    expect(thresholdT([17], 3)).toBe(5);
    expect(thresholdT([17], 2)).toBe(6);
    expect(thresholdT([0], 3)).toBe(2);
  });

  test("promote when mean gain ≥ T, net majority wins ≥ 1, no easy regression, cost ok", () => {
    const parent = { runs: runs([["t0", "t1", "t2"], ["t0", "t1", "t3"], ["t0", "t1"]]), costPerTask: 0.01 };
    const cand = { runs: runs([["t0", "t1", "t2", "t3", "t4", "t5"], ["t0", "t1", "t2", "t3", "t4", "t5"], ["t0", "t1", "t2", "t3", "t4"]]), costPerTask: 0.012 };
    const d = gateDecision({ parent, cand, levels, T: 2 });
    expect(d).toMatchObject({ decision: "promote", easy_regressions: 0 });
    expect(d.cand_correct - d.parent_correct).toBeGreaterThanOrEqual(2);
    expect(d.confirmed_wins).toBe(4); // t2 t3 t4 t5 by majority (t2/t3 1-of-3 at parent)
  });

  test("reject: easy regression, cost-guard, gain below T", () => {
    const parent = { runs: runs([["t0", "t1"], ["t0", "t1"], ["t0", "t1"]]), costPerTask: 0.01 };
    const easyLoss = { runs: runs([["t1", "t2", "t3", "t4"], ["t1", "t2", "t3", "t4"], ["t1", "t2", "t3", "t4"]]), costPerTask: 0.01 };
    expect(gateDecision({ parent, cand: easyLoss, levels, T: 1 })).toMatchObject({ decision: "reject", reason: expect.stringMatching(/easy/) });
    const pricey = { runs: runs([["t0", "t1", "t2", "t3", "t4"], ["t0", "t1", "t2", "t3", "t4"], ["t0", "t1", "t2", "t3", "t4"]]), costPerTask: 0.02 };
    expect(gateDecision({ parent, cand: pricey, levels, T: 2 })).toMatchObject({ decision: "reject", reason: expect.stringMatching(/cost/) });
    expect(gateDecision({ parent, cand: pricey, levels, T: 9 }).decision).toBe("reject");
  });
});

describe("version store", () => {
  test("createVersion writes manifest/playbook/skills/diff; readVersion round-trips; ids increment", () => {
    const repo = mkdtempSync(join(tmpdir(), "vs-"));
    cpSync(join(ROOT, "versions"), join(repo, "versions"), { recursive: true });
    const parent = readVersion(repo, "v000");
    expect(parent.playbook.rules).toEqual([]);
    const r = curate(parent, { kind: "content", rationale: "why", ops: [{ op: "playbook_add", text: "Fraud level is fraudulent EUR volume over total EUR volume." }, { op: "skill_upsert", name: "fees", skill_md: "# fees", files: { "fees.py": "x = 1\n" } }] }, "v001");
    if (!r.ok) throw new Error(r.reason);
    const expected = nextVersionId(repo);
    const id = createVersion(repo, { parent: "v000", content: r.content, status: "candidate", change_summary: "add fraud rule + fees skill", curation: r.curation, reflectCostUsd: 0.05 });
    expect(id).toBe(expected);
    const back = readVersion(repo, id);
    expect(back.playbook.rules[0].text).toMatch(/Fraud level/);
    expect(back.skills.fees["fees.py"]).toBe("x = 1\n");
    expect(back.manifest).toMatchObject({ id, parent: "v000", status: "candidate" });
    const diff = readFileSync(join(repo, "versions", id, "diff.patch"), "utf8");
    expect(diff).toContain("+- [R001] Fraud level");
    expect(diff).toContain("skills/fees/fees.py");
    const metrics = JSON.parse(readFileSync(join(repo, "versions", id, "metrics.json"), "utf8"));
    expect(metrics).toMatchObject({ val: null, reflect_cost_usd: 0.05 });
    expect(createVersion(repo, { parent: "v000", content: r.content, status: "rejected", change_summary: "x", reflectCostUsd: 0, rejectStage: "leakcheck", rejectReason: "leak: gold" })).toBe(nextVersionId(repo).replace(/\d+$/, (n) => String(Number(n) - 1).padStart(3, "0")));
  });
});
