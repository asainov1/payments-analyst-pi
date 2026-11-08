"""py-sandbox exec server (SPEC §4.4 `python`, §4.5). Stdlib only.

POST /exec {"code": str, "session": str, "version": str, "timeout_s"?: int}
  → {"stdout": str, "stderr": str, "exit_code": int, "timed_out": bool, "ms": int}

Each session gets a workdir under WORK_DIR with `data` → DATA_DIR, `skills` → the version's
skills (both read-only mounts in the container) and `payments.duckdb` → DB_FILE (read-only). Isolation (no network, read-only root fs,
uid 65534, memory/pids limits) is enforced by the container, not by this process.
"""

import json
import os
import re
import signal
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("DATA_DIR", "/data")
VERSIONS_DIR = os.environ.get("VERSIONS_DIR", "/versions")
WORK_DIR = os.environ.get("WORK_DIR", "/work")
# Read-only DuckDB with the same tables/views as the harness `sql` tool (built into the image by
# build_db.py from config/data-schema.sql); linked into each workdir as payments.duckdb.
DB_FILE = os.environ.get("DB_FILE", "")
MAX_OUTPUT = int(os.environ.get("MAX_OUTPUT", "8192"))
DEFAULT_TIMEOUT = int(os.environ.get("TIMEOUT_S", "60"))
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
VERSION_ID = re.compile(r"^v\d{3}$")


def truncate(s):
    if len(s) <= MAX_OUTPUT:
        return s
    return s[:MAX_OUTPUT] + f"\n... [truncated {len(s) - MAX_OUTPUT} chars]"


def link(target, name, cwd):
    path = os.path.join(cwd, name)
    if os.path.lexists(path):
        os.remove(path)
    os.symlink(target, path)


def run(code, session, version, timeout_s):
    cwd = os.path.join(WORK_DIR, session)
    os.makedirs(cwd, exist_ok=True)
    link(DATA_DIR, "data", cwd)
    if DB_FILE and os.path.isfile(DB_FILE):
        link(DB_FILE, "payments.duckdb", cwd)
    skills = os.path.join(VERSIONS_DIR, version, "skills")
    if os.path.isdir(skills):
        link(skills, "skills", cwd)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": cwd,
        "MPLCONFIGDIR": cwd,
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    started = time.time()
    p = subprocess.Popen(
        ["python3", "-c", code],
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    timed_out = False
    try:
        out, err = p.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(p.pid, signal.SIGKILL)
        out, err = p.communicate()
    return {
        "stdout": truncate(out.decode("utf-8", "replace")),
        "stderr": truncate(err.decode("utf-8", "replace")),
        "exit_code": p.returncode,
        "timed_out": timed_out,
        "ms": int((time.time() - started) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/exec":
            self.reply(404, {"error": "not found"})
            return
        try:
            req = json.loads(
                self.rfile.read(int(self.headers.get("content-length", "0")))
            )
            code, session, version = (
                req["code"],
                str(req["session"]),
                str(req["version"]),
            )
        except (ValueError, KeyError, TypeError):
            self.reply(400, {"error": "expected JSON {code, session, version}"})
            return
        if not SAFE_ID.match(session):
            self.reply(400, {"error": "invalid session id"})
            return
        if not VERSION_ID.match(version):
            self.reply(400, {"error": "invalid version id"})
            return
        timeout_s = min(int(req.get("timeout_s") or DEFAULT_TIMEOUT), DEFAULT_TIMEOUT)
        self.reply(200, run(code, session, version, timeout_s))

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(
        ("0.0.0.0", int(os.environ.get("PORT", "8000"))), Handler
    )
    print(f"listening on http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
