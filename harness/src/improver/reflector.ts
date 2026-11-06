// Reflector (SPEC §3.4 PROPOSE): an Opus Pi session without tools reads compact trajectories of the
// parent's failures (verdict + numeric direction only — never the gold value), slow successes,
// 👎 feedback and the negative memory of rejected candidates, and returns one Proposal as JSON.
import { join } from "node:path";
import { resolveModelConfig } from "../llm/model-config.ts";
import { createPiSession, type PiRuntime } from "../llm/pi.ts";
import type { PriceTable } from "../llm/prices.ts";
import { type Tracing, traceTurn } from "../obs/tracer.ts";
import { LIMITS, type Proposal, underPressure, type VersionContent } from "./curator.ts";
import { renderPlaybook } from "./playbook.ts";

export interface Telemetry {
  runs: number;
  tasks_per_run: number;
  limit_hits_per_run: number;
  over_60s_per_run: number;
  p95_s: number;
}

export const REFLECTOR_MODEL = "claude-opus-5-5";

export interface Trajectory {
  level: string;
  question: string;
  guidelines: string;
  answer: string;
  verdict: "wrong" | "correct_but_slow";
  /** numeric answers: "too high" / "too low" / "off by > 50%" … — never the gold value */
  hint?: string;
  ms: number;
  steps: Array<{ tool?: string; args?: string; output?: string; error?: boolean; say?: string }>;
}

const SYSTEM = `You improve the harness of a payments-analytics agent. The agent answers questions about a
merchant-payments dataset (DuckDB tables payments, fees, merchants, mcc, acquirer_countries; a rules
manual) with tools sql, read_manual, python and submit_answer. You see its current instructions,
playbook and skills, and trajectories where it failed or was slow. Propose ONE focused change that
fixes a whole CLASS of mistakes, not individual questions.

Hard rules (a candidate that breaks them is rejected automatically):
- Never hard-code values from the data or answers: no amounts, counts, rates, fee ids, lists of
  merchants→numbers, no tables of precomputed facts. Rules and skills describe HOW to compute;
  the agent queries the data at answer time.
- Never mention task ids, copy question wording, or reference task / scorer files.
- Playbook rules: short, general, actionable (one sentence or two). Prefer editing or merging
  existing rules over adding near-duplicates.
- Skills are optional helper code (Python files executed by the agent's python tool) plus a short
  SKILL.md explaining when and how to use them. Code must compute from data/ files at run time.
- A proposal is EITHER content (playbook / skills / tool descriptions) OR routing (model / thinking /
  max_turn_s), never both. Routing models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5;
  thinking: off|minimal|low|medium|high; max_turn_s: integer 120..300.

Reply with ONLY a JSON object, no prose before or after:
{"kind":"content","rationale":"<which class of mistakes this fixes and why>","ops":[
  {"op":"playbook_add","text":"..."} | {"op":"playbook_edit","rule_id":"R001","text":"..."} |
  {"op":"playbook_remove","rule_id":"R001"} | {"op":"playbook_merge","rule_ids":["R001","R002"],"text":"..."} |
  {"op":"skill_upsert","name":"snake_name","skill_md":"...","files":{"helper.py":"..."}} |
  {"op":"tool_description","tool":"sql|read_manual|python|submit_answer","text":"..."}
]}
or {"kind":"routing","rationale":"...","ops":[{"op":"routing","model"?:...,"thinking"?:...,"max_turn_s"?:...}]}`;

function renderTrajectory(t: Trajectory, i: number): string {
  const steps = t.steps
    .slice(0, 14)
    .map((s) => (s.tool ? `  - ${s.tool}(${s.args})${s.error ? " ERROR" : ""} → ${s.output}` : `  - says: ${s.say}`))
    .join("\n");
  return `### Case ${i + 1} [${t.level}] — ${t.verdict === "wrong" ? `WRONG${t.hint ? ` (${t.hint})` : ""}` : `correct but slow (${Math.round(t.ms / 1000)} s)`}
Question: ${t.question}
Guidelines: ${t.guidelines}
Agent's final answer: ${t.answer}
Steps:
${steps || "  (none)"}`;
}

export function buildReflectorPrompt(o: {
  parent: VersionContent;
  failures: Trajectory[];
  slow: Trajectory[];
  feedback: Array<{ question: string; answer: string; comment: string | null }>;
  rejected: Array<{ id: string; summary: string; reason: string }>;
  /** gold-independent runtime telemetry of the current version (no correctness, no task ids) */
  telemetry?: { val: Telemetry; train: Telemetry };
  /** exact table / column names — the dataset renames columns of the public original */
  schema?: string;
}): string {
  const tel = (name: string, t: Telemetry) =>
    `- ${name}: on average ${t.limit_hits_per_run} of ${t.tasks_per_run} turns per run hit the max_turn_s limit (${o.parent.manifest.limits.max_turn_s} s), ${t.over_60s_per_run} ran longer than 60 s, p95 ${t.p95_s} s (${t.runs} run(s))`;
  const pressure = underPressure(o.parent.playbook);
  const skills = Object.entries(o.parent.skills)
    .map(([n, f]) => `### ${n}\n${f["SKILL.md"] ?? ""}\nfiles: ${Object.keys(f).join(", ")}`)
    .join("\n\n");
  return [
    `## Current instructions (system.md)\n${o.parent.system}`,
    `## Current ${renderPlaybook(o.parent.playbook).replace(/^## /, "")}\n(${o.parent.playbook.rules.length}/${LIMITS.maxRules} rules)`,
    `## Current skills\n${skills || "(none)"}`,
    o.schema ? `## Data schema — use ONLY these exact table and column names\n${o.schema}` : "",
    `## Current routing\nmodel ${o.parent.manifest.models.analyst}, thinking ${o.parent.manifest.thinking}, max_turn_s ${o.parent.manifest.limits.max_turn_s}`,
    o.telemetry
      ? `## Runtime telemetry of the current version (wall time only)\n${tel("validation set", o.telemetry.val)}\n${tel("train sample", o.telemetry.train)}\nTurns that hit the limit end without an answer. Consider routing (max_turn_s within 120..300; cost per task must stay ≤ 1.3× the parent's) or rules that make the agent reach an answer with fewer, cheaper steps.`
      : "",
    pressure ? `## LIMIT PRESSURE\nThe playbook is at ≥ 80% of its limits. Your proposal MUST NOT increase the number of rules: add only via playbook_merge or together with playbook_remove.` : "",
    o.rejected.length ? `## Already tried and rejected — do not repeat\n${o.rejected.map((r) => `- ${r.id}: ${r.summary} → ${r.reason}`).join("\n")}` : "",
    `## Failed trajectories (${o.failures.length})\n${o.failures.map(renderTrajectory).join("\n\n")}`,
    o.slow.length ? `## Correct but slow trajectories (${o.slow.length})\n${o.slow.map(renderTrajectory).join("\n\n")}` : "",
    o.feedback.length ? `## User 👎 feedback\n${o.feedback.map((f) => `- Q: ${f.question}\n  A: ${f.answer}\n  comment: ${f.comment ?? "(none)"}`).join("\n")}` : "",
    "Return the JSON proposal now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseProposal(text: string): Proposal {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const raw = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const p = JSON.parse(raw) as Proposal;
  if ((p.kind !== "content" && p.kind !== "routing") || !Array.isArray(p.ops) || !p.ops.length) throw new Error("proposal must have kind content|routing and non-empty ops");
  return p;
}

export async function runReflector(o: {
  rt: PiRuntime;
  prices: PriceTable;
  tracing: Tracing | null;
  stateDir: string;
  ref: string;
  improveRunId: string;
  prompt: string;
}): Promise<{ proposal: Proposal | null; text: string; error?: string }> {
  // low thinking + a large answer budget: proposals with skill code are long, and a cut-off JSON is useless
  const model = resolveModelConfig(o.prices, { model: REFLECTOR_MODEL, thinking: "low", limits: { max_output_tokens: 32000 } });
  const session = await createPiSession(o.rt, { ref: o.ref, scope: "improve", model, systemPrompt: SYSTEM, tools: [], compaction: false, cwd: join(o.stateDir, "work") });
  const lf = o.tracing
    ? traceTurn(o.tracing, session, { name: "reflect", sessionId: o.improveRunId, version: "improver", tags: ["improve", "reflect"], metadata: { ref: o.ref }, input: o.prompt, model: model.model })
    : null;
  let text = "";
  const unsub = session.subscribe((e: any) => {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const t = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (t) text = t;
    }
  });
  let proposal: Proposal | null = null;
  let error: string | undefined;
  try {
    await session.prompt(o.prompt);
    try {
      proposal = parseProposal(text);
    } catch (e) {
      // one retry in the same session (prompt cache hit): the JSON was malformed or cut off
      error = String(e);
      await session.prompt(
        "Your reply was not one complete JSON object (it may have been cut off). Reply again with ONLY the complete JSON proposal — rationale under 80 words, skill files short.",
      );
      try {
        proposal = parseProposal(text);
        error = undefined;
      } catch (e2) {
        error = `${error}; retry: ${String(e2)}`;
      }
    }
  } finally {
    unsub();
    session.dispose();
  }
  lf?.end(proposal ? { proposal } : { error, text: text.slice(0, 20_000) });
  return { proposal, text, error };
}
