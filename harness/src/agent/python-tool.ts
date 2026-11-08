// `python` tool (SPEC §4.4): code runs in the py-sandbox service (no network, read-only fs,
// only data/ and the version's skills/ visible). Non-zero exit or timeout → tool error.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function pythonTool(o: { url: string; session: string; version: string; timeoutS?: number }): ToolDefinition {
  return defineTool({
    name: "python",
    label: "Python",
    description:
      "Run Python 3.12 (pandas, duckdb available) in a sandbox. Files: data/ (payments.csv, fees.json, merchant_data.json, " +
      "merchant_category_codes.csv, acquirer_countries.csv, manual.md) and skills/ (helper scripts of this harness version). " +
      "payments.duckdb has the SAME tables and views as the sql tool (payments, payments_m, fees, merchants, mcc, " +
      "acquirer_countries): con = duckdb.connect('payments.duckdb', read_only=True); df = con.sql('SELECT ...').df(). " +
      "A new duckdb.connect() without that file is an empty database. " +
      "No network. Print what you need; output is truncated at 8 KB. Files you write persist within this conversation.",
    parameters: Type.Object({ code: Type.String({ description: "Python source to execute" }) }),
    async execute(_id, p, signal) {
      const res = await fetch(`${o.url.replace(/\/+$/, "")}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: p.code, session: o.session, version: o.version, timeout_s: o.timeoutS }),
        signal,
      });
      const body = (await res.json()) as { stdout?: string; stderr?: string; exit_code?: number; timed_out?: boolean; error?: string };
      if (!res.ok) throw new Error(`python sandbox: ${body.error ?? res.status}`);
      if (body.timed_out) throw new Error(`python timed out\n${body.stderr ?? ""}`);
      if (body.exit_code !== 0) throw new Error(`python exited with ${body.exit_code}\n${body.stderr ?? ""}${body.stdout ?? ""}`);
      const out = `${body.stdout ?? ""}${body.stderr ? `\n[stderr]\n${body.stderr}` : ""}`;
      return { content: [{ type: "text", text: out || "(no output)" }], details: {} };
    },
  }) as ToolDefinition;
}
