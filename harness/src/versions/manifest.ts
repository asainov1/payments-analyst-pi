// versions/vNNN/manifest.json (SPEC §3.1 VersionManifest).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "../llm/model-config.ts";

export interface VersionManifest {
  id: string;
  parent: string | null;
  created_at: string;
  status: "baseline" | "candidate" | "promoted" | "rejected";
  change_summary: string;
  models: { analyst: string; reflector: string };
  thinking: ThinkingLevel;
  limits: { max_tool_calls: number; max_turn_usd: number; max_turn_s: number; max_task_usd: number; max_output_tokens: number };
  tool_descriptions: Record<string, string>;
}

export const versionDir = (repoRoot: string, id: string) => join(repoRoot, "versions", id);

export function loadManifest(repoRoot: string, id: string): VersionManifest {
  return JSON.parse(readFileSync(join(versionDir(repoRoot, id), "manifest.json"), "utf8")) as VersionManifest;
}
