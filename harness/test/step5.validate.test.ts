// SPEC §6 step 5: guidelines → answer format, validator, submit_answer slot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AnswerSlot } from "../src/agent/submit.ts";
import { parseFormat, validateAnswer } from "../src/agent/validate.ts";

const TASKS = join(import.meta.dirname, "..", "..", "bundle", "tasks");
const gold = ["train.jsonl", "val.jsonl"].flatMap((f) =>
  readFileSync(join(TASKS, f), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { task_id: string; guidelines: string; answer: string }),
);

const G = {
  num6: "Answer must be just a number rounded to 6 decimals. If a question does not have a relevant or applicable answer for the task, please respond with 'Not Applicable'",
  list: "Answer must be a list of values in comma separated list, eg: A, B, C. If the answer is an empty list, reply with an empty string. If a question does not have a relevant or applicable answer for the task, please respond with 'Not Applicable'",
  grouped: gold.find((t) => t.guidelines.startsWith("Present your results broken down by grouping"))?.guidelines ?? "",
  scheme: "Answer must be just the name of the card scheme. If a question does not have a relevant or applicable answer for the task, please respond with 'Not Applicable'",
  yesno: "Answer must be just either yes or no. If a question does not have a relevant or applicable answer for the task, please respond with 'Not Applicable'.",
  number: "Answer must be just a number. If a question does not have a relevant or applicable answer for the task, please respond with 'Not Applicable'.",
  option: "Answer must be in the form 'X. Y' where X is the option's letter chosen and Y is the option's country code. If a question does not have a relevant or applicable answer for the task, please respond with 'Not Applicable'.",
  country: "Answer must be just the country code. If a question does not have a relevant or applicable answer for the task, please respond with 'Not Applicable'.",
};

describe("validator accepts every gold answer in its own guidelines", () => {
  test(`all ${gold.length} train+val gold answers are valid`, () => {
    const bad = gold.filter((t) => !validateAnswer(t.answer, parseFormat(t.guidelines)).ok);
    expect(bad.map((t) => `${t.task_id}: ${JSON.stringify(t.answer)} | ${t.guidelines.slice(0, 60)}`)).toEqual([]);
    expect(gold.length).toBe(277);
  });

  test("no gold guideline falls back to the unchecked 'free' format", () => {
    const free = gold.filter((t) => parseFormat(t.guidelines).kind === "free");
    expect(free.map((t) => t.guidelines.slice(0, 80))).toEqual([]);
  });
});

describe("validator rejects malformed answers", () => {
  test.each([
    [G.num6, "27.2504791", "more decimals than allowed"],
    [G.num6, "27.250479 EUR", "unit suffix"],
    [G.list, "[64, 394]", "brackets around plain list"],
    [G.list, "The fees are 64, 394", "prose in list"],
    [G.grouped, "[B: 2.00, A: 1.00]", "not sorted ascending by amount"],
    [G.grouped, "[A: 1.0, B: 2.0]", "amounts not 2 decimals"],
    [G.scheme, "The cheapest is GlobalCard", "sentence instead of name"],
    [G.yesno, "Yes, it is", "not just yes/no"],
    [G.number, "about 5", "prose number"],
    [G.number, "", "empty for a number"],
    [G.option, "B", "missing ' Y' part"],
    [G.country, "Netherlands", "not a country code"],
  ])("%#: %s ← %j (%s)", (g, answer) => {
    const r = validateAnswer(answer, parseFormat(g));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  test("'Not Applicable' is always accepted; empty string only where the guidelines allow it", () => {
    for (const g of Object.values(G)) expect(validateAnswer("Not Applicable", parseFormat(g)).ok).toBe(true);
    expect(validateAnswer("", parseFormat(G.list)).ok).toBe(true);
    expect(validateAnswer("", parseFormat(G.num6)).ok).toBe(false);
  });

  test("yes/no is case-insensitive and surrounding whitespace is ignored", () => {
    expect(validateAnswer(" Yes ", parseFormat(G.yesno)).ok).toBe(true);
  });
});

describe("submit_answer slot", () => {
  test("valid answer is accepted and stored with assumptions", () => {
    const s = new AnswerSlot(G.num6);
    expect(s.submit({ answer: "1.000000", assumptions: ["used 2023"] })).toEqual({ ok: true });
    expect(s.result()).toEqual({ answer: "1.000000", assumptions: ["used 2023"], valid: true, attempts: 1 });
  });

  test("invalid answer returns reason + expected format, then is force-accepted after 3 tries", () => {
    const s = new AnswerSlot(G.num6);
    for (let i = 0; i < 3; i++) {
      const r = s.submit({ answer: "1.5 EUR" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.expected_format).toMatch(/6 decimals/);
        expect(r.attempts_left).toBe(2 - i);
      }
    }
    expect(s.submit({ answer: "1.5 EUR" })).toEqual({ ok: true, warning: "accepted without passing format validation" });
    expect(s.result()).toMatchObject({ answer: "1.5 EUR", valid: false, attempts: 4 });
  });

  test("no submission → result() is null", () => {
    expect(new AnswerSlot(G.num6).result()).toBeNull();
  });
});
