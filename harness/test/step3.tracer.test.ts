// SPEC §6 step 3 (unit part): Pi session events → Langfuse observations, exported in memory.
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { initTracing, type Tracing, traceTurn } from "../src/obs/tracer.ts";

type Listener = (e: any) => void;
class FakeSession {
  private ls: Listener[] = [];
  subscribe(l: Listener) {
    this.ls.push(l);
    return () => {
      this.ls = this.ls.filter((x) => x !== l);
    };
  }
  emit(e: any) {
    for (const l of this.ls) l(e);
  }
  get listeners() {
    return this.ls.length;
  }
}

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

let exporter: InMemorySpanExporter;
let tracing: Tracing;
beforeAll(() => {
  exporter = new InMemorySpanExporter();
  tracing = initTracing({ publicKey: "pk", secretKey: "sk", baseUrl: "http://lf:3000", publicUrl: "http://localhost:3000", projectId: "analyst", exporter });
});
afterAll(() => tracing.shutdown());

const attr = (s: ReadableSpan, k: string) => s.attributes[k];
const byName = (spans: ReadableSpan[], n: string) => spans.filter((s) => s.name === n);

describe("traceTurn", () => {
  test("one trace per turn: agent root, generation per LLM call with usage+cost, tool span per tool call", async () => {
    const s = new FakeSession();
    const t = traceTurn(tracing, s, {
      name: "task",
      sessionId: "run-1",
      version: "v000",
      tags: ["solve", "v000"],
      metadata: { ref: "run-1/1014", task_id: "1014" },
      input: { question: "How many?", guidelines: "Answer must be just a number." },
      model: "claude-sonnet-5-5",
    });
    expect(t.traceUrl).toBe(`http://localhost:3000/project/analyst/traces/${t.traceId}`);

    s.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Question: How many?" }] } });
    s.emit({ type: "message_start", message: { role: "assistant" } });
    s.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", name: "sql", arguments: { query: "SELECT 1" } }], usage: usage(5, 40, 9000, 300, 0.0123), stopReason: "toolUse" },
    });
    s.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "sql", args: { query: "SELECT 1" } });
    s.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "sql", result: { content: [{ type: "text", text: "| n |\n| 1 |" }] }, isError: false });
    s.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "sql", args: { query: "DROP x" } });
    s.emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "sql", result: { content: [{ type: "text", text: "only SELECT" }] }, isError: true });
    s.emit({ type: "message_start", message: { role: "assistant" } });
    s.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "1" }], usage: usage(3, 10, 9300, 0, 0.002), stopReason: "stop" } });
    t.end({ answer: "1" }, { valid: "true" });
    await tracing.flush();

    const spans = exporter.getFinishedSpans();
    const traceIds = new Set(spans.map((x) => x.spanContext().traceId));
    expect(traceIds).toEqual(new Set([t.traceId]));

    const [root] = byName(spans, "task");
    expect(attr(root, "langfuse.observation.type")).toBe("agent");
    expect(attr(root, "session.id")).toBe("run-1");
    expect(attr(root, "langfuse.version")).toBe("v000");
    expect(JSON.parse(String(attr(root, "langfuse.observation.output")))).toEqual({ answer: "1" });

    const gens = spans.filter((x) => attr(x, "langfuse.observation.type") === "generation");
    expect(gens).toHaveLength(2);
    const u = JSON.parse(String(attr(gens[0], "langfuse.observation.usage_details")));
    expect(u).toEqual({ input: 5, output: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 });
    expect(JSON.parse(String(attr(gens[0], "langfuse.observation.cost_details"))).total).toBeCloseTo(0.0123);
    expect(attr(gens[0], "langfuse.observation.model.name")).toBe("claude-sonnet-5-5");
    expect(String(attr(gens[0], "langfuse.observation.input"))).toContain("Question: How many?");
    for (const g of gens) expect(g.parentSpanContext?.spanId).toBe(root.spanContext().spanId);

    const tools = spans.filter((x) => attr(x, "langfuse.observation.type") === "tool");
    expect(tools.map((x) => x.name)).toEqual(["sql", "sql"]);
    expect(attr(tools[1], "langfuse.observation.level")).toBe("ERROR");
    expect(String(attr(tools[0], "langfuse.observation.output"))).toContain("| 1 |");
    expect(s.listeners).toBe(0); // end() unsubscribes
  });

  test("tool output is truncated to keep traces small", async () => {
    exporter.reset();
    const s = new FakeSession();
    const t = traceTurn(tracing, s, { name: "turn", sessionId: "chat-1", version: "v000", tags: [], metadata: {}, input: "q", model: "m" });
    s.emit({ type: "tool_execution_start", toolCallId: "c", toolName: "sql", args: {} });
    s.emit({ type: "tool_execution_end", toolCallId: "c", toolName: "sql", result: { content: [{ type: "text", text: "x".repeat(50_000) }] }, isError: false });
    t.end("done");
    await tracing.flush();
    const tool = exporter.getFinishedSpans().find((x) => x.name === "sql");
    expect(String(tool?.attributes["langfuse.observation.output"]).length).toBeLessThan(9000);
  });
});
