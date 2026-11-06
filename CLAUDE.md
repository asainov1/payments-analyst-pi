# zimran-task

Self-improving payments analyst on Pi (test assignment). Plan, decisions and step status: `SPEC.md`.
Assignment text: `ASSIGNMENT.md` (root `README.md` is our deliverable). Task bundle (never modify): `bundle/`.

## Shell and git rules

- Chain commands only with `&&`, never with `;` — a failed step must stop the chain.
- Scripts start with `set -euo pipefail`.
- Commit as a separate command, and only after tests and lint are green:
  `npm test` + `npm run lint` in `harness/`, `uvx ruff check .` at the repo root.
- One commit per SPEC step.

## Tests

- `cd harness && npm test` — unit tests, no network, no LLM spend.
- `cd harness && npm run test:live` — live LLM tests (`test/live/`), cost money; run only when a step needs them.

## Libraries

- Before writing code against an external library, check its API via context7, not from memory: Pi (`@earendil-works/pi-coding-agent@1.5.0`, context7 `/earendil-works/pi`, `/websites/pi_dev`), Langfuse (v4, OTLP via `@langfuse/otel`), DuckDB, MCP TypeScript SDK.
- Claude prompt caching / thinking: use the claude-api skill.
- Versions are pinned exactly; record version changes in SPEC §7.

## Budget

- LiteLLM key budget $150. Our runs are capped at $135 (`GLOBAL_BUDGET_USD`); $15 stays reserved for the organisers' holdout run.
