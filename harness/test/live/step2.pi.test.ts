// Live: Pi session → in-process proxy → LiteLLM, Haiku only, budget-capped at $0.05 (SPEC §6 step 2).
// Run: npm run test:live
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openDb } from "../../src/db/db.ts";
import { resolveModelConfig } from "../../src/llm/model-config.ts";
import { createPiRuntime, createPiSession, type PiRuntime } from "../../src/llm/pi.ts";
import { loadPrices } from "../../src/llm/prices.ts";
import { LlmProxy, type LlmUsageEvent } from "../../src/llm/proxy.ts";
import { BudgetLedger } from "../../src/runtime/budget.ts";
import { Governor } from "../../src/runtime/governor.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const prices = loadPrices(join(ROOT, "config", "prices.json"));
const CAP = 0.05;
const dir = mkdtempSync(join(tmpdir(), "live-pi-"));
const ledger = new BudgetLedger(openDb(join(dir, "harness.db")), { capUsd: CAP });
const governor = new Governor({ ledger, concurrency: 2, rpm: 30 });
const proxy = new LlmProxy({ upstream: process.env.LITELLM_BASE_URL ?? "", apiKey: process.env.LITELLM_API_KEY ?? "", governor, prices });
const usageEvents: LlmUsageEvent[] = [];
proxy.on("usage", (e) => usageEvents.push(e));
let rt: PiRuntime;

// ~18k-token stable prefix so the system prompt is cacheable.
const SYSTEM = [
  "You are a test assistant. When asked for a code, call the lookup_code tool and answer with the code only.",
  ...Array.from({ length: 400 }, (_, i) => `Rule ${i}: a fee rule applies when card_scheme, account_type and aci match; fee = fixed + rate * amount / 10000.`),
].join("\n");

const lookupCode = defineTool({
  name: "lookup_code",
  label: "Lookup code",
  description: "Returns the secret code for a name.",
  parameters: Type.Object({ name: Type.String() }),
  async execute() {
    return { content: [{ type: "text", text: "4711" }], details: {} };
  },
});

const model = resolveModelConfig(prices, { model: "claude-haiku-5-5", thinking: "off", limits: { max_output_tokens: 1024 } });
const newSession = (ref: string) =>
  createPiSession(rt, { ref, scope: "probe", model, systemPrompt: SYSTEM, tools: [lookupCode], compaction: false, cwd: dir });

before(async () => {
  assert.ok(process.env.LITELLM_API_KEY, "LITELLM_API_KEY missing (.env)");
  const proxyUrl = await proxy.start();
  rt = await createPiRuntime({ proxyUrl, prices, stateDir: dir });
});
after(() => proxy.stop());

test("Pi via proxy: tool call, cache read, ledger matches Pi cost", async () => {
  const a = await newSession("live-a");
  const tools: string[] = [];
  const piUsage: Array<{ cacheRead: number; cacheWrite: number; input: number; output: number; cost: { total: number } }> = [];
  let text = "";
  a.subscribe((e: any) => {
    if (e.type === "tool_execution_start") tools.push(`start:${e.toolName}`);
    if (e.type === "tool_execution_end") tools.push(`end:${e.toolName}:${e.isError ? "err" : "ok"}`);
    if (e.type === "message_end" && e.message?.role === "assistant") {
      piUsage.push(e.message.usage);
      text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    }
  });
  await a.prompt("Use lookup_code with name 'alpha' and reply with the code only.");
  const afterTurn1 = text;
  await a.prompt("Reply with just: done");
  a.dispose();

  // Second, independent session with the same system prompt — what batch fan-out relies on.
  const b = await newSession("live-b");
  let bUsage: any = null;
  b.subscribe((e: any) => {
    if (e.type === "message_end" && e.message?.role === "assistant" && !bUsage) bUsage = e.message.usage;
  });
  await b.prompt("Reply with just: ok");
  b.dispose();

  console.table(usageEvents.map((e) => ({ ref: e.ref, in: e.usage.input, out: e.usage.output, cr: e.usage.cacheRead, cw: e.usage.cacheWrite, usd: e.costUsd.toFixed(6), src: e.costSource, hdr: e.providerCostUsd, ms: e.ms })));

  assert.deepEqual(tools, ["start:lookup_code", "end:lookup_code:ok"]);
  assert.match(afterTurn1, /4711/);
  assert.ok(piUsage.slice(1).some((u) => u.cacheRead > 0), "a later call in session A must read the cached prefix");
  assert.ok(bUsage && bUsage.cacheRead > 0, "a new session with the same system prompt must hit the cache");

  // Every Pi LLM call went through the proxy and is in the ledger, attributed.
  const aEvents = usageEvents.filter((e) => e.ref === "live-a");
  assert.equal(aEvents.length, piUsage.length);
  assert.ok(usageEvents.every((e) => !e.aborted && !e.estimated && e.status === 200));
  const piTotal = piUsage.reduce((s, u) => s + u.cost.total, 0);
  const ledgerA = ledger.spentUsd("live-a");
  assert.ok(Math.abs(ledgerA - piTotal) <= piTotal * 0.01, `ledger ${ledgerA} vs Pi ${piTotal}`);
  for (const e of usageEvents.filter((x) => x.providerCostUsd !== null && x.costSource === "usage")) {
    console.log(`header vs usage: ${e.providerCostUsd} vs ${e.costUsd.toFixed(8)}`);
  }
  assert.ok(ledger.spentUsd() < CAP);
  console.log(`total spent: $${ledger.spentUsd().toFixed(5)}`);
});
