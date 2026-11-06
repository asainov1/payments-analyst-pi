// `harness improve` / `harness report` through the API (SPEC §5): improve runs in the service,
// progress over the run events SSE; report renders the versions table. Fake improve loop, no LLM.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { ImproveService } from "../src/api/improve-service.ts";
import { buildServer } from "../src/api/server.ts";
import { improveCommand, renderReport, reportCommand } from "../src/cli/harness.ts";
import { VersionsService } from "../src/versions/service.ts";

const ROOT = join(import.meta.dirname, "..", "..");
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe("improve via API", () => {
  test("202 run_id; progress events; second start while running → 409; run.end done", async () => {
    let release: () => void = () => {};
    const svc = new ImproveService(async (o) => {
      o.onProgress?.("analyze", { gen: 1 });
      await new Promise<void>((r) => {
        release = r;
      });
      o.onProgress?.("gate", { gen: 1, decision: "promote" });
      return { promoted: ["v001"], rejected: [], spent_usd: 1.2 };
    });
    app = buildServer({ improve: svc, progressPollMs: 20 });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const post = (b: unknown) => fetch(`${base}/api/runs/improve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const r = await post({ generations: 2, budget_usd: 5 });
    expect(r.status).toBe(202);
    const { run_id } = await r.json();
    expect((await post({ generations: 1, budget_usd: 1 })).status).toBe(409);
    const evP = fetch(`${base}/api/runs/${run_id}/events`).then((x) => x.text());
    await new Promise((res) => setTimeout(res, 60));
    release();
    const ev = (await evP)
      .split("\n\n")
      .filter((b) => b.includes("event:"))
      .map((b) => ({ event: /event: (.*)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? "null") }));
    expect(ev.some((e) => e.event === "progress" && e.data.stage === "analyze" && e.data.total === 2)).toBe(true);
    expect(ev.at(-1)).toEqual({ event: "run.end", data: { status: "done" } });
    const run = await (await fetch(`${base}/api/runs/${run_id}`)).json();
    expect(run.run).toMatchObject({ kind: "improve", status: "done", result: { promoted: ["v001"] } });
  });

  test("CLI improve follows progress and prints the result", async () => {
    const svc = new ImproveService(async (o) => {
      o.onProgress?.("propose", { gen: 1 });
      return { promoted: [], rejected: ["v001"], spent_usd: 0.4 };
    });
    app = buildServer({ improve: svc, progressPollMs: 20 });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const lines: string[] = [];
    const run = await improveCommand({ baseUrl: base, generations: 1, budgetUsd: 1, pollMs: 20, log: (s) => lines.push(s) });
    expect(run.status).toBe("done");
    expect(lines.join("\n")).toMatch(/rejected.*v001/);
  });
});

describe("report", () => {
  test("renders per-version val (mean of runs), easy/hard, $/task, cache, p50/p95, status, change", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rep-"));
    cpSync(join(ROOT, "versions"), join(repo, "versions"), { recursive: true });
    writeFileSync(
      join(repo, "versions", "v000", "metrics.json"),
      JSON.stringify({ val: { correct: 40.5, n: 91, accuracy: 0.445, by_level: { easy: 0.72, hard: 0.41 }, runs: [39, 42] }, cost_per_task_usd: 0.0043, cache_hit_rate: 0.907, latency_p50_s: 7.9, latency_p95_s: 180 }),
    );
    app = buildServer({ versions: new VersionsService(repo) });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const md = renderReport((await (await fetch(`${base}/api/versions`)).json()) as never, "md");
    const best = readFileSync(join(repo, "versions", "BEST"), "utf8").trim();
    expect(md).toContain(best === "v000" ? "| v000 ★ |" : "| v000 |");
    expect(md).toContain(`| ${best} ★ |`);
    expect(md).toContain("40.5/91");
    expect(md).toContain("44.5%");
    expect(md).toContain("90.7%");
    const lines: string[] = [];
    await reportCommand({ baseUrl: base, md: false, log: (s) => lines.push(s) });
    expect(lines.join("\n")).toContain("v000");
  });
});
