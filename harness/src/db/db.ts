// SQLite state (SPEC §3.1) on Node's built-in node:sqlite — no extra dependency.
// Migrations are append-only; PRAGMA user_version tracks how many have been applied.
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  `CREATE TABLE ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     scope TEXT NOT NULL CHECK (scope IN ('chat','solve','improve','mcp','probe')),
     ref TEXT NOT NULL,
     cost_usd REAL NOT NULL
   );
   CREATE INDEX ledger_ref ON ledger(ref);`,
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     version TEXT NOT NULL,
     tasks_file TEXT NOT NULL,
     out_path TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('queued','running','done','stopped_budget','failed')),
     scorable INTEGER NOT NULL,
     summary_json TEXT,
     error TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     finished_at TEXT
   );
   CREATE INDEX runs_out ON runs(out_path);
   CREATE TABLE run_tasks (
     run_id TEXT NOT NULL REFERENCES runs(id),
     task_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','running','done','error')),
     attempts INTEGER NOT NULL DEFAULT 0,
     answer TEXT,
     correct INTEGER,
     PRIMARY KEY (run_id, task_id)
   );`,
  // Per-call LLM accounting from the proxy (SPEC §7: cost_source, aborted/estimated rows).
  `ALTER TABLE ledger ADD COLUMN model TEXT;
   ALTER TABLE ledger ADD COLUMN input INTEGER;
   ALTER TABLE ledger ADD COLUMN output INTEGER;
   ALTER TABLE ledger ADD COLUMN cache_read INTEGER;
   ALTER TABLE ledger ADD COLUMN cache_write INTEGER;
   ALTER TABLE ledger ADD COLUMN cost_source TEXT;
   ALTER TABLE ledger ADD COLUMN provider_cost_usd REAL;
   ALTER TABLE ledger ADD COLUMN aborted INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE ledger ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE ledger ADD COLUMN ms INTEGER;`,
  `ALTER TABLE run_tasks ADD COLUMN ms INTEGER;`,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = user_version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec("COMMIT");
  }
  return db;
}
