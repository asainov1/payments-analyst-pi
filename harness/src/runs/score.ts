// Runs the official scorer as a subprocess (never imported or copied). Refuses a modified scorer.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScoreSummary {
  n: number;
  correct: number;
  accuracy: number;
  missing: number;
  by_level: Record<string, { n: number; accuracy: number }>;
}

export function verifyScorer(scorerDir: string): void {
  const expected = readFileSync(join(scorerDir, "SHA256"), "utf8").split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(join(scorerDir, "score.py"))).digest("hex");
  if (actual !== expected) throw new Error(`scorer/score.py checksum mismatch (${actual} ≠ ${expected}) — refusing to score`);
}

export function score(opts: { scorerDir: string; tasksFile: string; answersFile: string; python?: string }): {
  summary: ScoreSummary;
  details: Array<{ task_id: string; correct: boolean }>;
} {
  verifyScorer(opts.scorerDir);
  const detailsPath = join(mkdtempSync(join(tmpdir(), "score-")), "details.jsonl");
  const out = execFileSync(
    opts.python ?? process.env.PYTHON ?? "python3",
    [join(opts.scorerDir, "score.py"), "--tasks", opts.tasksFile, "--answers", opts.answersFile, "--details", detailsPath],
    { encoding: "utf8" },
  );
  const details = readFileSync(detailsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { task_id: string; correct: boolean });
  return { summary: JSON.parse(out) as ScoreSummary, details };
}
