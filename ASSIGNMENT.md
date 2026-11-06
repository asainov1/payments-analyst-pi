# Test Assignment — AI Software Engineer

**Build a self-improving, conversational payments analyst on Pi.**

- **Time:** 6–8 hours of work (budget an extra ~30 min to get familiar with Pi), **on site at our office**. We provide the task bundle and LLM access there.
- **Presentation:** 1 hour with the team after submission.
- **AI coding tools (Claude Code, Codex, etc.) are allowed and expected.** You own every line — be ready to explain and change any of it live.

---

## 1. Context

Our finance-ops team asks analytical questions about merchant payments every day: fees, fraud, card schemes, merchant categories. The answers depend on a dense rules manual and messy edge cases, and today an analyst has to dig through the data by hand.

We want an **AI analyst** that people can talk to, and that **gets measurably better from its own mistakes** — without an engineer hand-editing prompts after every failure.

## 2. What you build

### 2.1 Analyst agent (on Pi)
A conversational agent built on **[Pi](https://pi.dev)** that answers questions about the provided dataset.

It must be **agentic**, not prompt-in / answer-out:
- **Multi-turn:** follow-ups build on what was already found ("now split that by card scheme").
- **Clarifies** ambiguous questions instead of guessing.
- **Investigates:** plans, uses tools over the data and the manual, checks its result before answering.
- **Shows its work:** intermediate steps stream to the UI.
- Returns answers in the **format required** by each task's `guidelines`.

Connect Pi to the provided LiteLLM endpoint as a custom provider (see Pi's docs on custom models). How the agent reaches the data is up to you — Pi's built-in tools (read/bash with Python, DuckDB, …), custom tools via Pi extensions, or both.

### 2.2 Improver (self-improvement loop)
A process that makes the analyst better over time:
1. Runs the analyst on training tasks and scores the results with the provided scorer.
2. Analyses failures (and user 👎 feedback from the UI).
3. Proposes changes to the harness — e.g. playbook rules, Pi skills / helper scripts, tool descriptions, model routing.
4. **Promotes a change to a new version only if it improves the validation score**; otherwise rejects it.
5. Keeps every version, its diff, its scores and its cost. Any version can be served or rolled back.

The improver **must not** modify the scorer, the data, or the task files, and must not store task-specific answers.

### 2.3 Frontend
A web UI with:
- **Chat** with streaming agent steps, multi-turn sessions, and per-turn cost / cache-hit / link to trace.
- **Version selector** — chat with any harness version.
- **👍 / 👎 feedback** per answer, stored and available to the improver.
- **Improvements page** — versions table (val score, cost, cache hit rate, what changed, promoted/rejected) and a way to trigger an improvement run with a budget.

Usefulness matters much more than visual polish.

### 2.4 Runtime, cost and observability
- **Everything runs locally via `docker compose up`.**
- **Langfuse (self-hosted, in the same compose)** traces every session, turn, LLM call and tool call, with tokens, cost, latency and cache reads/writes.
- **Prompt caching** is used deliberately and **measured** (report your hit rate — don't assume it works).
- **Cost control:** per-task / per-turn limits and a global budget cap that stops runs.
- **Scale:** batch runs execute tasks concurrently, respect provider rate limits, retry transient failures, and can resume after a crash.

## 3. Requirements by priority

Prioritise. We'd rather see the **Must** tier done well than everything done badly — Extra mile only after that.

| Tier | Items |
|---|---|
| **Must** | Agentic multi-turn analyst on Pi · chat UI with streamed agent steps · improver with ≥ 2 promotions gated on validation · Langfuse traces with cost & cache data · batch CLI (§5) · `docker compose up` works from a clean clone |
| **Should** | Version selector · 👍/👎 feeding the improver · improvements page · global budget cap · shared rate limiter across concurrent sessions · resumable batch runs |
| **Extra mile** | **Ship the analyst as an MCP server** that other agents (Claude Code, Codex, …) can connect to — see §5.1 |

## 4. What we provide

```
data/            Merchant Payments & Fees dataset (CSV / JSON files + manual.md)
tasks/
  train.jsonl    186 tasks with answers — use for improvement
  val.jsonl       91 tasks with answers — use for promotion gating
scorer/
  score.py       official scorer (SHA-256 in scorer/SHA256 — do not modify)
.env.example     LiteLLM endpoint + virtual key (provided on site)
```

Task format:
```json
{"task_id": "1234", "question": "...", "guidelines": "Answer must be a number rounded to 2 decimals...", "level": "easy|hard", "answer": "..."}
```

Score any answers file with:
```bash
python scorer/score.py --tasks tasks/val.jsonl --answers answers.jsonl [--details per_task.jsonl]
```

We keep a **hidden holdout set** of different questions. We will run your frozen best version on it ourselves.

## 5. Interface contract

Your system must support (container or host command, your choice — document it):

```bash
docker compose up                                                  # UI + agent + Langfuse
harness solve   --tasks <file.jsonl> --version best --out answers.jsonl
harness improve --generations N --budget-usd X
harness report                                                     # per-version metrics
```

`answers.jsonl` lines: `{"task_id": "...", "answer": "..."}`

### 5.1 Extra mile: MCP server

Expose the analyst as an **MCP server** so any MCP client (Claude Code, Codex, …) can use it as a tool. Tool design is yours; at minimum a client should be able to:

- **Ask a question and continue the conversation** (multi-turn — e.g. via a session id), including answering the analyst's clarifying questions.
- **Choose a harness version** (default: `best`).
- **Get a link to the trace** and the cost of each answer.
- **Send feedback** that reaches the improver, like 👍/👎 in the UI.

Serve it from the same `docker compose up` (Streamable HTTP) and/or stdio, and include a one-line setup for Claude Code and Codex in your README. MCP calls must go through the same budget caps, rate limits and Langfuse tracing as the UI.

## 6. Rules

- **Pi is the agent foundation.** Everything else — languages, libraries, frameworks (incl. GEPA, DSPy, ACE-style approaches) — is your choice. Whatever you import, you must be able to explain what it does and what you built yourself.
- All LLM calls go through the **provided LiteLLM virtual key**. At runtime the analyst and improver may reach **only that endpoint**.
- **Do not** use external answer keys or published solutions for this data. Doing so disqualifies the submission. Disclose any external data you used.
- How you spend tokens is part of the evaluation.

## 7. Deliverables

1. **Git repo** (link or zip) that runs with `docker compose up` from a clean clone.
2. **`README.md`** — architecture diagram, how to run, key design decisions and trade-offs, what you'd do with another week.
3. **`REPORT.md`** — per version: val score, cost, cache hit rate, p50/p95 latency, what changed; total budget spent; honest notes on what didn't work and how confident you are that gains are real (not noise).
4. **Frozen `best` version** that we run on the holdout.
5. Your **Langfuse data** from the runs you report (export or a volume we can load), so we can inspect traces.

## 8. How we evaluate

- **Harness & agentic behaviour** — tool design, conversation handling, clarification, answer validation, guardrails.
- **Self-improvement & eval rigour** — gating, versioning, overfitting control, whether gains hold on the holdout.
- **Production readiness & scalability** — concurrency, rate limits, retries, resumability, budget enforcement, one-command setup.
- **Caching & cost management** — prompt layout, measured cache efficiency, cost per task / per version, spend discipline.
- **Observability** — can you (and we) explain any single answer from its trace?
- **Frontend** — useful for both the analyst user and the operator.
- **Ownership** — clarity of reasoning in the presentation and the ability to change the system live.

## 9. Presentation (1 hour)

- **15 min** — architecture, results, what didn't work.
- **20 min** — deep dive: we pick tasks and traces and ask you to walk through them.
- **15 min** — live change: we ask for a modification; you implement it (AI tools allowed).
- **10 min** — holdout results and discussion.

Good luck — we're looking for sound engineering judgement, not a perfect score.
