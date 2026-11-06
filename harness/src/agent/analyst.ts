// Batch analyst (Solver): one fresh Pi session per task, tools over the sealed data, answer via
// submit_answer. Turn limits abort the session; spend is attributed to `<runId>/<taskId>`.
import { mkdirSync } from "node:fs";
import type { DataDb } from "../data/db.ts";
import { resolveModelConfig } from "../llm/model-config.ts";
import { createPiSession, type PiRuntime } from "../llm/pi.ts";
import type { PriceTable } from "../llm/prices.ts";
import type { LlmUsageEvent } from "../llm/proxy.ts";
import { type Tracing, traceTurn } from "../obs/tracer.ts";
import type { Solver } from "../runs/batch.ts";
import { LimitExceeded, TurnLimits } from "../runtime/limits.ts";
import { loadManifest, versionDir } from "../versions/manifest.ts";
import { buildSystemPrompt, taskToPrompt } from "./prompt.ts";
import { AnswerSlot } from "./submit.ts";
import { analystTools } from "./tools.ts";

export interface AnalystDeps {
  rt: PiRuntime;
  db: DataDb;
  dataDir: string;
  repoRoot: string;
  workDir: string;
  prices: PriceTable;
  /** Subscribe to proxy usage events; returns unsubscribe. */
  onUsage: (fn: (e: LlmUsageEvent) => void) => () => void;
  /** Smoke/experiments only: run a version with a different analyst model. */
  modelOverride?: string;
  /** Langfuse; null → no tracing (unit tests). */
  tracing?: Tracing | null;
}

export interface SolveTrace {
  answer: string;
  valid: boolean | null;
  assumptions: string[];
  toolCalls: number;
  costUsd: number;
  limit: string | null;
  traceUrl: string | null;
}

const NUDGE = "You have not called submit_answer yet. Call it now with your final answer in exactly the required format.";

export function createAnalystSolver(d: AnalystDeps, onTrace?: (taskId: string, t: SolveTrace) => void): Solver {
  const prompts = new Map<string, Promise<string>>(); // per version: identical text → cache hits
  const systemPrompt = (version: string) => {
    let p = prompts.get(version);
    if (!p) {
      p = buildSystemPrompt({ versionDir: versionDir(d.repoRoot, version), dataDir: d.dataDir, db: d.db, mode: "batch" });
      prompts.set(version, p);
    }
    return p;
  };

  return async (task, ctx) => {
    const v = loadManifest(d.repoRoot, ctx.version);
    const model = resolveModelConfig(d.prices, {
      model: d.modelOverride ?? v.models.analyst,
      thinking: v.thinking,
      limits: { max_output_tokens: v.limits.max_output_tokens },
    });
    const ref = `${ctx.runId}/${ctx.taskId}`;
    const slot = new AnswerSlot(task.guidelines);
    // One shared cwd for every session: Pi renders <cwd> into the system prompt, so a per-task cwd
    // would give every task a different prefix and defeat cross-task prompt caching.
    const cwd = d.workDir;
    mkdirSync(cwd, { recursive: true });

    const session = await createPiSession(d.rt, {
      ref,
      scope: "solve",
      model,
      systemPrompt: await systemPrompt(ctx.version),
      tools: analystTools({ db: d.db, dataDir: d.dataDir, slot }),
      compaction: false,
      cwd,
    });

    const limits = new TurnLimits(v.limits);
    let limit: string | null = null;
    let toolCalls = 0;
    let costUsd = 0;
    const stop = (e: unknown) => {
      if (e instanceof LimitExceeded && !limit) {
        limit = e.kind;
        void session.abort();
      }
    };
    const unsubUsage = d.onUsage((e) => {
      if (e.ref !== ref) return;
      costUsd += e.costUsd;
      try {
        limits.onLlmCost(e.costUsd);
      } catch (err) {
        stop(err);
      }
    });
    const unsubSession = session.subscribe((e) => {
      if (e.type !== "tool_execution_start") return;
      toolCalls++;
      try {
        limits.onToolCall();
      } catch (err) {
        stop(err);
      }
    });
    const lf = d.tracing
      ? traceTurn(d.tracing, session, {
          name: "task",
          sessionId: ctx.runId,
          version: ctx.version,
          tags: ["solve", ctx.version, model.model],
          metadata: { ref, task_id: ctx.taskId, model: model.model, thinking: model.thinking },
          input: { question: task.question, guidelines: task.guidelines },
          model: model.model,
        })
      : null;
    const timer = setTimeout(() => stop(new LimitExceeded("turn_s", `> ${v.limits.max_turn_s}s`)), v.limits.max_turn_s * 1000);

    try {
      await session.prompt(taskToPrompt(task));
      if (!slot.result() && !limit) await session.prompt(NUDGE);
    } finally {
      clearTimeout(timer);
      const r0 = slot.result();
      lf?.end(
        { answer: r0?.answer ?? "Not Applicable", assumptions: r0?.assumptions ?? [] },
        { valid: String(r0?.valid ?? "none"), limit: limit ?? "none", tool_calls: String(toolCalls), cost_usd: costUsd.toFixed(6) },
      );
      unsubUsage();
      unsubSession();
      session.dispose();
    }

    const r = slot.result();
    const trace: SolveTrace = {
      answer: r?.answer ?? "Not Applicable",
      valid: r?.valid ?? null,
      assumptions: r?.assumptions ?? [],
      toolCalls,
      costUsd,
      limit,
      traceUrl: lf?.traceUrl ?? null,
    };
    onTrace?.(ctx.taskId, trace);
    return { answer: trace.answer };
  };
}
