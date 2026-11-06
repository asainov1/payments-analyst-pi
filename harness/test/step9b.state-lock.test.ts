// One harness process per state dir: a second process would re-queue the first one's running tasks.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { acquireStateLock } from "../src/runtime/lock.ts";

describe("state lock", () => {
  test("second acquire while the holder is alive fails; release frees it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    const release = acquireStateLock(dir);
    expect(() => acquireStateLock(dir)).toThrow(/already in use by pid/);
    release();
    expect(existsSync(join(dir, "harness.lock"))).toBe(false);
    acquireStateLock(dir)();
  });

  test("a stale lock (dead pid) is taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    writeFileSync(join(dir, "harness.lock"), "999999\n");
    const release = acquireStateLock(dir);
    release();
  });
});
