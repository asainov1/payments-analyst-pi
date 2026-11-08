"""Build the sandbox's read-only DuckDB file from the shared schema (config/data-schema.sql).

usage: python3 build_db.py <schema.sql> <data_dir> <out.duckdb>

The harness `sql` tool loads the same schema, so Python code sees the same tables and views
(payments, payments_m, fees, merchants, mcc, acquirer_countries) via
duckdb.connect("payments.duckdb", read_only=True).
"""

import os
import sys


def statements(schema_text, data_dir):
    path = data_dir.rstrip("/").replace("'", "''")
    out = []
    for chunk in schema_text.split(";\n"):
        lines = [ln for ln in chunk.split("\n") if not ln.strip().startswith("--")]
        stmt = "\n".join(lines).strip().rstrip(";").strip()
        if stmt:
            out.append(stmt.replace("{data}", path))
    return out


def main():
    schema_file, data_dir, out = sys.argv[1:4]
    import duckdb  # only inside the sandbox image; server.py itself stays stdlib-only

    tmp = out + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = duckdb.connect(tmp)
    with open(schema_file, encoding="utf-8") as f:
        for stmt in statements(f.read(), data_dir):
            con.execute(stmt)
    con.close()
    os.replace(tmp, out)
    print(f"built {out}", flush=True)


if __name__ == "__main__":
    main()
