// Improve runs inside the service (SPEC §4.1 POST /api/runs/improve): one at a time, progress kept in
// memory for the run events SSE; the versions themselves are the durable record (versions/vNNN).
import { randomUUID } from "node:crypto";
import { RequestError } from "../runs/paths.ts";

export type ImproveFn = (o: {
  generations: number;
  budgetUsd: number;
  improveRunId: string;
  onProgress?: (stage: string, info: Record<string, unknown>) => void;
}) => Promise<{ promoted: string[]; rejected: string[]; spent_usd: number }>;

export interface ImproveRun {
  id: string;
  kind: "improve";
  status: "running" | "done" | "stopped_budget" | "failed";
  generations: number;
  budget_usd: number;
  stage: string;
  gen: number;
  last: Record<string, unknown>;
  result?: { promoted: string[]; rejected: string[]; spent_usd: number };
  error?: string;
  created_at: string;
}

export class ImproveService {
  private readonly fn: ImproveFn;
  private readonly runs = new Map<string, ImproveRun>();
  constructor(fn: ImproveFn) {
    this.fn = fn;
  }

  start(o: { generations: number; budgetUsd: number }): string {
    if ([...this.runs.values()].some((r) => r.status === "running")) throw new RequestError("run_in_progress", 409, "an improve run is already in progress");
    const id = `imp-${randomUUID().slice(0, 8)}`;
    const run: ImproveRun = { id, kind: "improve", status: "running", generations: o.generations, budget_usd: o.budgetUsd, stage: "start", gen: 0, last: {}, created_at: new Date().toISOString() };
    this.runs.set(id, run);
    this.fn({
      generations: o.generations,
      budgetUsd: o.budgetUsd,
      improveRunId: id,
      onProgress: (stage, info) => {
        run.stage = stage;
        if (typeof info.gen === "number") run.gen = info.gen;
        run.last = info;
        if (stage === "stopped_budget") run.status = "stopped_budget";
      },
    }).then(
      (r) => {
        run.result = r;
        if (run.status === "running") run.status = "done";
      },
      (e) => {
        run.status = "failed";
        run.error = String(e instanceof Error ? e.message : e);
      },
    );
    return id;
  }

  get(id: string): { run: ImproveRun; progress: { done: number; total: number; stage: string } } | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const done = run.status === "running" ? Math.max(0, run.gen - 1) : run.generations;
    return { run, progress: { done, total: run.generations, stage: run.stage } };
  }
}
