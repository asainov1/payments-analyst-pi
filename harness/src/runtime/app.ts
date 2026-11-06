// Process-wide runtime (SPEC §2): one state DB, ledger + governor, the LLM proxy, Pi runtime,
// sealed data DB, Langfuse tracing and the py-sandbox URL. Used by the server and experiments.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAnalystSolver, type SolveTrace } from "../agent/analyst.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { dataTools } from "../agent/tools.ts";
import type { ChatSessionFactory } from "../chat/service.ts";
import { type DataDb, openDataDb } from "../data/db.ts";
import { type Db, openDb } from "../db/db.ts";
import { resolveModelConfig } from "../llm/model-config.ts";
import { createPiRuntime, createPiSession, type PiRuntime } from "../llm/pi.ts";
import { loadPrices, type PriceTable } from "../llm/prices.ts";
import { LlmProxy, type LlmUsageEvent } from "../llm/proxy.ts";
import { type Tracing, tracingFromEnv } from "../obs/tracer.ts";
import type { Solver } from "../runs/batch.ts";
import { loadManifest, versionDir } from "../versions/manifest.ts";
import { BudgetLedger } from "./budget.ts";
import { Governor } from "./governor.ts";
import { acquireStateLock } from "./lock.ts";

export interface AppRuntime {
  repoRoot: string;
  stateDir: string;
  dataDir: string;
  db: Db;
  ledger: BudgetLedger;
  governor: Governor;
  proxy: LlmProxy;
  prices: PriceTable;
  rt: PiRuntime;
  data: DataDb;
  tracing: Tracing | null;
  pythonUrl: string | undefined;
  solver(opts?: { modelOverride?: string; onTrace?: (taskId: string, t: SolveTrace) => void; guard?: () => void }): Solver;
  onUsage(fn: (e: LlmUsageEvent) => void): () => void;
  /** Chat: data tools for a session (ask_user is added by ChatService). */
  chatTools(o: { sessionId: string; version: string }): ToolDefinition[];
  chatFactory: ChatSessionFactory;
  close(): Promise<void>;
}

export async function createRuntime(o: { repoRoot: string; stateDir?: string; env?: NodeJS.ProcessEnv }): Promise<AppRuntime> {
  const env = o.env ?? process.env;
  const stateDir = o.stateDir ?? join(o.repoRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  if (!env.LITELLM_BASE_URL || !env.LITELLM_API_KEY) throw new Error("LITELLM_BASE_URL / LITELLM_API_KEY are not set");
  const releaseLock = acquireStateLock(stateDir);

  const db = openDb(join(stateDir, "harness.db"));
  const ledger = new BudgetLedger(db, { capUsd: Number(env.GLOBAL_BUDGET_USD ?? 135) });
  const governor = new Governor({ ledger, concurrency: Number(env.LLM_CONCURRENCY ?? 8), rpm: Number(env.LLM_RPM ?? 120) });
  const prices = loadPrices(join(o.repoRoot, "config", "prices.json"));
  const proxy = new LlmProxy({ upstream: env.LITELLM_BASE_URL, apiKey: env.LITELLM_API_KEY, governor, prices });
  const proxyUrl = await proxy.start();
  const rt = await createPiRuntime({ proxyUrl, prices, stateDir });
  const dataDir = join(o.repoRoot, "bundle", "data");
  const data = await openDataDb(dataDir);
  const tracing = tracingFromEnv(env);
  const pythonUrl = env.PY_SANDBOX_URL || undefined;

  const onUsage = (fn: (e: LlmUsageEvent) => void) => {
    proxy.on("usage", fn);
    return () => {
      proxy.off("usage", fn);
    };
  };

  return {
    repoRoot: o.repoRoot,
    stateDir,
    dataDir,
    db,
    ledger,
    governor,
    proxy,
    prices,
    rt,
    data,
    tracing,
    pythonUrl,
    onUsage,
    chatTools: ({ sessionId, version }) =>
      dataTools({ db: data, dataDir, python: pythonUrl ? { url: pythonUrl, session: `chat_${sessionId}`, version } : undefined }),
    chatFactory: async ({ version, tools, ref }) => {
      const v = loadManifest(o.repoRoot, version);
      const model = resolveModelConfig(prices, { model: v.models.analyst, thinking: v.thinking, limits: { max_output_tokens: v.limits.max_output_tokens } });
      const systemPrompt = await buildSystemPrompt({ versionDir: versionDir(o.repoRoot, version), dataDir, db: data, mode: "chat" });
      return createPiSession(rt, { ref, scope: "chat", model, systemPrompt, tools, compaction: true, cwd: join(stateDir, "work") });
    },
    solver(opts = {}) {
      const inner = createAnalystSolver(
        { rt, db: data, dataDir, repoRoot: o.repoRoot, workDir: join(stateDir, "work"), prices, onUsage, tracing, pythonUrl, modelOverride: opts.modelOverride },
        opts.onTrace,
      );
      return async (task, ctx) => {
        opts.guard?.();
        return inner(task, ctx);
      };
    },
    async close() {
      await tracing?.flush();
      await tracing?.shutdown();
      await proxy.stop();
      data.close();
      releaseLock();
    },
  };
}
