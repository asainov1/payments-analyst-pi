import { useEffect, useRef, useState } from "react";
import { ApiError, api, streamTurn, type Usage, type VersionRow } from "../api.ts";

type Step = { call_id: string; tool: string; args: unknown; ok?: boolean; preview?: string; ms?: number };

type Turn = {
  key: string;
  user: string;
  turnId?: string;
  steps: Step[];
  text: string;
  clarification?: { question: string; options?: string[] };
  answer?: { answer: string; assumptions: string[]; valid: boolean };
  end?: { outcome: string; usage: Usage; cache_hit_rate: number; latency_ms: number; trace_url: string };
  traceUrl?: string;
  error?: string;
  running: boolean;
  rating?: "up" | "down";
};

const fmtUsd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`);

export function Chat() {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [best, setBest] = useState("");
  const [version, setVersion] = useState("best");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const running = turns.some((t) => t.running);

  useEffect(() => {
    api.versions().then((r) => { setVersions(r.versions); setBest(r.best); }).catch(() => {});
  }, []);

  const update = (key: string, fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.key === key ? fn(t) : t)));

  async function send(message: string) {
    const text = message.trim();
    if (!text || running) return;
    setInput("");
    const key = crypto.randomUUID();
    setTurns((ts) => [...ts, { key, user: text, steps: [], text: "", running: true }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let sid = sessionId;
      if (!sid) {
        sid = (await api.createSession(version)).session_id;
        setSessionId(sid);
      }
      for await (const ev of streamTurn(sid, text, ctrl.signal)) {
        switch (ev.type) {
          case "turn.start": update(key, (t) => ({ ...t, turnId: ev.data.turn_id, traceUrl: ev.data.trace_url })); break;
          case "tool.start": update(key, (t) => ({ ...t, steps: [...t.steps, { call_id: ev.data.call_id, tool: ev.data.tool, args: ev.data.args }] })); break;
          case "tool.end": update(key, (t) => ({ ...t, steps: t.steps.map((s) => (s.call_id === ev.data.call_id ? { ...s, ok: ev.data.ok, preview: ev.data.preview, ms: ev.data.ms } : s)) })); break;
          case "text.delta": update(key, (t) => ({ ...t, text: t.text + ev.data.delta })); break;
          case "clarification": update(key, (t) => ({ ...t, clarification: ev.data })); break;
          case "answer": update(key, (t) => ({ ...t, answer: ev.data })); break;
          case "turn.end": update(key, (t) => ({ ...t, end: ev.data, traceUrl: ev.data.trace_url })); break;
          case "error": update(key, (t) => ({ ...t, error: `${ev.data.code}: ${ev.data.message}` })); break;
          default: break;
        }
      }
    } catch (e) {
      const msg = e instanceof DOMException && e.name === "AbortError" ? "stopped by user"
        : e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
      update(key, (t) => ({ ...t, error: msg }));
    } finally {
      abortRef.current = null;
      update(key, (t) => ({ ...t, running: false }));
    }
  }

  function stop() {
    abortRef.current?.abort();
    if (sessionId) void api.abort(sessionId);
  }

  function newSession(v: string) {
    stop();
    setVersion(v);
    setSessionId(null);
    setTurns([]);
  }

  async function rate(t: Turn, rating: "up" | "down") {
    if (!t.turnId) return;
    const comment = rating === "down" ? (prompt("What was wrong? (optional, goes to the improver)") ?? undefined) : undefined;
    try {
      await api.feedback(t.turnId, rating, comment || undefined);
      update(t.key, (x) => ({ ...x, rating }));
    } catch (e) {
      alert(`feedback failed: ${String(e)}`);
    }
  }

  return (
    <div className="chat">
      <div className="toolbar">
        <label>
          Version{" "}
          <select value={version} onChange={(e) => newSession(e.target.value)} data-testid="version">
            <option value="best">best{best ? ` (${best})` : ""}</option>
            {versions.map((v) => <option key={v.id} value={v.id}>{v.id} · {v.status}</option>)}
          </select>
        </label>
        <button onClick={() => newSession(version)} disabled={running}>New chat</button>
        <span className="muted">{sessionId ? `session ${sessionId.slice(0, 8)}` : "new session on first message"}</span>
      </div>

      <div className="turns">
        {turns.length === 0 && <p className="muted">Ask about fees, fraud, card schemes, merchants… Follow-ups keep the context.</p>}
        {turns.map((t) => (
          <div className="turn" key={t.key}>
            <div className="user">{t.user}</div>
            {t.steps.length > 0 && (
              <ol className="steps" data-testid="steps">
                {t.steps.map((s) => (
                  <li key={s.call_id}>
                    <details>
                      <summary>
                        <code>{s.tool}</code> {s.ok === undefined ? "running…" : s.ok ? `ok · ${s.ms} ms` : `failed · ${s.ms} ms`}
                      </summary>
                      <pre>{JSON.stringify(s.args, null, 2)}</pre>
                      {s.preview && <pre>{s.preview}</pre>}
                    </details>
                  </li>
                ))}
              </ol>
            )}
            {t.text && <div className="assistant">{t.text}</div>}
            {t.clarification && (
              <div className="clarification" data-testid="clarification">
                <strong>Clarification needed:</strong> {t.clarification.question}
                {t.clarification.options && (
                  <div className="options">
                    {t.clarification.options.map((o) => <button key={o} onClick={() => send(o)} disabled={running}>{o}</button>)}
                  </div>
                )}
              </div>
            )}
            {t.answer && (
              <div className="answer" data-testid="answer">
                <div><strong>Answer:</strong> <code>{t.answer.answer}</code> {t.answer.valid ? "" : <span className="bad">(format invalid)</span>}</div>
                {t.answer.assumptions.length > 0 && <div className="muted">Assumptions: {t.answer.assumptions.join("; ")}</div>}
              </div>
            )}
            {t.error && <div className="bad" data-testid="error">Error — {t.error}</div>}
            <div className="meta" data-testid="meta">
              {t.running && <span>streaming…</span>}
              {t.end && (
                <>
                  <span>{t.end.outcome}</span>
                  <span>cost {fmtUsd(t.end.usage.cost_usd)}</span>
                  <span>cache hit {(t.end.cache_hit_rate * 100).toFixed(0)}%</span>
                  <span>{(t.end.latency_ms / 1000).toFixed(1)} s</span>
                  {t.end.usage.llm_calls !== undefined && <span>{t.end.usage.llm_calls} LLM · {t.end.usage.tool_calls} tools</span>}
                </>
              )}
              {t.traceUrl && <a href={t.traceUrl} target="_blank" rel="noreferrer">trace ↗</a>}
              {t.end && t.turnId && (
                <span className="rate">
                  <button onClick={() => rate(t, "up")} disabled={!!t.rating} aria-label="thumbs up">👍</button>
                  <button onClick={() => rate(t, "down")} disabled={!!t.rating} aria-label="thumbs down">👎</button>
                  {t.rating && <span className="muted">thanks</span>}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. What is the fraud rate of Crossfit_Hanna in 2023?" maxLength={2000} data-testid="input" />
        <button type="submit" disabled={running || !input.trim()}>Ask</button>
        <button type="button" onClick={stop} disabled={!running}>Stop</button>
      </form>
    </div>
  );
}
