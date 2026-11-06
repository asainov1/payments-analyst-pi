// HTTP API (SPEC §4.1–§4.2): batch runs and chat sessions with SSE turns.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { ChatService } from "../chat/service.ts";
import type { Db } from "../db/db.ts";
import type { BatchRunner } from "../runs/batch.ts";
import { RequestError } from "../runs/paths.ts";
import type { BudgetLedger } from "../runtime/budget.ts";
import type { VersionsService } from "../versions/service.ts";

const HEARTBEAT_MS = 15_000;
const TERMINAL = new Set(["done", "stopped_budget", "failed"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export interface ServerDeps {
  runner?: BatchRunner;
  chat?: ChatService;
  versions?: VersionsService;
  ledger?: BudgetLedger;
  /** State DB (feedback). */
  db?: Db;
  /** Built UI (web/dist); served for non-/api paths when present. */
  webDist?: string;
  progressPollMs?: number;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: { code: "invalid_request", message: (err as Error).message } });
    }
    return reply.status(500).send({ error: { code: "internal", message: (err as Error).message } });
  });

  app.get("/api/health", async () => ({ ok: true }));

  const { runner, chat, versions, ledger, db } = deps;

  // Until the improver lands (steps 11–13) — explicit, so the UI can show it (SPEC §4.1).
  app.post("/api/runs/improve", async (_req, reply) =>
    reply.status(501).send({ error: { code: "not_implemented", message: "improver is not implemented yet (SPEC steps 11–13)" } }),
  );

  if (versions) {
    app.get("/api/versions", async () => versions.list());
    app.get("/api/versions/:id/diff", async (req, reply) => reply.type("text/x-diff; charset=utf-8").send(versions.diff((req.params as { id: string }).id)));
    app.post("/api/versions/:id/promote", async (req) => versions.promote((req.params as { id: string }).id));
  }

  if (ledger) {
    app.get("/api/budget", async () => {
      const spent = Math.round(ledger.spentUsd() * 1e6) / 1e6;
      return { cap_usd: ledger.capUsd, spent_usd: spent, remaining_usd: Math.round((ledger.capUsd - spent) * 1e6) / 1e6 };
    });
  }

  if (db) {
    app.post(
      "/api/feedback",
      {
        schema: {
          body: {
            type: "object",
            required: ["turn_id", "rating"],
            properties: { turn_id: { type: "string" }, rating: { type: "string", enum: ["up", "down"] }, comment: { type: "string", maxLength: 4000 } },
          },
        },
      },
      async (req, reply) => {
        const b = req.body as { turn_id: string; rating: "up" | "down"; comment?: string };
        if (!db.prepare("SELECT 1 FROM turns WHERE id = ?").get(b.turn_id)) throw new RequestError("not_found", 404, "turn not found");
        const id = randomUUID();
        db.prepare("INSERT INTO feedback (id, turn_id, rating, comment) VALUES (?, ?, ?, ?)").run(id, b.turn_id, b.rating, b.comment ?? null);
        return reply.status(201).send({ id });
      },
    );
  }

  if (runner) {
    app.post(
      "/api/runs/solve",
      {
        schema: {
          body: {
            type: "object",
            required: ["tasks_file", "version", "out"],
            properties: { tasks_file: { type: "string" }, version: { type: "string" }, out: { type: "string" } },
          },
        },
      },
      async (req, reply) => {
        const b = req.body as { tasks_file: string; version: string; out: string };
        const runId = await runner.startSolve({ tasksFile: b.tasks_file, version: b.version, out: b.out });
        return reply.status(202).send({ run_id: runId });
      },
    );

    app.get("/api/runs/:id/events", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!runner.get(id)) return reply.status(404).send({ error: { code: "not_found", message: "run not found" } });
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      let open = true;
      raw.on("close", () => {
        open = false;
      });
      const send = (event: string, data: unknown) => {
        if (open) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let last = -1;
      let lastBeat = Date.now();
      while (open) {
        const v = runner.get(id);
        if (!v) break;
        const done = v.tasks.filter((t) => t.status === "done" || t.status === "error").length;
        if (done !== last) {
          send("progress", { done, total: v.tasks.length, stage: v.run.kind === "solve" ? "solve" : v.run.kind });
          last = done;
        }
        if (TERMINAL.has(v.run.status)) {
          send("run.end", { status: v.run.status });
          break;
        }
        if (Date.now() - lastBeat > HEARTBEAT_MS) {
          if (open) raw.write(": hb\n\n");
          lastBeat = Date.now();
        }
        await new Promise((r) => setTimeout(r, deps.progressPollMs ?? 1000));
      }
      raw.end();
    });

    app.get("/api/runs/:id", async (req, reply) => {
      const v = runner.get((req.params as { id: string }).id);
      if (!v) return reply.status(404).send({ error: { code: "not_found", message: "run not found" } });
      const done = v.tasks.filter((t) => t.status === "done" || t.status === "error").length;
      const correct = v.tasks.some((t) => t.correct !== null) ? v.tasks.filter((t) => t.correct).length : null;
      return { run: v.run, progress: { done, total: v.tasks.length, correct } };
    });
  }

  if (chat) {
    app.post("/api/sessions", { schema: { body: { type: "object", properties: { version: { type: "string" } } } } }, async (req, reply) => {
      const b = (req.body ?? {}) as { version?: string };
      return reply.status(201).send(chat.create(b.version ?? "best"));
    });

    app.get("/api/sessions/:id", async (req, reply) => {
      const v = chat.get((req.params as { id: string }).id);
      if (!v) return reply.status(404).send({ error: { code: "not_found", message: "session not found" } });
      return v;
    });

    app.post(
      "/api/sessions/:id/turns",
      { schema: { body: { type: "object", required: ["message"], properties: { message: { type: "string", minLength: 1 } } } } },
      async (req, reply) => {
        const id = (req.params as { id: string }).id;
        const { message } = req.body as { message: string };
        chat.assertCanStart(id); // 404 / 409 as JSON, before the stream starts

        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
        let open = true;
        const write = (s: string) => {
          if (open) raw.write(s);
        };
        const hb = setInterval(() => write(": hb\n\n"), HEARTBEAT_MS);
        raw.on("close", () => {
          if (!open) return;
          open = false;
          chat.abort(id); // client went away → stop the turn (the proxy cancels the upstream call)
        });
        try {
          await chat.runTurn(id, message, (e) => write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
        } catch (err) {
          const e = err instanceof RequestError ? { code: err.code, message: err.message } : { code: "internal", message: String(err) };
          write(`event: error\ndata: ${JSON.stringify(e)}\n\n`);
        } finally {
          clearInterval(hb);
          open = false;
          raw.end();
        }
      },
    );

    app.post("/api/sessions/:id/abort", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!chat.get(id)) return reply.status(404).send({ error: { code: "not_found", message: "session not found" } });
      chat.abort(id);
      return reply.status(202).send({ ok: true });
    });
  }

  if (deps.webDist && existsSync(join(deps.webDist, "index.html"))) {
    const root = normalize(deps.webDist);
    app.get("/*", async (req, reply) => {
      const url = decodeURIComponent((req.url.split("?")[0] ?? "/").replace(/^\/+/, ""));
      if (url.startsWith("api/")) return reply.status(404).send({ error: { code: "not_found", message: "no such endpoint" } });
      const file = normalize(join(root, url || "index.html"));
      if (!file.startsWith(root + sep) && file !== root) return reply.status(404).send({ error: { code: "not_found", message: "not found" } });
      const target = existsSync(file) && statSync(file).isFile() ? file : null;
      if (!target) return reply.status(404).send({ error: { code: "not_found", message: "not found" } });
      return reply.type(MIME[extname(target)] ?? "application/octet-stream").send(readFileSync(target));
    });
  }

  return app;
}
