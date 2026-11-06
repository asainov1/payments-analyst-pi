# SPEC — Self-improving payments analyst on Pi

Источники: `ASSIGNMENT.md` (текст задания, копия `~/Desktop/ai-engineer-test-assignment/README.md`; далее «задание»), PDF, llm-access.md, ответы в чате.
Дата: 2026-11-06.

---

## 1. Цель и «готово, когда…»

**Цель.** Разговорный ИИ-аналитик на Pi по датасету платежей (DABStep-подобный: `payments.csv`, `fees.json`, `merchant_data.json`, `manual.md`), который улучшает свой харнесс сам, по гейту на val, с контролем стоимости, кэша и трейсингом в Langfuse.

**Готово, когда (проверяемо):**

| # | Критерий | Проверка |
|---|---|---|
| A1 | `git clone && cp .env.example .env && docker compose up` поднимает UI, API, MCP и Langfuse без ручных шагов | чистый клон в `/tmp`, `curl :8080/api/health` → 200, `curl :3000` (Langfuse) → 200 |
| A2 | `harness solve --tasks /io/<file>.jsonl --version best --out /io/answers.jsonl` (хостовая `./io` смонтирована в `/io`) пишет по строке на каждую задачу; если в задачах нет `answer` (holdout), скоринг пропускается без ошибки | val: `python scorer/score.py --tasks tasks/val.jsonl --answers io/answers.jsonl` → `missing: 0`; файл без `answer` → `solve` завершается `done`, `answers.jsonl` полный |
| A3 | `docker compose restart harness` посреди solve, повторный `solve` с тем же `--out` доделывает только оставшиеся задачи; задачи в `running` возвращаются в `pending`, оборванная последняя строка `answers.jsonl` отбрасывается | число **задач**, обработанных во втором запуске, = число не-`done` на момент рестарта |
| A4 | `harness improve --generations N --budget-usd X` создаёт версии; **≥ 2 промоушена** гейтом на val; отклонённые версии тоже сохранены | `harness report`: v000 `baseline` + ≥ 2 версии `promoted` + ≥ 1 `rejected` |
| A5 | Каждая версия хранит: дифф к родителю, val score, cost, cache hit rate, p50/p95 latency, статус | `versions/vNNN/metrics.json` + `diff.patch` |
| A6 | Чат: multi-turn (follow-up использует контекст), стрим шагов (tool calls) в UI, cost / cache-hit / ссылка на трейс на каждый ход | ручной сценарий: «fraud rate Crossfit_Hanna 2023» → «now split by card scheme» |
| A7 | На неоднозначном вопросе в чате агент задаёт уточнение (`ask_user`), а не отвечает | ручной сценарий: «what's the fee?» → уточняющий вопрос |
| A8 | Langfuse: trace на ход, generation на каждый LLM-вызов (tokens, cost, cacheRead/cacheWrite, latency), span на каждый tool call; session = чат-сессия / run | открыть трейс по ссылке из UI |
| A9 | Cache hit rate измерен и отчитан (`cache_read / (input + cache_read + cache_write)`) | `harness report`, REPORT.md |
| A10 | Глобальный кап $135 (+ $15 резерв под holdout вне капа) и per-turn / per-task лимиты реально останавливают работу | тест с `GLOBAL_BUDGET_USD=0.01` → 402 / run `stopped_budget` |
| A11 | 👍/👎 сохраняются и попадают во вход improver | `harness improve` логирует `feedback_items: N` |
| A12 | Version selector: чат с любой версией; rollback = смена `best` | UI + `POST /api/versions/:id/promote` |
| A13 | (Extra) MCP: ask (multi-turn по `session_id`, выбор версии), trace URL + cost, feedback; одна строка подключения для Claude Code / Codex | `claude mcp add --transport http payments http://localhost:8080/mcp` → вызов `ask` |
| A14 | Improver не трогает `data/`, `tasks/`, `scorer/`, не хранит ответы задач; инструменты агента не видят `tasks/` / `scorer/`; у python-sandbox нет egress | `sha256sum -c` по scorer; leak-check тест; vitest «tool не читает val.jsonl» (`sql`: `read_json_auto('…/val.jsonl')` → ошибка; `python`: `open('/bundle/tasks/val.jsonl')` → `FileNotFoundError`); `python`: `urllib.urlopen('https://example.com')` и `subprocess curl` → ошибка сети |

---

## 2. Архитектура

Один процесс `harness` (Node/TS) владеет **всеми** LLM-вызовами: агентом, improver, лимитером и бюджетом. CLI — тонкий HTTP-клиент к нему. Так rate limiter и бюджет общие для UI, MCP, batch и improver без Redis.

```mermaid
flowchart LR
  subgraph Clients
    UI[Web UI<br/>Vite+React]
    CLI[harness CLI<br/>thin client]
    MCPC[Claude Code / Codex]
  end

  subgraph harness["harness (Node/TS, :8080)"]
    API[REST + SSE API]
    MCP[MCP Streamable HTTP /mcp]
    SM[Session manager<br/>Pi AgentSession per chat]
    BR[Batch runner<br/>queue + resume]
    IMP[Improver loop]
    GOV[Governor<br/>rate limiter · retry · budget ledger]
    TR[Tracer<br/>Pi events → Langfuse]
    VS[Version store<br/>versions/vNNN]
    TOOLS[Tools: sql · python · read_manual · read_skill<br/>submit_answer · ask_user]
  end

  subgraph sbx["py-sandbox (internal network, no egress)"]
    PY[python exec<br/>ro fs · uid 65534 · mem/pids limits]
  end

  DB[(SQLite<br/>state/harness.db)]
  DATA[(data/ + manual<br/>ro, видно инструментам)]
  TASKS[(tasks/ scorer/<br/>ro, только BR и score)]
  IO[(./io → /io<br/>holdout in/out)]
  LLM[[LiteLLM<br/>litellm.zimran.net]]
  LF[(Langfuse v4<br/>web+worker+pg+clickhouse+redis+minio)]
  SCORER[[python scorer/score.py]]

  UI -- SSE --> API
  CLI --> API
  MCPC --> MCP
  API --> SM & BR & IMP
  MCP --> SM
  BR --> SM
  IMP --> BR
  IMP --> VS
  SM --> TOOLS --> DATA
  TOOLS -- HTTP --> PY --> DATA
  SM --> GOV --> LLM
  IMP --> GOV
  SM --> TR --> LF
  IMP --> TR
  BR --> TASKS
  BR --> IO
  BR --> SCORER --> TASKS
  SM & BR & IMP --> DB
  SM --> VS
```

**Поток chat-хода:** UI `POST /turns` → SessionManager берёт Pi-сессию (версия фиксирована на сессию) → `session.prompt()` → события Pi → (a) SSE в UI, (b) Tracer → Langfuse, (c) Governor считает cost → агент вызывает `submit_answer` или `ask_user` → `turn.end` с cost / cache / trace_url.

**Поток improve:** родительская версия → её провалы на train (+ 👎) → reflection-LLM → Proposal → **curator** (детерминированно применяет ops, дедуп, лимиты) → leak-check → smoke на подвыборке train → полный val → гейт → `promoted` (новый `best`) или `rejected`. Каждый Proposal становится версией `vNNN`, даже если отклонён до val.

**Изоляция gold-ответов:** batch-runner читает `tasks/*.jsonl` сам и передаёт агенту **только `question` + `guidelines`**; `answer` не покидает BR / скорер. `tasks/` и `scorer/` не смонтированы в py-sandbox и недоступны `sql` (см. §4.4).

---

## 3. Ядро

### 3.1 Модели данных (TS-типы, хранятся в SQLite, кроме Version)

```ts
type VersionId = `v${string}`;            // v000, v001…
interface VersionManifest {               // versions/vNNN/manifest.json — в git, иммутабелен
  id: VersionId; parent: VersionId | null; created_at: string;
  status: 'baseline' | 'candidate' | 'promoted' | 'rejected';
  reject_stage?: 'curator' | 'leakcheck' | 'smoke' | 'gate';   // где отклонён (null у promoted)
  change_summary: string;                 // «что изменилось», 1–3 строки
  models: { analyst: string; reflector: string };   // model routing
  thinking: ThinkingLevel;                // enum Pi 1.x: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' (xhigh/max — только если модель поддерживает)
  limits: { max_tool_calls: number; max_turn_usd: number; max_turn_s: number; max_task_usd: number; max_output_tokens: number };  // не правится improver'ом, кроме max_turn_s через RoutingOp
  tool_descriptions: Record<ToolName, string>;      // правится improver'ом
}
// + versions/vNNN/{system.md, playbook.json, playbook.md, skills/<name>/{SKILL.md, *.py}, diff.patch, metrics.json}
// playbook.json — источник истины; playbook.md — детерминированный рендер (по id) для промпта и человеческого diff

interface PlaybookRule { id: string;     // "R001"… выдаёт curator, не reflector; id не переиспользуются
  text: string; added_in: VersionId; updated_in: VersionId; merged_from?: string[] }

interface VersionMetrics {
  val:   { correct: number; n: number; accuracy: number; by_level: Record<string, number> } | null;  // null у отклонённых до val
  reflect_cost_usd: number;               // стоимость рефлексии, породившей версию (из ledger по ref improve/<run>/gen<k>/reflect)
  reject_reason?: string;                 // напр. "over_limit: 41 rules > 40", "growth_under_pressure", "leak: gold literal"
  curation?: { applied: number; skipped_duplicates: string[]; rules_before: number; rules_after: number; tokens_after: number };
  train_sample?: { correct: number; n: number };
  cost_usd: number; cost_per_task_usd: number;
  cache_hit_rate: number; latency_p50_s: number; latency_p95_s: number;
  gate?: GateDecision;
}

interface Session { id: string; version: VersionId; origin: 'ui' | 'mcp' | 'batch';
  created_at: string; status: 'idle' | 'running' | 'closed'; pi_session_file: string }

type TurnOutcome = 'answered' | 'clarification' | 'limit_exceeded' | 'error' | 'aborted';
interface Turn { id: string; session_id: string; idx: number; user_message: string;
  outcome: TurnOutcome; answer: string | null; assumptions: string[];
  usage: Usage; latency_ms: number; trace_id: string }

interface Usage { input: number; output: number; cache_read: number; cache_write: number;
  cost_usd: number; llm_calls: number; tool_calls: number }

interface Run { id: string; kind: 'solve' | 'improve_eval' | 'improve_smoke';
  version: VersionId; tasks_file: string; out_path: string;
  status: 'queued' | 'running' | 'done' | 'stopped_budget' | 'failed';
  budget_usd: number | null; usage: Usage; created_at: string }
interface RunTask { run_id: string; task_id: string;
  status: 'pending' | 'running' | 'done' | 'error'; attempts: number;
  answer: string | null; correct: boolean | null; turn_id: string | null }

interface Feedback { id: string; turn_id: string; rating: 'up' | 'down';
  comment: string | null; consumed_by: VersionId | null; created_at: string }

interface LedgerEntry { id: string; ts: string; scope: 'chat' | 'solve' | 'improve' | 'mcp';
  ref: string; cost_usd: number }       // SUM = глобальный расход

// Proposal — либо content, либо routing, никогда оба (иначе нельзя атрибутировать прирост)
type ContentOp =
  | { op: 'playbook_add'; text: string }                        // id выдаёт curator
  | { op: 'playbook_edit'; rule_id: string; text: string }
  | { op: 'playbook_remove'; rule_id: string }
  | { op: 'playbook_merge'; rule_ids: string[]; text: string }  // ≥ 2 правил → одно новое (id новый, merged_from)
  | { op: 'skill_upsert'; name: string; skill_md: string; files: Record<string, string> }
  | { op: 'tool_description'; tool: ToolName; text: string };
interface RoutingOp {                   // allow-list полей: только { model, thinking, max_turn_s }
  op: 'routing';
  model?: 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5'; // → models.analyst; только модели, зарегистрированные в Pi-провайдере (сейчас claude-*); gpt/gemini — после регистрации их провайдера
  thinking?: ThinkingLevel;             // валидация по enum Pi SDK
  max_turn_s?: number;                  // целое ∈ [120, 300]; кандидат обязан пройти cost-guard гейта (≤ 1.3× $/task родителя); прочие лимиты и reflector improver не трогает
}
type Proposal =
  | { kind: 'content'; rationale: string; ops: ContentOp[] }
  | { kind: 'routing'; rationale: string; ops: [RoutingOp] };

interface GateDecision { parent_correct: number; cand_correct: number; wins: number; losses: number;
  confirmed_wins: number; easy_regressions: number; threshold_T: number;
  parent_cost_per_task: number; cand_cost_per_task: number;
  decision: 'promote' | 'reject'; reason: string }
```

### 3.2 Модули

| Модуль | Ответственность |
|---|---|
| `llm/provider` | Генерирует Pi `models.json`: провайдер `litellm`, `api: "anthropic-messages"` для claude-*, `openai-completions` для gpt / gemini; цены в `cost` для подсчёта Pi |
| `agent/session` | `createAgentSession({ modelRuntime, tools: [<только наши>], customTools })` (Pi 1.5) с `DefaultResourceLoader({ systemPromptOverride })`; схемы tools — TypeBox (`Type` из `@earendil-works/pi-ai`); skills из `versions/vNNN/skills`, `customTools`, `SessionManager` с файлом в `state/sessions/` |
| `agent/prompt` | Сборка system prompt в порядке, удобном для кэша: **[статичная инструкция → сжатый manual → схема данных → playbook]** → история → вопрос + guidelines |
| `agent/tools/*` | `sql`, `python`, `read_manual`, `submit_answer`, `ask_user` (контракты в §4.4) |
| `agent/validate` | Парсинг `guidelines` в `AnswerFormat` (`number{d}`, `list`, `scheme_name`, `merchant_name`, `grouped_list`, `yes_no`, `free`) и проверка ответа |
| `runtime/governor` | Семафор конкурентности + token bucket (RPM/TPM на модель), retry 429/5xx/ECONNRESET (exp backoff + jitter, 4 попытки), budget ledger с жёстким стопом |
| `obs/tracer` | Pi events → Langfuse SDK: trace на ход, generation на `message_end` assistant (usage из `message.usage`), span на `tool_execution_start/end`. Reflector improver'а тоже Pi-сессия (без tools) → идёт через тот же Tracer (trace `improve/<run>/gen<k>/reflect`) |
| `runs/batch` | Очередь RunTask, конкурентность N, идемпотентный append в `answers.jsonl`, resume по статусам в БД; агенту отдаёт только `question` + `guidelines`; `--tasks`/`--out` только под `/io` или `bundle/tasks` |
| `runs/score` | Вызов `python scorer/score.py --details` (скорер не импортируем и не копируем); пропускается, если хотя бы у одной задачи нет `answer` |
| `runs/splits` | Фиксированный (seed) стратифицированный по `level` сплит train: `improve` (≈ 150) и `report-holdout` (≈ 36). Хранится только список `task_id` в `config/splits.json`. Improver видит только `improve`-часть; `report-holdout` гоняется для REPORT («держится ли прирост вне val») |
| `improver/*` | `analyze` → `propose` → `curate` → `leakcheck` → `smoke` → `validate` → `gate` |
| `improver/curator` | **Детерминированный, без LLM.** Применяет ops по `rule_id` (unknown id → reject `invalid_op`); дедуп `playbook_add` / результата merge: нормализованный текст (lowercase, без пунктуации, схлопнутые пробелы) совпал или Jaccard по словам ≥ 0.9 с существующим правилом → op пропускается и пишется в `curation.skipped_duplicates`; лимиты playbook **≤ 40 правил и ≤ 3000 токенов** (оценка `ceil(chars/4)` — детерминированно, без токенайзера); skills ≤ 8 шт., файл skill ≤ 20 KB. Рендер `playbook.md` — по возрастанию id |
| `versions/store` | Создание `vNNN` из родителя + результата curator'а для **каждого** Proposal (в т. ч. отклонённого до val), `diff.patch` (unified diff по дереву), указатель `versions/BEST`. Отклонённые на leak-check: в `diff.patch` и файлах версии найденные литералы заменены на `[REDACTED:<check>]` |
| `api`, `mcp`, `cli` | Транспорт поверх одного ядра |

### 3.3 Состояние хода и условия выхода

```
idle ──prompt──▶ running
running ──submit_answer(valid)──────────▶ answered        (exit)
running ──ask_user(q) [chat/mcp only]───▶ clarification   (exit; следующий user-msg продолжает сессию)
running ──submit_answer(invalid)────────▶ running         (tool error с причиной; ≤ 3 раз, затем принимаем как есть + флаг)
running ──limits (tool_calls | $ | s)───▶ limit_exceeded  (session.abort(); в batch ответ = лучший черновик или "Not Applicable")
running ──LLM error after retries───────▶ error
running ──global budget exhausted───────▶ aborted
```
- **Batch-режим:** `ask_user` не регистрируется; в промпт добавляется «если вопрос неоднозначен — выбери наиболее разумную трактовку и запиши её в `assumptions`». Ответ = последнее значение `submit_answer`.
- **Чат:** финальный текст агента + структурированный `answer` (если был `submit_answer`). `submit_answer` в чате необязателен: на свободные вопросы агент отвечает текстом.

### 3.4 Improver: состояния поколения

```
ANALYZE  ─ родитель: провалы на последнем прогоне train-`improve`-сплита (+ непотреблённые 👎), кластеризация по типу ошибки (format / wrong-filter / wrong-formula / NA-misuse / timeout).
           Приоритет выборки — критерий предметной области, НЕ состав val: hard-задачи про комиссии (все форматы) + успешные, но долгие (> 60 с) траектории
PROPOSE  ─ reflector (**Opus** `claude-opus-5-5`, Pi-сессия через Tracer) получает: текущие system/playbook/skills, ≤ 8 компактных трейсов провалов (вопрос, guidelines, шаги, ответ, «неверно»).
           Gold-ответ показываем ТОЛЬКО как «верно/неверно» + для чисел направление ошибки — значение не отдаём  → Proposal JSON
           (content XOR routing; routing — только allow-list {model, thinking, max_turn_s}, thinking ∈ enum Pi SDK, max_turn_s ∈ [120, 300])
           Давление лимита: если у родителя ≥ 80% любого лимита (≥ 32 правил или ≥ 2400 токенов), в промпт reflector'а
           добавляется обязательное условие «число правил не растёт: новые правила только через merge/remove существующих»
           Всегда в промпте reflector'а: **запрет хардкода значений из данных** (суммы, счётчики, ставки, списки id, «у мерчанта X объём Y») —
           правила и skills только описывают, КАК вычислить; числа агент получает запросом к данным в момент ответа
CURATE   ─ curator применяет ops (детерминированно, без LLM). Reject (версия сохраняется, status=rejected, reject_stage=curator, val=null):
           invalid_op · over_limit (> 40 правил или > 3000 токенов после применения) · growth_under_pressure (родитель ≥ 80% и rules_after > rules_before)
           · empty (после дедупа не осталось изменений). Отдельной LLM-консолидации-кандидата нет: ASSIGNMENT §2.2 — промоушен только при росте val,
           поэтому консолидация = обычный content-Proposal с merge/remove и проходит обычный гейт
LEAKCHK  ─ отклонить, если в патче: task_id; ≥ 8-словная n-gram из любого question train/val; любой gold-ответ train/val длиной ≥ 4 символов как литерал;
           упоминание путей `tasks/`, `scorer/`, `*.jsonl`.
           Gold-литералы, которые встречаются как токены в `data/*`, `manual.md` или тексте guidelines (`GlobalCard`, `Rafa_AI`, `Not Applicable`, …), из словаря исключаются;
           **предвычисленные факты:** reject skill / правила, содержащего литеральную таблицу > 10 пар «имя → число»
           (dict/map-литерал `'X': 1.23`, строки markdown-таблицы `| X | 1.23 |`, CSV-строки `X,1.23`; считаются по всем файлам кандидата)
SMOKE    ─ кандидат на (провалы из ANALYZE ∪ 15 случайных пройденных improve-train); продолжаем, если fixed − broken ≥ 2
VALIDATE ─ полный val (91) **k = 3 раза** для кандидата; у родителя — его k прогонов (считаются один раз и хранятся)
GATE     ─ promote ⇔ (mean_k(cand) − mean_k(parent) ≥ T_k) ∧ (confirmed_wins − losses ≥ 1) ∧ easy_regressions = 0 ∧ cand_cost_per_task ≤ 1.3 × parent_cost_per_task,
           mean_k — среднее число верных по k = 3 прогонам val; задача «верна» у стороны, если верна в большинстве (≥ 2 из 3) её прогонов;
           confirmed_wins / losses — задачи, где большинство кандидата и большинство родителя расходятся (большинство из 3 = подтверждение);
           easy_regressions — easy-задачи, верные по большинству у родителя и неверные у кандидата;
           T_k = max(2, ⌈2 · σ_run · √(2/k)⌉), σ_run = √(F̄ / 2), F̄ — среднее число «перевернувшихся» задач между парами прогонов v000 (baseline: F = 17 → σ_run ≈ 2.9, T₃ = 5);
           пишется в config/gate.json и REPORT
PROMOTE  ─ status=promoted, BEST=vNNN, свежий train-sample(60) для следующего ANALYZE
REJECT   ─ status=rejected (+ reject_stage, reject_reason, reflect_cost_usd, val=null если до VALIDATE); ops и причина → «негативная память» reflector'а (не повторять).
           Каждая версия сохраняется (ASSIGNMENT §2.2 «keeps every version»), в git тоже
Выход: generations исчерпаны ∨ budget_usd исчерпан ∨ 3 rejected подряд ∨ глобальный кап
```

**Generator** (кто и как гоняет аналитика для ANALYZE: модель, число прогонов на задачу, размер выборки) — решается по результату шага 9 (baseline: $/task, разброс между прогонами).

---

## 4. Контракты

### 4.1 REST API (`:8080`, JSON; ошибки `{ "error": { "code": string, "message": string } }`)

| Метод | Путь | Запрос | Ответ |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, langfuse, llm }` |
| POST | `/api/sessions` | `{ version?: "best" \| VersionId }` | `201 { session_id, version }` |
| GET | `/api/sessions/:id` | — | `{ session, turns: Turn[] }` |
| POST | `/api/sessions/:id/turns` | `{ message: string }` | `200 text/event-stream` (§4.2) |
| POST | `/api/sessions/:id/abort` | — | `202` |
| POST | `/api/feedback` | `{ turn_id, rating: "up"\|"down", comment? }` | `201 { id }` |
| GET | `/api/versions` | — | `{ best: VersionId, versions: Array<VersionManifest & { metrics: VersionMetrics \| null }> }` (порядок — по id; `web/src/api.ts` `VersionRow`) |
| GET | `/api/versions/:id/diff` | — | `text/x-diff` |
| POST | `/api/versions/:id/promote` | — | `200 { best }` (ручной rollback / forward) |
| POST | `/api/runs/solve` | `{ tasks_file, version, out, concurrency? }` — пути только под `/io/` или `bundle/tasks/`, иначе `400` | `202 { run_id }`. Тот же `out` + незавершённый run: если run жив — `200 { run_id }` (CLI переподключается к прогрессу), если остановлен — resume. Задачи без `answer` → скоринг пропущен, `correct: null` |
| POST | `/api/runs/improve` | `{ generations, budget_usd }` | `202 { run_id }`; до реализации improver'а (шаги 11–13) — `501 not_implemented` |
| GET | `/api/runs/:id` | — | `{ run, progress: { done, total, correct? }, usage }` |
| GET | `/api/runs/:id/events` | — | SSE: `progress { done, total, stage }` при каждом изменении (`stage`: `solve` для batch; `analyze`/`propose`/`curate`/`smoke`/`validate`/`gate` для improve), в конце `run.end { status }` (`done`/`stopped_budget`/`failed`); heartbeat 15 с; уже завершённый run → сразу `progress` + `run.end` |
| GET | `/api/report` | — | per-version metrics + total spend |
| GET | `/api/budget` | — | `{ cap_usd, spent_usd, remaining_usd }` |

**Коды ошибок:** `400 invalid_request` · `404 not_found` · `409 session_busy` (ход уже идёт) / `run_in_progress` · `402 budget_exhausted` (глобальный кап) · `422 version_invalid` · `503 llm_unavailable` (после ретраев) · `500 internal`.

### 4.2 SSE-события хода (`event: <type>`, `data: JSON`)

| type | data |
|---|---|
| `turn.start` | `{ turn_id, session_id, version, trace_url }` |
| `text.delta` | `{ delta }` |
| `thinking.delta` | `{ delta }` (если thinking включён) |
| `tool.start` | `{ call_id, tool, args }` |
| `tool.end` | `{ call_id, tool, ok, preview (≤ 2 KB), ms }` |
| `llm.usage` | `{ model, input, output, cache_read, cache_write, cost_usd, ms }` (на каждый LLM-вызов) |
| `clarification` | `{ question, options? }` |
| `answer` | `{ answer, assumptions[], format, valid }` — только если ход вызвал `submit_answer` (batch); в чате ответ = текст из `text.delta`, он же `Turn.answer` |
| `turn.end` | `{ turn_id, outcome, usage: Usage, cache_hit_rate, latency_ms, trace_url }` (`turn_id` добавлен в шаге 14 — совместимо) |
| `error` | `{ code, message }` |

Порядок гарантирован: `turn.start` → (…)* → `turn.end` | `error`. Heartbeat-комментарий каждые 15 с.
`outcome` в `turn.end`: `answered` | `clarification` (был `ask_user`, перед этим событие `clarification`) | `limit_exceeded` | `aborted` (`POST /abort`) | `error`. `Usage` в `turn.end` и в `Turn.usage` (`GET /api/sessions/:id`): `{ input, output, cache_read, cache_write, cost_usd, llm_calls, tool_calls }`.

**Статика UI:** `GET /` и прочие не-`/api` пути отдаются из `web/dist` (Fastify static), если сборка есть; SPA-роутинг через `#/…`, fallback не нужен.

### 4.3 MCP (Streamable HTTP `/mcp` + stdio `harness mcp`)

| Tool | Вход | Выход |
|---|---|---|
| `ask` | `{ question, session_id?, version? = "best" }` | `{ session_id, turn_id, status: "answered"\|"needs_clarification", answer?, clarification_question?, assumptions, cost_usd, trace_url, version }` |
| `feedback` | `{ turn_id, rating: "up"\|"down", comment? }` | `{ ok }` |
| `list_versions` | `{}` | `[{ id, status, val_accuracy, is_best }]` |

Ответ на уточнение = следующий `ask` с тем же `session_id`. Через Governor и Tracer идёт тот же путь, что у UI (origin=`mcp`).

### 4.4 Инструменты агента

| Tool | Контракт |
|---|---|
| `sql` | `{ query: string }` → DuckDB in-process. На старте данные из `data/` грузятся в **таблицы**, затем `SET enable_external_access=false; SET lock_configuration=true` — `read_csv/read_json/COPY/ATTACH` к любым файлам невозможны. Таблицы: `payments`, `fees` (списки как `LIST`), `merchants`, `mcc`, `acquirer_countries`, хелпер-view `payments_m` с `month` из `day_of_year`. Результат: ≤ 200 строк в markdown + `row_count`; таймаут 20 с |
| `python` | `{ code: string }` → HTTP-вызов в сервис **`py-sandbox`** (§4.5): `python3` в `/work/<session>` (tmpfs), смонтированы только `data/` (ro) и `skills/` текущей версии (ro); pandas + duckdb; таймаут 60 с; stdout/stderr ≤ 8 KB. Сети нет на уровне docker (internal network) |
| `read_manual` | `{ section?: string, grep?: string }` → фрагмент `manual.md` (весь мануал в промпте сжат; полный текст по запросу) |
| `read_skill` | `{ name: string }` → `SKILL.md` из `versions/<v>/skills/<name>/` (только этот каталог). Встроенные Pi `read` / `bash` / `write` / `edit` **отключены** |
| `submit_answer` | `{ answer: string, assumptions?: string[] }` → `{ ok }` или ошибка `{ reason, expected_format }` |
| `ask_user` | `{ question: string, options?: string[] }` → завершает ход (только chat / mcp) |

### 4.5 Внешние контракты

- **LiteLLM:** `LITELLM_BASE_URL`, `LITELLM_API_KEY` из `.env` (в git только `.env.example`). Модели: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `gpt-6.1-sol`, `gemini-3.8-flash`. Для Claude используем Anthropic Messages (`/v1/messages`) с `cache_control` (Pi ставит его сам для `anthropic-messages`). **Предположение, проверяется в шаге 1.** Fallback: `openai-completions` с ручными `cache_control` в content-блоках.
- **Факты пробника (шаг 1, 2026-11-06, LiteLLM 1.106.6):** все 5 моделей в `/v1/models`; `/v1/messages` + `cache_control` работает для Sonnet и Haiku (запись → чтение 18 411 токенов на 2-м вызове). Цены, выведенные из `x-litellm-response-cost-*`, $/Mtok:

  | модель | input | output | cache write (5m) | cache read |
  |---|---|---|---|---|
  | claude-sonnet-5-5 | 2.00 | 10.00 | 2.50 | 0.10 |
  | claude-haiku-5-5 | 0.10 | 0.50 | 0.125 | 0.01 |

  Заголовков `x-ratelimit-*` прокси **не отдаёт** → Governor стартует со статических лимитов из env и снижает темп на 429. Каждый ответ несёт `x-litellm-response-cost` (+ разбивку input / output / cache) — это точная стоимость вызова от самого прокси. Opus / gpt / gemini ценами пока не проверены.
- **Стоимость:** первично `usage.cost` из Pi (по ценам в `models.json`); в конце run сверяемся с `GET /key/info` LiteLLM (spend по ключу), расхождение > 10% → warning в report.
- **Langfuse v4** (`4.74.0`, self-hosted, урезанный официальный compose): `LANGFUSE_HOST=http://langfuse-web:3000`, ключи проекта задаются через `LANGFUSE_INIT_*` env, поэтому работает из чистого клона без ручной настройки.
- **Песочница `py-sandbox`** (отдельный compose-сервис): только сеть `sandbox` с `internal: true` (нет egress; harness подключён к ней и к default), `read_only: true` + tmpfs `/work`, `user: "65534:65534"`, `mem_limit: 1g`, `pids_limit: 128`, `cpus: 1`, `cap_drop: [ALL]`, `no-new-privileges`. Mounts: `bundle/data:ro`, `versions:ro`. **Нет** `tasks/`, `scorer/`, `state/`, `.env`. Минимальный exec-сервер (POST `/exec {code, session, version}` → `{stdout, stderr, exit, ms}`).
- **harness:** `bundle/data`, `bundle/tasks`, `bundle/scorer` `:ro`; `./io:/io` (rw); egress нужен только на LiteLLM и Langfuse (внутри compose). Сетевой allow-list для самого harness не ставим (§7).
- **Скорер:** только как subprocess; при старте проверяем `sha256(scorer/score.py) == scorer/SHA256`, иначе отказ.

---

## 5. Структура папок

```
zimran-task/
├── SPEC.md  README.md  REPORT.md
├── docker-compose.yml          # harness + langfuse stack
├── .env.example  .gitignore    # .env, state/ в ignore
├── bundle/                     # копия задания: data/ tasks/ scorer/ (ro-mount, не трогаем)
├── harness/
│   ├── Dockerfile  package.json  tsconfig.json
│   ├── src/
│   │   ├── config.ts
│   │   ├── llm/{provider.ts, pricing.ts}
│   │   ├── agent/{session.ts, prompt.ts, validate.ts}
│   │   ├── agent/tools/{sql.ts, python.ts, manual.ts, submit.ts, ask_user.ts}
│   │   ├── runtime/{governor.ts, limiter.ts, retry.ts, budget.ts}
│   │   ├── obs/tracer.ts
│   │   ├── runs/{batch.ts, score.ts}
│   │   ├── improver/{loop.ts, analyze.ts, propose.ts, curator.ts, leakcheck.ts, smoke.ts, gate.ts}
│   │   ├── versions/store.ts
│   │   ├── db/{schema.sql, db.ts}
│   │   ├── api/{server.ts, sse.ts, routes/*.ts}
│   │   ├── mcp/server.ts
│   │   └── cli/harness.ts
│   └── test/                   # vitest
├── py-sandbox/                 # Dockerfile + exec-сервер (python, pandas, duckdb)
├── config/splits.json          # task_id для improve / report-holdout (без ответов)
├── io/                         # mount /io: holdout-задачи и answers.jsonl (в .gitignore, кроме .keep)
├── web/                        # Vite + React, собирается в harness/public
│   └── src/{pages/Chat.tsx, pages/Improvements.tsx, components/*}
├── versions/
│   ├── BEST                    # "v003"
│   └── v000/ {manifest.json, system.md, playbook.md, skills/, metrics.json, diff.patch}
├── scripts/{export-langfuse.sh, import-langfuse.sh, clean-clone-test.sh}
└── state/                      # volume: harness.db, sessions/, runs/, work/
```

---

## 6. План (от самого рискованного)

Порядок исполнения: **1–8 → 9 (baseline в фоне) → 14–15 (тонкий чат) → 10–12 → 13 (improve в фоне) → 16–18 → 19–20**. Номера шагов — идентификаторы, не порядок.

| # | Шаг (15–30 мин) | Готово, когда… |
|---|---|---|
| 1 ✅ | **Пробник LiteLLM:** `/v1/models`, `/v1/messages` для Sonnet/Haiku с `cache_control`, два одинаковых запроса; заголовки rate-limit / cost | на 2-м запросе `cache_read_input_tokens > 0`; записаны цены, `x-ratelimit-*` (→ RPM/TPM Governor) |
| 2 ✅⁴ | **Pi + LiteLLM** через SDK: `models.json`, одна сессия, `customTools` с тестовым tool, подписка на события | скрипт печатает `tool_execution_start/end` и `message.usage.cacheRead > 0` на 2-м ходе |
| 3 ✅⁵ | **Langfuse в compose** + Tracer на событиях Pi. **Time-box 40 мин** на v4 (план писался под v3) (web+worker+pg+clickhouse+redis+minio); не взлетел → fallback **Langfuse v2 + Postgres** (тот же JS SDK, тот же Tracer) | `docker compose up` → трейс с generation (tokens / cost / cacheRead) и tool-span виден в UI Langfuse |
| 4 ✅¹ | **Tools `sql` + `read_manual`**, DuckDB-таблицы + `enable_external_access=false`, промпт v000 (manual + схема); BR отдаёт агенту только question + guidelines | 3 easy train-задачи верно через `harness-dev ask`; vitest: `sql` с `read_json_auto('…/val.jsonl')` → ошибка |
| 5 ✅ | **`validate` + `submit_answer`** | vitest: валидатор принимает **все** gold-ответы train+val в их guidelines (277/277, включая 3 пустых `''`) и отвергает 12 заведомо кривых. Факт: для «rounded to N decimals» gold иногда короче (`-10.48` при N=14) → правило «≤ N знаков» |
| 6 ✅² | **Governor:** семафор, token bucket (RPM/TPM из шага 1, адаптивное снижение на 429), retry, ledger, per-turn и per-task лимиты | vitest с fake-LLM: 429 → ретрай; кап $0.01 → `budget_exhausted`; лимит tool_calls → `limit_exceeded`; per-task $ превышен → задача `error` |
| 7 ✅³ | **Batch runner + `harness solve`** (CLI → API), `/io`-mount, resume, пропуск скоринга без `answer`, `config/splits.json` | `solve` на 10 train → скорер; A3 (restart посередине); файл без `answer` → `done` |
| 8 ✅⁶ | **`py-sandbox`** (internal network, ro, uid 65534, mem/pids limits) + tool `python` + `read_skill` | `python` считает то же, что `sql`, на 1 задаче; A14: `open(val.jsonl)` → `FileNotFoundError`, `urllib` / `subprocess curl` → ошибка сети |
| 9 | **Baseline v000 (фон):** **прогрев кэша перед fan-out (з):** в каждом batch сначала 1 задача (пишет префикс), потом параллель — иначе N первых запросов платят запись 1.25×; выбор модели на 20 improve-train (Haiku vs Sonnet), затем **2× val**, improve-train, report-holdout. Метрики пишутся в БД (run-уровень); `metrics.json` материализуется в шаге 10 | в БД есть 4 run'а v000; посчитан порог `T` (§3.4) и $/task |
| 14 ✅⁷ | **API сессий + SSE**, multi-turn, `ask_user` | `curl -N` показывает поток событий; follow-up использует контекст |
| 15 ✅ | **UI Chat (тонкий):** стрим шагов, cost / cache / trace-ссылка, 👍/👎, version selector | ручной сценарий A6 / A7 |
| 10 | **Version store + `harness report`** (`metrics.json` из БД, `diff.patch`, bind-mount `./versions`; rejected-версии тоже в git) | `report` печатает таблицу с v000; `diff.patch` генерируется |
| 11 | **Improver: analyze → propose → curate → leakcheck** (reflector — Pi-сессия через Tracer; content XOR routing; allow-list; v000 переводится на `playbook.json`) | валидный Proposal на провалах v000; curator-тесты (без LLM): ops по rule_id, merge, дедуп, `over_limit` (41-е правило), `growth_under_pressure` (родитель 32 правила, +1 → reject; merge 2→1 → pass), рендер детерминирован; отклонённый кандидат сохранён версией с diff / причиной / `reflect_cost_usd`, `val = null`; leak-тесты: gold-литерал → reject + `[REDACTED]` в diff, `GlobalCard`/`Not Applicable` в правиле → pass, путь `tasks/` → reject; skill с dict-литералом из 11 пар `'merchant': число` → reject, из 10 → pass, вычисляющий SQL-шаблон → pass; промпт reflector'а содержит запрет хардкода; reflect-трейс виден в Langfuse |
| 12 | **Improver: smoke → validate → gate → promote/reject** (T из шага 9, confirmed_wins, cost-guard ×1.3) | 1 поколение end-to-end, `GateDecision` записан в metrics |
| 13 | **Прогон improve (фон, бюджет ≤ $60)**, пока идут шаги 16–18 | ≥ 2 `promoted` |
| 16 ✅ | **UI Improvements:** таблица версий, дифф, кнопка «improve» с бюджетом, promote/rollback | запуск improve из UI виден в прогрессе |
| 17 | **👎 → improver** | `improve` логирует `feedback_items > 0`, 👎-ход попадает в ANALYZE |
| 18 | **MCP** (Streamable HTTP; stdio = прокси к `:8080`, чтобы шёл через общий Governor) | Claude Code и Codex: `ask` → `needs_clarification` → `ask` с session_id → `answered` |
| 19 ✅ | **Чистый клон** | `scripts/clean-clone-test.sh` зелёный (A1, A2 включая holdout-файл без `answer`) |
| 20 | **Финализация deliverables** (§9): заморозка best, report-holdout для best, экспорт Langfuse, README / REPORT | чек-лист §9.3 закрыт |

² Governor готов как библиотека (`Governor.call`). Точка подключения к Pi (Pi сам делает HTTP-запросы) решается в шаге 2: хук Pi перед запросом или локальный governor-прокси между Pi и LiteLLM (бонус: точная стоимость из `x-litellm-response-cost`).

³ С fake-solver'ом; реальный агент подключается как `Solver` после шага 2. Сплит по факту: improve 148 / report-holdout 38 (`ceil(0.2·n)` по каждому уровню, seed 42). Относительные пути `--tasks` резолвятся от корня репо (`bundle/tasks/val.jsonl`).

⁷ API по §4.1–§4.2 (`POST/GET /api/sessions`, `POST /turns` → SSE, `POST /abort`; 404 / 409 `session_busy` до старта стрима; обрыв SSE клиентом → abort хода → прокси отменяет upstream). Unit (фейковая Pi-сессия): порядок событий, multi-turn в одной Pi-сессии, атрибуция расхода по ходам `chat/<session>/<turn>`, `ask_user` → `clarification` + `terminate`, 409/abort. Живой (Haiku, $0.0022): «Crossfit_Hanna 2023» → 55,139; «now split that by card scheme» → таблица по 4 схемам с той же суммой (cache 98%); «What's the fee?» → `ask_user`, outcome `clarification`. Сервис: `npm run serve` (`src/server/main.ts`).

⁶ `npm run test:docker` (без LLM): pandas считает 138236 строк как `sql`; duckdb работает; обход всей ФС не находит `val.jsonl` / `train.jsonl` / `score.py`; urllib, raw socket, подпроцесс `python3 -I -S` и `litellm.zimran.net` — все без сети; uid 65534, root fs и `data/` read-only, workdir пишется; fork-бомба упирается в `pids_limit`, песочница жива. Unit-контракт инструмента — против того же `server.py`, запущенного локально.

⁵ Langfuse v4 поднялся с первой попытки, fallback не понадобился. Живой тест (Haiku, ≈ $0.002): задача 1014 → в Langfuse `agent`-корень, 3 `generation` (токены, cache read/write, cost, latency 0.9–2.6 с), `tool` `sql` и `submit_answer`; `sessionId` = run id, `version` на каждом наблюдении. Экспорт / импорт (`scripts/export-langfuse.sh`, `import-langfuse.sh`) проверен: архив поднят в чистом проекте `lfcheck`, тот же трейс читается целиком.

⁴ Живой тест (Haiku, $0.003): tool-call через Pi → прокси → LiteLLM; cache read 18.9k на 2-м и 3-м вызове; **новая сессия с тем же system prompt тоже читает кэш** (18.8k) — fan-out batch работает от прогретого префикса; ledger = Pi `usage.cost` (±1%); на стриме LiteLLM `x-litellm-response-cost` не отдаёт → стоимость из usage.

¹ Смоук (после шага 2, `npm run test:live`, вне дефолтного `npm test`): 3 easy improve-train задачи, v000 на Sonnet и на Haiku. Критерий (согласован): у всех ответов валидный формат и ≥ 2/3 верных на каждой модели — LLM недетерминирован, разброс меряется на val в шаге 9. Факт: Sonnet 3/3 и 2/3 в двух прогонах (1041: взял 30 мерчантов из `merchants` вместо 5 из `payments`), Haiku 3/3 и 3/3; Pi пишет `<cwd>` в system prompt → общий `cwd` у всех сессий, иначе нет кэша между задачами (hit 73% → 88%, Sonnet $0.030 → $0.008–0.014 на тёплую задачу).

**Сквозные шаги deliverables (не в конце, а по ходу):**
- после шага 3 — скелет `README.md` (mermaid из §2, «как запустить»), дальше дописываю по мере готовности;
- с шага 9 — `harness report --md > REPORT.md` генерирует таблицы автоматически; каждый прогон сразу пишет метрики, руками только «что не сработало»;
- после каждого промоушена — `git commit` версии (`versions/vNNN` + `BEST`), чтобы история версий была в git, а не только в БД;
- `scripts/export-langfuse.sh` пишется вместе с шагом 3 и проверяется импортом в чистый volume сразу, а не в последний час.

**Бюджет ($150 ключ; кап наших прогонов $135, $15 — резерв под holdout, пока организаторы не ответят; оценка при ≈ $0.10/task):** шаги 1–8 ≈ $5 · baseline (2×20 + 2×91 + 150 + 36 ≈ 408 задач) ≈ $41 · improve ≈ $60 · report-holdout best + финальный val + демо ≈ $10 · резерв $19. Если шаг 9 покажет > $0.15/task — ANALYZE на improve-train-sample(60) вместо 150 и improve ≤ 3 поколений.

---

## 7. Решения и компромиссы

| Решение | Почему | Цена |
|---|---|---|
| Один процесс владеет всеми LLM-вызовами, CLI = HTTP-клиент | общий лимитер и бюджет без Redis / распределённых локов | `harness solve` требует поднятый сервис (`docker compose exec harness harness solve …`, задокументировать в README); масштаб = один узел |
| Pi через SDK (`createAgentSession`), а не RPC-процесс на сессию; `@earendil-works/pi-coding-agent@1.5.0` (версия зафиксирована точно; API сверено по context7 `/earendil-works/pi/v1.4.0` и `/websites/pi_dev`) | прямой доступ к событиям / usage, нет IPC, проще трейсинг | больше привязки к SDK-API Pi 1.x (`ModelRuntime`, `tools` allow-list, TypeBox-схемы); апгрейд Pi — только осознанно |
| Встроенные `bash` / `write` / `edit` Pi отключены, свои `sql` / `python` | контроль песочницы, предсказуемые tool-span'ы в Langfuse | теряем «универсальность» coding-агента |
| Claude через `anthropic-messages` | явный `cache_control`, измеримый `cache_read` | зависит от того, пропускает ли LiteLLM `/v1/messages` (шаг 1) |
| Порядок промпта: статика → manual → схема → playbook → история → вопрос | максимальный общий префикс между задачами | правка playbook инвалидирует кэш версии (это нормально: версия = новый префикс) |
| **Batch: `ask_user` выключен, трактовка + `assumptions` в трейс** (ваш ответ: в задании нет разрешения конфликта) | скорер засчитывает уточнение как ошибку | в batch агент «угадывает», что формально противоречит «clarifies instead of guessing» |
| **Improver может писать playbook, skills / хелперы, описания tools, routing** (ASSIGNMENT §2.2 разрешает) | хелперы (матчинг fee-правил, месячные агрегаты) дают больше, чем текст промпта | риск переобучения → leak-check + gate на val |
| **Curator детерминированный** (ACE-style: reflector предлагает дельты, curator применяет), лимит 40 правил / 3000 токенов; без LLM-консолидации как отдельного кандидата | ASSIGNMENT §2.2: промоушен только при росте val — «чистка» без прироста не может стать версией-победителем; давление ≥ 80% заставляет reflector сокращать через merge/remove внутри обычного гейта | при упоре в лимит прирост даётся тяжелее (нужно и сократить, и улучшить); оценка токенов `chars/4` грубая |
| **Каждый Proposal = версия**, в т. ч. отклонённый curator'ом / leak-check'ом (`val = null`, причина, `reflect_cost_usd`) | ASSIGNMENT §2.2 «keeps every version, its diff, its scores and its cost» | номера версий тратятся на мусорные кандидаты; больше файлов в `versions/` |
| Отклонённые на leak-check хранятся с литералами, заменёнными на `[REDACTED:<check>]` | иначе сохранённый diff сам стал бы «хранением task-specific answers» (ASSIGNMENT §2.2) | diff такой версии не воспроизводит исходное предложение дословно |
| **Нельзя** (подтверждено организаторами): конкретные ответы задач, `task_id`, формулировки вопросов, пути к `tasks/` / `scorer/` — ни в playbook, ни в skills, ни в коде версий | ASSIGNMENT §2.2 «must not store task-specific answers» | leak-check отклоняет такие кандидаты (§3.4) |
| **Можно** (подтверждено организаторами): общие правила и формулы в playbook / skills, хелпер-скрипты, которые вычисляют значения из `data/` во время ответа | ASSIGNMENT §2.2 разрешает «playbook rules, Pi skills / helper scripts» | граница с «предвычисленными фактами» — по строке ниже |
| **Предвычисленные факты о датасете не храним** (уточнено у организаторов): reflector обязан предлагать только вычисляющий код / правила «как считать», хардкод значений из данных запрещён промптом; leak-check отклоняет skill / правило с литеральной таблицей > 10 пар «имя → число» | граница overfitting: таблица значений из данных — скрытое хранение ответов, даже если формально это «факт о данных»; на holdout с другими вопросами она не обобщается | агент каждый раз пересчитывает (больше токенов и tool-вызовов); порог 10 пар — эвристика, мелкие справочники (например, маппинг capture_delay) проходят |
| Reflector не видит значений gold-ответов, только верно/неверно (+ направление для чисел) | снижает риск зашивания ответов | ему сложнее найти причину ошибки |
| **Гейт по среднему из k = 3 прогонов val** для кандидата и родителя: `mean₃(cand) − mean₃(parent) ≥ T₃ = 5`, `confirmed_wins − losses ≥ 1` (по большинству из 3), 0 регрессий easy, cost ≤ 1.3× | шум baseline: 17 из 91 задач меняют исход между двумя одинаковыми прогонами (39 vs 42 верных) — одиночный прогон не отличает улучшение от шума | ≈ $1.2 на поколение (3 × val на Haiku); T₃ = 5 задач (≈ 5.5 п.п.) — часть реальных улучшений меньше порога будет отклонена |
| Proposal = content XOR routing; routing только `{model, thinking, max_turn_s ∈ [120, 300]}`; `max_turn_s` — только вместе с cost-guard гейта (решение после baseline: 9 из 91 задач val упирались в 180 с) | прирост атрибутируется одному типу изменения | больше поколений на комбинированные улучшения |
| Train делится на improve (≈150) и report-holdout (≈36) | независимая проверка «держится ли прирост» вне val, по которому отбираем | improver видит меньше провалов |
| v000 содержит человеческий «domain primer» (данные важнее readme, `[]` = `null` = любое, fraud = fraud_vol / total_vol, маппинг capture_delay) | ответы на ваши вопросы 7; не тратим бюджет improver на очевидное | меньше «места» для демонстрации self-improvement |
| Версии в git (`versions/`), рантайм-состояние в SQLite (volume) | frozen best и история едут с клоном | метрики дублируются в `metrics.json` и БД |
| Бюджет $150: кап наших прогонов $135 (`GLOBAL_BUDGET_USD`), $15 резерв под holdout | holdout запускают организаторы — на него должен остаться ключ | improve ограничен ~4–6 поколениями |
| Код агента (python) — в отдельном `py-sandbox` в internal-сети без egress; сам `harness` сетевым allow-list не ограничен | исполняемый LLM-код физически не выходит наружу и не видит `tasks/`; allow-list-прокси для harness — часы работы | harness (наш код, не LLM-код) формально может выйти в интернет; закрываем ревью кода + LLM только через LiteLLM baseUrl |
| Выборка ANALYZE по критерию предметной области: hard-задачи про комиссии всех форматов + успешные, но долгие (> 60 с) траектории; **не** подгоняем под состав val | подгонка выборки под состав val = подстройка под судью (уточнено с пользователем) | improver видит мало провалов: на improve-train 21 из 148 против 49–52 из 91 на val |
| Reflector — Opus; параллельность прогонов 12 (governor: 12 одновременных LLM-вызовов, 240 RPM, снижение на 429) | на val-провалах точность hard 39–43%: нужна сильная рефлексия; бюджет позволяет | дороже рефлексия (≈ центы на поколение) |
| Анализ на train-sample(60), а не на full train каждое поколение | экономия ~$15 на поколение | ANALYZE видит не все провалы |
| **LLM-прокси in-process** (`src/llm/proxy.ts`): отдельный listener на `127.0.0.1:<random>`, не маршрут на `:8080` | ключ LiteLLM знает только прокси, снаружи контейнера он недостижим; один choke point для бюджета / лимитов / ретраев / учёта | ещё один слой между Pi и LiteLLM (≈ +1 мс) |
| Прокси пробрасывает любой путь; разбор usage — Anthropic SSE/JSON и OpenAI chat-completions | routing на gpt/gemini не потребует правки прокси | Pi-провайдер сейчас зарегистрирован только для `claude-*` (`anthropic-messages`); gpt/gemini-провайдер — когда improver дойдёт до routing |
| Атрибуция: inline-расширение на сессию с `before_provider_headers` → `x-harness-ref / scope / max-tokens / budget-usd`; без ref/scope → 400 | документированный хук, срабатывает на каждый запрос, переживает подмену модели реестром | расширение пересоздаётся на каждую сессию (дёшево) |
| Ретраи только в прокси (408/429/5xx/сеть, до первого байта); у Pi `retry.enabled=false`, `provider.maxRetries=0` | иначе до 3×4 = 12 запросов на вызов мимо учёта | обрыв посреди стрима: batch повторяет задачу (2 попытки), в чате — ошибка хода |
| Бюджет: проверка перед вызовом, без резервирования; `max_tokens` выше сессионного cap → 400 | перерасход ≤ concurrency × стоимость вызова (центы) при запасе $10 до лимита ключа | теоретический небольшой overshoot |
| Стоимость: на стриме — всегда из итогового usage по `config/prices.json`; заголовок `x-litellm-response-cost` пишется как `provider_cost_usd`; источник для полного не-стримового ответа — заголовок | факт: на стриме LiteLLM заголовок не отдаёт; usage-расчёт сверен с заголовком на шаге 1 | сверка с `/key/info` в конце run'а остаётся нужна |
| Отмена: закрытие клиента → `AbortController` на upstream fetch; строка ledger `aborted=1, estimated=1`, input/кэш точно из `message_start`, output ≈ символы/4 | не платим за генерацию, которую никто не читает; доля оценочных расходов видна | output у прерванных — оценка |
| Единая таблица цен `config/prices.json` — снимок `/v1/model/info` (`harness`-скрипт `fetchPrices`); из неё же `cost` в Pi-провайдере | Pi `usage.cost` (UI хода) и ledger (бюджет) совпадают | проверка дрейфа цен при старте — вместе с entrypoint сервиса (шаг 14) |
| Модель на сессию: `maxTokens = max(limit, thinkingBudget + 1024)`; допустимые thinking: off/minimal/low/medium/high (у наших моделей нет `thinkingLevelMap` → xhigh/max недоступны) → иначе 422 `version_invalid` | правило из Q10; 1024 = `MIN_ANSWER_TOKENS` самого Pi | — |
| Pi: `cacheWarming=off`, compaction off в batch / on в чате, изолированный `agentDir` в `state/`, `noExtensions/noSkills/noContextFiles`, `User-Agent` снят | честный замер hit rate; ничего из `~/.pi` разработчика не попадает в харнесс | skills версий подключаются своим `read_skill`, не механизмом Pi |
| Явные зависимости `@earendil-works/pi-ai@1.5.0` и `typebox@1.3.27` (те же версии, что внутри Pi) | импортируем `thinkingBudgetForLevel` и `Type` напрямую, не через транзитивные пакеты | — |
| **Langfuse v4 `4.74.0`** (не v3 из исходного плана: v4 — текущий официальный compose; самый свежий 4.76 не берём — вышел вчера); compose урезан: без AI gateway, телеметрия off, наружу только `:3000`, проект и ключи через `LANGFUSE_INIT_*` | чистый клон поднимается без ручной настройки | v4 работает в режиме `events_only`: старый `/api/public/traces/{id}` недоступен, чтение — через `/api/public/v2/observations` |
| Трейсинг через официальный SDK `@langfuse/tracing` + `@langfuse/otel` `6.0.2` (OTLP; старый `/api/public/ingestion` в v4 deprecated) на собственном `NodeTracerProvider` (не глобальный) | SDK сам шлёт `x-langfuse-ingestion-version: 4` → данные видны сразу | OTel зафиксирован на линии 2.x (`api 1.9.1`, `sdk-trace-* 2.12.0`, `exporter-trace-otlp-http 0.223.0`): exporter `0.301` требует `api ≥ 1.10` и `sdk-trace 3.x`, несовместимые с `core 2.x`, который нужен Langfuse SDK |
| Стоимость в Langfuse — из Pi `usage.cost` (та же `config/prices.json`, совпадение с ledger прокси ±1% проверено вживую); генерация начинается в момент отправки запроса, `completionStartTime` — первый токен | трейс строится синхронно из событий Pi, без сопоставления с событиями прокси | ledger прокси остаётся источником истины для бюджета; у прерванных вызовов в трейсе нет оценочной стоимости |
| Экспорт Langfuse = tar всех volume'ов (Postgres, ClickHouse, MinIO, Redis) при остановленном стеке | один формат, проверенный восстановлением в чистом проекте | на время экспорта Langfuse недоступен (минута) |
| **Сервис `harness` в compose** (сделан до шага 19 — пробел в Must A1): multi-stage Dockerfile (сборка `web/` → `web/dist`, `npm ci --omit=dev`, Node 25.8.2, `python3` для скорера); тома `./bundle:ro`, `./versions`, `./config:ro`, `./io:/io`, named volume `harness_state`; сети default (LiteLLM, Langfuse) + `sandbox`; CLI — `docker compose exec harness harness …` | `docker compose up` поднимает всё; CLI в контейнере делит с сервисом бюджет, лимитер и трейсинг | ledger контейнера (`harness_state`) и хостовый `state/` — разные; прогоны с хоста (эксперименты) в UI контейнера не видны |
| Чат: одна Pi-сессия на чат в памяти процесса (история у Pi), `ask_user` → `terminate`; ref заголовка берётся из держателя, меняющегося на каждый ход; ответ чата = финальный текст модели (без `submit_answer`) | follow-up опирается на настоящий контекст Pi, расход и трейс — по ходам | рестарт сервиса теряет живые чат-сессии (ходы в БД остаются, контекст — нет); persist Pi-сессий в файл — в «ещё неделю» |
| v000 = **Haiku** по заранее зафиксированному правилу шага 9 (Haiku, если отстаёт от Sonnet ≤ 2 задач из 20): 18/20 против 19/20, $0.0017 против $0.0110 за задачу | в 6.5× дешевле при разнице в 1 задачу; бюджет остаётся на improve | Sonnet остаётся вариантом для routing-кандидата improver'а |
| **Batch: принятый `submit_answer` завершает ход** (`terminate: true` в результате tool — штатный механизм Pi), без финального LLM-вызова; неверный формат ход не завершает; в чате не завершает — нужен текст ответа | финальный вызов в batch ничего не добавляет к ответу, но стоит один LLM-вызов с чтением всего префикса | проверено вживую: задача 1014 — 3 → 2 генерации, 4.7 → 3.9 с; ответ после submit модель уже не может «передумать» |
| `py-sandbox`: python 3.12.14-slim, pandas 3.0.6, duckdb 1.5.6; exec-сервер на stdlib; код запускается `python3 -c` (без `-I`, чтобы `skills/` в cwd импортировались) | изоляция обеспечивается контейнером (internal network, read-only, uid 65534, limits, cap_drop ALL), а не флагами интерпретатора — их можно обойти подпроцессом | — |
| `sandbox-gateway` (alpine/socat 1.8.1.1) публикует песочницу только на `127.0.0.1:7070` для harness, запущенного на хосте (baseline шага 9 идёт до контейнеризации harness) | песочница остаётся только в internal-сети; у шлюза есть egress, но он не исполняет пользовательский код | ещё один контейнер; когда harness переедет в compose, шлюз нужен только для запуска с хоста |

---

## 8. Что режем, если не успеваем (по порядку)

1. ~~MCP stdio-транспорт~~ — **срезан вместе с MCP** (решение 14:30: improver к 16:00 важнее).
2. ~~MCP целиком (Extra mile, шаг 18)~~ — **срезан**.
3. Кнопка запуска improve из UI (оставить CLI; таблица версий остаётся).
4. Подтверждение flipped-задач в гейте (оставить `cand − parent ≥ T` / 0 регрессий easy / cost-guard).
5. Smoke-этап improver (сразу val; дороже, но проще).
6. 👎 → improver (хранить 👎, но не подавать в ANALYZE) — **Should**.
7. Tool `python` (только `sql` + skills в виде SQL-шаблонов).
8. Сверка cost с LiteLLM `/key/info`.
9. Version selector в UI (версия через query-param).

**Не режем (Must):** multi-turn агент на Pi, чат со стримом шагов, improver с ≥ 2 промоушенами по val, Langfuse с cost / cache, `harness solve / improve / report`, `docker compose up` из чистого клона.

---

## 9. Deliverables (задание §7) — план заранее

### 9.1 Что, откуда, когда

| # | Deliverable | Как получается | Когда начинаем | Проверка |
|---|---|---|---|---|
| D1 | **Git repo**, `docker compose up` из чистого клона | `bundle/` (данные, задачи, скорер) в репо, `.env.example`, compose со всеми сервисами; без локальных путей и ручных шагов | шаг 3 (compose), финал — шаг 19 | `scripts/clean-clone-test.sh`: `git clone` во временную папку → `cp .env.example .env` + ключ → `up -d` → health → `solve` на 3 задачах |
| D2 | **README.md** | Архитектура (mermaid из §2), как запустить (compose, CLI в контейнере, MCP one-liners для Claude Code / Codex), решения и компромиссы (из §7), «что бы сделал за ещё неделю» | скелет после шага 3, дополняется на каждом шаге | все команды из README выполнены в clean-clone-test |
| D3 | **REPORT.md** | Автогенерация `harness report --md`: per-version val (по уровням), cost, $/task, cache hit rate, p50/p95, change_summary, gate decision, promoted / rejected, total spend (ledger + сверка с LiteLLM `/key/info`). Руками: «что не сработало», оценка шума | с шага 9 (baseline) | цифры в REPORT совпадают с `/api/report` и Langfuse |
| D4 | **Frozen `best`** | `versions/BEST` + каталог версии в git, тег `best-frozen`; `manifest.json` фиксирует модели / thinking / лимиты; `harness solve --tasks /io/holdout.jsonl --version best --out /io/answers.jsonl` читает версию только из репо; holdout кладут в `./io/` | после последнего промоушена | `git checkout best-frozen && solve` на val даёт тот же score ± T; файл без `answer` отрабатывает |
| D5 | **Langfuse data** | `scripts/export-langfuse.sh`: `pg_dump` (Postgres) + `clickhouse-backup` / `BACKUP TABLE … TO File` (ClickHouse) + `mc mirror` (MinIO) → `langfuse-export.tar.zst` (+ `import-langfuse.sh`). Дополнительно JSON-экспорт трейсов отчётных run'ов через публичный API Langfuse (запасной вариант, если volume не поднимется) | шаг 3 (скрипт и проверка импорта) | импорт в чистый compose → трейсы отчётных run'ов открываются по `trace_url` из REPORT |

### 9.2 Что фиксировать по ходу (иначе потом не восстановить)

- Каждый run хранит `run_id`, `version`, `git sha`, модели, конкурентность, стоимость и Langfuse `session_id` = `run_id`. REPORT ссылается на трейсы через них.
- **Шум:** baseline v000 на val прогоняем **дважды** (≈ $10) → получаем разброс между прогонами одной версии, это основа раздела «насколько уверены, что прирост реален». Плюс бутстреп-ДИ по задачам и парные wins / losses из гейта.
- Отклонённые версии и причины не удаляются — это часть REPORT («что не сработало»).
- Метрика кэша считается из usage каждого LLM-вызова, а не предполагается: `cache_read / (input + cache_read + cache_write)` per version и per run.
- Total spend: ledger в SQLite + снимок `GET /key/info` LiteLLM в начале и в конце дня.

### 9.2a Holdout и бюджет (подтверждено организаторами)

- Holdout запускают организаторы **с нашим ключом**, в пределах его лимита $150. Резерв $15 под holdout — **жёсткий**: кап наших прогонов $135 (`GLOBAL_BUDGET_USD`).
- Наш ledger лежит в `state/` (не в git) → у организаторов внутренний кап стартует с нуля; реальная защита у них — лимит ключа $150. Это честно написано в README.

### 9.3 Финальный чек-лист сдачи

- [ ] `clean-clone-test.sh` зелёный на свежем клоне
- [ ] `versions/BEST` указывает на финальную версию, тег `best-frozen` стоит
- [ ] `sha256` скорера совпадает, `bundle/` не изменён (`git diff --stat bundle/` пуст)
- [ ] в репо нет `.env` и ключа (`git grep sk-` пуст)
- [ ] REPORT.md: таблица версий, total spend, шум, «что не сработало», уверенность
- [ ] README.md: диаграмма, запуск, MCP one-liners, решения, «ещё неделя»
- [ ] `langfuse-export.tar.zst` проверен импортом; ссылка или файл приложен
- [ ] **все фоновые прогоны (improve, solve, эксперименты) остановлены** — `docker compose ps`, `ps aux | grep harness` пусто
- [ ] **остаток ключа по `x-litellm-key-spend` (заголовок ответа LiteLLM) ≥ $15 (holdout) + ~$3 (демо)**; `/key/info` для нашего ключа отдаёт `spend 0` — не годится
- [ ] в README и REPORT — «стоимость holdout» = $/задача frozen best × N задач holdout, видно, что резерва $15 хватает
- [ ] zip / ссылка на репо отправлены
