// Dev fallback when the LiteLLM key is unavailable: harness proxy (Anthropic Messages, model claude-*)
// -> an OpenRouter model. Rewrites `model`, drops `thinking` and unsigned thinking blocks, swaps auth.
//   OPENROUTER_API_KEY=… [OR_MODEL=…] node scripts/openrouter-shim.mjs   (then LITELLM_BASE_URL=http://host.docker.internal:4010)
import http from "node:http";

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OR_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";
const PORT = Number(process.env.OR_PORT ?? 4010);
if (!KEY) throw new Error("OPENROUTER_API_KEY not set");

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    }
    if (body.length && (req.headers["content-type"] ?? "").includes("json")) {
      const j = JSON.parse(body.toString());
      if (j.model) j.model = MODEL;
      delete j.thinking;
      // unsigned thinking blocks from the free model must not be sent back
      for (const m of j.messages ?? [])
        if (Array.isArray(m.content)) m.content = m.content.filter((c) => c?.type !== "thinking" && c?.type !== "redacted_thinking");
      body = Buffer.from(JSON.stringify(j));
    }
    try {
      const up = await fetch(`https://openrouter.ai/api${req.url}`, {
        method: req.method,
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${KEY}` },
        body: req.method === "GET" ? undefined : body,
      });
      const h = {};
      up.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) h[k] = v;
      });
      res.writeHead(up.status, h);
      if (up.body) for await (const c of up.body) res.write(c);
      res.end();
      console.log(new Date().toISOString(), req.method, req.url, up.status);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e) } }));
    }
  })
  .listen(PORT, "0.0.0.0", () => console.log(`or-shim :${PORT} -> ${MODEL}`));
