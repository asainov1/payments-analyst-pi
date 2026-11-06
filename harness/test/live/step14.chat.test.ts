// Live (SPEC §6 step 14, A6/A7): chat over HTTP + SSE with the real Pi session on v000 (Haiku).
// Own temp STATE_DIR so it never touches a running batch's state DB. ≈ $0.01.
// Run: node --env-file=../.env --test test/live/step14.chat.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.ts";
import { ChatService } from "../../src/chat/service.ts";
import { type AppRuntime, createRuntime } from "../../src/runtime/app.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
let app: AppRuntime;
let server: FastifyInstance;
let base = "";

before(async () => {
  app = await createRuntime({ repoRoot: ROOT, stateDir: mkdtempSync(join(tmpdir(), "chat-live-")) });
  const chat = new ChatService({ db: app.db, repoRoot: ROOT, factory: app.chatFactory, baseTools: app.chatTools, onUsage: app.onUsage, tracing: app.tracing });
  server = buildServer({ chat });
  base = await server.listen({ port: 0, host: "127.0.0.1" });
});
after(async () => {
  await server.close();
  await app.close();
});

const post = (p: string, b: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
async function turn(sid: string, message: string) {
  const text = await (await post(`/api/sessions/${sid}/turns`, { message })).text();
  const ev = text
    .split("\n\n")
    .filter((b) => b.includes("event:"))
    .map((b) => ({ event: /event: (.*)/.exec(b)?.[1] ?? "", data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? "null") }));
  const answer = ev.filter((e) => e.event === "text.delta").map((e) => e.data.delta).join("");
  const end = ev.at(-1)?.data;
  const tools = ev.filter((e) => e.event === "tool.start").map((e) => e.data.tool);
  console.log(`\n> ${message}\n< [${end?.outcome}] tools=${tools.join(",")} $${end?.usage?.cost_usd?.toFixed(5)} cache=${(end?.cache_hit_rate * 100).toFixed(0)}% ${end?.trace_url}\n${answer.slice(0, 400)}`);
  return { ev, answer, end, tools, clarification: ev.find((e) => e.event === "clarification")?.data };
}

test("multi-turn follow-up and clarification over SSE", async () => {
  const { session_id } = (await (await post("/api/sessions", {})).json()) as { session_id: string };
  const t1 = await turn(session_id, "How many transactions did Crossfit_Hanna have in 2023?");
  assert.equal(t1.end.outcome, "answered");
  assert.ok(t1.tools.length > 0, "used a data tool");
  assert.match(t1.answer, /55[,.\s]?139/);

  const t2 = await turn(session_id, "Now split that by card scheme.");
  assert.equal(t2.end.outcome, "answered");
  assert.match(t2.answer, /GlobalCard/);
  assert.match(t2.answer, /NexPay/);

  const { session_id: s2 } = (await (await post("/api/sessions", {})).json()) as { session_id: string };
  const t3 = await turn(s2, "What's the fee?");
  assert.equal(t3.end.outcome, "clarification");
  assert.ok(t3.clarification?.question, "asked a clarifying question");

  assert.ok(app.ledger.spentUsd() < 0.1);
  console.log(`\ntotal: $${app.ledger.spentUsd().toFixed(4)}`);
});
