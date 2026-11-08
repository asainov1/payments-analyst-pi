# zimran-task → payments-analyst-pi

Self-improving payments analyst on Pi (test assignment for Zimran, defended 2026-11-06).
Plan, decisions and step status: `SPEC.md`. Results and analysis: `REPORT.md`.
Assignment text: `ASSIGNMENT.md` (root `README.md` is our deliverable). Task bundle (never modify): `bundle/`.

## Branches and remote

- Remote: `origin` = github.com/asainov1/payments-analyst-pi (PRIVATE — `bundle/` holds Zimran's
  tasks, data and scorer; never make the repo public).
- `main` = the submitted version (`0cc4de8`), tag `best-frozen` → BEST = v012. Frozen: never commit
  to `main`, never move the tag.
- `dev` = all work after the submission (shared sql/python schema, long-term memory, fixes,
  post-freeze experiments v016–v020). Work and commit here; one folder, no extra worktrees.

## Shell and git rules

- Chain commands only with `&&`, never with `;` — a failed step must stop the chain.
- Scripts start with `set -euo pipefail`.
- Commit as a separate command, and only after tests and lint are green:
  `npm test` + `npm run lint` in `harness/`, `uvx ruff check .` at the repo root,
  `npm run typecheck` in `web/` when the UI changed.
- Stage only our own paths explicitly (`git add harness/ SPEC.md …`), never `git add -A` / `git add .`.
- Commits carry no AI co-author trailer (no `Co-Authored-By: Claude`).
- Before a commit or push: no secret from `.env` in the diff (`git diff --cached | grep -F "<key>"` is empty).
- The API contract for `web/` is SPEC §4.1–§4.2: any change to it goes into SPEC first.

## Tests

- `cd harness && npm test` — unit tests, no network, no LLM spend.
- `cd harness && npm run test:live` — live LLM tests (`test/live/`), cost money; run only when a step needs them.
- `cd harness && npm run test:docker` — against the running py-sandbox (`docker compose up -d py-sandbox sandbox-gateway`).

## Running the stack

- `docker compose -p zimran-task up -d` (UI/API :8080, Langfuse :3000). After changing
  `config/data-schema.sql` rebuild py-sandbox: the sandbox's `payments.duckdb` is built into its image.
- State (SQLite `harness.db`, Pi chat sessions `pi-sessions/*.jsonl`, long-term memory) lives in the
  `harness_state` volume; `docker compose down -v` deletes it.

## LLM access

- The LiteLLM key from Zimran expired on 2026-11-07 (every call → 401).
- Dev fallback: `scripts/openrouter-shim.mjs` on :4010 + `LITELLM_BASE_URL=http://host.docker.internal:4010`
  in `.env` (`OPENROUTER_API_KEY` there too). Default model `nvidia/nemotron-3-ultra-550b-a55b:free`:
  slower and weaker than Claude, rate-limited — chat demos only, no eval/improver runs. The ledger
  still prices tokens as Claude, so `$` figures under the shim are nominal.

## Libraries

- Before writing code against an external library, check its API via context7, not from memory: Pi (`@earendil-works/pi-coding-agent@1.5.0`, context7 `/earendil-works/pi`, `/websites/pi_dev`), Langfuse (v4, OTLP via `@langfuse/otel`), DuckDB, MCP TypeScript SDK.
- Claude prompt caching / thinking: use the claude-api skill.
- Versions are pinned exactly; record version changes in SPEC §7.

## Budget

- LiteLLM key budget $150; our runs were capped at $135 (`GLOBAL_BUDGET_USD`), $57 spent at submission.
