// answers.jsonl ({"task_id","answer"} per line) — append-only, crash tolerant: a torn last line
// left by a killed process is dropped when the file is reopened.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export function repairAnswers(path: string): Map<string, string> {
  const done = new Map<string, string>();
  if (!existsSync(path)) return done;
  const good: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { task_id: unknown; answer: unknown };
      if (typeof r.task_id === "string" && typeof r.answer === "string" && !done.has(r.task_id)) {
        done.set(r.task_id, r.answer);
        good.push(JSON.stringify({ task_id: r.task_id, answer: r.answer }));
      }
    } catch {
      // torn / garbage line → drop
    }
  }
  writeFileSync(path, good.length ? `${good.join("\n")}\n` : "");
  return done;
}

export function appendAnswer(path: string, taskId: string, answer: string): void {
  appendFileSync(path, `${JSON.stringify({ task_id: taskId, answer })}\n`);
}
