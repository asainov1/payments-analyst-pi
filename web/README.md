# web — chat + improvements UI

Vite + React + TypeScript, no UI kit. Talks to the harness API (SPEC §4.1) and reads the chat turn
as SSE over `fetch` (a POST stream, which `EventSource` cannot do; SPEC §4.2).

```bash
npm ci
npm run mock                                  # mock API on :8787 (no LLM spend), see mock/server.ts
npm run dev                                   # http://localhost:5173, /api proxied to the mock
API_TARGET=http://127.0.0.1:8080 npm run dev  # same UI against the real harness
npm run build                                 # tsc + vite build → web/dist
```

Mock triggers: a message containing `fee?` → clarification, `fail` → `error` event, `slow` → slow stream.

## Pages

- **Chat** (`#/chat`): version selector (new session per version), streamed tool steps (args + preview),
  streamed text, structured answer + assumptions, clarification with options, per-turn outcome / cost /
  cache hit / latency / LLM and tool calls / trace link, 👍/👎 (👎 asks for a comment for the improver),
  Stop (aborts the fetch and calls `POST /api/sessions/:id/abort`).
- **Improvements** (`#/improvements`): versions table (val, easy/hard, $/task, cache hit, p50/p95, what
  changed, model/thinking, gate decision), diff vs parent, Serve = promote/rollback, start an improve run
  with generations + budget and follow its progress SSE.

## Integration notes for the harness

- `GET /api/versions` is consumed as `{ best, versions: VersionRow[] }` (see `src/api.ts`).
- `GET /api/runs/:id/events` is consumed as SSE `progress {done,total,stage}` and `run.end {status}`.
- Serving the build: point Fastify static at `web/dist` (or copy it into the image) — not done here,
  `harness/` belongs to the main session.
