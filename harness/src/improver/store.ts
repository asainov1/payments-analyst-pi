// Version store (SPEC §3.2 versions/store): every proposal becomes versions/vNNN with manifest,
// system.md, playbook.json + rendered playbook.md, skills/, diff.patch vs parent and metrics.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { VersionManifest } from "../versions/manifest.ts";
import type { Curation, VersionContent } from "./curator.ts";
import { emptyPlaybook, type Playbook, renderPlaybook } from "./playbook.ts";

const vdir = (repo: string, id: string) => join(repo, "versions", id);

export function readVersion(repo: string, id: string): VersionContent {
  const d = vdir(repo, id);
  const manifest = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")) as VersionManifest;
  const pbPath = join(d, "playbook.json");
  const playbook: Playbook = existsSync(pbPath) ? JSON.parse(readFileSync(pbPath, "utf8")) : emptyPlaybook();
  const skills: VersionContent["skills"] = {};
  const sd = join(d, "skills");
  if (existsSync(sd)) {
    for (const name of readdirSync(sd).sort()) {
      skills[name] = {};
      for (const f of readdirSync(join(sd, name)).sort()) skills[name][f] = readFileSync(join(sd, name, f), "utf8");
    }
  }
  return { manifest, system: readFileSync(join(d, "system.md"), "utf8"), playbook, skills };
}

/** All text files of a version as path → content (for diffs and leak-checks). */
export function versionFiles(c: VersionContent): Record<string, string> {
  const files: Record<string, string> = {
    "manifest.json": `${JSON.stringify({ ...c.manifest, id: undefined, parent: undefined, status: undefined, created_at: undefined, change_summary: undefined }, null, 2)}\n`,
    "system.md": c.system,
    "playbook.md": `${renderPlaybook(c.playbook)}\n`,
  };
  for (const [name, fs] of Object.entries(c.skills)) for (const [f, body] of Object.entries(fs)) files[`skills/${name}/${f}`] = body;
  return files;
}

export function diffVersions(parent: VersionContent, child: VersionContent): string {
  const a = versionFiles(parent);
  const b = versionFiles(child);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((p) => a[p] !== b[p])
    .map((p) => createTwoFilesPatch(`a/${p}`, `b/${p}`, a[p] ?? "", b[p] ?? "", "", "", { context: 3 }).replace(/^=+\n/, ""))
    .join("\n");
}

export function nextVersionId(repo: string): string {
  const ids = readdirSync(join(repo, "versions"))
    .filter((d) => /^v\d{3}$/.test(d))
    .map((d) => Number(d.slice(1)));
  return `v${String(Math.max(-1, ...ids) + 1).padStart(3, "0")}`;
}

export function createVersion(
  repo: string,
  o: {
    parent: string;
    content: VersionContent;
    status: VersionManifest["status"];
    change_summary: string;
    curation?: Curation;
    reflectCostUsd: number;
    rejectStage?: string;
    rejectReason?: string;
    /** leak-check rejects store the redacted diff instead of the real one */
    diffOverride?: string;
  },
): string {
  const id = nextVersionId(repo);
  const d = vdir(repo, id);
  mkdirSync(d, { recursive: true });
  const parent = readVersion(repo, o.parent);
  const manifest = {
    ...o.content.manifest,
    id,
    parent: o.parent,
    status: o.status,
    created_at: new Date().toISOString(),
    change_summary: o.change_summary,
    ...(o.rejectStage ? { reject_stage: o.rejectStage } : {}),
  };
  const content = { ...o.content, manifest };
  writeFileSync(join(d, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!o.diffOverride) {
    writeFileSync(join(d, "system.md"), content.system);
    writeFileSync(join(d, "playbook.json"), `${JSON.stringify(content.playbook, null, 2)}\n`);
    writeFileSync(join(d, "playbook.md"), `${renderPlaybook(content.playbook)}\n`);
    for (const [name, fs] of Object.entries(content.skills)) {
      mkdirSync(join(d, "skills", name), { recursive: true });
      for (const [f, body] of Object.entries(fs)) writeFileSync(join(d, "skills", name, f), body);
    }
  } else {
    // leaked content is not stored: the version keeps only manifest, metrics and the redacted diff
    writeFileSync(join(d, "system.md"), parent.system);
    writeFileSync(join(d, "playbook.json"), `${JSON.stringify(parent.playbook, null, 2)}\n`);
    writeFileSync(join(d, "playbook.md"), `${renderPlaybook(parent.playbook)}\n`);
  }
  writeFileSync(join(d, "diff.patch"), o.diffOverride ?? diffVersions(parent, content));
  writeFileSync(
    join(d, "metrics.json"),
    `${JSON.stringify({ val: null, reflect_cost_usd: o.reflectCostUsd, ...(o.rejectReason ? { reject_reason: o.rejectReason } : {}), ...(o.curation ? { curation: o.curation } : {}) }, null, 2)}\n`,
  );
  return id;
}

export function updateManifest(repo: string, id: string, patch: Partial<VersionManifest> & Record<string, unknown>): void {
  const p = join(vdir(repo, id), "manifest.json");
  writeFileSync(p, `${JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }, null, 2)}\n`);
}

export function updateMetrics(repo: string, id: string, patch: Record<string, unknown>): void {
  const p = join(vdir(repo, id), "metrics.json");
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  writeFileSync(p, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
}

export type { VersionContent } from "./curator.ts";
