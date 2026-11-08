// Pi session factory (SPEC §3.2 agent/session, step 2). All Pi LLM traffic goes to the in-process
// proxy; per-session attribution is a `before_provider_headers` inline extension (SPEC §7, Q14).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  compact,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { LedgerScope } from "../runtime/budget.ts";
import type { ModelConfig } from "./model-config.ts";
import type { PriceTable } from "./prices.ts";

export const PROVIDER = "litellm";

/** What a compaction summary of an analyst chat must keep (appended to Pi's summary prompt as "Additional focus"). */
export const ANALYST_COMPACTION_FOCUS =
  "This is a payments-data analysis chat. Start the summary with an 'Analysis state' section listing, verbatim: " +
  "the merchant(s), period, card scheme and every other filter in force; definitions and assumptions agreed with the " +
  "user (e.g. fraud rate = share of EUR volume, 'only NexPay'); each key number found, with what it measures and the " +
  "filters/query behind it; open questions or pending clarifications. Keep exact identifiers and numbers.";

/** Pi starts compaction when context > contextWindow - reserveTokens, so a fixed threshold is window - compactAt. */
export function compactionSettings(contextWindow: number, compactAtTokens: number, keepRecentTokens: number) {
  return { reserveTokens: Math.max(16_384, contextWindow - compactAtTokens), keepRecentTokens: Math.min(keepRecentTokens, Math.floor(compactAtTokens / 2)) };
}

export interface PiRuntime {
  runtime: ModelRuntime;
  agentDir: string;
}

/** One per process. Registers LiteLLM (via the proxy) as the only provider; Pi never sees the real key. */
export async function createPiRuntime(o: { proxyUrl: string; prices: PriceTable; stateDir: string }): Promise<PiRuntime> {
  // Isolated agent dir: nothing from the developer's ~/.pi (extensions, settings, auth) leaks in.
  const agentDir = join(o.stateDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  runtime.registerProvider(PROVIDER, {
    name: "LiteLLM via harness proxy",
    baseUrl: o.proxyUrl,
    api: "anthropic-messages",
    apiKey: "harness-proxy", // dummy: the proxy swaps in the real key
    models: Object.entries(o.prices)
      .filter(([id]) => id.startsWith("claude-"))
      .map(([id, p]) => ({
        id,
        name: id,
        reasoning: p.reasoning,
        input: ["text"] as Array<"text">,
        contextWindow: p.contextWindow,
        maxTokens: p.maxOutput,
        cost: { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite },
      })),
  });
  return { runtime, agentDir };
}

export interface PiSessionOptions {
  /** Ledger attribution; a function lets a chat session attribute each turn separately. */
  ref: string | (() => string);
  scope: LedgerScope;
  budgetUsd?: number | null;
  model: ModelConfig;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** Chat: on (long conversations). Batch: off (short, avoids an extra LLM call). */
  compaction: boolean;
  cwd: string;
  /** Chat: Pi's JSONL session file — the conversation (incl. compaction) survives a page reload or a
   *  server restart and is resumed by opening the same file. Batch: in memory. */
  sessionFile?: string;
  /** Compact once the context exceeds this many tokens (default: Pi's window - 16k). */
  compactAtTokens?: number;
  /** Recent context kept verbatim by a compaction (default: Pi's 20k). */
  keepRecentTokens?: number;
}

export async function createPiSession(rt: PiRuntime, o: PiSessionOptions): Promise<AgentSession> {
  const base = rt.runtime.getModel(PROVIDER, o.model.model);
  if (!base) throw new Error(`model ${o.model.model} is not registered with provider ${PROVIDER}`);
  const model = { ...base, maxTokens: o.model.maxTokens };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, provider: { maxRetries: 0 } }, // retries live in the proxy only (Q15)
    compaction: {
      enabled: o.compaction,
      ...(o.compactAtTokens ? compactionSettings(base.contextWindow, o.compactAtTokens, o.keepRecentTokens ?? 20_000) : {}),
    },
    cacheWarming: "off", // we warm caches ourselves before fan-out (Q16)
  });

  // The summary request is a standalone call: it carries the same attribution headers as the session.
  const harnessHeaders = (): Record<string, string> => ({
    "x-harness-ref": typeof o.ref === "function" ? o.ref() : o.ref,
    "x-harness-scope": o.scope,
    "x-harness-max-tokens": String(o.model.maxTokens),
    ...(o.budgetUsd != null ? { "x-harness-budget-usd": String(o.budgetUsd) } : {}),
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: o.cwd,
    agentDir: rt.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => o.systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      (pi) => {
        pi.on("before_provider_headers", (event) => {
          event.headers["x-harness-ref"] = typeof o.ref === "function" ? o.ref() : o.ref;
          event.headers["x-harness-scope"] = o.scope;
          event.headers["x-harness-max-tokens"] = String(o.model.maxTokens);
          if (o.budgetUsd != null) event.headers["x-harness-budget-usd"] = String(o.budgetUsd);
          event.headers["User-Agent"] = null;
          event.headers["user-agent"] = null;
        });
        // Domain-aware compaction: Pi's own summariser, plus what an analyst chat must not lose.
        pi.on("session_before_compact", async (event) => {
          const result = await compact(event.preparation, model, "harness-proxy", harnessHeaders(), ANALYST_COMPACTION_FOCUS, event.signal);
          return { compaction: result };
        });
      },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: o.cwd,
    agentDir: rt.agentDir,
    modelRuntime: rt.runtime,
    model,
    thinkingLevel: o.model.thinking,
    tools: o.tools.map((t) => t.name),
    customTools: o.tools,
    resourceLoader,
    sessionManager: o.sessionFile ? SessionManager.open(o.sessionFile, undefined, o.cwd) : SessionManager.inMemory(o.cwd),
    settingsManager,
  });
  return session;
}
