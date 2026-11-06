// System prompt assembly (SPEC §3.2 agent/prompt). Order is chosen for prompt caching: everything
// that is identical across tasks of one version comes first, the task itself goes into the user turn.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataDb } from "../data/db.ts";

export interface Task {
  task_id: string;
  question: string;
  guidelines: string;
  level?: string;
  answer?: string;
}

export async function buildSystemPrompt(opts: { versionDir: string; dataDir: string; db: DataDb }): Promise<string> {
  const system = readFileSync(join(opts.versionDir, "system.md"), "utf8").trim();
  const manual = readFileSync(join(opts.dataDir, "manual.md"), "utf8").trim();
  const playbook = readFileSync(join(opts.versionDir, "playbook.md"), "utf8").trim();
  const schema = await opts.db.schema();
  return [
    system,
    `## Rules manual (manual.md)\n\n${manual}`,
    `## Data schema\n\nDuckDB tables (query with the \`sql\` tool):\n${schema}`,
    playbook,
  ].join("\n\n---\n\n");
}

/** The only task fields the agent ever sees: question and guidelines (never id, level or answer). */
export function taskToPrompt(task: Pick<Task, "question" | "guidelines">): string {
  return `Question: ${task.question}\n\nAnswer guidelines: ${task.guidelines}`;
}
