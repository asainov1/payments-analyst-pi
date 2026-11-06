// Chat sessions (SPEC §4.1–§4.2, step 14): one Pi session per chat, kept in memory for follow-ups;
// every turn streams SSE events, is attributed in the ledger as `chat/<session>/<turn>`, traced in
// Langfuse and persisted (turns table). `ask_user` ends a turn as a clarification.
import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Db } from "../db/db.ts";
import type { LlmUsageEvent } from "../llm/proxy.ts";
import { type Tracing, traceTurn } from "../obs/tracer.ts";
import { RequestError, resolveVersion } from "../runs/paths.ts";
import { LimitExceeded, TurnLimits } from "../runtime/limits.ts";
import { loadManifest } from "../versions/manifest.ts";

export interface ChatSessionLike {
  subscribe(listener: (e: any) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export type ChatSessionFactory = (o: { sessionId: string; version: string; tools: ToolDefinition[]; ref: () => string }) => Promise<ChatSessionLike>;

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  llm_calls: number;
  tool_calls: number;
}

export type TurnOutcome = "answered" | "clarification" | "limit_exceeded" | "aborted" | "error";
export type SseEvent = { event: string; data: unknown };

export interface ChatServiceOptions {
  db: Db;
  repoRoot: string;
  factory: ChatSessionFactory;
  /** Data tools for a session (sql, read_manual, python …); ask_user is added by the service. */
  baseTools: (o: { sessionId: string; version: string }) => ToolDefinition[];
  onUsage: (fn: (e: LlmUsageEvent) => void) => () => void;
  tracing?: Tracing | null;
}

interface Live {
  session: ChatSessionLike;
  ref: string;
  busy: boolean;
  abort: (() => void) | null;
}

const PREVIEW = 2048;
const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("") : String(content ?? "");

export class ChatService {
  private readonly o: ChatServiceOptions;
  private readonly live = new Map<string, Live>();

  constructor(o: ChatServiceOptions) {
    this.o = o;
  }

  create(version = "best", origin: "ui" | "mcp" = "ui"): { session_id: string; version: string } {
    const v = resolveVersion(version, this.o.repoRoot);
    const id = randomUUID();
    this.o.db.prepare("INSERT INTO sessions (id, version, origin) VALUES (?, ?, ?)").run(id, v, origin);
    return { session_id: id, version: v };
  }

  get(id: string) {
    const session = this.o.db.prepare("SELECT id, version, origin, created_at FROM sessions WHERE id = ?").get(id) as
      | { id: string; version: string; origin: string; created_at: string }
      | undefined;
    if (!session) return undefined;
    const turns = (this.o.db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY idx").all(id) as any[]).map((t) => ({
      id: t.id,
      session_id: t.session_id,
      idx: t.idx,
      user_message: t.user_message,
      outcome: t.outcome,
      answer: t.answer,
      assumptions: JSON.parse(t.assumptions_json),
      usage: JSON.parse(t.usage_json) as Usage,
      latency_ms: t.latency_ms,
      trace_url: t.trace_url,
      created_at: t.created_at,
    }));
    return { session: { ...session, status: this.live.get(id)?.busy ? "running" : "idle" }, turns };
  }

  /** Throws 404 / 409 before any streaming starts. */
  assertCanStart(id: string): void {
    if (!this.get(id)) throw new RequestError("not_found", 404, "session not found");
    if (this.live.get(id)?.busy) throw new RequestError("session_busy", 409, "a turn is already running in this session");
  }

  abort(id: string): boolean {
    const l = this.live.get(id);
    if (!l?.busy || !l.abort) return false;
    l.abort();
    return true;
  }

  async runTurn(id: string, message: string, emit: (e: SseEvent) => void): Promise<void> {
    this.assertCanStart(id);
    const s = this.get(id);
    if (!s) throw new RequestError("not_found", 404, "session not found");
    const version = s.session.version;
    const turnId = randomUUID();
    const idx = s.turns.length;

    let live = this.live.get(id);
    if (!live) {
      const holder: Live = { session: undefined as unknown as ChatSessionLike, ref: "", busy: false, abort: null };
      const tools = [...this.o.baseTools({ sessionId: id, version }), this.askUserTool(id)];
      holder.session = await this.o.factory({ sessionId: id, version, tools, ref: () => holder.ref });
      this.live.set(id, holder);
      live = holder;
    }
    const l = live;
    l.busy = true;
    l.ref = `chat/${id}/${turnId}`;
    this.clarification.delete(id);
    this.emitters.set(id, emit);

    const manifest = loadManifest(this.o.repoRoot, version);
    const limits = new TurnLimits(manifest.limits);
    const started = Date.now();
    const usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0, llm_calls: 0, tool_calls: 0 };
    let outcome: TurnOutcome = "answered";
    let lastText = "";
    const toolStart = new Map<string, number>();

    const stop = (why: TurnOutcome) => {
      if (outcome === "answered" || outcome === "clarification") outcome = why;
      void l.session.abort();
    };
    l.abort = () => stop("aborted");

    const trace = this.o.tracing
      ? traceTurn(this.o.tracing, l.session, {
          name: "turn",
          sessionId: id,
          version,
          tags: ["chat", version],
          metadata: { turn_id: turnId, idx: String(idx) },
          input: message,
          model: manifest.models.analyst,
        })
      : null;
    emit({ event: "turn.start", data: { turn_id: turnId, session_id: id, version, trace_url: trace?.traceUrl ?? null } });

    const unsubUsage = this.o.onUsage((e) => {
      if (e.ref !== l.ref) return;
      usage.input += e.usage.input;
      usage.output += e.usage.output;
      usage.cache_read += e.usage.cacheRead;
      usage.cache_write += e.usage.cacheWrite;
      usage.cost_usd += e.costUsd;
      usage.llm_calls++;
      emit({
        event: "llm.usage",
        data: { model: e.model, input: e.usage.input, output: e.usage.output, cache_read: e.usage.cacheRead, cache_write: e.usage.cacheWrite, cost_usd: e.costUsd, ms: e.ms },
      });
      try {
        limits.onLlmCost(e.costUsd);
      } catch (err) {
        if (err instanceof LimitExceeded) stop("limit_exceeded");
      }
    });
    const unsubSession = l.session.subscribe((e: any) => {
      switch (e.type) {
        case "message_update": {
          const a = e.assistantMessageEvent;
          if (a?.type === "text_delta") emit({ event: "text.delta", data: { delta: a.delta } });
          else if (a?.type === "thinking_delta") emit({ event: "thinking.delta", data: { delta: a.delta } });
          break;
        }
        case "message_end":
          if (e.message?.role === "assistant") {
            const t = textOf(e.message.content);
            if (t) lastText = t;
          }
          break;
        case "tool_execution_start":
          usage.tool_calls++;
          toolStart.set(e.toolCallId, Date.now());
          emit({ event: "tool.start", data: { call_id: e.toolCallId, tool: e.toolName, args: e.args } });
          try {
            limits.onToolCall();
          } catch (err) {
            if (err instanceof LimitExceeded) stop("limit_exceeded");
          }
          break;
        case "tool_execution_end": {
          const out = textOf(e.result?.content);
          emit({
            event: "tool.end",
            data: { call_id: e.toolCallId, tool: e.toolName, ok: !e.isError, preview: out.length > PREVIEW ? `${out.slice(0, PREVIEW)}…` : out, ms: Date.now() - (toolStart.get(e.toolCallId) ?? Date.now()) },
          });
          break;
        }
      }
    });
    const timer = setTimeout(() => stop("limit_exceeded"), manifest.limits.max_turn_s * 1000);

    try {
      await l.session.prompt(message);
    } catch (err) {
      if (outcome === "answered") outcome = "error";
      emit({ event: "error", data: { code: "turn_failed", message: String(err instanceof Error ? err.message : err) } });
    } finally {
      clearTimeout(timer);
      unsubUsage();
      unsubSession();
    }

    const clar = this.clarification.get(id);
    if (clar && outcome === "answered") outcome = "clarification";
    const answer = outcome === "clarification" ? (clar?.question ?? null) : lastText || null;
    const latency = Date.now() - started;
    trace?.end({ outcome, answer }, { outcome });
    this.o.db
      .prepare("INSERT INTO turns (id, session_id, idx, user_message, outcome, answer, usage_json, latency_ms, trace_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(turnId, id, idx, message, outcome, answer, JSON.stringify(usage), latency, trace?.traceUrl ?? null);
    const prompt = usage.input + usage.cache_read + usage.cache_write;
    emit({
      event: "turn.end",
      data: { turn_id: turnId, outcome, usage, cache_hit_rate: prompt ? usage.cache_read / prompt : 0, latency_ms: latency, trace_url: trace?.traceUrl ?? null },
    });
    l.busy = false;
    l.abort = null;
    this.emitters.delete(id);
  }

  private readonly clarification = new Map<string, { question: string; options?: string[] }>();
  private readonly emitters = new Map<string, (e: SseEvent) => void>();

  private askUserTool(sessionId: string): ToolDefinition {
    return defineTool({
      name: "ask_user",
      label: "Ask user",
      description:
        "Ask the user ONE clarifying question when the request is ambiguous (missing merchant, period, card scheme, or several readings " +
        "that give different results). Ends your turn; the user's next message is the answer.",
      parameters: Type.Object({
        question: Type.String(),
        options: Type.Optional(Type.Array(Type.String(), { description: "Likely answers, if known" })),
      }),
      execute: async (_id, p) => {
        this.clarification.set(sessionId, p);
        this.emitters.get(sessionId)?.({ event: "clarification", data: { question: p.question, options: p.options } });
        return { content: [{ type: "text", text: "Question sent to the user. Stop and wait for the reply." }], details: {}, terminate: true };
      },
    }) as ToolDefinition;
  }
}
