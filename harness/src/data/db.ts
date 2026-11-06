// DuckDB over the task bundle's data/ (SPEC §4.4 `sql`). Data is loaded into in-memory tables,
// then the database is sealed: no file / network access, configuration locked, SELECT only.
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
const TABLES = ["payments", "fees", "merchants", "mcc", "acquirer_countries"] as const;

export async function openDataDb(dataDir: string): Promise<DataDb> {
  const instance = await DuckDBInstance.create(":memory:");
  const con = await instance.connect();
  const f = (name: string) => `'${join(dataDir, name).replaceAll("'", "''")}'`;

  await con.run(`CREATE TABLE payments AS SELECT * FROM read_csv(${f("payments.csv")}, header = true)`);
  await con.run(`CREATE TABLE fees AS SELECT * FROM read_json(${f("fees.json")})`);
  await con.run(`CREATE TABLE merchants AS SELECT * FROM read_json(${f("merchant_data.json")})`);
  // The two small CSVs carry a pandas index as an unnamed first column — drop it.
  await con.run(`CREATE TABLE mcc AS SELECT mcc, description FROM read_csv(${f("merchant_category_codes.csv")}, header = true)`);
  await con.run(
    `CREATE TABLE acquirer_countries AS SELECT acquirer, country_code FROM read_csv(${f("acquirer_countries.csv")}, header = true)`,
  );
  // Natural months (manual §5): all payments are 2023.
  await con.run(
    "CREATE VIEW payments_m AS SELECT *, CAST(month(DATE '2023-01-01' + CAST(day_of_year - 1 AS INTEGER)) AS INTEGER) AS month FROM payments",
  );

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
