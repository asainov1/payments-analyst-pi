// unknown_column (SPEC §3.4 CURATE): snake_case identifiers in natural-language parts of a candidate
// (playbook rules, SKILL.md, tool descriptions) must exist in the data schema or domain vocabulary.
// Catches rules about columns that do not exist here (e.g. names from the public original dataset).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataDb } from "../data/db.ts";

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

export async function buildIdentifierAllowList(repoRoot: string, db: DataDb): Promise<Set<string>> {
  const data = join(repoRoot, "bundle", "data");
  const allowed = new Set<string>(["payments_m", "submit_answer", "read_manual", "max_turn_s", "max_tool_calls", "tool_descriptions", "task_id"]);
  for (const m of (await db.schema()).matchAll(/\b[a-z][a-z0-9_]*\b/g)) allowed.add(m[0]);
  const texts = [
    readFileSync(join(data, "manual.md"), "utf8"),
    readFileSync(join(data, "payments-readme.md"), "utf8"),
    readFileSync(join(data, "fees.json"), "utf8").slice(0, 20_000),
    readFileSync(join(data, "merchant_data.json"), "utf8"),
    readFileSync(join(data, "acquirer_countries.csv"), "utf8"),
    readFileSync(join(data, "merchant_category_codes.csv"), "utf8").split("\n")[0],
  ];
  for (const t of texts) for (const m of t.toLowerCase().matchAll(SNAKE)) allowed.add(m[0]);
  return allowed;
}

export function unknownIdentifiers(text: string, allowed: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SNAKE)) if (!allowed.has(m[0])) out.add(m[0]);
  return [...out].sort();
}

const TABLES = "payments_m|payments|fees|merchants|mcc|acquirer_countries";

/** Text whose snake_case tokens must be real identifiers (v007 fix): playbook rules / tool descriptions
 *  in full (prose), but from SKILL.md only explicit column references — `table.column` and identifiers
 *  inside SQL fragments (aliases after AS, function names before "(" and quoted literals excluded).
 *  Local variables of helper code are not columns. */
export function candidateColumnRefs(o: { rules: string[]; skillDocs: string[] }): string {
  const out: string[] = [...o.rules];
  for (const doc of o.skillDocs) {
    for (const m of doc.matchAll(new RegExp(`\\b(?:${TABLES})\\.([a-z_][a-z0-9_]*)`, "g"))) out.push(m[1]);
    for (const line of doc.split("\n")) {
      const k = line.search(/\b(SELECT|WHERE|GROUP BY|ORDER BY|HAVING)\b/i);
      if (k < 0) continue;
      let seg = line.slice(k);
      const q = seg.indexOf('"');
      if (q >= 0) seg = seg.slice(0, q);
      seg = seg
        .replace(/'[^']*'/g, " ")
        .replace(/\bAS\s+[a-z_][a-z0-9_]*/gi, " ")
        .replace(/\b[a-z_][a-z0-9_]*\s*\(/gi, " ");
      out.push(seg);
    }
  }
  return out.join("\n");
}
