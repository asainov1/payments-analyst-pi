// MCP server (SPEC §4.3, ASSIGNMENT §5.1): the analyst as tools for other agents (Claude Code, Codex…).
// Streamable HTTP at /mcp, stateless transport (a server + transport per HTTP request). Multi-turn state
// lives in our own chat sessions (`session_id`), not in the MCP transport, so every call goes through the
// same ChatService as the UI: same budget cap, rate limiter, per-turn limits and Langfuse tracing
// (sessions are created with origin = "mcp").
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatService } from "../chat/service.ts";
import type { Db } from "../db/db.ts";
import { RequestError } from "../runs/paths.ts";
import type { VersionsService } from "../versions/service.ts";

export interface McpDeps {
  chat: ChatService;
  db: Db;
  versions?: VersionsService;
}

export interface AskResult {
  session_id: string;
  turn_id: string | null;
  status: "answered" | "needs_clarification" | "error";
  answer?: string;
  clarification_question?: string;
  clarification_options?: string[];
  outcome?: string;
  cost_usd: number;
  trace_url: string | null;
  version: string;
  error?: { code: string; message: string };
}

/** One chat turn, collected from the same events the UI streams. */
export interface AskHooks {
  /** Called on every agent step (tool call, text) — used for MCP progress notifications. */
  onStep?: (message: string) => void;
  /** Aborts the turn when the MCP request is cancelled or the client disconnects. */
  signal?: AbortSignal;
}

export async function ask(deps: McpDeps, a: { question: string; session_id?: string; version?: string }, hooks: AskHooks = {}): Promise<AskResult> {
  const s = a.session_id ? deps.chat.get(a.session_id) : undefined;
  if (a.session_id && !s) throw new RequestError("not_found", 404, "session not found");
  const session = s ? { session_id: s.session.id, version: s.session.version } : deps.chat.create(a.version ?? "best", "mcp");

  let text = "";
  let turnId: string | null = null;
  let traceUrl: string | null = null;
  let clarification: { question: string; options?: string[] } | undefined;
  let end: { outcome: string; usage: { cost_usd: number }; trace_url?: string } | undefined;
  let error: { code: string; message: string } | undefined;
  const onAbort = () => deps.chat.abort(session.session_id);
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  try {
  await deps.chat.runTurn(session.session_id, a.question, (e) => {
    const d = e.data as Record<string, any>;
    if (e.event === "turn.start") {
      turnId = d.turn_id ?? null;
      traceUrl = d.trace_url ?? null;
    } else if (e.event === "text.delta") text += d.delta ?? "";
    else if (e.event === "clarification") clarification = { question: d.question, options: d.options };
    else if (e.event === "turn.end") end = d as typeof end;
    else if (e.event === "error") error = { code: d.code, message: d.message };
    if (e.event === "tool.start") hooks.onStep?.(`tool ${d.tool}`);
    else if (e.event === "tool.end") hooks.onStep?.(`tool ${d.tool} ${d.ok ? "ok" : "failed"}`);
  });
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
  }

  const base = { session_id: session.session_id, turn_id: turnId, cost_usd: end?.usage?.cost_usd ?? 0, trace_url: end?.trace_url ?? traceUrl, version: session.version, outcome: end?.outcome };
  if (error || !end) return { ...base, status: "error", error: error ?? { code: "internal", message: "turn ended without a result" } };
  if (clarification) return { ...base, status: "needs_clarification", clarification_question: clarification.question, clarification_options: clarification.options };
  return { ...base, status: "answered", answer: text.trim() };
}

function json(v: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] };
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "payments-analyst", version: "1.0.0" });

  server.registerTool(
    "ask",
    {
      title: "Ask the payments analyst",
      description:
        "Ask a question about the merchant payments dataset (fees, fraud, card schemes, merchants). Multi-turn: pass the " +
        "session_id from a previous result to continue the conversation, including answering the analyst's clarifying " +
        "question (status needs_clarification). Returns the answer, cost and a Langfuse trace link.",
      inputSchema: {
        question: z.string().min(1).max(2000).describe("The question, or your answer to the analyst's clarifying question"),
        session_id: z.string().optional().describe("Continue an existing conversation"),
        version: z.string().optional().describe('Harness version for a NEW session: "best" (default) or e.g. "v012"'),
      },
    },
    async (a, extra) => {
      // Agent turns take up to max_turn_s (minutes): progress notifications let clients that support
      // resetTimeoutOnProgress keep the request alive; a cancelled request / closed connection aborts the turn.
      const token = extra._meta?.progressToken;
      let n = 0;
      const onStep = (message: string) => {
        if (token === undefined) return;
        void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => {});
      };
      try {
        return json(await ask(deps, a, { onStep, signal: extra.signal }));
      } catch (e) {
        const err = e instanceof RequestError ? { code: e.code, message: e.message } : { code: "internal", message: String(e) };
        return { ...json({ status: "error", error: err }), isError: true };
      }
    },
  );

  server.registerTool(
    "feedback",
    {
      title: "Rate an answer",
      description: "Send 👍/👎 feedback for an answer (turn_id from ask). 👎 with a comment is used by the improver.",
      inputSchema: {
        turn_id: z.string(),
        rating: z.enum(["up", "down"]),
        comment: z.string().max(4000).optional(),
      },
    },
    async (a) => {
      if (!deps.db.prepare("SELECT 1 FROM turns WHERE id = ?").get(a.turn_id)) return { ...json({ ok: false, error: "turn not found" }), isError: true };
      const id = randomUUID();
      deps.db.prepare("INSERT INTO feedback (id, turn_id, rating, comment) VALUES (?, ?, ?, ?)").run(id, a.turn_id, a.rating, a.comment ?? null);
      return json({ ok: true, id });
    },
  );

  server.registerTool(
    "list_versions",
    { title: "List harness versions", description: "Harness versions with status and validation accuracy; which one is best.", inputSchema: {} },
    async () => {
      if (!deps.versions) return json([]);
      const { best, versions } = deps.versions.list() as { best: string; versions: Array<{ id: string; status: string; change_summary: string; metrics: any }> };
      return json(
        versions.map((v) => ({ id: v.id, status: v.status, is_best: v.id === best, val_accuracy: v.metrics?.val?.accuracy ?? null, change_summary: v.change_summary })),
      );
    },
  );

  return server;
}

/** POST /mcp (Streamable HTTP, stateless). GET/DELETE → 405, as the SDK recommends for stateless servers. */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post("/mcp", async (req, reply) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  app.get("/mcp", notAllowed as never);
  app.delete("/mcp", notAllowed as never);
}
