// Per-turn and per-task limits (SPEC §3.3): exceeding any of them aborts the turn / task.

export type LimitKind = "tool_calls" | "turn_usd" | "turn_s" | "task_usd";

export class LimitExceeded extends Error {
  readonly code = "limit_exceeded";
  readonly kind: LimitKind;
  constructor(kind: LimitKind, detail: string) {
    super(`limit ${kind} exceeded: ${detail}`);
    this.kind = kind;
  }
}

export interface TurnLimitConfig {
  max_tool_calls: number;
  max_turn_usd: number;
  max_turn_s: number;
}

export class TurnLimits {
  private toolCalls = 0;
  private costUsd = 0;
  private readonly started: number;
  private readonly cfg: TurnLimitConfig;
  private readonly now: () => number;

  constructor(cfg: TurnLimitConfig, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
    this.started = now();
  }

  onToolCall(): void {
    this.toolCalls++;
    if (this.toolCalls > this.cfg.max_tool_calls) throw new LimitExceeded("tool_calls", `${this.toolCalls} > ${this.cfg.max_tool_calls}`);
    this.check();
  }

  onLlmCost(usd: number): void {
    this.costUsd += usd;
    if (this.costUsd > this.cfg.max_turn_usd) throw new LimitExceeded("turn_usd", `$${this.costUsd.toFixed(4)} > $${this.cfg.max_turn_usd}`);
    this.check();
  }

  check(): void {
    const s = (this.now() - this.started) / 1000;
    if (s > this.cfg.max_turn_s) throw new LimitExceeded("turn_s", `${s.toFixed(1)}s > ${this.cfg.max_turn_s}s`);
  }
}

export class TaskLimits {
  private costUsd = 0;
  private readonly cfg: { max_task_usd: number };
  constructor(cfg: { max_task_usd: number }) {
    this.cfg = cfg;
  }

  add(usd: number): void {
    this.costUsd += usd;
    if (this.costUsd > this.cfg.max_task_usd) throw new LimitExceeded("task_usd", `$${this.costUsd.toFixed(4)} > $${this.cfg.max_task_usd}`);
  }
}
