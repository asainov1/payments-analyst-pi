// Step 4 (Pi wiring): data tools exposed as Pi ToolDefinitions + batch-mode system prompt.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { AnswerSlot } from "../src/agent/submit.ts";
import { analystTools } from "../src/agent/tools.ts";
import { type DataDb, openDataDb } from "../src/data/db.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DATA = join(ROOT, "bundle", "data");
let db: DataDb;
beforeAll(async () => {
  db = await openDataDb(DATA);
});
afterAll(() => db?.close());

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const run = (tools: ReturnType<typeof analystTools>, name: string, params: unknown) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.execute("call-1", params as never, undefined, undefined, {} as never);
};

describe("analyst tools", () => {
  test("batch exposes sql, read_manual, submit_answer — and nothing that can ask the user", () => {
    const tools = analystTools({ db, dataDir: DATA, slot: new AnswerSlot("Answer must be just a number.") });
    expect(tools.map((t) => t.name).sort()).toEqual(["read_manual", "sql", "submit_answer"]);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(20);
  });

  test("python tool is added when a sandbox URL is configured", () => {
    const tools = analystTools({ db, dataDir: DATA, slot: new AnswerSlot("x"), python: { url: "http://127.0.0.1:7070", session: "s", version: "v000" } });
    expect(tools.map((t) => t.name).sort()).toEqual(["python", "read_manual", "sql", "submit_answer"]);
  });

  test("sql returns a markdown table; rejected statements surface as tool errors", async () => {
    const tools = analystTools({ db, dataDir: DATA, slot: new AnswerSlot("x") });
    expect(text(await run(tools, "sql", { query: "SELECT count(*) AS n FROM payments" }))).toContain("138236");
    await expect(run(tools, "sql", { query: "DROP TABLE payments" })).rejects.toThrow(/SELECT/);
  });

  test("read_manual by section", async () => {
    const tools = analystTools({ db, dataDir: DATA, slot: new AnswerSlot("x") });
    expect(text(await run(tools, "read_manual", { section: "Account Type" }))).toContain("Enterprise - Retail");
  });

  test("submit_answer validates through the slot and reports the expected format", async () => {
    const slot = new AnswerSlot("Answer must be just a number rounded to 2 decimals.");
    const tools = analystTools({ db, dataDir: DATA, slot });
    expect(text(await run(tools, "submit_answer", { answer: "about 3" }))).toMatch(/2 decimals/);
    expect(slot.result()).toBeNull();
    expect(JSON.parse(text(await run(tools, "submit_answer", { answer: "3.14", assumptions: ["2023 only"] })))).toEqual({ ok: true });
    expect(slot.result()).toMatchObject({ answer: "3.14", assumptions: ["2023 only"], valid: true });
  });
});

describe("batch-mode system prompt", () => {
  test("adds the no-clarification / always-submit rules, identical for every task", async () => {
    const v = join(ROOT, "versions", "v000");
    const a = await buildSystemPrompt({ versionDir: v, dataDir: DATA, db, mode: "batch" });
    const chat = await buildSystemPrompt({ versionDir: v, dataDir: DATA, db, mode: "chat" });
    expect(a).toMatch(/submit_answer/);
    expect(a).toMatch(/assumptions/);
    expect(chat).not.toMatch(/## Batch mode/);
    expect(a.startsWith(chat.slice(0, 1000))).toBe(true);
  });
});
