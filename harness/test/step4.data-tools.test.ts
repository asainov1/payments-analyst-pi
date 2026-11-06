// SPEC §6 step 4: sql + read_manual tools, DuckDB sealed from the filesystem, v000 prompt,
// agent sees only question + guidelines.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildSystemPrompt, taskToPrompt } from "../src/agent/prompt.ts";
import { type DataDb, openDataDb } from "../src/data/db.ts";
import { readManual } from "../src/data/manual.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DATA = join(ROOT, "bundle", "data");
const VAL = join(ROOT, "bundle", "tasks", "val.jsonl");
const V000 = join(ROOT, "versions", "v000");

let db: DataDb;
beforeAll(async () => {
  db = await openDataDb(DATA);
});
afterAll(() => db?.close());

describe("sql tool: data loaded", () => {
  test.each([
    ["payments", 138236],
    ["fees", 1000],
    ["merchants", 30],
    ["acquirer_countries", 8],
  ])("%s has %i rows", async (table, n) => {
    const r = await db.sql(`SELECT count(*) AS n FROM ${table}`);
    expect(r.rows[0].n).toBe(n);
  });

  test("mcc table has mcc + description, no pandas index column", async () => {
    const r = await db.sql("SELECT * FROM mcc LIMIT 1");
    expect(r.columns).toEqual(["mcc", "description"]);
  });

  test("fees keeps list columns as lists and null as 'any'", async () => {
    const r = await db.sql("SELECT account_type, aci, intracountry FROM fees WHERE ID = 1");
    expect(r.rows[0].account_type).toEqual([]);
    expect(r.rows[0].aci).toEqual(["C", "B"]);
    expect(r.rows[0].intracountry).toBeNull();
  });

  test("payments_m adds natural month 1..12 from day_of_year (2023)", async () => {
    const r = await db.sql("SELECT min(month) AS lo, max(month) AS hi FROM payments_m");
    expect(r.rows[0]).toEqual({ lo: 1, hi: 12 });
    const feb = await db.sql("SELECT min(day_of_year) AS d FROM payments_m WHERE month = 2");
    expect(feb.rows[0].d).toBe(32);
  });

  test("result is capped at 200 rows but row_count is exact", async () => {
    const r = await db.sql("SELECT psp_reference FROM payments");
    expect(r.rows.length).toBe(200);
    expect(r.row_count).toBe(138236);
    expect(r.markdown.split("\n").length).toBeLessThan(210);
  });

  test("long query is interrupted by timeout", async () => {
    await expect(
      db.sql("SELECT count(*) FROM payments a, payments b, payments c", { timeoutMs: 200 }),
    ).rejects.toThrow(/timeout|interrupt/i);
  });
});

describe("sql tool: sealed from filesystem and writes", () => {
  test.each([
    `SELECT * FROM read_json_auto('${VAL}')`,
    `SELECT * FROM read_csv('${join(DATA, "payments.csv")}')`,
    `SELECT * FROM '${VAL}'`,
    "SET enable_external_access = true",
    "DROP TABLE payments",
    "CREATE TABLE x AS SELECT 1",
    "SELECT 1; DROP TABLE payments",
  ])("rejects: %s", async (q) => {
    await expect(db.sql(q)).rejects.toThrow();
  });

  test("tables survive rejected statements", async () => {
    const r = await db.sql("SELECT count(*) AS n FROM payments");
    expect(r.rows[0].n).toBe(138236);
  });
});

describe("read_manual tool", () => {
  test("section by name", () => {
    const t = readManual(DATA, { section: "Account Type" });
    expect(t).toContain("| R            | Enterprise - Retail");
    expect(t).not.toContain("Merchant Category Code (MCC) is a four-digit");
  });
  test("grep returns matching lines with line numbers", () => {
    const t = readManual(DATA, { grep: "fraudulent volume" });
    expect(t).toMatch(/^\d+: .*fraudulent volume/m);
  });
  test("unknown section lists available sections", () => {
    const t = readManual(DATA, { section: "nope" });
    expect(t).toMatch(/Available sections/);
    expect(t).toContain("Understanding Payment Processing Fees");
  });
});

describe("v000 prompt", () => {
  test("cache-friendly order: instructions → manual → schema → playbook; deterministic", async () => {
    const a = await buildSystemPrompt({ versionDir: V000, dataDir: DATA, db });
    const b = await buildSystemPrompt({ versionDir: V000, dataDir: DATA, db });
    expect(a).toBe(b);
    const iManual = a.indexOf("# Merchant Guide to Optimizing Payment Processing");
    const iSchema = a.indexOf("## Data schema");
    const iPlaybook = a.indexOf("## Playbook");
    expect(0).toBeLessThan(iManual);
    expect(iManual).toBeLessThan(iSchema);
    expect(iSchema).toBeLessThan(iPlaybook);
    expect(a).toContain("payments_m");
    expect(a).not.toMatch(/tasks\/|val\.jsonl|train\.jsonl/);
  });

  test("agent sees only question + guidelines, never the answer", () => {
    const task = { task_id: "x1", question: "Q?", guidelines: "Answer must be a number.", level: "easy", answer: "SECRET_42" };
    const p = taskToPrompt(task);
    expect(p).toContain("Q?");
    expect(p).toContain("Answer must be a number.");
    expect(p).not.toContain("SECRET_42");
    expect(p).not.toContain("x1");
  });
});
