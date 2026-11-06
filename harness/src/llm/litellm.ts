// Minimal raw client for the LiteLLM proxy. Used by the step-1 probe; the agent itself talks to
// LiteLLM through Pi (models.json), not through this module.

function config(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.LITELLM_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.LITELLM_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("LITELLM_BASE_URL and LITELLM_API_KEY must be set (.env)");
  return { baseUrl, apiKey };
}

// Headers worth recording: rate limits and LiteLLM's own cost accounting.
const INTERESTING = /^(x-ratelimit-|x-litellm-|retry-after|anthropic-ratelimit-)/i;

export async function listModels(): Promise<string[]> {
  const { baseUrl, apiKey } = config();
  const res = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data.map((m) => m.id);
}

export async function messages(body: unknown): Promise<{ status: number; json: any; headers: Record<string, string> }> {
  const { baseUrl, apiKey } = config();
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (INTERESTING.test(k)) headers[k] = v; });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers };
}
