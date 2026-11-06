// In-process LLM proxy (SPEC §7, step 2): Pi talks to http://127.0.0.1:<random port>, the proxy
// talks to LiteLLM. It is the single choke point for every LLM call:
//   а) loopback-only listener, the real API key lives only here (Pi gets a dummy key);
//   б) budget check before forwarding (402), attribution via x-harness-* headers (400 without);
//   в) concurrency slot + per-model rate limit + retry of 408/429/5xx before the first byte;
//   г) SSE streamed through unbuffered; usage parsed on the fly and written to the ledger;
//   д) per-session max_tokens cap (400 above it);
//   е) client abort → upstream fetch aborted, partial cost recorded as aborted + estimated;
//   ж) cost from x-litellm-response-cost only for complete non-streaming responses, else from usage.
import { EventEmitter } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BudgetExhausted, LEDGER_SCOPES, type LedgerScope } from "../runtime/budget.ts";
import type { Governor } from "../runtime/governor.ts";
import { HttpError, type RetryOptions, withRetry } from "../runtime/retry.ts";
import { costUsd, type PriceTable, type TokenUsage } from "./prices.ts";

export interface LlmUsageEvent {
  ref: string;
  scope: LedgerScope;
  model: string;
  status: number;
  usage: TokenUsage;
  costUsd: number;
  costSource: "header" | "usage";
  providerCostUsd: number | null;
  aborted: boolean;
  estimated: boolean;
  ms: number;
}

export interface LlmProxyOptions {
  upstream: string;
  apiKey: string;
  governor: Governor;
  prices: PriceTable;
  retry?: RetryOptions;
}

const DROP_REQ = new Set(["host", "connection", "content-length", "keep-alive", "transfer-encoding", "x-api-key", "authorization", "user-agent", "accept-encoding"]);
const DROP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

export class LlmProxy extends EventEmitter {
  private readonly o: LlmProxyOptions;
  private server: Server | null = null;

  constructor(opts: LlmProxyOptions) {
    super();
    this.o = { ...opts, upstream: opts.upstream.replace(/\/+$/, "") };
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) sendError(res, 500, "proxy_error", String(e));
        else res.destroy();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    this.server = server;
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const body = await readBody(req);
    const ref = one(req.headers, "x-harness-ref");
    const scope = one(req.headers, "x-harness-scope") as LedgerScope | undefined;
    if (!ref || !scope || !LEDGER_SCOPES.includes(scope)) {
      return sendError(res, 400, "invalid_request_error", "x-harness-ref and a valid x-harness-scope header are required");
    }
    const budgetUsd = num(one(req.headers, "x-harness-budget-usd"));
    const maxTokens = num(one(req.headers, "x-harness-max-tokens"));

    let payload: { model?: unknown; max_tokens?: unknown } | null = null;
    try {
      payload = body.length ? JSON.parse(body.toString("utf8")) : null;
    } catch {
      // non-JSON bodies are forwarded as-is
    }
    const model = typeof payload?.model === "string" ? payload.model : "unknown";
    if (maxTokens !== null && typeof payload?.max_tokens === "number" && payload.max_tokens > maxTokens) {
      return sendError(res, 400, "invalid_request_error", `max_tokens ${payload.max_tokens} exceeds session cap ${maxTokens}`);
    }

    let release: () => void;
    try {
      release = await this.o.governor.admit({ ref, budgetUsd });
    } catch (e) {
      if (e instanceof BudgetExhausted) return sendError(res, 402, "budget_exhausted", e.message);
      throw e;
    }

    const ac = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        clientGone = true;
        ac.abort();
      }
    });

    const acc = new UsageAccumulator();
    let status = 0;
    let providerCost: number | null = null;
    let streamed = false;
    let broken = false;
    try {
      let up: Response;
      try {
        up = await withRetry(async () => {
          await this.o.governor.pace(model);
          const r = await fetch(`${this.o.upstream}${req.url ?? "/"}`, {
            method: req.method,
            headers: this.forwardHeaders(req.headers),
            body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
            signal: ac.signal,
          });
          if (r.status === 408 || r.status === 429 || r.status >= 500) {
            const text = await r.text().catch(() => "");
            if (r.status === 429) this.o.governor.limiter.onRateLimited(model);
            throw new HttpError(r.status, text || `upstream ${r.status}`, num(r.headers.get("retry-after")) ?? undefined);
          }
          return r;
        }, this.o.retry);
      } catch (e) {
        if (clientGone) {
          broken = true;
          return;
        }
        if (e instanceof HttpError) return sendRaw(res, e.status, e.message);
        return sendError(res, 502, "upstream_unreachable", String(e));
      }

      status = up.status;
      providerCost = num(up.headers.get("x-litellm-response-cost"));
      streamed = (up.headers.get("content-type") ?? "").includes("text/event-stream");
      const headers: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        if (!DROP_RES.has(k)) headers[k] = v;
      });
      res.writeHead(up.status, headers);
      acc.mode = streamed ? "sse" : "json";
      try {
        if (up.body) {
          for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
            acc.push(chunk);
            res.write(chunk);
          }
        }
        res.end();
      } catch {
        broken = true;
        if (!clientGone) res.destroy(); // upstream broke mid-stream: surface it to Pi
      }
    } finally {
      release();
      if (status >= 200 && status < 300 ? true : broken) this.account({ ref, scope, model, status, acc, providerCost, streamed, aborted: clientGone || broken, started });
    }
  }

  private forwardHeaders(h: IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined || DROP_REQ.has(k) || k.startsWith("x-harness-")) continue;
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    out["x-api-key"] = this.o.apiKey;
    out.authorization = `Bearer ${this.o.apiKey}`;
    out["user-agent"] = "zimran-harness";
    out["accept-encoding"] = "identity"; // we parse the stream; no compression
    return out;
  }

  private account(a: {
    ref: string;
    scope: LedgerScope;
    model: string;
    status: number;
    acc: UsageAccumulator;
    providerCost: number | null;
    streamed: boolean;
    aborted: boolean;
    started: number;
  }): void {
    const { usage, estimated } = a.acc.result(a.aborted);
    const price = this.o.prices[a.model];
    const fromUsage = price ? costUsd(price, usage) : 0;
    const useHeader = !a.streamed && !a.aborted && a.providerCost !== null;
    const ev: LlmUsageEvent = {
      ref: a.ref,
      scope: a.scope,
      model: a.model,
      status: a.status,
      usage,
      costUsd: useHeader ? (a.providerCost as number) : fromUsage,
      costSource: useHeader ? "header" : "usage",
      providerCostUsd: a.providerCost,
      aborted: a.aborted,
      estimated,
      ms: Date.now() - a.started,
    };
    this.o.governor.ledger.record({
      scope: ev.scope,
      ref: ev.ref,
      costUsd: ev.costUsd,
      model: ev.model,
      usage: ev.usage,
      costSource: ev.costSource,
      providerCostUsd: ev.providerCostUsd,
      aborted: ev.aborted,
      estimated: ev.estimated,
      ms: ev.ms,
    });
    this.emit("usage", ev);
  }
}

/** Incrementally extracts token usage from an Anthropic or OpenAI response (SSE or JSON). */
class UsageAccumulator {
  mode: "sse" | "json" = "json";
  private buf = "";
  private readonly decoder = new TextDecoder();
  private usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private final = false; // saw the end-of-message usage
  private chars = 0; // streamed output characters, for estimates on abort

  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    if (this.mode !== "sse") return;
    let i = this.buf.indexOf("\n\n");
    while (i !== -1) {
      this.event(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 2);
      i = this.buf.indexOf("\n\n");
    }
  }

  private event(block: string): void {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") return;
    try {
      this.observe(JSON.parse(data));
    } catch {
      // ignore unparsable event
    }
  }

  private observe(e: any): void {
    if (e?.type === "message_start") this.anthropic(e.message?.usage, false);
    else if (e?.type === "message_delta") this.anthropic(e.usage, true);
    else if (e?.type === "content_block_delta") {
      const d = e.delta ?? {};
      this.chars += String(d.text ?? d.thinking ?? d.partial_json ?? "").length;
    } else if (Array.isArray(e?.choices) || e?.usage) {
      for (const c of e.choices ?? []) this.chars += String(c?.delta?.content ?? "").length;
      if (e.usage) this.openai(e.usage);
    }
  }

  private anthropic(u: any, final: boolean): void {
    if (!u) return;
    const set = (k: keyof TokenUsage, v: unknown) => {
      if (typeof v === "number") this.usage[k] = v;
    };
    set("input", u.input_tokens);
    set("output", u.output_tokens);
    set("cacheRead", u.cache_read_input_tokens);
    set("cacheWrite", u.cache_creation_input_tokens);
    if (final) this.final = true;
  }

  private openai(u: any): void {
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? 0);
    this.usage = { input: Number(u.prompt_tokens ?? 0) - cached, output: Number(u.completion_tokens ?? 0), cacheRead: cached, cacheWrite: 0 };
    this.final = true;
  }

  result(aborted: boolean): { usage: TokenUsage; estimated: boolean } {
    if (this.mode === "json" && this.buf) {
      try {
        const j = JSON.parse(this.buf);
        if (j.usage?.prompt_tokens !== undefined) this.openai(j.usage);
        else this.anthropic(j.usage, true);
      } catch {
        // incomplete JSON (aborted)
      }
    }
    if (this.final && !aborted) return { usage: { ...this.usage }, estimated: false };
    // No final usage: output estimated from streamed characters (~4 chars per token).
    const output = Math.max(this.usage.output, Math.ceil(this.chars / 4));
    return { usage: { ...this.usage, output }, estimated: true };
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function one(h: IncomingHttpHeaders, k: string): string | undefined {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function sendRaw(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text.startsWith("{") ? text : JSON.stringify({ type: "error", error: { type: "upstream_error", message: text } }));
}
