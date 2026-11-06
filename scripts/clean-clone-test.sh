#!/usr/bin/env bash
# Clean-clone acceptance test (SPEC step 19: A1, A2 incl. a holdout-style file without `answer`).
#
# Clones the committed HEAD into a temp dir and brings the whole stack up as a separate compose
# project on its own ports and image tags, so a running dev stack (:8080 / :3000) is not touched.
# Checks: health, UI, Langfuse, versions/budget API, scorer checksum, `harness solve` on 2 easy
# train tasks (scored) and on 1 task without `answer` (scoring skipped), traces in Langfuse.
# Live LLM spend: ~3 tasks of the best version (cents).
#
# Usage: scripts/clean-clone-test.sh            # from the repo root; needs .env with the LiteLLM key
#   KEEP=1        leave the stack and the clone up for inspection (prints the teardown command)
#   NO_LLM=1      skip the solve steps (no spend)
#   SRC=<url|dir> clone from somewhere else (default: this repo)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$REPO}"
ENV_FILE="${ENV_FILE:-$REPO/.env}"
PROJECT="${PROJECT:-zimran-clean}"
export HARNESS_PORT="${HARNESS_PORT:-8180}"
export LANGFUSE_WEB_PORT="${LANGFUSE_WEB_PORT:-3100}"
export PY_SANDBOX_PORT="${PY_SANDBOX_PORT:-7170}"
export LANGFUSE_PUBLIC_URL="http://localhost:${LANGFUSE_WEB_PORT}"
export COMPOSE_PROJECT_NAME="$PROJECT"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/zimran-clean.XXXXXX")"
CLONE="$WORK/repo"
fails=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails + 1)); }
step() { printf '\n== %s\n' "$*"; }

dc() { docker compose -p "$PROJECT" -f "$CLONE/docker-compose.yml" -f "$WORK/override.yml" "$@"; }

cleanup() {
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo; echo "KEEP=1: stack '$PROJECT' and clone $CLONE left running."
    echo "teardown: docker compose -p $PROJECT -f $CLONE/docker-compose.yml -f $WORK/override.yml down -v && rm -rf $WORK"
    return
  fi
  step "teardown"
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$PROJECT/harness:local" "$PROJECT/py-sandbox:local" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  ok "stack '$PROJECT', its volumes, images and the clone removed"
}
trap cleanup EXIT

[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE (copy .env.example and add the LiteLLM key)"; exit 2; }

step "clone $SRC"
git clone -q "$SRC" "$CLONE"
echo "  HEAD $(git -C "$CLONE" rev-parse --short HEAD)"
cp "$ENV_FILE" "$CLONE/.env"
# Own image tags: building the clone must not overwrite the dev stack's images.
cat > "$WORK/override.yml" <<EOF
services:
  harness:
    image: $PROJECT/harness:local
  py-sandbox:
    image: $PROJECT/py-sandbox:local
EOF

step "docker compose up -d --build"
t0=$(date +%s)
dc up -d --build >"$WORK/up.log" 2>&1 || { tail -30 "$WORK/up.log"; bad "compose up failed"; exit 1; }
ok "up in $(( $(date +%s) - t0 )) s"

step "wait for health"
wait_http() { # url code timeout_s
  local i
  for ((i = 0; i < $3; i += 2)); do
    [[ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$1")" == "$2" ]] && return 0
    sleep 2
  done
  return 1
}
wait_http "http://localhost:$HARNESS_PORT/api/health" 200 180 && ok "harness /api/health 200" || bad "harness not healthy"
wait_http "http://localhost:$LANGFUSE_WEB_PORT/api/public/health" 200 240 && ok "langfuse health 200" || bad "langfuse not healthy"

step "API and UI"
ct=$(curl -s -m 5 -o /dev/null -w '%{http_code} %{content_type}' "http://localhost:$HARNESS_PORT/")
[[ "$ct" == 200\ text/html* ]] && ok "UI / -> $ct" || bad "UI / -> $ct"
best=$(curl -s -m 5 "http://localhost:$HARNESS_PORT/api/versions" | python3 -c 'import json,sys; print(json.load(sys.stdin)["best"])' 2>/dev/null || true)
want=$(tr -d '[:space:]' < "$CLONE/versions/BEST")
[[ -n "$best" && "$best" == "$want" ]] && ok "/api/versions best = $best (versions/BEST)" || bad "/api/versions best='$best', versions/BEST='$want'"
curl -s -m 5 "http://localhost:$HARNESS_PORT/api/budget" | grep -q '"cap_usd"' && ok "/api/budget" || bad "/api/budget"

step "scorer checksum inside the container"
if dc exec -T harness sh -c 'cd /app/bundle/scorer && [ "$(sha256sum score.py | cut -d" " -f1)" = "$(cut -d" " -f1 SHA256)" ]'; then
  ok "score.py matches scorer/SHA256"
else
  bad "scorer checksum mismatch"
fi

if [[ "${NO_LLM:-0}" != "1" ]]; then
  step "harness solve (live LLM, cents)"
  mkdir -p "$CLONE/io"
  grep '"level": "easy"' "$CLONE/bundle/tasks/train.jsonl" | head -2 > "$CLONE/io/cc-smoke.jsonl"
  grep '"level": "easy"' "$CLONE/bundle/tasks/train.jsonl" | sed -n 3p \
    | python3 -c 'import json,sys; [print(json.dumps({k: v for k, v in json.loads(l).items() if k != "answer"})) for l in sys.stdin]' \
    > "$CLONE/io/cc-holdout.jsonl"

  out=$(dc exec -T harness harness solve --tasks /io/cc-smoke.jsonl --version best --out /io/cc-smoke.answers.jsonl 2>&1) || true
  echo "$out" | tail -3 | sed 's/^/  | /'
  n=$(grep -c '"answer"' "$CLONE/io/cc-smoke.answers.jsonl" 2>/dev/null || true); n=${n:-0}
  [[ "$n" == 2 ]] && ok "scored file: 2/2 answers written" || bad "scored file: $n/2 answers written"
  echo "$out" | grep -q '^accuracy' && ok "scorer ran" || bad "no accuracy line (scorer did not run?)"

  out=$(dc exec -T harness harness solve --tasks /io/cc-holdout.jsonl --version best --out /io/cc-holdout.answers.jsonl 2>&1) || true
  echo "$out" | tail -2 | sed 's/^/  | /'
  n=$(grep -c '"answer"' "$CLONE/io/cc-holdout.answers.jsonl" 2>/dev/null || true); n=${n:-0}
  [[ "$n" == 1 ]] && ok "holdout-style file (no answer): 1/1 answers written" || bad "holdout-style file: $n/1 answers written"
  echo "$out" | grep -qi 'scoring skipped' && ok "scoring skipped without gold answers" || bad "expected 'scoring skipped'"

  step "traces in Langfuse"
  set -a; . "$CLONE/.env"; set +a
  sleep 5 # OTLP export is batched
  nobs=$(curl -s -m 5 -u "${LANGFUSE_PUBLIC_KEY:-pk-lf-local}:${LANGFUSE_SECRET_KEY:-sk-lf-local}" \
    "http://localhost:$LANGFUSE_WEB_PORT/api/public/v2/observations?limit=50" \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data", [])))' 2>/dev/null || true); n=${n:-0}
  [[ "$nobs" -gt 0 ]] && ok "$nobs observations in Langfuse" || bad "no observations in Langfuse"
  echo "  spent: $(curl -s -m 5 "http://localhost:$HARNESS_PORT/api/budget")"
fi

echo
if [[ $fails -eq 0 ]]; then echo "CLEAN CLONE: PASS"; else echo "CLEAN CLONE: FAIL ($fails)"; exit 1; fi
