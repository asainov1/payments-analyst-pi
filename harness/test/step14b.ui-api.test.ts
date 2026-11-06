// SPEC §4.1–§4.2 endpoints the web UI needs: versions (list / diff / promote), budget, feedback,
// run progress SSE, improve (501 until steps 11–13), static web/dist.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { buildServer } from "../src/api/server.ts";
import { openDb } from "../src/db/db.ts";
import { BatchRunner, type Solver } from "../src/runs/batch.ts";
import { BudgetLedger } from "../src/runtime/budget.ts";
import { VersionsService } from "../src/versions/service.ts";

const REAL_ROOT = join(import.meta.dirname, "..", "..");
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "repo-"));
  const v = (id: string, status: string, parent: string | null, metrics?: object, diff?: string) => {
    mkdirSync(join(root, "versions", id), { recursive: true });
    writeFileSync(join(root, "versions", id, "manifest.json"), JSON.stringify({ id, parent, status, change_summary: `${id} summary`, created_at: "2026-11-06", models: { analyst: "claude-haiku-5-5", reflector: "x" }, thinking: "off", limits: {}, tool_descriptions: {} }));
    if (metrics) writeFileSync(join(root, "versions", id, "metrics.json"), JSON.stringify(metrics));
    if (diff !== undefined) writeFileSync(join(root, "versions", id, "diff.patch"), diff);
  };
  v("v000", "baseline", null, { val: { correct: 39, n: 91, accuracy: 0.4286 }, cost_per_task_usd: 0.0043 });
  v("v001", "promoted", "v000", { val: { correct: 45, n: 91, accuracy: 0.4945 } }, "--- a/playbook.md\n+++ b/playbook.md\n+R001 rule\n");
  v("v002", "rejected", "v001", undefined, "+bad\n");
  writeFileSync(join(root, "versions", "BEST"), "v000\n");
  const dist = join(root, "web", "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>analyst</title>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  return { root, dist };
}

async function start(deps: Parameters<typeof buildServer>[0]) {
  app = buildServer(deps);
  return app.listen({ port: 0, host: "127.0.0.1" });
}
const post = (base: string, p: string, b: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

describe("versions", () => {
  test("list → { best, versions } with metrics (null when absent), sorted by id", async () => {
    const { root } = fixture();
    const base = await start({ versions: new VersionsService(root) });
    const body = await (await fetch(`${base}/api/versions`)).json();
    expect(body.best).toBe("v000");
    expect(body.versions.map((v: { id: string }) => v.id)).toEqual(["v000", "v001", "v002"]);
    expect(body.versions[0].metrics.val.correct).toBe(39);
    expect(body.versions[2].metrics).toBeNull();
    expect(body.versions[1].change_summary).toBe("v001 summary");
  });

  test("diff → text/x-diff; baseline without diff → empty; unknown → 404", async () => {
    const { root } = fixture();
    const base = await start({ versions: new VersionsService(root) });
    const r = await fetch(`${base}/api/versions/v001/diff`);
    expect(r.headers.get("content-type")).toContain("text/x-diff");
    expect(await r.text()).toContain("+R001 rule");
    expect(await (await fetch(`${base}/api/versions/v000/diff`)).text()).toBe("");
    expect((await fetch(`${base}/api/versions/v999/diff`)).status).toBe(404);
  });

  test("promote (serve / rollback) rewrites versions/BEST; rejected → 422; unknown → 404", async () => {
    const { root } = fixture();
    const base = await start({ versions: new VersionsService(root) });
    const r = await post(base, "/api/versions/v001/promote", {});
    expect(r.status).toBe(200);
    expect((await r.json()).best).toBe("v001");
    expect(readFileSync(join(root, "versions", "BEST"), "utf8").trim()).toBe("v001");
    expect((await post(base, "/api/versions/v000/promote", {})).status).toBe(200); // rollback
    expect((await post(base, "/api/versions/v002/promote", {})).status).toBe(422);
    expect((await post(base, "/api/versions/v999/promote", {})).status).toBe(404);
  });
});

describe("budget and feedback", () => {
  test("budget = cap, spent, remaining from the ledger", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "b-")), "h.db"));
    const ledger = new BudgetLedger(db, { capUsd: 135 });
    ledger.record({ scope: "solve", ref: "r/1", costUsd: 0.64 });
    const base = await start({ ledger });
    expect(await (await fetch(`${base}/api/budget`)).json()).toEqual({ cap_usd: 135, spent_usd: 0.64, remaining_usd: 134.36 });
  });

  test("feedback 👍/👎 stored per turn; unknown turn → 404; bad rating → 400", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "f-")), "h.db"));
    db.prepare("INSERT INTO sessions (id, version, origin) VALUES ('s1', 'v000', 'ui')").run();
    db.prepare("INSERT INTO turns (id, session_id, idx, user_message, outcome, answer, usage_json, latency_ms) VALUES ('t1', 's1', 0, 'q', 'answered', 'a', '{}', 1)").run();
    const base = await start({ db });
    const r = await post(base, "/api/feedback", { turn_id: "t1", rating: "down", comment: "wrong merchant filter" });
    expect(r.status).toBe(201);
    const { id } = await r.json();
    expect(db.prepare("SELECT turn_id, rating, comment, consumed_by FROM feedback WHERE id = ?").get(id)).toEqual({ turn_id: "t1", rating: "down", comment: "wrong merchant filter", consumed_by: null });
    expect((await post(base, "/api/feedback", { turn_id: "nope", rating: "up" })).status).toBe(404);
    expect((await post(base, "/api/feedback", { turn_id: "t1", rating: "meh" })).status).toBe(400);
  });
});

describe("runs", () => {
  test("GET /api/runs/:id/events streams progress {done,total,stage} then run.end {status}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-"));
    const io = join(dir, "io");
    mkdirSync(io);
    const lines = readFileSync(join(REAL_ROOT, "bundle", "tasks", "train.jsonl"), "utf8").split("\n").filter(Boolean).slice(0, 4);
    writeFileSync(join(io, "t.jsonl"), `${lines.join("\n")}\n`);
    const solver: Solver = async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { answer: "Not Applicable" };
    };
    const runner = new BatchRunner({ db: openDb(join(dir, "h.db")), solver, concurrency: 1, ioDir: io, repoRoot: REAL_ROOT });
    const base = await start({ runner, progressPollMs: 50 });
    const { run_id } = await (await post(base, "/api/runs/solve", { tasks_file: join(io, "t.jsonl"), version: "v000", out: join(io, "a.jsonl") })).json();
    const text = await (await fetch(`${base}/api/runs/${run_id}/events`)).text();
    const ev = text
      .split("\n\n")
      .filter((b) => b.includes("event:"))
      .map((b) => ({ event: /event: (.*)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? "null") }));
    const prog = ev.filter((e) => e.event === "progress").map((e) => e.data);
    expect(prog.length).toBeGreaterThanOrEqual(2);
    expect(prog.every((p) => p.total === 4 && p.stage === "solve")).toBe(true);
    expect(prog.map((p) => p.done)).toEqual([...prog.map((p) => p.done)].sort((a, b) => a - b));
    expect(prog.at(-1)?.done).toBe(4);
    expect(ev.at(-1)).toEqual({ event: "run.end", data: { status: "done" } });
  });

  test("improve → 501 not_implemented until steps 11–13", async () => {
    const base = await start({});
    const r = await post(base, "/api/runs/improve", { generations: 1, budget_usd: 1 });
    expect(r.status).toBe(501);
    expect((await r.json()).error.code).toBe("not_implemented");
  });
});

describe("static UI", () => {
  test("serves web/dist; /api stays API; no path traversal", async () => {
    const { dist } = fixture();
    const base = await start({ webDist: dist });
    const html = await fetch(`${base}/`);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("analyst");
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
  });
});
