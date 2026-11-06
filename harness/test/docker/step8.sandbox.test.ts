// SPEC §6 step 8 / A14 (docker): the real py-sandbox container behind sandbox-gateway.
// Needs `docker compose up -d py-sandbox sandbox-gateway`. No LLM spend.
// Run: npm run test:docker
import assert from "node:assert/strict";
import { test } from "node:test";
import { pythonTool } from "../../src/agent/python-tool.ts";

const URL = process.env.PY_SANDBOX_URL ?? "http://127.0.0.1:7070";
const py = (code: string) => pythonTool({ url: URL, session: "a14", version: "v000", timeoutS: 20 }).execute("c", { code } as never, undefined, undefined, {} as never);
const out = async (code: string) => (await py(code)).content.map((c) => ("text" in c ? c.text : "")).join("");

test("python computes the same payments count as the sql tool (138236) with pandas", async () => {
  assert.match(await out("import pandas as pd\nprint(len(pd.read_csv('data/payments.csv')))"), /^138236/);
});

test("duckdb works inside the sandbox", async () => {
  assert.match(await out("import duckdb\nprint(duckdb.sql(\"select count(*) from 'data/fees.json'\").fetchone()[0])"), /^1000/);
});

test("tasks/ and scorer/ are not reachable from the sandbox (A14)", async () => {
  const r = await out(
    [
      "import os",
      "hits = []",
      "for root, dirs, files in os.walk('/', onerror=lambda e: None):",
      "    if root.startswith(('/proc', '/sys', '/dev')): dirs[:] = []; continue",
      "    hits += [os.path.join(root, f) for f in files if f in ('val.jsonl', 'train.jsonl', 'score.py')]",
      "print('HITS', hits)",
      "for p in ['/bundle/tasks/val.jsonl', 'data/../tasks/val.jsonl', '/data/../tasks/val.jsonl']:",
      "    try: open(p); print('OPENED', p)",
      "    except OSError as e: print('DENIED', type(e).__name__)",
    ].join("\n"),
  );
  assert.match(r, /HITS \[\]/);
  assert.doesNotMatch(r, /OPENED/);
});

test("no network egress: urllib, raw socket and a subprocess all fail (A14)", async () => {
  const r = await out(
    [
      "import socket, subprocess, urllib.request",
      "def attempt(name, fn):",
      "    try: fn(); print(name, 'CONNECTED')",
      "    except Exception as e: print(name, 'BLOCKED', type(e).__name__)",
      "attempt('urllib', lambda: urllib.request.urlopen('https://example.com', timeout=5))",
      "attempt('socket', lambda: socket.create_connection(('1.1.1.1', 443), timeout=5))",
      "attempt('litellm', lambda: socket.create_connection(('litellm.zimran.net', 443), timeout=5))",
      "r = subprocess.run(['python3', '-I', '-S', '-c', \"import socket; socket.create_connection(('8.8.8.8', 53), timeout=5)\"], capture_output=True)",
      "print('subprocess', 'BLOCKED' if r.returncode else 'CONNECTED')",
    ].join("\n"),
  );
  assert.doesNotMatch(r, /CONNECTED/, r);
  assert.equal((r.match(/BLOCKED/g) ?? []).length, 4, r);
});

test("runs as uid 65534 on a read-only root filesystem; data/ is read-only", async () => {
  const r = await out(
    [
      "import os",
      "print('uid', os.getuid())",
      "for p in ['/app/x', '/etc/x', 'data/x']:",
      "    try: open(p, 'w'); print('WROTE', p)",
      "    except OSError as e: print('RO', p)",
      "open('scratch.txt', 'w').write('ok'); print('workdir writable')",
    ].join("\n"),
  );
  assert.match(r, /uid 65534/);
  assert.doesNotMatch(r, /WROTE/);
  assert.match(r, /workdir writable/);
});

test("pids limit stops a fork bomb without taking the sandbox down", async () => {
  const r = await out(
    [
      "import subprocess",
      "procs, err = [], None",
      "try:",
      "    for _ in range(400): procs.append(subprocess.Popen(['sleep', '5']))",
      "except OSError as e: err = type(e).__name__",
      "print('spawned', len(procs), 'err', err)",
      "for p in procs: p.kill()",
    ].join("\n"),
  );
  const n = Number(/spawned (\d+)/.exec(r)?.[1]);
  assert.ok(n < 128, r);
  assert.match(await out("print('alive')"), /alive/);
});
