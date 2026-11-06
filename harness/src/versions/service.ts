// Version list / diff / serve (SPEC §4.1): versions/<id>/{manifest.json, metrics.json, diff.patch}, versions/BEST.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RequestError } from "../runs/paths.ts";

const ID = /^v\d{3}$/;

export class VersionsService {
  private readonly dir: string;
  constructor(repoRoot: string) {
    this.dir = join(repoRoot, "versions");
  }

  best(): string {
    return readFileSync(join(this.dir, "BEST"), "utf8").trim();
  }

  private path(id: string): string {
    if (!ID.test(id) || !existsSync(join(this.dir, id, "manifest.json"))) throw new RequestError("not_found", 404, `unknown version ${id}`);
    return join(this.dir, id);
  }

  list(): { best: string; versions: Array<Record<string, unknown>> } {
    const ids = readdirSync(this.dir)
      .filter((d) => ID.test(d) && existsSync(join(this.dir, d, "manifest.json")))
      .sort();
    const versions = ids.map((id) => {
      const manifest = JSON.parse(readFileSync(join(this.dir, id, "manifest.json"), "utf8"));
      const m = join(this.dir, id, "metrics.json");
      return { ...manifest, metrics: existsSync(m) ? JSON.parse(readFileSync(m, "utf8")) : null };
    });
    return { best: this.best(), versions };
  }

  diff(id: string): string {
    const p = join(this.path(id), "diff.patch");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  /** Serve this version as `best` (promotion or rollback). Rejected / candidate versions cannot be served. */
  promote(id: string): { best: string } {
    const manifest = JSON.parse(readFileSync(join(this.path(id), "manifest.json"), "utf8")) as { status: string };
    if (manifest.status !== "baseline" && manifest.status !== "promoted") {
      throw new RequestError("version_invalid", 422, `version ${id} is ${manifest.status}; only baseline/promoted versions can be served`);
    }
    writeFileSync(join(this.dir, "BEST"), `${id}\n`);
    return { best: id };
  }
}
