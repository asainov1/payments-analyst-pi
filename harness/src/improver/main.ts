// Host entry for the improver (SPEC §6 step 13):
//   node --env-file=../.env src/improver/main.ts --generations N --budget-usd X
// Uses the same runtime as the service (state/, ledger cap, proxy, Langfuse). The harness CLI
// `harness improve` goes through the API once that is wired; this entry runs it directly.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createRuntime } from "../runtime/app.ts";
import { improve } from "./loop.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { generations: { type: "string", default: "3" }, "budget-usd": { type: "string", default: "20" }, "no-new-generation-after": { type: "string" } } });
  const app = await createRuntime({ repoRoot: ROOT });
  const id = `imp-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}-${randomUUID().slice(0, 4)}`;
  try {
    const r = await improve(app, {
      generations: Number(values.generations),
      budgetUsd: Number(values["budget-usd"]),
      improveRunId: id,
      noNewGenerationAfter: values["no-new-generation-after"],
      onProgress: (stage, info) => console.log(`[${new Date().toISOString()}] ${stage} ${JSON.stringify(info)}`),
    });
    console.log(`DONE ${JSON.stringify(r)}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
