// The sql tool (harness DuckDB) and the python tool (py-sandbox payments.duckdb) are built from one
// schema file, config/data-schema.sql, so model code sees the same tables/views in both tools.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pythonTool } from "../src/agent/python-tool.ts";
import { openDataDb, SCHEMA_FILE, schemaStatements } from "../src/data/db.ts";

const BUILD_DB = join(import.meta.dirname, "..", "..", "py-sandbox");
const DATA = join(import.meta.dirname, "..", "..", "bundle", "data");

describe("shared data schema", () => {
  test("TS and the sandbox's build_db.py parse the schema file into identical statements", () => {
    const dir = "/data/it's";
    const py = execFileSync(
      "python3",
      ["-c", "import json,sys; sys.path.insert(0, sys.argv[1]); from build_db import statements; print(json.dumps(statements(open(sys.argv[2]).read(), sys.argv[3])))", BUILD_DB, SCHEMA_FILE, dir],
      { encoding: "utf8" },
    );
    const ts = schemaStatements(dir);
    expect(JSON.parse(py)).toEqual(ts);
    expect(ts).toHaveLength(6);
    expect(ts.join("\n")).toContain("'/data/it''s/payments.csv'");
    expect(ts.join("\n")).not.toContain("--");
  });

  test("the harness DuckDB built from the schema file has every table and payments_m", async () => {
    const db = await openDataDb(DATA);
    try {
      const r = await db.sql("SELECT (SELECT count(*) FROM payments_m) AS n, (SELECT count(*) FROM mcc) AS mcc, (SELECT count(*) FROM acquirer_countries) AS acq");
      expect(r.rows[0]).toEqual({ n: 138236, mcc: 769, acq: 8 });
    } finally {
      db.close();
    }
  });

  test("python tool description points the model at payments.duckdb with the sql tables", () => {
    const d = pythonTool({ url: "http://x", session: "s", version: "v000" }).description;
    expect(d).toContain("payments.duckdb");
    expect(d).toContain("payments_m");
  });
});
