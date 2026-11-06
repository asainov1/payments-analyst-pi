// Mock of the harness API (SPEC §4.1–§4.2) so the UI can be built and checked without LLM spend.
// Run: `node mock/server.ts` (Node ≥ 23 strips TS types natively). Port: MOCK_PORT or 8787.
// Message triggers: contains "fee?" → clarification · "fail" → error event · "slow" → slow stream.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Version = {
  id: string; parent: string | null; status: "baseline" | "promoted" | "rejected" | "candidate";
  change_summary: string; created_at: string;
  models: { analyst: string; reflector: string }; thinking: string;
  metrics: {
    val: { correct: number; n: number; accuracy: number; by_level: Record<string, number> } | null;
    cost_usd: number; cost_per_task_usd: number; cache_hit_rate: number;
    latency_p50_s: number; latency_p95_s: number;
    gate?: { decision: "promote" | "reject"; reason: string; confirmed_wins: number; losses: number; threshold_T: number };
  };
};

const versions: Version[] = [
  {
    id: "v000", parent: null, status: "baseline", created_at: "2026-11-06T13:50:00Z",
    change_summary: "Baseline: domain primer, compressed manual, schema, empty playbook",
    models: { analyst: "claude-haiku-5-5", reflector: "claude-opus-5-5" }, thinking: "low",
    metrics: { val: { correct: 52, n: 91, accuracy: 0.571, by_level: { easy: 0.8, hard: 0.42 } },
      cost_usd: 0.41, cost_per_task_usd: 0.0045, cache_hit_rate: 0.87, latency_p50_s: 4.1, latency_p95_s: 11.8 },
  },
  {
    id: "v001", parent: "v000", status: "promoted", created_at: "2026-11-06T15:10:00Z",
    change_summary: "playbook +R01 fraud rate by volume; +R02 [] / null in fees means 'any'",
    models: { analyst: "claude-haiku-5-5", reflector: "claude-opus-5-5" }, thinking: "low",
    metrics: { val: { correct: 57, n: 91, accuracy: 0.626, by_level: { easy: 0.82, hard: 0.5 } },
      cost_usd: 0.44, cost_per_task_usd: 0.0048, cache_hit_rate: 0.88, latency_p50_s: 4.3, latency_p95_s: 12.1,
      gate: { decision: "promote", reason: "net +5 ≥ T=3, 0 easy regressions, cost ×1.07", confirmed_wins: 6, losses: 1, threshold_T: 3 } },
  },
  {
    id: "v002", parent: "v001", status: "rejected", created_at: "2026-11-06T15:40:00Z",
    change_summary: "routing: thinking low → high",
    models: { analyst: "claude-haiku-5-5", reflector: "claude-opus-5-5" }, thinking: "high",
    metrics: { val: { correct: 58, n: 91, accuracy: 0.637, by_level: { easy: 0.8, hard: 0.52 } },
      cost_usd: 0.93, cost_per_task_usd: 0.0102, cache_hit_rate: 0.86, latency_p50_s: 7.9, latency_p95_s: 21.4,
      gate: { decision: "reject", reason: "net +1 < T=3; cost ×2.1 > 1.3", confirmed_wins: 2, losses: 1, threshold_T: 3 } },
  },
];
let best = "v001";
const sessions = new Map<string, { id: string; version: string; turns: unknown[] }>();
const feedback: unknown[] = [];
const runs = new Map<string, { done: number; total: number; status: string }>();
let spent = 3.42;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function err(res: ServerResponse, status: number, code: string, message: string) {
  json(res, status, { error: { code, message } });
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function sse(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let closed = false;
  res.on("close", () => { closed = true; });
  return {
    send(type: string, data: unknown) { if (!closed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); },
    get closed() { return closed; },
    end() { if (!closed) res.end(); },
  };
}

async function streamTurn(res: ServerResponse, sessionId: string, version: string, message: string) {
  const s = sse(res);
  const turnId = randomUUID();
  const trace = `http://localhost:3000/project/analyst/traces/${turnId.replaceAll("-", "")}`;
  const step = message.includes("slow") ? 900 : 250;
  s.send("turn.start", { turn_id: turnId, session_id: sessionId, version, trace_url: trace });
  await sleep(step);
  s.send("llm.usage", { model: "claude-haiku-5-5", input: 312, output: 88, cache_read: 9840, cache_write: 0, cost_usd: 0.00017, ms: 1240 });
  if (message.toLowerCase().includes("fail")) {
    s.send("error", { code: "llm_unavailable", message: "LiteLLM returned 503 after 4 retries" });
    return s.end();
  }
  if (message.toLowerCase().includes("fee?")) {
    s.send("clarification", { question: "Which fee do you mean — for a specific merchant, card scheme or a single transaction?", options: ["Merchant total for a period", "Fee for one transaction (fee ID)", "Average fee per card scheme"] });
    s.send("turn.end", { outcome: "clarification", usage: { input: 312, output: 88, cache_read: 9840, cache_write: 0, cost_usd: 0.00017, llm_calls: 1, tool_calls: 0 }, cache_hit_rate: 0.94, latency_ms: 1300, trace_url: trace });
    return s.end();
  }
  const callId = randomUUID();
  const query = "SELECT card_scheme, SUM(eur_amount) AS volume FROM payments WHERE merchant = 'Crossfit_Hanna' GROUP BY 1 ORDER BY 2 DESC";
  s.send("tool.start", { call_id: callId, tool: "sql", args: { query } });
  await sleep(step);
  if (s.closed) return;
  s.send("tool.end", { call_id: callId, tool: "sql", ok: true, ms: 34, preview: "| card_scheme | volume |\n|---|---|\n| GlobalCard | 1823411.20 |\n| NexPay | 1290112.05 |\n| TransactPlus | 990344.91 |\n(3 rows)" });
  await sleep(step);
  for (const delta of ["By card scheme, ", "GlobalCard leads ", "with €1.82M, ", "then NexPay (€1.29M) ", "and TransactPlus (€0.99M)."]) {
    if (s.closed) return;
    s.send("text.delta", { delta });
    await sleep(step / 2);
  }
  s.send("llm.usage", { model: "claude-haiku-5-5", input: 540, output: 61, cache_read: 9840, cache_write: 0, cost_usd: 0.00013, ms: 870 });
  s.send("answer", { answer: "GlobalCard: 1823411.20, NexPay: 1290112.05, TransactPlus: 990344.91", assumptions: ["Volume = SUM(eur_amount) over all 2023 payments"], format: "grouped_list", valid: true });
  spent += 0.0003;
  s.send("turn.end", { outcome: "answered", usage: { input: 852, output: 149, cache_read: 19680, cache_write: 0, cost_usd: 0.0003, llm_calls: 2, tool_calls: 1 }, cache_hit_rate: 0.95, latency_ms: 3120, trace_url: trace });
  sessions.get(sessionId)?.turns.push({ id: turnId, user_message: message });
  s.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const p = url.pathname;
  const m = req.method;
  try {
    if (m === "GET" && p === "/api/health") return json(res, 200, { ok: true, langfuse: true, llm: true });
    if (m === "GET" && p === "/api/versions") return json(res, 200, { best, versions });
    if (m === "GET" && p === "/api/budget") return json(res, 200, { cap_usd: 135, spent_usd: Number(spent.toFixed(4)), remaining_usd: Number((135 - spent).toFixed(4)) });
    if (m === "POST" && p === "/api/sessions") {
      const b = await body(req);
      const version = b.version && b.version !== "best" ? String(b.version) : best;
      if (!versions.some((v) => v.id === version)) return err(res, 422, "version_invalid", `unknown version ${version}`);
      const id = randomUUID();
      sessions.set(id, { id, version, turns: [] });
      return json(res, 201, { session_id: id, version });
    }
    let mm = p.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (m === "POST" && mm) {
      const sess = sessions.get(mm[1]);
      if (!sess) return err(res, 404, "not_found", "session not found");
      const b = await body(req);
      return streamTurn(res, sess.id, sess.version, String(b.message ?? ""));
    }
    mm = p.match(/^\/api\/sessions\/([^/]+)\/abort$/);
    if (m === "POST" && mm) { res.writeHead(202); return res.end(); }
    if (m === "POST" && p === "/api/feedback") {
      const b = await body(req);
      if (b.rating !== "up" && b.rating !== "down") return err(res, 400, "invalid_request", "rating must be up|down");
      feedback.push(b);
      return json(res, 201, { id: randomUUID() });
    }
    mm = p.match(/^\/api\/versions\/([^/]+)\/diff$/);
    if (m === "GET" && mm) {
      res.writeHead(200, { "content-type": "text/x-diff" });
      return res.end(`--- a/playbook.md\n+++ b/playbook.md\n@@ -0,0 +1,2 @@\n+R01 Fraud rate = fraud volume / total volume (by amount, not count).\n+R02 An empty list or null in fees.json matches any value.\n`);
    }
    mm = p.match(/^\/api\/versions\/([^/]+)\/promote$/);
    if (m === "POST" && mm) {
      if (!versions.some((v) => v.id === mm![1])) return err(res, 404, "not_found", "version not found");
      best = mm[1];
      return json(res, 200, { best });
    }
    if (m === "POST" && p === "/api/runs/improve") {
      const b = await body(req);
      if (!(Number(b.generations) > 0) || !(Number(b.budget_usd) > 0)) return err(res, 400, "invalid_request", "generations and budget_usd must be > 0");
      const id = randomUUID();
      runs.set(id, { done: 0, total: Number(b.generations), status: "running" });
      return json(res, 202, { run_id: id });
    }
    mm = p.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (m === "GET" && mm) {
      const run = runs.get(mm[1]);
      if (!run) return err(res, 404, "not_found", "run not found");
      const s = sse(res);
      while (run.done < run.total && !s.closed) {
        await sleep(1500);
        run.done += 1;
        s.send("progress", { done: run.done, total: run.total, stage: run.done < run.total ? "validate" : "done" });
      }
      run.status = "done";
      s.send("run.end", { status: "done" });
      return s.end();
    }
    mm = p.match(/^\/api\/runs\/([^/]+)$/);
    if (m === "GET" && mm) {
      const run = runs.get(mm[1]);
      if (!run) return err(res, 404, "not_found", "run not found");
      return json(res, 200, { run: { id: mm[1], status: run.status }, progress: { done: run.done, total: run.total } });
    }
    return err(res, 404, "not_found", `${m} ${p}`);
  } catch (e) {
    return err(res, 500, "internal", (e as Error).message);
  }
});

const port = Number(process.env.MOCK_PORT ?? 8787);
server.listen(port, "127.0.0.1", () => console.log(`mock api on http://127.0.0.1:${port}`));
