// Leak-check (SPEC §3.4 LEAKCHK, §7 "confirmed with the organisers"): a candidate may carry general
// rules and code that computes from data/ — never task answers, task ids, question text, paths to
// tasks/ or scorer/, or precomputed tables of values (> 10 literal name→number pairs).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LeakContext {
  goldLiterals: string[];
  questionNgrams: Set<string>;
}

const N = 8;
const words = (s: string) => s.toLowerCase().match(/[a-z0-9_.%]+/g) ?? [];

/** Gold answers (and list items) from train+val, minus literals that are ordinary tokens of the domain. */
export function buildLeakContext(repoRoot: string): LeakContext {
  const tasks = ["train.jsonl", "val.jsonl"].flatMap((f) =>
    readFileSync(join(repoRoot, "bundle", "tasks", f), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { question: string; guidelines: string; answer: string }),
  );
  const data = join(repoRoot, "bundle", "data");
  const domainText = [
    readFileSync(join(data, "manual.md"), "utf8"),
    readFileSync(join(data, "merchant_data.json"), "utf8"),
    readFileSync(join(data, "acquirer_countries.csv"), "utf8"),
    readFileSync(join(data, "merchant_category_codes.csv"), "utf8"),
    readFileSync(join(data, "payments.csv"), "utf8").split("\n").slice(0, 2000).join("\n"),
    readFileSync(join(data, "payments-readme.md"), "utf8"),
    ...tasks.map((t) => t.guidelines),
    "GlobalCard NexPay SwiftCharge TransactPlus Not Applicable",
  ].join("\n");
  const domainTokens = new Set(domainText.match(/[A-Za-z0-9_.%<>-]+/g) ?? []);
  const literals = new Set<string>();
  for (const t of tasks) {
    const a = t.answer.trim();
    for (const piece of [a, ...a.replace(/^\[|\]$/g, "").split(/,\s*/)]) {
      const p = piece.trim().replace(/^[A-Z]{2}:\s*/, "");
      if (p.length >= 4 && !domainTokens.has(p) && !/^not applicable$/i.test(p) && !/^\d{1,4}$/.test(p)) literals.add(p);
    }
  }
  const questionNgrams = new Set<string>();
  for (const t of tasks) {
    const w = words(t.question);
    for (let i = 0; i + N <= w.length; i++) questionNgrams.add(w.slice(i, i + N).join(" "));
  }
  return { goldLiterals: [...literals].sort((a, b) => b.length - a.length), questionNgrams };
}

const PAIR_PATTERNS = [
  /['"]?[A-Za-z_][\w .-]{0,40}['"]?\s*[:=]\s*-?\d+(?:\.\d+)?/g, // dict / map literal
  /^\|\s*[^|\n]+\|\s*-?\d+(?:\.\d+)?\s*\|/gm, // markdown table row
  /^[A-Za-z_][\w .-]{0,40},\s*-?\d+(?:\.\d+)?\s*$/gm, // csv row
];

export function leakCheck(text: string, ctx: LeakContext): { ok: boolean; reasons: string[]; redacted: string } {
  const reasons: string[] = [];
  let redacted = text;

  if (/task[_\s-]?id\W{0,3}\d+|\btask\s+\d{3,5}\b/i.test(text)) {
    reasons.push("task_id");
    redacted = redacted.replace(/task[_\s-]?id\W{0,3}\d+|\btask\s+\d{3,5}\b/gi, "[REDACTED:task_id]");
  }
  if (/(^|[^\w])(tasks\/|scorer\/|score\.py|[\w-]+\.jsonl\b)/i.test(text)) {
    reasons.push("path");
    redacted = redacted.replace(/[\w./-]*(tasks\/|scorer\/|score\.py|\.jsonl)[\w./-]*/gi, "[REDACTED:path]");
  }
  const w = words(text);
  for (let i = 0; i + N <= w.length; i++) {
    if (ctx.questionNgrams.has(w.slice(i, i + N).join(" "))) {
      reasons.push("question_ngram");
      break;
    }
  }
  for (const lit of ctx.goldLiterals) {
    const re = new RegExp(`(^|[^\\w.])${lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
    if (re.test(redacted)) {
      if (!reasons.includes("gold")) reasons.push("gold");
      redacted = redacted.split(lit).join("[REDACTED:gold]");
    }
  }
  const pairs = PAIR_PATTERNS.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
  if (pairs > 10) reasons.push(`literal_table: ${pairs} name→number pairs > 10`);
  return { ok: reasons.length === 0, reasons, redacted };
}
