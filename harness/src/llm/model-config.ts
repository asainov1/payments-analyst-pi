// Per-version model settings → Pi session model limits (SPEC §7, Q10).
// maxTokens = max(limit, thinkingBudget + 1024); unsupported / impossible pairs → 422 version_invalid.
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import { RequestError } from "../runs/paths.ts";
import type { PriceTable } from "./prices.ts";

/** Pi 1.x thinking levels (pi-agent-core ThinkingLevel). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Pi reserves this many tokens for the answer next to a thinking budget (MIN_ANSWER_TOKENS). */
export const ANSWER_ROOM = 1024;

/** Levels Pi exposes for a reasoning model without a thinkingLevelMap (pi-ai getSupportedThinkingLevels). */
const SUPPORTED: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export interface ModelConfig {
  model: string;
  thinking: ThinkingLevel;
  maxTokens: number;
}

export function resolveModelConfig(
  prices: PriceTable,
  v: { model: string; thinking: ThinkingLevel; limits: { max_output_tokens: number } },
): ModelConfig {
  const price = prices[v.model];
  const bad = (msg: string) => new RequestError("version_invalid", 422, msg);
  if (!price) throw bad(`unknown model ${v.model}`);
  if (v.thinking !== "off" && !price.reasoning) throw bad(`${v.model} does not support thinking`);
  if (!SUPPORTED.includes(v.thinking)) throw bad(`thinking level ${v.thinking} is not supported for ${v.model}`);
  const need = v.thinking === "off" ? 0 : thinkingBudgetForLevel(v.thinking) + ANSWER_ROOM;
  const maxTokens = Math.max(v.limits.max_output_tokens, need);
  if (maxTokens > price.maxOutput) throw bad(`${v.model}: thinking ${v.thinking} needs ${maxTokens} output tokens > model max ${price.maxOutput}`);
  return { model: v.model, thinking: v.thinking, maxTokens };
}
