// Promotion gate (SPEC §3.4 GATE): mean of k val runs per side, majority-vote wins/losses,
// threshold T from the noise between identical runs, no easy regressions, cost-guard.

export interface Side {
  /** one Map(task_id → correct) per val run */
  runs: Array<Map<string, boolean>>;
  costPerTask: number;
}

export interface GateDecision {
  parent_correct: number;
  cand_correct: number;
  wins: number;
  losses: number;
  confirmed_wins: number;
  easy_regressions: number;
  threshold_T: number;
  parent_cost_per_task: number;
  cand_cost_per_task: number;
  decision: "promote" | "reject";
  reason: string;
}

/** σ_run = √(F̄/2) from flips between pairs of identical runs; T_k = max(2, ⌈2·σ_run·√(2/k)⌉). */
export function thresholdT(pairFlips: number[], k: number): number {
  const f = pairFlips.reduce((a, b) => a + b, 0) / (pairFlips.length || 1);
  const sigma = Math.sqrt(f / 2);
  return Math.max(2, Math.ceil(2 * sigma * Math.sqrt(2 / k) - 1e-9));
}

export function pairFlips(runs: Array<Map<string, boolean>>): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++) out.push([...runs[i].keys()].filter((t) => runs[i].get(t) !== runs[j].get(t)).length);
  return out;
}

const mean = (runs: Array<Map<string, boolean>>) => runs.reduce((s, r) => s + [...r.values()].filter(Boolean).length, 0) / runs.length;
const majority = (runs: Array<Map<string, boolean>>, t: string) => runs.filter((r) => r.get(t)).length * 2 > runs.length;

export function gateDecision(o: { parent: Side; cand: Side; levels: Record<string, string>; T: number }): GateDecision {
  const tasks = [...o.parent.runs[0].keys()];
  let wins = 0;
  let losses = 0;
  let easy = 0;
  for (const t of tasks) {
    const p = majority(o.parent.runs, t);
    const c = majority(o.cand.runs, t);
    if (c && !p) wins++;
    if (p && !c) {
      losses++;
      if (o.levels[t] === "easy") easy++;
    }
  }
  const pc = mean(o.parent.runs);
  const cc = mean(o.cand.runs);
  const d: GateDecision = {
    parent_correct: Math.round(pc * 100) / 100,
    cand_correct: Math.round(cc * 100) / 100,
    wins,
    losses,
    confirmed_wins: wins,
    easy_regressions: easy,
    threshold_T: o.T,
    parent_cost_per_task: o.parent.costPerTask,
    cand_cost_per_task: o.cand.costPerTask,
    decision: "reject",
    reason: "",
  };
  const fails: string[] = [];
  if (cc - pc < o.T) fails.push(`mean gain ${(cc - pc).toFixed(2)} < T=${o.T}`);
  if (wins - losses < 1) fails.push(`majority wins−losses ${wins - losses} < 1`);
  if (easy > 0) fails.push(`${easy} easy regression(s)`);
  if (o.cand.costPerTask > 1.3 * o.parent.costPerTask) fails.push(`cost ${o.cand.costPerTask.toFixed(4)} > 1.3× parent ${o.parent.costPerTask.toFixed(4)}`);
  d.decision = fails.length ? "reject" : "promote";
  d.reason = fails.length ? fails.join("; ") : `mean +${(cc - pc).toFixed(2)} ≥ T=${o.T}, wins ${wins} / losses ${losses}`;
  return d;
}

/** VALIDATE early stop: the candidate's first val run is more than T below the parent's mean → reject without the remaining runs. */
export function earlyStop(candFirst: number, parentMean: number, T: number): boolean {
  return parentMean - candFirst > T;
}
