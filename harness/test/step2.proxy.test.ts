// SPEC §6 step 2 (unit part): in-process LLM proxy between Pi and LiteLLM, against a fake upstream.
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { openDb } from "../src/db/db.ts";
import { resolveModelConfig } from "../src/llm/model-config.ts";
import { costUsd, loadPrices } from "../src/llm/prices.ts";
import { LlmProxy, type LlmUsageEvent } from "../src/llm/proxy.ts";
import { BudgetLedger } from "../src/runtime/budget.ts";
import { Governor } from "../src/runtime/governor.ts";

const PRICES = loadPrices(join(import.meta.dirname, "..", "..", "config", "prices.json"));
const HAIKU = "claude-haiku-5-5";
const USAGE = { input: 100, output: 20, cacheRead: 5000, cacheWrite: 300 };
const USAGE_COST = costUsd(PRICES[HAIKU], USAGE);

// ---------- fake upstream ----------
type Mode = "sse" | "json" | "slow-sse" | "429-then-sse" | "openai-sse";
let mode: Mode = "sse";
let costHeader: string | null = null;
const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: any }> = [];
let upstreamClosedAt: number | null = null;
let upstream: Server;
let upstreamUrl = "";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const msgStart = sse("message_start", {
  type: "message_start",
  message: { id: "m1", usage: { input_tokens: USAGE.input, output_tokens: 1, cache_read_input_tokens: USAGE.cacheRead, cache_creation_input_tokens: USAGE.cacheWrite } },
});
const textDelta = (t: string) => sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
const msgDelta = sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: USAGE.output } });
const msgStop = sse("message_stop", { type: "message_stop" });

function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  seen.push({ url: req.url ?? "", headers: req.headers, body: body ? JSON.parse(body) : null });
  const h: Record<string, string> = {};
  if (costHeader) h["x-litellm-response-cost"] = costHeader;
  if (mode === "429-then-sse" && seen.length === 1) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" }).end('{"error":"rate"}');
    return;
  }
  if (mode === "json") {
    res.writeHead(200, { "content-type": "application/json", ...h });
    res.end(JSON.stringify({ id: "m1", content: [{ type: "text", text: "hi" }], usage: { input_tokens: USAGE.input, output_tokens: USAGE.output, cache_read_input_tokens: USAGE.cacheRead, cache_creation_input_tokens: USAGE.cacheWrite } }));
    return;
  }
  if (mode === "openai-sse") {
    res.writeHead(200, { "content-type": "text/event-stream", ...h });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: USAGE.input + USAGE.cacheRead, completion_tokens: USAGE.output, prompt_tokens_details: { cached_tokens: USAGE.cacheRead } } })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", ...h });
  if (mode === "slow-sse") {
    res.write(msgStart);
    const t = setInterval(() => res.write(textDelta("xxxxxxxx")), 20);
    res.on("close", () => {
      clearInterval(t);
      upstreamClosedAt = Date.now();
    });
    return;
  }
  res.write(msgStart);
  res.write(textDelta("hello"));
  res.write(msgDelta);
  res.end(msgStop);
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => upstream.close());

// ---------- proxy under test ----------
let proxy: LlmProxy;
let ledger: BudgetLedger;
let proxyUrl = "";
const events: LlmUsageEvent[] = [];

async function start(capUsd = 10) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "proxy-")), "harness.db"));
  ledger = new BudgetLedger(db, { capUsd });
  const governor = new Governor({ ledger, concurrency: 4, rpm: 1000, sleep: async () => {} });
  proxy = new LlmProxy({ upstream: upstreamUrl, apiKey: "REAL-KEY", governor, prices: PRICES });
  proxy.on("usage", (e) => events.push(e));
  proxyUrl = await proxy.start();
}

afterEach(async () => {
  await proxy?.stop();
  seen.length = 0;
  events.length = 0;
  mode = "sse";
  costHeader = null;
  upstreamClosedAt = null;
});

const HARNESS = { "x-harness-ref": "run-1", "x-harness-scope": "solve", "x-harness-max-tokens": "8192" };
const call = (body: object, headers: Record<string, string> = HARNESS, signal?: AbortSignal, path = "/v1/messages") =>
  fetch(`${proxyUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "pi-dummy", "user-agent": "pi/1.5.0", ...headers },
    body: JSON.stringify(body),
    signal,
  });
const BODY = { model: HAIKU, max_tokens: 4096, stream: true, messages: [{ role: "user", content: "hi" }] };

const rows = () =>
  (ledger as unknown as { db: { prepare(s: string): { all(): any[] } } }).db.prepare("SELECT * FROM ledger ORDER BY id").all();

describe("forwarding", () => {
  test("listens on loopback only, swaps auth, strips harness/UA headers, streams through", async () => {
    await start();
    expect(new URL(proxyUrl).hostname).toBe("127.0.0.1");
    const res = await call(BODY);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello");
    const h = seen[0].headers;
    expect(h["x-api-key"]).toBe("REAL-KEY");
    expect(h.authorization).toBe("Bearer REAL-KEY");
    expect(Object.keys(h).filter((k) => k.startsWith("x-harness-"))).toEqual([]);
    expect(h["user-agent"]).not.toMatch(/^pi\//);
    expect(seen[0].body.model).toBe(HAIKU);
  });

  test("ledger row carries ref, scope, model, tokens; usage event emitted", async () => {
    await start();
    await (await call(BODY)).text();
    const [r] = rows();
    expect(r).toMatchObject({ ref: "run-1", scope: "solve", model: HAIKU, input: 100, output: 20, cache_read: 5000, cache_write: 300, aborted: 0, estimated: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ref: "run-1", model: HAIKU, usage: USAGE });
  });

  test("openai chat-completions passthrough: usage from final chunk (cached tokens split out)", async () => {
    await start();
    mode = "openai-sse";
    await (await call({ model: HAIKU, stream: true, messages: [] }, HARNESS, undefined, "/v1/chat/completions")).text();
    expect(seen[0].url).toBe("/v1/chat/completions");
    expect(rows()[0]).toMatchObject({ input: 100, output: 20, cache_read: 5000, cache_write: 0 });
  });
});

describe("guards (upstream never called)", () => {
  test("missing x-harness-ref → 400", async () => {
    await start();
    const res = await call(BODY, { "x-harness-scope": "solve" });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("global budget exhausted → 402 budget_exhausted", async () => {
    await start(0.000001);
    ledger.record({ scope: "solve", ref: "x", costUsd: 1 });
    const res = await call(BODY);
    expect(res.status).toBe(402);
    expect((await res.json()).error.type).toBe("budget_exhausted");
    expect(seen).toHaveLength(0);
  });

  test("per-ref budget header enforced", async () => {
    await start();
    ledger.record({ scope: "solve", ref: "run-1", costUsd: 0.5 });
    const res = await call(BODY, { ...HARNESS, "x-harness-budget-usd": "0.4" });
    expect(res.status).toBe(402);
  });

  test("max_tokens above the session cap → 400", async () => {
    await start();
    const res = await call({ ...BODY, max_tokens: 9000 });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("retry and rate limit", () => {
  test("429 before first byte is retried; limiter slows down", async () => {
    await start();
    mode = "429-then-sse";
    const res = await call(BODY);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello");
    expect(seen).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });
});

describe("cost: header vs usage (ж)", () => {
  test("non-stream with header → cost from header", async () => {
    await start();
    mode = "json";
    costHeader = String(USAGE_COST);
    await (await call({ ...BODY, stream: false })).text();
    expect(rows()[0]).toMatchObject({ cost_source: "header" });
    expect(rows()[0].cost_usd).toBeCloseTo(USAGE_COST, 12);
  });

  test("non-stream without header → cost from usage, same number", async () => {
    await start();
    mode = "json";
    await (await call({ ...BODY, stream: false })).text();
    expect(rows()[0].cost_source).toBe("usage");
    expect(rows()[0].cost_usd).toBeCloseTo(USAGE_COST, 12);
  });

  test("stream: header (possibly incomplete) is only recorded; cost from final usage", async () => {
    await start();
    costHeader = "0.0000001"; // e.g. input-only estimate computed before the stream finished
    await (await call(BODY)).text();
    expect(rows()[0]).toMatchObject({ cost_source: "usage", provider_cost_usd: 0.0000001 });
    expect(rows()[0].cost_usd).toBeCloseTo(USAGE_COST, 12);
  });
});

describe("abort (е)", () => {
  test("client abort mid-stream → upstream request cancelled < 200 ms, partial cost marked aborted+estimated", async () => {
    await start();
    mode = "slow-sse";
    const ac = new AbortController();
    const res = await call(BODY, HARNESS, ac.signal);
    const reader = res.body?.getReader();
    await reader?.read();
    await new Promise((r) => setTimeout(r, 60));
    const abortedAt = Date.now();
    ac.abort();
    for (let i = 0; i < 40 && (upstreamClosedAt === null || rows().length === 0); i++) await new Promise((r) => setTimeout(r, 10));
    expect(upstreamClosedAt).not.toBeNull();
    expect((upstreamClosedAt ?? 0) - abortedAt).toBeLessThan(200);
    const [r] = rows();
    expect(r).toMatchObject({ aborted: 1, estimated: 1, input: 100, cache_read: 5000, cache_write: 300 });
    expect(r.output).toBeGreaterThan(0);
    expect(r.cost_usd).toBeGreaterThan(0);
  });
});

describe("model config (Q10)", () => {
  const base = { model: HAIKU, limits: { max_output_tokens: 8192 } };
  test("thinking=high → maxTokens ≥ budget(high) + 1024", () => {
    expect(resolveModelConfig(PRICES, { ...base, thinking: "high" }).maxTokens).toBeGreaterThanOrEqual(16384 + 1024);
  });
  test("thinking=off → limit", () => {
    expect(resolveModelConfig(PRICES, { ...base, thinking: "off" }).maxTokens).toBe(8192);
  });
  test.each(["xhigh", "max"] as const)("thinking=%s unsupported on Haiku → 422 version_invalid", (thinking) => {
    expect(() => resolveModelConfig(PRICES, { ...base, thinking })).toThrow(expect.objectContaining({ status: 422, code: "version_invalid" }));
  });
  test("budget + 1024 above model max output → 422", () => {
    const tiny = { ...PRICES, tiny: { ...PRICES[HAIKU], maxOutput: 4096 } };
    expect(() => resolveModelConfig(tiny, { ...base, model: "tiny", thinking: "medium" })).toThrow(expect.objectContaining({ status: 422 }));
  });
  test("unknown model → 422", () => {
    expect(() => resolveModelConfig(PRICES, { ...base, model: "nope", thinking: "off" })).toThrow(expect.objectContaining({ status: 422 }));
  });
});
