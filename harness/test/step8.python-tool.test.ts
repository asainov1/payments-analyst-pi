// SPEC §6 step 8 (unit part): python tool ↔ py-sandbox exec server contract. The real server
// (py-sandbox/server.py, stdlib only) runs locally on a random port against a temp data dir.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { pythonTool } from "../src/agent/python-tool.ts";

const SERVER = join(import.meta.dirname, "..", "..", "py-sandbox", "server.py");
let proc: ChildProcess;
let url = "";

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "pysbx-"));
  const data = join(root, "data");
  mkdirSync(data);
  writeFileSync(join(data, "payments.csv"), "psp_reference,eur_amount\n1,10.5\n2,20\n3,30\n");
  mkdirSync(join(root, "versions", "v000", "skills", "fees"), { recursive: true });
  writeFileSync(join(root, "versions", "v000", "skills", "fees", "helper.py"), "def double(x):\n    return 2 * x\n");
  proc = spawn("python3", [SERVER], {
    env: { PATH: process.env.PATH, PORT: "0", DATA_DIR: data, VERSIONS_DIR: join(root, "versions"), WORK_DIR: join(root, "work"), MAX_OUTPUT: "2000" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  url = await new Promise<string>((resolve, reject) => {
    proc.stdout?.on("data", (b: Buffer) => {
      const m = /listening on (http:\/\/\S+)/.exec(b.toString());
      if (m) resolve(m[1]);
    });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
afterAll(() => proc?.kill());

const run = (code: string, version = "v000") =>
  pythonTool({ url, session: "s1", version }).execute("c", { code } as never, undefined, undefined, {} as never);
const text = (r: { content: Array<{ type: string }> }) => r.content.map((c) => ("text" in c ? String(c.text) : "")).join("");

describe("python tool", () => {
  test("runs code with data/ mounted; stdout returned", async () => {
    expect(text(await run("import csv\nrows=list(csv.DictReader(open('data/payments.csv')))\nprint(len(rows), sum(float(r['eur_amount']) for r in rows))"))).toContain("3 60.5");
  });

  test("skills of the session's version are importable", async () => {
    expect(text(await run("import sys; sys.path.insert(0, 'skills/fees')\nfrom helper import double\nprint(double(21))"))).toContain("42");
  });

  test("non-zero exit → tool error with stderr", async () => {
    await expect(run("raise ValueError('boom')")).rejects.toThrow(/ValueError: boom/);
  });

  test("timeout kills the process", async () => {
    await expect(pythonTool({ url, session: "s1", version: "v000", timeoutS: 1 }).execute("c", { code: "while True: pass" } as never, undefined, undefined, {} as never)).rejects.toThrow(/timed out/);
  });

  test("output is truncated", async () => {
    const out = text(await run("print('x' * 50000)"));
    expect(out.length).toBeLessThan(2500);
    expect(out).toMatch(/truncated/);
  });

  test("files persist within a session's workdir between calls", async () => {
    await run("open('tmp.txt','w').write('hello')");
    expect(text(await run("print(open('tmp.txt').read())"))).toContain("hello");
  });

  test("unknown version → error, no skills", async () => {
    await expect(run("print(1)", "../../etc")).rejects.toThrow(/version/);
  });
});
