// Records existing val runs as a version's metrics (step 10: version metrics from runs):
//   node --env-file=../.env src/improver/seed.ts v000 b9-val-1-sonnet b9-val-2-sonnet
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "../runtime/app.ts";
import { materializeValMetrics } from "./loop.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function main(): Promise<void> {
  const [version, ...labels] = process.argv.slice(2);
  if (!version || !labels.length) throw new Error("usage: seed.ts <version> <run-label>…");
  const app = await createRuntime({ repoRoot: ROOT });
  try {
    const ids = labels.map((l) => {
      const r = app.db.prepare("SELECT id, status FROM runs WHERE out_path LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%/${l}.answers.jsonl`) as { id: string; status: string } | undefined;
      if (r?.status !== "done") throw new Error(`run ${l} not found or not done`);
      return r.id;
    });
    const levels = Object.fromEntries(
      ["train.jsonl", "val.jsonl"].flatMap((f) =>
        readFileSync(join(ROOT, "bundle", "tasks", f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .map((t) => [t.task_id, t.level]),
      ),
    );
    console.log(JSON.stringify(materializeValMetrics(app, version, ids, levels), null, 2));
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
