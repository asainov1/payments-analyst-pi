// Deterministic failure labels for ANALYZE (SPEC §3.4): cheap clustering from trace features, no LLM.
export type FailureLabel = "timeout" | "invalid_format" | "not_applicable" | "numeric_high" | "numeric_low" | "other";

const isNA = (s: string) => /^\s*not applicable\s*$/i.test(s);
const num = (s: string) => {
  const t = s.trim().replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

export function labelFailure(o: {
  answer: string;
  gold: string;
  ms: number;
  maxTurnS: number;
  trace: { limit?: string | null; valid?: boolean | null; steps?: Array<{ tool?: string; output?: string }> } | null;
}): FailureLabel {
  const tr = o.trace ?? {};
  if (tr.limit === "turn_s" || o.ms >= o.maxTurnS * 1000 - 1000) return "timeout";
  const rejectedSubmit = (tr.steps ?? []).some((s) => s.tool === "submit_answer" && /"ok"\s*:\s*false/.test(s.output ?? ""));
  if (tr.valid === false || rejectedSubmit) return "invalid_format";
  if (isNA(o.answer) && !isNA(o.gold) && o.gold.trim() !== "") return "not_applicable";
  const a = num(o.answer);
  const g = num(o.gold);
  if (a !== null && g !== null) return a > g ? "numeric_high" : "numeric_low";
  return "other";
}
