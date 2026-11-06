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
