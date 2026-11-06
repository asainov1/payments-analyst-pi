// Pi session factory (SPEC §3.2 agent/session, step 2). All Pi LLM traffic goes to the in-process
// proxy; per-session attribution is a `before_provider_headers` inline extension (SPEC §7, Q14).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
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
}

export async function createPiSession(rt: PiRuntime, o: PiSessionOptions): Promise<AgentSession> {
  const base = rt.runtime.getModel(PROVIDER, o.model.model);
  if (!base) throw new Error(`model ${o.model.model} is not registered with provider ${PROVIDER}`);
  const model = { ...base, maxTokens: o.model.maxTokens };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, provider: { maxRetries: 0 } }, // retries live in the proxy only (Q15)
    compaction: { enabled: o.compaction },
    cacheWarming: "off", // we warm caches ourselves before fan-out (Q16)
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
    sessionManager: SessionManager.inMemory(o.cwd),
    settingsManager,
  });
  return session;
}
