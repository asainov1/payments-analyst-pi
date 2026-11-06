// Analyst tools as Pi ToolDefinitions (SPEC §4.4). Thrown errors become tool errors the model sees.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DataDb } from "../data/db.ts";
import { readManual } from "../data/manual.ts";
import { pythonTool } from "./python-tool.ts";
import type { AnswerSlot } from "./submit.ts";

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export interface AnalystToolOptions extends DataToolOptions {
  slot: AnswerSlot;
  /** Batch: an accepted submit_answer ends the turn (no final LLM call). Chat: false — the model writes the answer text. */
  terminateOnSubmit?: boolean;
}

export interface DataToolOptions {
  db: DataDb;
  dataDir: string;
  /** py-sandbox; omitted → no python tool. */
  python?: { url: string; session: string; version: string };
  /** Per-version overrides from manifest.tool_descriptions (improver op `tool_description`). */
  descriptions?: Record<string, string>;
}

const withDescription = (t: ToolDefinition, d?: Record<string, string>): ToolDefinition => (d?.[t.name] ? { ...t, description: d[t.name] } : t);

/** Tools over the data shared by chat and batch: sql, read_manual (+ python when a sandbox is configured). */
export function dataTools(o: DataToolOptions): ToolDefinition[] {
  const sql = defineTool({
    name: "sql",
    label: "SQL",
    description:
      "Run ONE read-only DuckDB SELECT over tables payments, payments_m (adds natural `month`), fees, merchants, mcc, acquirer_countries. " +
      "Returns a markdown table (first 200 rows) and the exact row count. No file access, no writes.",
    parameters: Type.Object({ query: Type.String({ description: "A single SELECT statement" }) }),
    async execute(_id, p) {
      const r = await o.db.sql(p.query);
      return textResult(r.markdown);
    },
  });

  const manual = defineTool({
    name: "read_manual",
    label: "Read manual",
    description: "Read the rules manual (manual.md): a section by heading name, or lines matching `grep` with line numbers. Without arguments lists sections.",
    parameters: Type.Object({
      section: Type.Optional(Type.String({ description: "Heading, e.g. 'Account Type'" })),
      grep: Type.Optional(Type.String({ description: "Case-insensitive substring" })),
    }),
    async execute(_id, p) {
      return textResult(readManual(o.dataDir, p));
    },
  });

  return ([sql, manual, ...(o.python ? [pythonTool(o.python)] : [])] as ToolDefinition[]).map((t) => withDescription(t, o.descriptions));
}

/** Batch analyst: data tools + submit_answer bound to the task's answer slot. */
export function analystTools(o: AnalystToolOptions): ToolDefinition[] {
  const submit = defineTool({
    name: "submit_answer",
    label: "Submit answer",
    description:
      "Submit the final answer exactly in the format required by the answer guidelines (no units, no prose). " +
      "Returns {ok:true} or a reason and the expected format — then fix and submit again.",
    parameters: Type.Object({
      answer: Type.String(),
      assumptions: Type.Optional(Type.Array(Type.String(), { description: "Interpretations you chose for ambiguous parts" })),
    }),
    async execute(_id, p) {
      const r = o.slot.submit(p);
      return { ...textResult(JSON.stringify(r)), ...(r.ok && o.terminateOnSubmit ? { terminate: true } : {}) };
    },
  });

  return [...dataTools(o), withDescription(submit as ToolDefinition, o.descriptions)];
}
