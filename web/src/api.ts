// Thin client for the harness API (SPEC §4.1–§4.2).

export type Usage = {
  input: number; output: number; cache_read: number; cache_write: number;
  cost_usd: number; llm_calls?: number; tool_calls?: number;
};

export type VersionRow = {
  id: string; parent: string | null; status: string; change_summary: string; created_at?: string;
  models?: { analyst: string; reflector: string }; thinking?: string;
  metrics?: {
    val: { correct: number; n: number; accuracy: number; by_level?: Record<string, number>; runs?: number[] } | null;
    cost_usd?: number; cost_per_task_usd?: number; cache_hit_rate?: number;
    latency_p50_s?: number; latency_p95_s?: number;
    gate?: {
      decision: string; reason: string; parent_correct?: number; cand_correct?: number; wins?: number; losses?: number;
      confirmed_wins?: number; easy_regressions?: number; threshold_T?: number; parent_cost_per_task?: number; cand_cost_per_task?: number;
    };
    /** Set when a candidate is rejected before or instead of a full gate (smoke, leak-check, early stop). */
    reject_reason?: string;
  };
};

export type TurnEvent =
  | { type: "turn.start"; data: { turn_id: string; session_id: string; version: string; trace_url: string } }
  | { type: "text.delta"; data: { delta: string } }
  | { type: "thinking.delta"; data: { delta: string } }
  | { type: "tool.start"; data: { call_id: string; tool: string; args: unknown } }
  | { type: "tool.end"; data: { call_id: string; tool: string; ok: boolean; preview: string; ms: number } }
  | { type: "llm.usage"; data: Usage & { model: string; ms: number } }
  | { type: "clarification"; data: { question: string; options?: string[] } }
  | { type: "answer"; data: { answer: string; assumptions: string[]; format: string; valid: boolean } }
  | { type: "turn.end"; data: { outcome: string; usage: Usage; cache_hit_rate: number; latency_ms: number; trace_url: string } }
  | { type: "error"; data: { code: string; message: string } };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? "http_error", body?.error?.message ?? res.statusText);
  }
  // 202 may carry a body (e.g. `202 { run_id }`), so read text and parse only when present.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  versions: () => call<{ best: string; versions: VersionRow[] }>("/api/versions"),
  budget: () => call<{ cap_usd: number; spent_usd: number; remaining_usd: number }>("/api/budget"),
  createSession: (version: string) =>
    call<{ session_id: string; version: string }>("/api/sessions", { method: "POST", body: JSON.stringify({ version }) }),
  abort: (sessionId: string) => fetch(`/api/sessions/${sessionId}/abort`, { method: "POST" }),
  feedback: (turnId: string, rating: "up" | "down", comment?: string) =>
    call<{ id: string }>("/api/feedback", { method: "POST", body: JSON.stringify({ turn_id: turnId, rating, comment }) }),
  diff: async (id: string) => {
    const res = await fetch(`/api/versions/${id}/diff`);
    if (!res.ok) throw new ApiError(res.status, "http_error", res.statusText);
    return res.text();
  },
  promote: (id: string) => call<{ best: string }>(`/api/versions/${id}/promote`, { method: "POST" }),
  improve: (generations: number, budgetUsd: number) =>
    call<{ run_id: string }>("/api/runs/improve", { method: "POST", body: JSON.stringify({ generations, budget_usd: budgetUsd }) }),
};

/** Parses an SSE byte stream into (event, data) pairs. Used for POST streams, which EventSource cannot do. */
export async function* readSse(res: Response): AsyncGenerator<{ type: string; data: unknown }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let type = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { type, data: JSON.parse(data.join("\n")) };
    }
  }
}

/** POST a chat message and stream turn events. Rejects with ApiError on non-2xx (e.g. 409 session_busy, 402). */
export async function* streamTurn(sessionId: string, message: string, signal: AbortSignal): AsyncGenerator<TurnEvent> {
  const res = await fetch(`/api/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? "http_error", body?.error?.message ?? res.statusText);
  }
  for await (const ev of readSse(res)) yield ev as TurnEvent;
}
