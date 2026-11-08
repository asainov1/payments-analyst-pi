// SPEC §6 step 14: chat sessions API + SSE (§4.1, §4.2), multi-turn, ask_user, busy/abort.
// A fake Pi session stands in for the model; no LLM spend.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../src/api/server.ts";
import { ChatService, type ChatSessionFactory, type ChatSessionLike } from "../src/chat/service.ts";
import { openDb } from "../src/db/db.ts";
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
let made: FakeSession[];
let script: Script;
let lastMemory: string[] = [];

beforeEach(async () => {
  bus = new EventEmitter();
  made = [];
  script = async (s, text) => {
    await s.callTool("sql", { query: "SELECT 1" });
    s.usage(0.01);
    s.say(`answer to: ${text}`);
  };
  const factory: ChatSessionFactory = async (o) => {
    lastMemory = o.memory;
    const s = new FakeSession(o.tools, o.ref, (x, t) => script(x, t), bus);
    made.push(s);
    return s;
  };
  const sqlTool = { name: "sql", label: "sql", description: "fake sql", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "| 1 |" }], details: {} }) } as unknown as ToolDefinition;
  const chat = new ChatService({
    db: openDb(join(mkdtempSync(join(tmpdir(), "chat-")), "h.db")),
    repoRoot: join(import.meta.dirname, "..", ".."),
    factory,
    baseTools: () => [sqlTool],
    onUsage: (fn) => {
      bus.on("usage", fn);
      return () => bus.off("usage", fn);
    },
  });
  app = buildServer({ chat });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});
afterEach(() => app.close());

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Reads an SSE response into [{event, data}] until the stream closes. */
async function sse(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("event:"))
    .map((b) => ({
      event: /event: (.*)/.exec(b)?.[1] ?? "",
      data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? "null"),
    }));
}

const newSession = async (version?: string) => (await (await post("/api/sessions", version ? { version } : {})).json()) as { session_id: string; version: string };

describe("sessions", () => {
  test("create → 201 with resolved version; unknown version → 422", async () => {
    const r = await post("/api/sessions", {});
    expect(r.status).toBe(201);
    expect((await r.json()).version).toBe(readFileSync(join(import.meta.dirname, "..", "..", "versions", "BEST"), "utf8").trim());
    expect((await post("/api/sessions", { version: "v999" })).status).toBe(422);
  });

  test("turn streams SSE in order: turn.start → tool.start/end → llm.usage → text.delta… → turn.end", async () => {
    const { session_id } = await newSession();
    const res = await post(`/api/sessions/${session_id}/turns`, { message: "how many payments?" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const ev = await sse(res);
    const types = ev.map((e) => e.event);
    expect(types[0]).toBe("turn.start");
    expect(types.at(-1)).toBe("turn.end");
    expect(types).toContain("tool.start");
    expect(types).toContain("tool.end");
    expect(types).toContain("llm.usage");
    expect(ev.filter((e) => e.event === "text.delta").map((e) => e.data.delta).join("")).toBe("answer to: how many payments?");
    const end = ev.at(-1)?.data;
    expect(end.outcome).toBe("answered");
    expect(end.usage.cost_usd).toBeCloseTo(0.01);
    expect(end.cache_hit_rate).toBeCloseTo(0.9);
    expect(ev[0].data.turn_id).toBe(end.turn_id);
    expect(ev.find((e) => e.event === "tool.end")?.data.preview).toContain("| 1 |");
  });

  test("multi-turn: the same Pi session gets both messages; usage attributed per turn", async () => {
    const { session_id } = await newSession();
    await sse(await post(`/api/sessions/${session_id}/turns`, { message: "first" }));
    await sse(await post(`/api/sessions/${session_id}/turns`, { message: "now split that by card scheme" }));
    expect(made).toHaveLength(1);
    expect(made[0].prompts).toEqual(["first", "now split that by card scheme"]);
    const s = (await (await fetch(`${base}/api/sessions/${session_id}`)).json()) as {
      turns: Array<{ idx: number; outcome: string; answer: string; usage: { cost_usd: number; tool_calls: number } }>;
    };
    expect(s.turns.map((t) => t.idx)).toEqual([0, 1]);
    expect(s.turns.every((t) => t.outcome === "answered" && t.usage.cost_usd > 0 && t.usage.tool_calls === 1)).toBe(true);
    expect(s.turns[1].answer).toBe("answer to: now split that by card scheme");
  });

  test("ask_user ends the turn as a clarification; the next message answers it in the same session", async () => {
    script = async (s, text) => {
      if (text === "what's the fee?") {
        await s.callTool("ask_user", { question: "Which merchant and card scheme?", options: ["Crossfit_Hanna", "Rafa_AI"] });
        return;
      }
      s.say("fee for Crossfit_Hanna is 0.12");
    };
    const { session_id } = await newSession();
    const ev = await sse(await post(`/api/sessions/${session_id}/turns`, { message: "what's the fee?" }));
    const clar = ev.find((e) => e.event === "clarification");
    expect(clar?.data.question).toBe("Which merchant and card scheme?");
    expect(ev.at(-1)?.data.outcome).toBe("clarification");
    const ev2 = await sse(await post(`/api/sessions/${session_id}/turns`, { message: "Crossfit_Hanna, GlobalCard" }));
    expect(ev2.at(-1)?.data.outcome).toBe("answered");
    expect(made).toHaveLength(1);
  });

  test("ask_user tool result terminates the Pi turn (no extra LLM call)", async () => {
    let terminate: unknown;
    script = async (s) => {
      terminate = (await s.callTool("ask_user", { question: "Which year?" })).terminate;
    };
    const { session_id } = await newSession();
    await sse(await post(`/api/sessions/${session_id}/turns`, { message: "x" }));
    expect(terminate).toBe(true);
  });

  test("second turn while one is running → 409 session_busy; abort stops it", async () => {
    let release: () => void = () => {};
    script = (s) =>
      new Promise<void>((r) => {
        release = () => {
          s.say("late");
          r();
        };
      });
    const { session_id } = await newSession();
    const first = post(`/api/sessions/${session_id}/turns`, { message: "slow" });
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post(`/api/sessions/${session_id}/turns`, { message: "again" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe("session_busy");
    expect((await post(`/api/sessions/${session_id}/abort`, {})).status).toBe(202);
    expect(made[0].aborted).toBe(true);
    release();
    const ev = await sse(await first);
    expect(ev.at(-1)?.data.outcome).toBe("aborted");
  });

  test("unknown session → 404; empty message → 400", async () => {
    expect((await post("/api/sessions/nope/turns", { message: "x" })).status).toBe(404);
    const { session_id } = await newSession();
    expect((await post(`/api/sessions/${session_id}/turns`, { message: "" })).status).toBe(400);
  });
});

describe("memory across page reloads and sessions", () => {
  test("GET /api/sessions lists chats with turns (newest first, title = first message); empty chats are hidden", async () => {
    const a = await newSession();
    await sse(await post(`/api/sessions/${a.session_id}/turns`, { message: "first chat" }));
    await newSession(); // no turns → not listed
    const b = await newSession();
    await sse(await post(`/api/sessions/${b.session_id}/turns`, { message: "second chat" }));
    await sse(await post(`/api/sessions/${b.session_id}/turns`, { message: "follow-up" }));
    const r = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ id: string; title: string; turns: number }> };
    expect(r.sessions.map((s) => [s.id, s.title, s.turns])).toEqual([
      [b.session_id, "second chat", 2],
      [a.session_id, "first chat", 1],
    ]);
  });

  test("remember tool → stored once, listed, passed to the next session's factory; DELETE forgets", async () => {
    script = async (s, text) => {
      await s.callTool("remember", { fact: "  User works on   Crossfit_Hanna " });
      await s.callTool("remember", { fact: "user works on crossfit_hanna" }); // duplicate, case-insensitive
      s.say(`ok: ${text}`);
    };
    const a = await newSession();
    const ev = await sse(await post(`/api/sessions/${a.session_id}/turns`, { message: "I work on Crossfit_Hanna" }));
    expect(ev.filter((e) => e.event === "tool.end").map((e) => e.data.preview)).toEqual([
      "Saved to long-term memory: User works on Crossfit_Hanna",
      "Saved to long-term memory: User works on Crossfit_Hanna",
    ]);
    const mems = ((await (await fetch(`${base}/api/memories`)).json()) as { memories: Array<{ id: string; text: string; session_id: string }> }).memories;
    expect(mems.map((m) => [m.text, m.session_id])).toEqual([["User works on Crossfit_Hanna", a.session_id]]);

    const prev = made.length;
    script = async (s, text) => s.say(`hi ${text}`);
    const b = await newSession();
    await sse(await post(`/api/sessions/${b.session_id}/turns`, { message: "hello" }));
    expect(made.length).toBe(prev + 1);
    expect(lastMemory).toEqual(["User works on Crossfit_Hanna"]);

    expect((await fetch(`${base}/api/memories/${mems[0].id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/api/memories/${mems[0].id}`, { method: "DELETE" })).status).toBe(404);
    expect(((await (await fetch(`${base}/api/memories`)).json()) as { memories: unknown[] }).memories).toEqual([]);
  });

  test("POST /api/memories adds a memory by hand; empty or too long → 400; the tool reports a refusal instead of failing", async () => {
    expect((await post("/api/memories", { text: "Amounts in EUR thousands" })).status).toBe(201);
    expect((await post("/api/memories", { text: "" })).status).toBe(400);
    expect((await post("/api/memories", { text: "x".repeat(301) })).status).toBe(400);
    script = async (s) => {
      await s.callTool("remember", { fact: "y".repeat(400) });
      s.say("done");
    };
    const a = await newSession();
    const ev = await sse(await post(`/api/sessions/${a.session_id}/turns`, { message: "remember this" }));
    expect(ev.find((e) => e.event === "tool.end")?.data.preview).toMatch(/^Not saved: memory longer than 300/);
    expect(ev.at(-1)?.data.outcome).toBe("answered");
  });

  test("Pi restores a chat from its JSONL session file (what the factory opens after a restart)", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const file = join(mkdtempSync(join(tmpdir(), "pi-sess-")), "s1.jsonl");
    const sm = SessionManager.open(file, undefined, tmpdir());
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "fraud rate of Crossfit_Hanna?" }], timestamp: Date.now() });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "9.1%" }], api: "anthropic-messages", provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
    const reopened = SessionManager.open(file, undefined, tmpdir());
    const msgs = reopened.buildSessionContext().messages as Array<{ role: string; content: Array<{ text?: string }> }>;
    expect(msgs.map((m) => [m.role, m.content[0]?.text])).toEqual([
      ["user", "fraud rate of Crossfit_Hanna?"],
      ["assistant", "9.1%"],
    ]);
  });
});

test("chat system prompt carries long-term memory; batch prompt does not", async () => {
  const { buildSystemPrompt } = await import("../src/agent/prompt.ts");
  const root = join(import.meta.dirname, "..", "..");
  const db = { schema: async () => "- payments(x INTEGER)" } as never;
  const versionDir = join(root, "versions", "v012");
  const dataDir = join(root, "bundle", "data");
  const chat = await buildSystemPrompt({ versionDir, dataDir, db, mode: "chat", memory: ["User works on Crossfit_Hanna"] });
  expect(chat).toContain("## Long-term memory");
  expect(chat).toContain("- User works on Crossfit_Hanna");
  expect(await buildSystemPrompt({ versionDir, dataDir, db, mode: "chat" })).toContain("## Long-term memory\n\n(empty)");
  expect(await buildSystemPrompt({ versionDir, dataDir, db, mode: "batch", memory: ["x"] })).not.toContain("Long-term memory");
});

describe("provider errors surface as error turns", () => {
  test("assistant message with stopReason=error (e.g. expired key 401) → outcome error + error event, not an empty 'answered'", async () => {
    script = async (s) => {
      s.emit({ type: "message_start", message: { role: "assistant" } });
      s.emit({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Authentication Error - Expired Key", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
      });
    };
    const { session_id } = await newSession();
    const ev = await sse(await post(`/api/sessions/${session_id}/turns`, { message: "fraud rate?" }));
    const err = ev.find((e) => e.event === "error");
    expect(err?.data.code).toBe("llm_error");
    expect(err?.data.message).toContain("Expired Key");
    expect(ev.find((e) => e.event === "turn.end")?.data.outcome).toBe("error");
  });

  test("turn that ends with no answer text and no clarification → outcome error (empty_answer)", async () => {
    script = async () => {};
    const { session_id } = await newSession();
    const ev = await sse(await post(`/api/sessions/${session_id}/turns`, { message: "hi" }));
    expect(ev.find((e) => e.event === "error")?.data.code).toBe("empty_answer");
    expect(ev.find((e) => e.event === "turn.end")?.data.outcome).toBe("error");
  });
});
