// Playbook (SPEC §3.1 PlaybookRule): playbook.json is the source of truth; playbook.md is its
// deterministic render (id order) used in the system prompt and in human-readable diffs.

export interface PlaybookRule {
  id: string;
  text: string;
  added_in: string;
  updated_in: string;
  merged_from?: string[];
}

export interface Playbook {
  next_id: number;
  rules: PlaybookRule[];
}

export const emptyPlaybook = (): Playbook => ({ next_id: 1, rules: [] });
export const ruleId = (n: number) => `R${String(n).padStart(3, "0")}`;
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function renderPlaybook(pb: Playbook): string {
  if (!pb.rules.length) return "## Playbook\n\n(no rules yet)";
  const rules = [...pb.rules].sort((a, b) => a.id.localeCompare(b.id));
  return `## Playbook\n\nRules learned from earlier mistakes. Follow them unless the question clearly says otherwise.\n\n${rules.map((r) => `- [${r.id}] ${r.text}`).join("\n")}`;
}
