// One harness process per state dir (SPEC §2: one process owns all LLM calls and the state DB).
// A second process would re-queue the first one's running tasks on startup and double-spend.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes state/harness.lock (stale locks of dead processes are taken over); returns release(). */
export function acquireStateLock(stateDir: string): () => void {
  const path = join(stateDir, "harness.lock");
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
  } catch {
    const holder = Number(readFileSync(path, "utf8").trim());
    if (holder && holder !== process.pid && alive(holder)) throw new Error(`state dir ${stateDir} is already in use by pid ${holder}`);
    if (holder === process.pid) throw new Error(`state dir ${stateDir} is already in use by pid ${holder} (this process)`);
    writeFileSync(path, `${process.pid}\n`);
  }
  return () => rmSync(path, { force: true });
}
