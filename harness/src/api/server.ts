// HTTP API (SPEC §4.1) — only the run endpoints needed by `harness solve` so far.
import Fastify, { type FastifyInstance } from "fastify";
import type { BatchRunner } from "../runs/batch.ts";
import { RequestError } from "../runs/paths.ts";

export function buildServer(deps: { runner: BatchRunner }): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: { code: "invalid_request", message: (err as Error).message } });
    }
    return reply.status(500).send({ error: { code: "internal", message: (err as Error).message } });
  });

  app.get("/api/health", async () => ({ ok: true }));

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
      const runId = await deps.runner.startSolve({ tasksFile: b.tasks_file, version: b.version, out: b.out });
      return reply.status(202).send({ run_id: runId });
    },
  );

  app.get("/api/runs/:id", async (req, reply) => {
    const v = deps.runner.get((req.params as { id: string }).id);
    if (!v) return reply.status(404).send({ error: { code: "not_found", message: "run not found" } });
    const done = v.tasks.filter((t) => t.status === "done" || t.status === "error").length;
    const correct = v.tasks.some((t) => t.correct !== null) ? v.tasks.filter((t) => t.correct).length : null;
    return { run: v.run, progress: { done, total: v.tasks.length, correct } };
  });

  return app;
}
