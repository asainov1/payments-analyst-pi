// Batch I/O paths are confined (SPEC §4.1): tasks under /io or bundle/tasks, answers under /io only.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export class RequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Resolves `p` (relative paths against repoRoot) and requires it to lie inside one of `allowed`. */
export function confinePath(p: string, allowed: string[], field: string, repoRoot: string): string {
  const abs = resolve(isAbsolute(p) ? p : join(repoRoot, p));
  const ok = allowed.some((dir) => {
    const rel = relative(resolve(dir), abs);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!ok) throw new RequestError("invalid_request", 400, `${field} must be inside ${allowed.join(" or ")}: ${p}`);
  return abs;
}

/** "best" → content of versions/BEST; the version directory must exist. */
export function resolveVersion(version: string, repoRoot: string): string {
  const id = version === "best" ? readFileSync(join(repoRoot, "versions", "BEST"), "utf8").trim() : version;
  if (!/^v\d{3}$/.test(id) || !existsSync(join(repoRoot, "versions", id, "manifest.json"))) {
    throw new RequestError("version_invalid", 422, `unknown version: ${version}`);
  }
  return id;
}
