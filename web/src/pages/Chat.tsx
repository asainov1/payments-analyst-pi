import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api, type Memory, type SessionSummary, type SessionTurn, streamTurn, type Usage, type VersionRow } from "../api.ts";

type Step = { call_id: string; tool: string; args: unknown; ok?: boolean; preview?: string; ms?: number; cancelled?: boolean };

/** Text and tool calls in arrival order: the agent's reasoning interleaves with its tool use. */
type Item = { kind: "text"; text: string } | { kind: "step"; step: Step } | { kind: "note"; text: string };

type Turn = {
  key: string;
  user: string;
  turnId?: string;
  items: Item[];
  clarification?: { question: string; options?: string[] };
  answer?: { answer: string; assumptions: string[]; valid: boolean };
  end?: { outcome: string; usage: Usage; cache_hit_rate: number; latency_ms: number; trace_url: string };
  traceUrl?: string;
  error?: string;
  running: boolean;
  rating?: "up" | "down";
};

const fmtUsd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`);

/** Model output as GitHub-flavoured markdown (tables, lists, code). Raw HTML is dropped and images are not
 *  loaded, so model text can never inject markup or fetch anything. */
const MD_COMPONENTS: Components = {
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
  table: ({ node: _n, ...p }) => (
    <div className="md-table">
      <table {...p} />
    </div>
  ),
};
function Md({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} components={MD_COMPONENTS}>
      {text}
    </Markdown>
  );
}

/** The open chat survives a page reload: its id is kept per browser (best effort — storage may be blocked). */
const STORE_KEY = "chat.session";
const stored = {
  get: () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
  set: (id: string | null) => { try { if (id) localStorage.setItem(STORE_KEY, id); else localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } },
};

/** A stored turn (GET /api/sessions/:id) → the view model; tool steps are not stored, only the outcome. */
function fromStored(t: SessionTurn): Turn {
  const prompt = t.usage.input + t.usage.cache_read + t.usage.cache_write;
  const clar = t.outcome === "clarification" && t.answer;
  return {
    key: t.id,
    user: t.user_message,
    turnId: t.id,
    items: t.answer && !clar ? [{ kind: "text", text: t.answer }] : [],
    clarification: clar ? { question: t.answer as string } : undefined,
    end: { outcome: t.outcome, usage: t.usage, cache_hit_rate: prompt ? t.usage.cache_read / prompt : 0, latency_ms: t.latency_ms, trace_url: t.trace_url ?? "" },
    traceUrl: t.trace_url ?? undefined,
    running: false,
  };
}

function appendText(items: Item[], delta: string): Item[] {
  const last = items.at(-1);
  return last?.kind === "text" ? [...items.slice(0, -1), { kind: "text", text: last.text + delta }] : [...items, { kind: "text", text: delta }];
}

export function Chat() {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [best, setBest] = useState("");
  const [version, setVersion] = useState("best");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const running = turns.some((t) => t.running);

  const refresh = () => {
    api.sessions().then((r) => setHistory(r.sessions)).catch(() => {});
    api.memories().then((r) => setMemories(r.memories)).catch(() => {});
  };

  async function open(id: string) {
    try {
      const s = await api.session(id);
      setSessionId(id);
      setVersion(s.session.version);
      setTurns(s.turns.map(fromStored));
      stored.set(id);
    } catch {
      stored.set(null); // deleted / unknown session: start fresh
    }
  }

  useEffect(() => {
    api.versions().then((r) => { setVersions(r.versions); setBest(r.best); }).catch(() => {});
    const last = stored.get();
    if (last) void open(last);
    refresh();
  }, []);

  const update = (key: string, fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.key === key ? fn(t) : t)));

  async function send(message: string) {
    const text = message.trim();
    if (!text || running) return;
    setInput("");
    const key = crypto.randomUUID();
    setTurns((ts) => [...ts, { key, user: text, items: [], running: true }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let sid = sessionId;
      if (!sid) {
        sid = (await api.createSession(version)).session_id;
        setSessionId(sid);
        stored.set(sid);
      }
      for await (const ev of streamTurn(sid, text, ctrl.signal)) {
        switch (ev.type) {
          case "turn.start": update(key, (t) => ({ ...t, turnId: ev.data.turn_id, traceUrl: ev.data.trace_url })); break;
          case "tool.start": update(key, (t) => ({ ...t, items: [...t.items, { kind: "step", step: { call_id: ev.data.call_id, tool: ev.data.tool, args: ev.data.args } }] })); break;
          case "tool.end": update(key, (t) => ({ ...t, items: t.items.map((it) => (it.kind === "step" && it.step.call_id === ev.data.call_id ? { kind: "step", step: { ...it.step, ok: ev.data.ok, preview: ev.data.preview, ms: ev.data.ms } } : it)) })); break;
          case "text.delta": update(key, (t) => ({ ...t, items: appendText(t.items, ev.data.delta) })); break;
          case "clarification": update(key, (t) => ({ ...t, clarification: ev.data })); break;
          case "answer": update(key, (t) => ({ ...t, answer: ev.data })); break;
          case "turn.end": update(key, (t) => ({ ...t, end: ev.data, traceUrl: ev.data.trace_url })); break;
          case "compaction.start": update(key, (t) => ({ ...t, items: [...t.items, { kind: "note", text: "compacting chat history…" }] })); break;
          case "compaction.end": {
            const d = ev.data;
            const k = (n?: number) => `${Math.round((n ?? 0) / 1000)}k`;
            const text = d.ok ? `chat history compacted: ${k(d.tokens_before)} → ${k(d.tokens_after)} tokens (earlier turns stay searchable)` : `history compaction failed: ${d.error}`;
            update(key, (t) => ({ ...t, items: t.items.map((it) => (it.kind === "note" && it.text === "compacting chat history…" ? { kind: "note", text } : it)) }));
            break;
          }
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
      refresh();
      // A step without tool.end will never finish (stop, error, dropped stream): mark it, don't leave "running…".
      update(key, (t) => ({
        ...t,
        running: false,
        items: t.items.map((it) => (it.kind === "step" && it.step.ok === undefined ? { kind: "step", step: { ...it.step, cancelled: true } } : it)),
      }));
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
    stored.set(null);
  }

  async function forget(id: string) {
    await api.forget(id);
    refresh();
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
        <select value="" onChange={(e) => e.target.value && void open(e.target.value)} disabled={running} data-testid="history">
          <option value="">History ({history.length})</option>
          {history.map((h) => (
            <option key={h.id} value={h.id}>
              {h.id === sessionId ? "● " : ""}{(h.title ?? "").slice(0, 48)} · {h.turns} turns · {h.version}
            </option>
          ))}
        </select>
        <span className="muted">{sessionId ? `session ${sessionId.slice(0, 8)}` : "new session on first message"}</span>
      </div>

      <details className="memory" data-testid="memory">
        <summary>Long-term memory ({memories.length}) — shared by all chats</summary>
        {memories.length === 0 && <p className="muted">Empty. Tell the analyst a preference ("remember: I work on Crossfit_Hanna") and it saves it here.</p>}
        <ul>
          {memories.map((m) => (
            <li key={m.id}>
              {m.text} <button onClick={() => void forget(m.id)} aria-label="forget">✕</button>
            </li>
          ))}
        </ul>
      </details>

      <div className="turns">
        {turns.length === 0 && <p className="muted">Ask about fees, fraud, card schemes, merchants… Follow-ups keep the context.</p>}
        {turns.map((t) => (
          <div className="turn" key={t.key}>
            <div className="user"><span className="who">You</span>{t.user}</div>
            <div className="timeline" data-testid="steps">
              {t.items.map((it, i) =>
                it.kind === "text" ? (
                  <div className="assistant md" key={i}><Md text={it.text} /></div>
                ) : it.kind === "note" ? (
                  <div className="muted note" key={i} data-testid="note">🗜 {it.text}</div>
                ) : (
                  <details className="step" key={it.step.call_id}>
                    <summary className={it.step.cancelled ? "st-cancel" : it.step.ok === undefined ? "st-run" : it.step.ok ? "st-ok" : "st-fail"}>
                      <code>{it.step.tool}</code> {it.step.cancelled ? "cancelled" : it.step.ok === undefined ? "running…" : it.step.ok ? `ok · ${it.step.ms} ms` : `failed · ${it.step.ms} ms`}
                    </summary>
                    <pre>{JSON.stringify(it.step.args, null, 2)}</pre>
                    {it.step.preview && <pre>{it.step.preview}</pre>}
                  </details>
                ),
              )}
            </div>
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
