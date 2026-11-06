// `read_manual` tool (SPEC §4.4): a section of manual.md by heading, or grep with line numbers.
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Section {
  title: string;
  level: number;
  start: number; // line index of the heading
  end: number; // exclusive
}

function sections(lines: string[]): Section[] {
  const heads = lines
    .map((l, i) => ({ m: /^(#+)\s+(.*)$/.exec(l), i }))
    .filter((h): h is { m: RegExpExecArray; i: number } => h.m !== null)
    .map(({ m, i }) => ({ title: m[2].trim(), level: m[1].length, start: i }));
  return heads.map((h, k) => {
    // A section runs until the next heading of the same or a higher level.
    const next = heads.slice(k + 1).find((n) => n.level <= h.level);
    return { ...h, end: next ? next.start : lines.length };
  });
}

// Strip numbering like "2." / "5.1.3" so "Account Type" matches "2. Account Type".
const norm = (s: string) => s.toLowerCase().replace(/^[\d.\s]+/, "").trim();

export function readManual(dataDir: string, opts: { section?: string; grep?: string }): string {
  const lines = readFileSync(join(dataDir, "manual.md"), "utf8").split("\n");

  if (opts.grep) {
    const re = new RegExp(opts.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const hits = lines.flatMap((l, i) => (re.test(l) ? [`${i + 1}: ${l}`] : []));
    return hits.length ? hits.join("\n") : `No lines match "${opts.grep}".`;
  }

  const all = sections(lines);
  if (opts.section) {
    const want = norm(opts.section);
    const s = all.find((x) => norm(x.title) === want) ?? all.find((x) => norm(x.title).includes(want));
    if (s) return lines.slice(s.start, s.end).join("\n").trim();
  }
  return `Available sections:\n${all.map((s) => `${"  ".repeat(s.level - 1)}- ${s.title}`).join("\n")}`;
}
