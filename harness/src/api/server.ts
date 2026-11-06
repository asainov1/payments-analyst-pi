// HTTP API (SPEC §4.1–§4.2): batch runs and chat sessions with SSE turns.
import Fastify, { type FastifyInstance } from "fastify";
import type { ChatService } from "../chat/service.ts";
import type { BatchRunner } from "../runs/batch.ts";
import { RequestError } from "../runs/paths.ts";

const HEARTBEAT_MS = 15_000;

export function buildServer(deps: { runner?: BatchRunner; chat?: ChatService }): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: { code: "invalid_request", message: (err as Error).message } });
    }
    return reply.status(500).send({ error: { code: "internal", message: (err as Error).message } });
  });

  app.get("/api/health", async () => ({ ok: true }));

  const { runner, chat } = deps;

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

  return app;
}
