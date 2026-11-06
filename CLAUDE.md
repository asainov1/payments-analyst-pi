# zimran-task

Self-improving payments analyst on Pi (test assignment). Plan, decisions and step status: `SPEC.md`.
Assignment text: `README.md`. Task bundle (never modify): `bundle/`.

## Shell and git rules

- Chain commands only with `&&`, never with `;` — a failed step must stop the chain.
- Scripts start with `set -euo pipefail`.
- Commit as a separate command, and only after tests and lint are green:
  `npm test` + `npm run lint` in `harness/`, `uvx ruff check .` at the repo root.
- One commit per SPEC step.

## Tests

- `cd harness && npm test` — unit tests, no network, no LLM spend.
- `cd harness && npm run test:live` — live LLM tests (`test/live/`), cost money; run only when a step needs them.

## Budget

- LiteLLM key budget $150. Our runs are capped at $135 (`GLOBAL_BUDGET_USD`); $15 stays reserved for the organisers' holdout run.
