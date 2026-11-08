// Langfuse tracing (SPEC §3.2 obs/tracer, step 3): Pi session events → OTLP observations.
// One trace per turn/task: an `agent` root, a `generation` per LLM call (tokens, cache read/write,
// cost from Pi's usage — same price table as the ledger), a `tool` observation per tool call.
// Uses its own NodeTracerProvider (not the global one) so nothing else in the process is traced.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { type LangfuseAgent, type LangfuseGeneration, type LangfuseTool, setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface TracingConfig {
  publicKey: string;
  secretKey: string;
  /** Where the harness sends spans (inside compose: http://langfuse-web:3000). */
  baseUrl: string;
  /** Where humans open traces (http://localhost:3000). */
  publicUrl: string;
  projectId: string;
  /** Tests: export in memory instead of OTLP. */
  exporter?: SpanExporter;
}

export interface Tracing {
  traceUrl(traceId: string): string;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function initTracing(cfg: TracingConfig): Tracing {
  const provider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: cfg.publicKey,
        secretKey: cfg.secretKey,
        baseUrl: cfg.baseUrl,
        exporter: cfg.exporter,
        // We emit only Langfuse observations; keep every span we create.
        shouldExportSpan: () => true,
      }),
    ],
  });
  setLangfuseTracerProvider(provider);
  const base = cfg.publicUrl.replace(/\/+$/, "");
  return {
    traceUrl: (traceId) => `${base}/project/${cfg.projectId}/traces/${traceId}`,
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

export function tracingFromEnv(env: NodeJS.ProcessEnv = process.env): Tracing | null {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY || !env.LANGFUSE_BASE_URL) return null;
  return initTracing({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
    publicUrl: env.LANGFUSE_PUBLIC_URL ?? env.LANGFUSE_BASE_URL,
    projectId: env.LANGFUSE_PROJECT_ID ?? "analyst",
  });
}

interface Subscribable {
  subscribe(listener: (e: any) => void): () => void;
}

export interface TurnMeta {
  name: string; // "task" | "turn"
  sessionId: string; // chat session id or batch run id
  version: string;
  tags: string[];
  metadata: Record<string, string>;
  input: unknown;
  model: string;
}

export interface TurnTrace {
  traceId: string;
  traceUrl: string;
  end(output: unknown, metadata?: Record<string, string>): void;
}

const MAX_TOOL_OUTPUT = 8000;

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((c: any) => (c?.type === "text" ? c.text : c?.type === "toolCall" ? `[call ${c.name} ${JSON.stringify(c.arguments)}]` : "")).join("\n")
    : String(content ?? "");

export function traceTurn(tracing: Tracing, session: Subscribable, meta: TurnMeta): TurnTrace {
  const traceAttrs = {
    "session.id": meta.sessionId,
    "langfuse.trace.name": meta.name,
    "langfuse.trace.tags": meta.tags,
    "langfuse.version": meta.version,
    "langfuse.trace.metadata": JSON.stringify(meta.metadata),
  };
  // Trace-level attributes go on every observation (Langfuse aggregates them per trace).
  const tag = <T extends { otelSpan: { setAttributes(a: Record<string, string | string[]>): unknown } }>(o: T) => {
    o.otelSpan.setAttributes(traceAttrs);
    return o;
  };

  const root: LangfuseAgent = tag(startObservation(meta.name, { input: meta.input, metadata: meta.metadata }, { asType: "agent" }));
  root.otelSpan.setAttributes({ "langfuse.trace.input": JSON.stringify(meta.input) });

  let pendingInput: string[] = [];
  // When the next LLM request is sent: turn start, after a user message or a tool result.
  // Pi's assistant message_start fires on the first streamed token, i.e. time-to-first-token.
  let requestAt = new Date();
  let gen: LangfuseGeneration | null = null;
  const tools = new Map<string, LangfuseTool>();
  let compaction: ReturnType<LangfuseAgent["startObservation"]> | null = null;

  const unsubscribe = session.subscribe((e: any) => {
    switch (e.type) {
      case "message_end":
        if (e.message?.role === "assistant") {
          const g = gen ?? tag(startObservation("llm", { model: meta.model, input: pendingInput.join("\n\n") }, { asType: "generation", startTime: requestAt, parentSpanContext: root.otelSpan.spanContext() }));
          const u = e.message.usage ?? {};
          g.update({
            output: textOf(e.message.content),
            usageDetails: { input: u.input ?? 0, output: u.output ?? 0, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0 },
            costDetails: {
              input: u.cost?.input ?? 0,
              output: u.cost?.output ?? 0,
              cache_read_input_tokens: u.cost?.cacheRead ?? 0,
              cache_creation_input_tokens: u.cost?.cacheWrite ?? 0,
              total: u.cost?.total ?? 0,
            },
            metadata: { stopReason: String(e.message.stopReason ?? "") },
            ...(e.message.stopReason === "error" || e.message.stopReason === "aborted" ? { level: "ERROR" as const, statusMessage: String(e.message.errorMessage ?? e.message.stopReason) } : {}),
          });
          g.end();
          gen = null;
          pendingInput = [];
          requestAt = new Date();
        } else if (e.message) {
          pendingInput.push(`[${e.message.role}] ${textOf(e.message.content)}`);
          requestAt = new Date();
        }
        break;
      case "message_start":
        if (e.message?.role === "assistant" && !gen) {
          gen = tag(
            startObservation(
              "llm",
              { model: meta.model, input: pendingInput.join("\n\n"), completionStartTime: new Date() },
              { asType: "generation", startTime: requestAt, parentSpanContext: root.otelSpan.spanContext() },
            ),
          );
        }
        break;
      case "compaction_start":
        compaction = tag(root.startObservation("compaction", { input: { reason: e.reason } }, { asType: "span" }));
        break;
      case "compaction_end":
        compaction?.update({
          output: e.result ? { tokensBefore: e.result.tokensBefore, estimatedTokensAfter: e.result.estimatedTokensAfter, summary: String(e.result.summary ?? "").slice(0, MAX_TOOL_OUTPUT) } : null,
          ...(e.aborted || !e.result ? { level: "WARNING" as const, statusMessage: String(e.errorMessage ?? "compaction did not complete") } : {}),
        });
        compaction?.end();
        compaction = null;
        requestAt = new Date();
        break;
      case "tool_execution_start":
        tools.set(e.toolCallId, tag(root.startObservation(e.toolName, { input: e.args }, { asType: "tool" })));
        break;
      case "tool_execution_end": {
        const t = tools.get(e.toolCallId);
        if (!t) break;
        const out = textOf(e.result?.content);
        t.update({
          output: out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}… [truncated ${out.length - MAX_TOOL_OUTPUT} chars]` : out,
          ...(e.isError ? { level: "ERROR" as const, statusMessage: out.slice(0, 500) } : {}),
        });
        t.end();
        tools.delete(e.toolCallId);
        requestAt = new Date();
        break;
      }
    }
  });

  const traceId = root.traceId;
  return {
    traceId,
    traceUrl: tracing.traceUrl(traceId),
    end(output, metadata) {
      unsubscribe();
      for (const t of tools.values()) t.update({ level: "WARNING", statusMessage: "turn ended before tool finished" }).end();
      gen?.update({ level: "WARNING", statusMessage: "turn ended before LLM call finished" }).end();
      root.otelSpan.setAttributes({ "langfuse.trace.output": JSON.stringify(output) });
      root.update({ output, ...(metadata ? { metadata: { ...meta.metadata, ...metadata } } : {}) }).end();
    },
  };
}
