# Payments analyst on Pi — self-improving harness

Conversational analyst for the merchant-payments dataset, built on [Pi](https://pi.dev)
(`@earendil-works/pi-coding-agent@1.5.0`), with a self-improvement loop gated on the validation
set, cost/caching control and Langfuse tracing. Built as a time-boxed take-home assignment: a
conversational analyst that answers questions about merchant payments and improves itself from
its own mistakes without hand-edited prompts.
Results: [`REPORT.md`](REPORT.md). Full design, decisions and step log: [`SPEC.md`](SPEC.md).

**Scope:** Must and Should tiers, plus the Extra-mile **MCP server** (Streamable HTTP at `/mcp`;
no stdio transport).

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    UI[Web UI<br/>chat · improvements]
    CLI[harness CLI<br/>thin HTTP client]
    MCPC[Claude Code / Codex]
  end
  subgraph harness["harness service (Node/TS, one process)"]
    API[REST + SSE API]
    MCP[MCP /mcp<br/>Streamable HTTP]
    SM[Pi sessions<br/>one per chat / task]
    BR[Batch runner<br/>concurrent · resumable]
    IMP[Improver<br/>analyze → reflect → curate → gate]
    PX[LLM proxy 127.0.0.1<br/>budget · rate limit · retry · cost]
    TR[Tracer → Langfuse]
    TOOLS[Tools: sql · read_manual · python · submit_answer · ask_user]
  end
  SBX[py-sandbox<br/>no network]
  LLM[[LiteLLM]]
  LF[(Langfuse v4)]
  DATA[(bundle/data ro)]
  UI --> API
  CLI --> API
  MCPC --> MCP
  MCP --> SM
  API --> SM & BR & IMP
  BR --> SM
  IMP --> BR
  SM --> TOOLS --> DATA
  TOOLS --> SBX
  SM -->|all LLM calls| PX --> LLM
  IMP -->|reflector| PX
  SM --> TR --> LF
```

## Run

```bash
cp .env.example .env          # fill in LITELLM_BASE_URL and LITELLM_API_KEY
docker compose up -d --build  # harness (API + UI) on :8080, Langfuse on :3000, py-sandbox
```

- **UI** — http://localhost:8080
  - *Chat:* version selector, streamed tool steps and text, structured answer and clarifying
    questions, per-turn cost / cache hit / latency / trace link, 👍/👎 (a 👎 comment reaches the improver).
  - *Improvements:* versions table (val mean of 3 runs, easy/hard, $/task, cache hit, p50/p95, what
    changed, gate numbers or reject reason), diff vs parent, serve / roll back a version, start an
    improve run with a budget and follow its progress.
- **Langfuse** — http://localhost:3000 (`admin@local.test` / `admin12345`): one trace per task or
  chat turn, a generation per LLM call (tokens, cache read/write, cost, latency), a span per tool call.
- **CLI** — runs inside the harness container, as a client of the service there (same budget cap,
  rate limiter and tracing). Task / answer files go through `./io`, mounted as `/io`:

```bash
docker compose exec harness harness solve --tasks /io/tasks.jsonl --version best --out /io/answers.jsonl
docker compose exec harness harness improve --generations 3 --budget-usd 30
docker compose exec harness harness report          # per-version metrics; --md for REPORT
```

Tasks without an `answer` field (e.g. the holdout) are solved without scoring.

- **MCP** — the analyst as an MCP server over Streamable HTTP at `http://localhost:8080/mcp`, through
  the same chat service (budget cap, rate limiter, Langfuse tracing; origin `mcp`).
  Tools: `ask {question, session_id?, version?}` · `feedback {turn_id, rating, comment?}` · `list_versions {}`.
  A clarifying question comes back as `needs_clarification`; answer it with `ask` and the same `session_id`.

```bash
# Claude Code
claude mcp add --transport http payments http://localhost:8080/mcp
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.payments]
url = "http://localhost:8080/mcp"
tool_timeout_sec = 300
```

A turn can take up to `max_turn_s` (260 s for the current best); the server sends progress
notifications, and for Claude Code set `MCP_TOOL_TIMEOUT=300000` if your client does not reset its
timeout on progress.

Development on the host:

```bash
cd harness && npm ci
npm test                      # unit tests, no network, no LLM spend
npm run test:docker           # sandbox isolation tests (needs docker compose up)
npm run test:live             # live LLM tests (cost cents)
npm run serve                 # the service on the host (STATE_DIR defaults to ../state)
scripts/clean-clone-test.sh   # clone → compose up → health + one solve, on separate ports
```

## Versions

_Filled in at the end from `harness report --md` (see REPORT.md)._

<!-- versions:start -->
| version | status | parent | model | val (mean) | acc | easy | hard | runs | $/task | cache hit | p50/p95 s | reflect $ | what changed / why rejected |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v000 | baseline | - | claude-sonnet-5-5 | 67/91 | 73.6% | 97.0% | 70.4% | 67 / 67 / 67 | 0.0395 | 94.0% | 9.0 / 180.0 | - | Hand-written baseline: instructions + domain primer, full manual, data schema, empty playbook. |
| v001 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.227 | Both failures are fee-delta questions where the agent matched the rule's criteria correctly but charged the fee on every matching payment, including refused one |
| v002 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.420 | reflector returned no valid proposal — invalid_proposal: SyntaxError: Unexpected end of JSON input |
| v003 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.416 | reflector returned no valid proposal — invalid_proposal: SyntaxError: Unexpected end of JSON input |
| v004 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.198 | reflector returned no valid proposal — invalid_proposal: SyntaxError: Unexpected token '\', "\nexec(ope"... is not valid JSON; retry: SyntaxError: Unexpected to |
| v005 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.143 | This fixes fraud-ranking questions where the agent ranks groups by raw fraud counts or absolute fraud EUR instead of by fraud rate. Questions like 'top country  |
| v006 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.384 | reflector returned no valid proposal — invalid_proposal: SyntaxError: Unexpected token 'p', "python\nim"... is not valid JSON; retry: SyntaxError: Unexpected to |
| v007 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.256 | Fee-rule questions (applicable fee IDs, fee deltas, fees paid) are the most expensive class. The agent rewrites fee matching from scratch every time and loses m |
| v008 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.141 | The biggest loss on validation is timeouts. On average 12.7 of 91 turns per run hit the 180 s cap and ended with no answer, and p95 sits exactly at the cap. The |
| v009 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.149 | The largest measurable loss on validation is turns that hit the time cap. On average 12.7 of 91 turns per run reached the 180 s limit and ended with no answer a |
| v010 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.259 | The biggest losses are fee-rule questions: fee deltas and applicable fee IDs. The agent hand-writes matching logic each time. In delta questions it applies only |
| v011 | rejected | v000 | claude-sonnet-5-5 | - | - | - | - | - | - | - | - | 0.222 | Fee-rule questions (rate-change deltas and applicable fee IDs) make up most failures and most slow turns. In the delta questions the agent hand-writes partial m |
| v012 ★ | promoted | v000 | claude-sonnet-5-5 | 71/91 | 78.0% | 97.0% | 75.4% | 72 / 70 / 71 | 0.0487 | 94.0% | 9.0 / 260.0 | 0.161 | The largest measured loss is turns that hit the time cap, not any single numeric-error pattern. On validation, an average of 12.7 of 91 turns per run reached th |
| v013 | rejected | v012 | claude-sonnet-5-5 | 76.33/91 | 83.9% | 93.9% | 82.5% | 77 / 79 / 73 | 0.0360 | 95.4% | 22.4 / 260.0 | 0.178 | Most failures (9 of 12) are fee-delta questions, where the agent built one hand-written SQL filter from the `fees` table row. The errors go both high and low, w |
<!-- versions:end -->

## Key design decisions

Full table with trade-offs: SPEC §7.

- **One process owns every LLM call.** Pi talks to an in-process proxy on a random loopback port;
  only the proxy holds the LiteLLM key. It checks the budget before each call, enforces per-model
  rate limits, retries 408/429/5xx before the first byte, and records exact usage and cost (cache
  reads/writes included) in a SQLite ledger. UI, CLI, batch and improver share it.
- **Prompt laid out for caching.** Instructions → rules manual → data schema → playbook → skills
  form one stable prefix per version; the task goes into the user turn. Measured: 88–95 % of input
  tokens are cache reads in batch runs. An accepted `submit_answer` ends a batch turn (no extra call).
- **The agent never sees answers.** The batch runner passes only question + guidelines; DuckDB is
  sealed (SELECT only, no file access); model-written Python runs in a sandbox without network that
  cannot see `tasks/` or `scorer/`.
- **Improver = deterministic curator + statistical gate.** Opus proposes one change (playbook rule,
  skill, tool description or routing) from train trajectories; a curator applies it by rule id with
  dedup and size limits; leak and unknown-column checks reject task-specific content for $0;
  promotion needs the mean of 3 val runs to beat the parent's by T = 3 (derived from the noise between
  identical runs), net majority wins, no easy regressions and ≤ 1.3× cost per task.
- **Every proposal is a version** (rejected ones too) with its diff, metrics, reflection cost and
  reject reason; any promoted version can be served or rolled back.
- **Baseline chosen by rules fixed in advance**, revised once before the improver (Haiku → Sonnet);
  details and the train/val gap in REPORT.

## Budget and the holdout run

- The LiteLLM key has a $150 limit. Our own runs are capped at **$135** (`GLOBAL_BUDGET_USD`,
  enforced by the proxy before every LLM call); **$15 is reserved for the organisers' holdout run**.
- **Holdout cost estimate:** _$/task of the frozen best × number of holdout tasks — filled in at the
  end (REPORT.md)._
- **Honest caveat:** the spend ledger lives in the `harness_state` volume (not in git). On a clean
  clone the internal cap starts from zero, so the harness does not know what was already spent on
  the key. The real protection in that setting is the key's own $150 limit on the LiteLLM side; set
  `GLOBAL_BUDGET_USD` lower for a tighter local cap.

## Observability

Each task / chat turn is one Langfuse trace; batch runs share a Langfuse session (= run id); every
observation carries the harness version. The improver's reflection is traced too. Export / import
of all Langfuse data (for the deliverable):

```bash
scripts/export-langfuse.sh langfuse-export.tar.gz
scripts/import-langfuse.sh langfuse-export.tar.gz && docker compose up -d
```

## With another week

- **MCP over stdio** as well (today only Streamable HTTP), and MCP resources for traces / versions.
- **Persist Pi chat sessions** so a service restart keeps conversation context (turns are already stored).
- **A train/val split by question family**, so the improver learns from the same failure classes the
  gate measures (today: 92 % on train vs 74 % on val for v000, and timeouts appear only on val).
- **Cheaper gate:** sequential testing (stop validating as soon as the outcome is clear) instead of a
  fixed 3 runs; a Haiku pre-screen of candidates before Sonnet validation.
- **Skills that the agent calls as tools** (typed, versioned helpers) instead of prompt-inlined text +
  python imports; per-tool latency budgets to attack the 180 s timeouts directly.
- **Langfuse scores** for 👍/👎 and gate outcomes, and dashboards per version.
