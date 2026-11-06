// Deterministic curator (SPEC §3.4 CURATE): applies a reflector Proposal to the parent version.
// No LLM. Rejects invalid ops, playbooks over the limits and growth under limit pressure.
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import type { VersionManifest } from "../versions/manifest.ts";
import { estimateTokens, type Playbook, type PlaybookRule, renderPlaybook, ruleId } from "./playbook.ts";

export const LIMITS = { maxRules: 40, maxTokens: 3000, pressure: 0.8, maxSkills: 8, maxSkillFileBytes: 20 * 1024 } as const;
export const ROUTABLE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
const THINKING = ["off", "minimal", "low", "medium", "high"] as const;
const TOOLS = ["sql", "read_manual", "python", "submit_answer"] as const;

export type ContentOp =
  | { op: "playbook_add"; text: string }
  | { op: "playbook_edit"; rule_id: string; text: string }
  | { op: "playbook_remove"; rule_id: string }
  | { op: "playbook_merge"; rule_ids: string[]; text: string }
  | { op: "skill_upsert"; name: string; skill_md: string; files: Record<string, string> }
  | { op: "tool_description"; tool: string; text: string };
export interface RoutingOp {
  op: "routing";
  model?: string;
  thinking?: string;
  max_turn_s?: number;
}
export type Proposal = { kind: "content"; rationale: string; ops: ContentOp[] } | { kind: "routing"; rationale: string; ops: RoutingOp[] };

export interface VersionContent {
  manifest: VersionManifest;
  system: string;
  playbook: Playbook;
  /** skill name → file name → content (SKILL.md included) */
  skills: Record<string, Record<string, string>>;
}

export interface Curation {
  applied: number;
  skipped_duplicates: string[];
  rules_before: number;
  rules_after: number;
  tokens_after: number;
}

export type CurateResult = { ok: true; content: VersionContent; curation: Curation } | { ok: false; reason: string; curation: Curation };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
function jaccard(a: string, b: string): number {
  const A = new Set(norm(a).split(" "));
  const B = new Set(norm(b).split(" "));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}
const duplicateOf = (text: string, rules: PlaybookRule[]) => rules.find((r) => norm(r.text) === norm(text) || jaccard(r.text, text) >= 0.9);

export function underPressure(pb: Playbook): boolean {
  return pb.rules.length >= LIMITS.maxRules * LIMITS.pressure || estimateTokens(renderPlaybook(pb)) >= LIMITS.maxTokens * LIMITS.pressure;
}

export function curate(parent: VersionContent, proposal: Proposal, newId: string): CurateResult {
  const content: VersionContent = structuredClone(parent);
  const pb = content.playbook;
  const curation: Curation = { applied: 0, skipped_duplicates: [], rules_before: parent.playbook.rules.length, rules_after: 0, tokens_after: 0 };
  const fail = (reason: string): CurateResult => {
    curation.rules_after = pb.rules.length;
    curation.tokens_after = estimateTokens(renderPlaybook(pb));
    return { ok: false, reason, curation };
  };
  const find = (id: string) => pb.rules.findIndex((r) => r.id === id);
  const addRule = (text: string, merged_from?: string[]) => {
    const dup = duplicateOf(text, pb.rules);
    if (dup) {
      curation.skipped_duplicates.push(`${text.slice(0, 80)} ≈ ${dup.id}`);
      return false;
    }
    pb.rules.push({ id: ruleId(pb.next_id++), text: text.trim(), added_in: newId, updated_in: newId, ...(merged_from ? { merged_from } : {}) });
    return true;
  };

  if (proposal.kind === "routing") {
    if (proposal.ops.length !== 1 || proposal.ops[0].op !== "routing") return fail("invalid_op: a routing proposal has exactly one routing op");
    const r = proposal.ops[0];
    const extra = Object.keys(r).filter((k) => !["op", "model", "thinking", "max_turn_s"].includes(k));
    if (extra.length) return fail(`invalid_op: routing fields outside the allow-list: ${extra.join(", ")}`);
    if (r.model !== undefined) {
      if (!(ROUTABLE_MODELS as readonly string[]).includes(r.model)) return fail(`invalid_op: model ${r.model} is not routable`);
      content.manifest.models.analyst = r.model;
    }
    if (r.thinking !== undefined) {
      if (!(THINKING as readonly string[]).includes(r.thinking)) return fail(`invalid_op: thinking ${r.thinking} not allowed`);
      content.manifest.thinking = r.thinking as VersionManifest["thinking"];
      if (r.thinking !== "off") thinkingBudgetForLevel(r.thinking as "low"); // throws on an unknown level
    }
    if (r.max_turn_s !== undefined) {
      if (!Number.isInteger(r.max_turn_s) || r.max_turn_s < 120 || r.max_turn_s > 300) return fail("invalid_op: max_turn_s must be an integer in [120, 300]");
      content.manifest.limits.max_turn_s = r.max_turn_s;
    }
    if (JSON.stringify(content.manifest) === JSON.stringify(parent.manifest)) return fail("empty: routing changes nothing");
    curation.applied = 1;
  } else {
    for (const op of proposal.ops) {
      switch (op.op) {
        case "playbook_add":
          if (addRule(op.text)) curation.applied++;
          break;
        case "playbook_edit": {
          const i = find(op.rule_id);
          if (i < 0) return fail(`invalid_op: unknown rule ${op.rule_id}`);
          pb.rules[i] = { ...pb.rules[i], text: op.text.trim(), updated_in: newId };
          curation.applied++;
          break;
        }
        case "playbook_remove": {
          const i = find(op.rule_id);
          if (i < 0) return fail(`invalid_op: unknown rule ${op.rule_id}`);
          pb.rules.splice(i, 1);
          curation.applied++;
          break;
        }
        case "playbook_merge": {
          if (op.rule_ids.length < 2) return fail("invalid_op: merge needs at least 2 rules");
          if (op.rule_ids.some((id) => find(id) < 0)) return fail(`invalid_op: unknown rule in merge ${op.rule_ids.join(",")}`);
          pb.rules = pb.rules.filter((r) => !op.rule_ids.includes(r.id));
          addRule(op.text, op.rule_ids);
          curation.applied++;
          break;
        }
        case "skill_upsert": {
          if (!/^[a-z0-9_-]{1,40}$/.test(op.name)) return fail(`invalid_op: bad skill name ${op.name}`);
          const files: Record<string, string> = { "SKILL.md": op.skill_md };
          for (const [f, body] of Object.entries(op.files ?? {})) {
            if (!/^[A-Za-z0-9_.-]{1,60}$/.test(f) || f === "SKILL.md" || f.startsWith(".")) return fail(`invalid_op: bad skill file name ${f}`);
            files[f] = body;
          }
          if (Object.values(files).some((b) => Buffer.byteLength(b) > LIMITS.maxSkillFileBytes)) return fail(`over_limit: skill file > ${LIMITS.maxSkillFileBytes} bytes`);
          content.skills[op.name] = files;
          if (Object.keys(content.skills).length > LIMITS.maxSkills) return fail(`over_limit: more than ${LIMITS.maxSkills} skills`);
          curation.applied++;
          break;
        }
        case "tool_description":
          if (!(TOOLS as readonly string[]).includes(op.tool)) return fail(`invalid_op: unknown tool ${op.tool}`);
          content.manifest.tool_descriptions = { ...content.manifest.tool_descriptions, [op.tool]: op.text.trim() };
          curation.applied++;
          break;
        default:
          return fail(`invalid_op: unknown op ${(op as { op: string }).op}`);
      }
    }
  }

  curation.rules_after = pb.rules.length;
  curation.tokens_after = estimateTokens(renderPlaybook(pb));
  if (curation.applied === 0) return fail("empty: nothing left to apply after dedup");
  if (pb.rules.length > LIMITS.maxRules || curation.tokens_after > LIMITS.maxTokens) {
    return fail(`over_limit: ${pb.rules.length} rules / ${curation.tokens_after} tokens (max ${LIMITS.maxRules} / ${LIMITS.maxTokens})`);
  }
  if (underPressure(parent.playbook) && curation.rules_after > curation.rules_before) {
    return fail(`growth_under_pressure: parent at ≥ ${LIMITS.pressure * 100}% of a limit, rules ${curation.rules_before} → ${curation.rules_after}`);
  }
  content.manifest = { ...content.manifest, id: newId, parent: parent.manifest.id };
  return { ok: true, content, curation };
}
