// Fixed, seeded train split (SPEC §3.2 runs/splits): `improve` for the improver, `report_holdout`
// kept away from it to check whether gains hold outside val. Stores task ids only.

export interface Splits {
  seed: number;
  improve: string[];
  report_holdout: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSplits(tasks: Array<{ task_id: string; level?: string }>, opts: { seed: number; holdoutFraction: number }): Splits {
  const rand = mulberry32(opts.seed);
  const byLevel = new Map<string, string[]>();
  for (const t of tasks) byLevel.set(t.level ?? "unknown", [...(byLevel.get(t.level ?? "unknown") ?? []), t.task_id]);
  const improve: string[] = [];
  const holdout: string[] = [];
  for (const level of [...byLevel.keys()].sort()) {
    const ids = [...(byLevel.get(level) ?? [])].sort();
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const k = Math.ceil(ids.length * opts.holdoutFraction);
    holdout.push(...ids.slice(0, k));
    improve.push(...ids.slice(k));
  }
  const num = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);
  return { seed: opts.seed, improve: improve.sort(num), report_holdout: holdout.sort(num) };
}
