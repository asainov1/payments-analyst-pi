// Live probe of the provided LiteLLM endpoint (SPEC §6, step 1). Costs a few cents.
// Run: node --env-file=.env --test harness/test/live/litellm.probe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { listModels, messages } from "../../src/llm/litellm.ts";

const REQUIRED = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6.1-sol", "gemini-3.8-flash"];

// ~18k tokens of stable prefix: comfortably above Anthropic's minimum cacheable length.
const PREFIX = Array.from({ length: 400 }, (_, i) =>
  `Rule ${i}: a fee rule applies when card_scheme, account_type and aci match; fee = fixed + rate * amount / 10000.`,
).join("\n");

test("model list contains all models we plan to use", async () => {
  const ids = await listModels();
  console.log("models:", ids.join(", "));
  for (const m of REQUIRED) assert.ok(ids.includes(m), `missing model ${m}`);
});

for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
  test(`${model}: /v1/messages works and 2nd identical call reads from cache`, async () => {
    const nonce = `probe-${Date.now()}`; // fresh prefix → 1st call must write, 2nd must read
    const body = {
      model,
      max_tokens: 16,
      system: [{ type: "text", text: `${nonce}\n${PREFIX}`, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Reply with just: ok" }],
    };
    const first = await messages(body);
    const second = await messages(body);
    for (const [i, r] of [first, second].entries()) {
      console.log(model, `call#${i + 1}`, JSON.stringify(r.json.usage), "headers:", JSON.stringify(r.headers));
    }
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.ok((first.json.usage.cache_creation_input_tokens ?? 0) > 0, "1st call should write cache");
    assert.ok((second.json.usage.cache_read_input_tokens ?? 0) > 0, "2nd call should read cache");
  });
}
