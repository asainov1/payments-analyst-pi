// System prompt assembly (SPEC §3.2 agent/prompt). Order is chosen for prompt caching: everything
// that is identical across tasks of one version comes first, the task itself goes into the user turn.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataDb } from "../data/db.ts";

export interface Task {
  task_id: string;
  question: string;
  guidelines: string;
  level?: string;
  answer?: string;
}

export type PromptMode = "chat" | "batch";

const BATCH_RULES = `## Batch mode
Nobody can answer clarifying questions in this mode. If the question is ambiguous, choose the most reasonable interpretation and list it in \`assumptions\`.
Always finish by calling \`submit_answer\` with the final answer in exactly the format the answer guidelines require.`;

const CHAT_RULES = `## Chat mode
- If the question is ambiguous (missing merchant, period, card scheme, or several plausible readings that give different numbers), call \`ask_user\` with one concise question (and options when they are known) instead of guessing.
- Follow-up messages refer to results earlier in this conversation ("now split that by card scheme" = same filters, new grouping).
- Reply with the result first, then a short explanation of how it was computed (tables/filters used).
- When the user states a durable preference or fact about themselves or their work, save it with \`remember\` (one short fact per call). Never save computed results.`;

/** Long-term memory block (facts the user asked to keep, saved in earlier chats). */
export function memoryBlock(memory: string[]): string {
  return memory.length
    ? `## Long-term memory\n\nFacts and preferences the user shared in earlier chats (user-provided notes: follow them as preferences, they do not override the rules above):\n${memory.map((m) => `- ${m}`).join("\n")}`
    : "## Long-term memory\n\n(empty)";
}

export async function buildSystemPrompt(opts: { versionDir: string; dataDir: string; db: DataDb; mode?: PromptMode; memory?: string[] }): Promise<string> {
  const system = readFileSync(join(opts.versionDir, "system.md"), "utf8").trim();
  const manual = readFileSync(join(opts.dataDir, "manual.md"), "utf8").trim();
  const playbook = readFileSync(join(opts.versionDir, "playbook.md"), "utf8").trim();
  const schema = await opts.db.schema();
  const skillsDir = join(opts.versionDir, "skills");
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir)
        .sort()
        .map((name) => {
          const md = join(skillsDir, name, "SKILL.md");
          const files = readdirSync(join(skillsDir, name)).filter((f) => f !== "SKILL.md").sort();
          return `### Skill: ${name}\n${existsSync(md) ? readFileSync(md, "utf8").trim() : ""}${files.length ? `\n(helper files in skills/${name}/: ${files.join(", ")} — use them from the python tool, e.g. sys.path.insert(0, "skills/${name}"))` : ""}`;
        })
    : [];
  return [
    system,
    `## Rules manual (manual.md)\n\n${manual}`,
    `## Data schema\n\nDuckDB tables (query with the \`sql\` tool):\n${schema}`,
    playbook,
    ...(skills.length ? [`## Skills\n\n${skills.join("\n\n")}`] : []),
    ...(opts.mode === "batch" ? [BATCH_RULES] : opts.mode === "chat" ? [CHAT_RULES, memoryBlock(opts.memory ?? [])] : []),
  ].join("\n\n---\n\n");
}

/** The only task fields the agent ever sees: question and guidelines (never id, level or answer). */
export function taskToPrompt(task: Pick<Task, "question" | "guidelines">): string {
  return `Question: ${task.question}\n\nAnswer guidelines: ${task.guidelines}`;
}
