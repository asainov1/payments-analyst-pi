// SPEC §6 step 18 / ASSIGNMENT §5.1: MCP over Streamable HTTP — a real MCP SDK client against /mcp.
// Same fake Pi session as the chat API tests; no LLM spend.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../src/api/server.ts";
import { ChatService, type ChatSessionFactory, type ChatSessionLike } from "../src/chat/service.ts";
import { type Db, openDb } from "../src/db/db.ts";
import type { LlmUsageEvent } from "../src/llm/proxy.ts";

type Script = (s: FakeSession, text: string) => Promise<void>;

class FakeSession implements ChatSessionLike {
  readonly prompts: string[] = [];
  aborted = false;
  private ls: Array<(e: any) => void> = [];
  readonly tools: ToolDefinition[];
  readonly ref: () => string;
  private readonly script: Script;
  private readonly bus: EventEmitter;
  constructor(tools: ToolDefinition[], ref: () => string, script: Script, bus: EventEmitter) {
    this.tools = tools;
    this.ref = ref;
    this.script = script;
    this.bus = bus;
  }
  subscribe(l: (e: any) => void) {
    this.ls.push(l);
    return () => {
      this.ls = this.ls.filter((x) => x !== l);
    };
  }
  emit(e: any) {
    for (const l of this.ls) l(e);
  }
  usage(cost: number) {
    const ev: LlmUsageEvent = { ref: this.ref(), scope: "chat", model: "m", status: 200, usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0 }, costUsd: cost, costSource: "usage", providerCostUsd: null, aborted: false, estimated: false, ms: 5 };
    this.bus.emit("usage", ev);
  }
  async callTool(name: string, args: unknown) {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    this.emit({ type: "tool_execution_start", toolCallId: name, toolName: name, args });
    const r = await t.execute(name, args as never, undefined, undefined, {} as never);
    this.emit({ type: "tool_execution_end", toolCallId: name, toolName: name, result: r, isError: false });
    return r;
  }
  say(text: string) {
    this.emit({ type: "message_start", message: { role: "assistant" } });
    for (const ch of text.match(/.{1,4}/g) ?? []) this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch } });
    this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
  }
  async prompt(text: string) {
    this.prompts.push(text);
    await this.script(this, text);
  }
  async abort() {
    this.aborted = true;
  }
  dispose() {}
}

let app: FastifyInstance;
let base = "";
let bus: EventEmitter;
let db: Db;
let script: Script;

beforeEach(async () => {
  bus = new EventEmitter();
  script = async (s, text) => {
    await s.callTool("sql", { query: "SELECT 1" });
    s.usage(0.01);
    s.say(`answer to: ${text}`);
  };
  const factory: ChatSessionFactory = async (o) => new FakeSession(o.tools, o.ref, (x, t) => script(x, t), bus);
  const sqlTool = { name: "sql", label: "sql", description: "fake sql", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "| 1 |" }], details: {} }) } as unknown as ToolDefinition;
  db = openDb(join(mkdtempSync(join(tmpdir(), "mcp-")), "h.db"));
  const chat = new ChatService({
    db,
    repoRoot: join(import.meta.dirname, "..", ".."),
    factory,
    baseTools: () => [sqlTool],
    onUsage: (fn) => {
      bus.on("usage", fn);
      return () => bus.off("usage", fn);
    },
  });
  app = buildServer({ chat, db });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});
afterEach(() => app.close());

async function client() {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { ...JSON.parse(r.content[0].text), isError: r.isError };
};

describe("mcp", () => {
  test("lists ask / feedback / list_versions", async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask", "feedback", "list_versions"]);
    await c.close();
  });

  test("ask → answered with cost, version and an mcp-origin session; follow-up keeps the session", async () => {
    const c = await client();
    const a = await call(c, "ask", { question: "how many payments?" });
    expect(a.status).toBe("answered");
    expect(a.answer).toBe("answer to: how many payments?");
    expect(a.cost_usd).toBeCloseTo(0.01);
    expect(a.version).toBe(readFileSync(join(import.meta.dirname, "..", "..", "versions", "BEST"), "utf8").trim());
    expect(a.turn_id).toBeTruthy();
    expect((db.prepare("SELECT origin FROM sessions WHERE id = ?").get(a.session_id) as { origin: string }).origin).toBe("mcp");

    const b = await call(c, "ask", { question: "now by scheme", session_id: a.session_id });
    expect(b.session_id).toBe(a.session_id);
    expect((db.prepare("SELECT COUNT(*) n FROM turns WHERE session_id = ?").get(a.session_id) as { n: number }).n).toBe(2);
    await c.close();
  });

  test("clarification round-trip: needs_clarification → answer it with the same session_id", async () => {
    script = async (s, text) => {
      if (text === "what's the fee?") await s.callTool("ask_user", { question: "Which merchant?", options: ["Crossfit_Hanna", "Rafa_AI"] });
      else s.say(`fee for ${text}`);
    };
    const c = await client();
    const q = await call(c, "ask", { question: "what's the fee?" });
    expect(q.status).toBe("needs_clarification");
    expect(q.clarification_question).toBe("Which merchant?");
    expect(q.clarification_options).toEqual(["Crossfit_Hanna", "Rafa_AI"]);
    const r = await call(c, "ask", { question: "Crossfit_Hanna", session_id: q.session_id });
    expect(r.status).toBe("answered");
    expect(r.answer).toBe("fee for Crossfit_Hanna");
    await c.close();
  });

  test("feedback is stored for the improver; unknown turn / session → isError", async () => {
    const c = await client();
    const a = await call(c, "ask", { question: "q" });
    const f = await call(c, "feedback", { turn_id: a.turn_id, rating: "down", comment: "wrong merchant" });
    expect(f.ok).toBe(true);
    expect(db.prepare("SELECT rating, comment FROM feedback WHERE turn_id = ?").get(a.turn_id)).toEqual({ rating: "down", comment: "wrong merchant" });
    expect((await call(c, "feedback", { turn_id: "nope", rating: "up" })).isError).toBe(true);
    expect((await call(c, "ask", { question: "q", session_id: "nope" })).isError).toBe(true);
    await c.close();
  });

  test("GET /mcp → 405 (stateless server)", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});
