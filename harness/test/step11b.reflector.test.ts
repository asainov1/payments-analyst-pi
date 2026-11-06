// Reflector prompt and proposal parsing (no LLM): no gold values, pressure note, JSON extraction.
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReflectorPrompt, parseProposal, type Trajectory } from "../src/improver/reflector.ts";
import { readVersion } from "../src/improver/store.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const parent = readVersion(ROOT, "v000");
const failure: Trajectory = {
  level: "hard",
  question: "What is the average fee for account type R?",
  guidelines: "Answer must be just a number rounded to 6 decimals.",
  answer: "0.512345",
  verdict: "wrong",
  hint: "too high",
  ms: 9000,
  steps: [{ tool: "sql", args: '{"query":"SELECT 1"}', output: "| 1 |" }],
};

describe("reflector prompt", () => {
  test("shows verdict and direction, never a gold value; includes the hard rules", () => {
    const p = buildReflectorPrompt({ parent, failures: [failure], slow: [], feedback: [], rejected: [] });
    expect(p).toContain("WRONG (too high)");
    expect(p).toContain("Agent's final answer: 0.512345");
    expect(p).not.toMatch(/gold|expected answer|correct answer is/i);
    expect(p).toContain("## Current Playbook");
  });

  test("limit pressure note appears when the playbook is ≥ 80 % full; rejected memory listed", () => {
    const full = structuredClone(parent);
    full.playbook.rules = Array.from({ length: 32 }, (_, i) => ({ id: `R${String(i + 1).padStart(3, "0")}`, text: `rule ${i}`, added_in: "v000", updated_in: "v000" }));
    const p = buildReflectorPrompt({ parent: full, failures: [failure], slow: [], feedback: [], rejected: [{ id: "v003", summary: "x", reason: "gate: mean gain 1 < T=5" }] });
    expect(p).toContain("LIMIT PRESSURE");
    expect(p).toContain("v003: x → gate: mean gain 1 < T=5");
  });
});

describe("parseProposal", () => {
  const json = '{"kind":"content","rationale":"r","ops":[{"op":"playbook_add","text":"t"}]}';
  test.each([json, `Here you go:\n\`\`\`json\n${json}\n\`\`\``, `prefix ${json} suffix`])("extracts the JSON object (%#)", (t) => {
    expect(parseProposal(t)).toMatchObject({ kind: "content", ops: [{ op: "playbook_add" }] });
  });
  test("rejects malformed proposals", () => {
    expect(() => parseProposal('{"kind":"other","ops":[]}')).toThrow();
    expect(() => parseProposal("no json here")).toThrow();
  });
});

describe("schema in the reflector prompt", () => {
  test("exact column names are given (the dataset renames columns of the public original)", async () => {
    const { openDataDb } = await import("../src/data/db.ts");
    const db = await openDataDb(join(ROOT, "bundle", "data"));
    try {
      const p = buildReflectorPrompt({ parent, failures: [], slow: [], feedback: [], rejected: [], schema: await db.schema() });
      expect(p).toContain("use ONLY these exact table and column names");
      expect(p).toContain("is_refused_by_psp");
      expect(p).not.toContain("is_refused_by_adyen");
    } finally {
      db.close();
    }
  });
});

describe("parseProposal with code fences inside JSON strings (v004)", () => {
  test("a ```python block inside skill code does not hijack parsing", () => {
    const code = "Use it like this:\n```python\nexec(open('skills/x/h.py').read())\n```\n";
    const raw = JSON.stringify({ kind: "content", rationale: "r", ops: [{ op: "skill_upsert", name: "x", skill_md: code, files: { "h.py": "x = 1\n" } }] });
    expect(parseProposal(raw).ops[0]).toMatchObject({ op: "skill_upsert", name: "x" });
    expect(parseProposal(`Here:\n${raw}\nthanks`).ops[0]).toMatchObject({ op: "skill_upsert" });
    expect(parseProposal(`\`\`\`json\n${raw}\n\`\`\``).ops[0]).toMatchObject({ op: "skill_upsert" });
  });
});
