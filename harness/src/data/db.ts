// DuckDB over the task bundle's data/ (SPEC §4.4 `sql`). Data is loaded into in-memory tables,
// then the database is sealed: no file / network access, configuration locked, SELECT only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, StatementType } from "@duckdb/node-api";

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[]; // at most MAX_ROWS
  row_count: number;
  markdown: string;
}

export interface DataDb {
  sql(query: string, opts?: { timeoutMs?: number }): Promise<SqlResult>;
  /** Compact schema description for the system prompt (stable order → cache friendly). */
  schema(): Promise<string>;
  close(): void;
}

const MAX_ROWS = 200;
/** Shared with py-sandbox/build_db.py: both tools must see the same tables and views. */
export const SCHEMA_FILE = join(import.meta.dirname, "..", "..", "..", "config", "data-schema.sql");

/** config/data-schema.sql → executable statements with {data} filled in. */
export function schemaStatements(dataDir: string, file = SCHEMA_FILE): string[] {
  const path = dataDir.replace(/\/+$/, "").replaceAll("'", "''");
  return readFileSync(file, "utf8")
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
    .map((s) => s.replaceAll("{data}", path));
}
const TABLES = ["payments", "fees", "merchants", "mcc", "acquirer_countries"] as const;

export async function openDataDb(dataDir: string): Promise<DataDb> {
  const instance = await DuckDBInstance.create(":memory:");
  const con = await instance.connect();

  for (const stmt of schemaStatements(dataDir)) await con.run(stmt);

  await con.run("SET enable_external_access = false");
  await con.run("SET lock_configuration = true");

  let busy: Promise<unknown> = Promise.resolve();

  async function runSelect(query: string, timeoutMs: number): Promise<SqlResult> {
    const extracted = await con.extractStatements(query);
    if (extracted.count !== 1) throw new Error(`sql: exactly one statement allowed, got ${extracted.count}`);
    const stmt = await extracted.prepare(0);
    if (stmt.statementType !== StatementType.SELECT) throw new Error("sql: only SELECT queries are allowed (read-only)");

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      con.interrupt();
    }, timeoutMs);
    try {
      const reader = await stmt.runAndReadAll();
      const columns = reader.columnNames();
      const all = reader.getRowObjectsJS().map((r) => plain(r) as Record<string, unknown>);
      const rows = all.slice(0, MAX_ROWS);
      return { columns, rows, row_count: all.length, markdown: toMarkdown(columns, rows, all.length) };
    } catch (e) {
      if (timedOut) throw new Error(`sql: query interrupted after timeout of ${timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // One connection → serialise queries so interrupt() only ever hits the query that timed out.
  const sql: DataDb["sql"] = (query, opts = {}) => {
    const next = busy.then(() => runSelect(query, opts.timeoutMs ?? 20_000));
    busy = next.catch(() => undefined);
    return next;
  };

  return {
    sql,
    async schema() {
      const parts: string[] = [];
      for (const t of [...TABLES, "payments_m"]) {
        const r = await sql(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${t}' ORDER BY ordinal_position`);
        parts.push(`- ${t}(${r.rows.map((c) => `${c.column_name} ${c.data_type}`).join(", ")})`);
      }
      return parts.join("\n");
    },
    close() {
      con.closeSync();
      instance.closeSync();
    },
  };
}

/** DuckDB JS values → JSON-safe: bigint → number when safe (else string), Date → ISO string. */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function toMarkdown(columns: string[], rows: Record<string, unknown>[], total: number): string {
  const lines = [`| ${columns.join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`];
  for (const r of rows) lines.push(`| ${columns.map((c) => cell(r[c])).join(" | ")} |`);
  lines.push(total > rows.length ? `(${total} rows, showing first ${rows.length})` : `(${total} rows)`);
  return lines.join("\n");
}
