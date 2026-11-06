// Improver guards: early stop in VALIDATE, no new generation after a cut-off time,
// cleanup of versions left as `candidate` by an interrupted run, atomic BEST.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { earlyStop } from "../src/improver/gate.ts";
import { pastCutoff, recoverInterrupted, writeBest } from "../src/improver/loop.ts";

const ROOT = join(import.meta.dirname, "..", "..");

describe("early stop", () => {
  test("first candidate val run more than T below the parent mean → stop", () => {
    expect(earlyStop(70, 76.5, 5)).toBe(true); // 6.5 below
    expect(earlyStop(72, 76.5, 5)).toBe(false); // 4.5 below — keep validating
    expect(earlyStop(80, 76.5, 5)).toBe(false);
  });
});

describe("time cut-off", () => {
  test("HH:MM local; no cut-off → never", () => {
    const at = (h: number, m: number) => new Date(2026, 10, 6, h, m);
    expect(pastCutoff("17:15", at(17, 16))).toBe(true);
    expect(pastCutoff("17:15", at(17, 14))).toBe(false);
    expect(pastCutoff(undefined, at(23, 59))).toBe(false);
  });
});

describe("interrupted runs", () => {
  test("versions left as candidate become rejected (interrupted); BEST is written atomically", () => {
    const repo = mkdtempSync(join(tmpdir(), "intr-"));
    cpSync(join(ROOT, "versions"), join(repo, "versions"), { recursive: true });
    cpSync(join(repo, "versions", "v000"), join(repo, "versions", "v001"), { recursive: true });
    const mp = join(repo, "versions", "v001", "manifest.json");
    writeFileSync(mp, JSON.stringify({ ...JSON.parse(readFileSync(mp, "utf8")), id: "v001", parent: "v000", status: "candidate" }));
    expect(recoverInterrupted(repo)).toEqual(["v001"]);
    expect(JSON.parse(readFileSync(mp, "utf8"))).toMatchObject({ status: "rejected", reject_stage: "interrupted" });
    expect(JSON.parse(readFileSync(join(repo, "versions", "v001", "metrics.json"), "utf8")).reject_reason).toMatch(/interrupted/);
    writeBest(repo, "v000");
    expect(readFileSync(join(repo, "versions", "BEST"), "utf8")).toBe("v000\n");
    expect(existsSync(join(repo, "versions", "BEST.tmp"))).toBe(false);
  });
});
