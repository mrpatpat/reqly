import { normativeFingerprint } from "./markdown.js";
import type { ReqlyRepository } from "./repository.js";
import type { ReqlyRecord } from "./types.js";
import { validateRepository } from "./validate.js";

export async function traceabilityReport(repository: ReqlyRepository): Promise<{ markdown: string; json: unknown }> {
  const validation = await validateRepository(repository);
  const items = [...repository.records.values()].sort((a, b) => a.data.id.localeCompare(b.data.id));
  const rows = items.map((record) => {
    return {
      id: record.data.id, type: record.type, title: record.data.title, status: record.status,
      verified: record.type === "requirement" ? repository.verificationState(record.data.id) : undefined,
      parents: (record.data.relations ?? []).filter((relation) => repository.config.relations[relation.type]?.acyclic === true),
      artifacts: record.data.artifacts ?? [],
    };
  });
  const markdown = [`# Reqly Traceability Report`, "", `| Item | Type | Status | Verified | Parents | Artifacts |`, `|---|---|---|---|---|---|`, ...rows.map((row) => `| ${row.id} ${row.title} | ${row.type} | ${row.status} | ${row.verified === undefined ? "—" : row.verified ? "yes" : "no"} | ${row.parents.map((parent) => parent.target).join(", ") || "—"} | ${row.artifacts.join("<br>") || "—"} |`), "", `Diagnostics: ${validation.diagnostics.length}`].join("\n");
  return { markdown, json: { items: rows, diagnostics: validation.diagnostics } };
}

export function graphData(repository: ReqlyRepository): { nodes: unknown[]; edges: unknown[] } {
  return {
    nodes: [...repository.records.values()].map((record) => ({ id: record.data.id, label: record.data.title, type: record.type, status: record.status, ...(record.type === "requirement" ? { verified: repository.verificationState(record.data.id) } : {}) })),
    edges: [...repository.records.values()].flatMap((record) => (record.data.relations ?? []).map((relation) => ({ source: record.data.id, target: relation.target, type: relation.type, fingerprint: relation.fingerprint }))),
  };
}

export async function compareBaselines(repository: ReqlyRepository, left: string, right: string): Promise<unknown> {
  const read = async (revision: string): Promise<Map<string, ReqlyRecord>> => {
    const records = new Map<string, ReqlyRecord>();
    const files = await repository.git.listFiles(revision, [repository.config.roots.requirements, repository.config.roots.verifications]);
    for (const file of files) {
      const raw = await repository.git.showFile(revision, file);
      if (!raw) continue;
      const { parseRecord } = await import("./markdown.js");
      const { default: path } = await import("node:path");
      const record = parseRecord(raw, path.join(repository.root, file), repository.root);
      records.set(record.data.id, record);
    }
    return records;
  };
  const [before, after] = await Promise.all([read(left), read(right)]);
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].sort().map((id) => {
    const oldRecord = before.get(id); const newRecord = after.get(id);
    if (!oldRecord) return { id, change: "added" };
    if (!newRecord) return { id, change: "removed" };
    if (normativeFingerprint(oldRecord, repository.config.relations) !== normativeFingerprint(newRecord, repository.config.relations)) return { id, change: "normative-changed" };
    if (oldRecord.raw !== newRecord.raw) return { id, change: "metadata-changed" };
    return { id, change: "unchanged" };
  });
}
