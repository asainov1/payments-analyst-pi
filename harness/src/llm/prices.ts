// Single price table (SPEC §7, Q18): config/prices.json is a committed snapshot of LiteLLM
// /v1/model/info. It feeds both Pi's models.json `cost` and the proxy's ledger costing.
import { readFileSync } from "node:fs";

export interface ModelPrice {
  /** USD per million tokens */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  maxOutput: number;
  contextWindow: number;
  reasoning: boolean;
}

export type PriceTable = Record<string, ModelPrice>;

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function loadPrices(path: string): PriceTable {
  return JSON.parse(readFileSync(path, "utf8")).models as PriceTable;
}

export function costUsd(price: ModelPrice, u: TokenUsage): number {
  return (u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) / 1e6;
}

/** Fetches /v1/model/info (costs no tokens) and converts it into a PriceTable. */
export async function fetchPrices(baseUrl: string, apiKey: string): Promise<PriceTable> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/model/info`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET /v1/model/info → ${res.status}`);
  const body = (await res.json()) as { data: Array<{ model_name: string; model_info?: Record<string, number | boolean | null> }> };
  const perM = (v: unknown, fallback = 0) => Math.round((typeof v === "number" ? v : fallback) * 1e6 * 1e6) / 1e6;
  const table: PriceTable = {};
  for (const m of [...body.data].sort((a, b) => a.model_name.localeCompare(b.model_name))) {
    const i = m.model_info ?? {};
    table[m.model_name] = {
      input: perM(i.input_cost_per_token),
      output: perM(i.output_cost_per_token),
      cacheRead: perM(i.cache_read_input_token_cost, i.input_cost_per_token as number),
      // null cache-write price (gemini) → bill as plain input
      cacheWrite: perM(i.cache_creation_input_token_cost, i.input_cost_per_token as number),
      maxOutput: Number(i.max_output_tokens ?? 16384),
      contextWindow: Number(i.max_input_tokens ?? 200000),
      reasoning: i.supports_reasoning === true,
    };
  }
  return table;
}
