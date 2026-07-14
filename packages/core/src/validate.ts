import { access, stat } from "node:fs/promises";
import path from "node:path";
import { dependencyFingerprint, extractMarkdownLinks, parseArtifactLink } from "./markdown.js";
import type { ReqlyRepository } from "./repository.js";
import type { Diagnostic, ItemStatus, ReqlyRecord } from "./types.js";

const HTTP = /^https?:\/\//i;

function diagnostic(record: ReqlyRecord, code: string, severity: Diagnostic["severity"], message: string, relatedId?: string): Diagnostic {
  return { code, severity, message, itemId: record.data.id, path: record.relativePath, relatedId };
}

export interface ValidationResult {
  diagnostics: Diagnostic[];
  statuses: ItemStatus[];
}

export async function validateRepository(repository: ReqlyRepository): Promise<ValidationResult> {
  const diagnostics = [...repository.parseDiagnostics];
  const health = new Map<string, Set<ItemStatus["health"][number]>>();
  const addHealth = (id: string, value: ItemStatus["health"][number]) => {
    if (!health.has(id)) health.set(id, new Set());
    health.get(id)!.add(value);
  };
  for (const record of repository.records.values()) {
    health.set(record.data.id, new Set());
    const folderId = path.basename(record.directory);
    const allowedFields = ["schema", "id", "title", "status", "relations", "artifacts"];
    for (const key of Object.keys(record.data)) if (!allowedFields.includes(key) && !key.startsWith("x-")) diagnostics.push(diagnostic(record, "UNKNOWN_FIELD", "error", `Unknown field ${key}; use x-* for extension metadata.`));
    if (folderId !== record.data.id) diagnostics.push(diagnostic(record, "FOLDER_ID_MISMATCH", "error", `Folder ${folderId} must match ID ${record.data.id}.`));
    const idSettings = repository.config.ids[record.type];
    if (!new RegExp(`^${escapeRegExp(idSettings.prefix)}\\d{${idSettings.width},}$`).test(record.data.id)) diagnostics.push(diagnostic(record, "INVALID_ID", "error", `${record.data.id} does not match configured prefix and width.`));
    if (!record.data.title?.trim()) diagnostics.push(diagnostic(record, "TITLE_REQUIRED", "error", "Title is required."));
    const requiredSections = record.type === "requirement" ? ["Requirement"] : ["Procedure", "Expected Result", "Evidence"];
    for (const requiredSection of requiredSections) {
      if (!record.sections.some((section) => section.name.toLowerCase() === requiredSection.toLowerCase())) diagnostics.push(diagnostic(record, "SECTION_REQUIRED", "error", `Missing required ## ${requiredSection} section.`));
    }

    const statuses: readonly string[] = record.type === "requirement" ? repository.config.requirements.statuses : repository.config.verifications.statuses;
    if (!statuses.includes(record.status)) diagnostics.push(diagnostic(record, "INVALID_STATUS", "error", `Unknown ${record.type} status ${record.status || "(missing)"}.`));

    if (record.type === "requirement" && record.status === "superseded" && !(record.data.relations ?? []).some((relation) => relation.type === "superseded-by")) {
      diagnostics.push(diagnostic(record, "SUPERSEDED_TARGET_REQUIRED", "error", "Superseded requirements need a superseded-by relation."));
    }

    for (const relation of record.data.relations ?? []) {
      for (const key of Object.keys(relation)) if (!["type", "target", "fingerprint"].includes(key)) diagnostics.push(diagnostic(record, "UNKNOWN_RELATION_FIELD", "error", `Unknown relation field ${key}.`, relation.target));
      const definition = repository.config.relations[relation.type];
      if (!definition) {
        diagnostics.push(diagnostic(record, "INVALID_RELATION_TYPE", "error", `Unknown relation type ${relation.type}.`, relation.target));
        continue;
      }
      const target = repository.records.get(relation.target);
      if (!target) {
        diagnostics.push(diagnostic(record, "BROKEN_REFERENCE", "error", `Missing relation target ${relation.target}.`, relation.target));
        addHealth(record.data.id, "broken-reference");
        continue;
      }
      if (definition.inverse) {
        const inverse = (target.data.relations ?? []).find((candidate) => candidate.type === definition.inverse && candidate.target === record.data.id);
        if (!inverse) diagnostics.push(diagnostic(record, "INVERSE_RELATION_MISSING", "error", `${relation.type} ${relation.target} requires ${definition.inverse} ${record.data.id} on the target.`, relation.target));
      }
      if ((definition.source !== "any" && definition.source !== record.type) || (definition.target !== "any" && definition.target !== target.type)) diagnostics.push(diagnostic(record, "INVALID_RELATION_ENDPOINT", "error", `${relation.type} cannot connect ${record.type} to ${target.type}.`, target.data.id));
      const draftParent = definition.propagatesImpact && record.status === "accepted" && target.status === "draft";
      if (draftParent) {
        diagnostics.push(diagnostic(record, "PARENT_DRAFT", "warning", `${target.data.id} is draft while ${record.data.id} is accepted.`, target.data.id));
        addHealth(record.data.id, "draft-parent");
      }
      const fingerprintRequired = definition.fingerprintRequired;
      if (fingerprintRequired && relation.fingerprint === undefined) diagnostics.push(diagnostic(record, "RELATION_FINGERPRINT_REQUIRED", "error", `${relation.type} requires a managed target fingerprint.`, target.data.id));
      if (relation.fingerprint !== undefined) {
        if (!/^sha256:[0-9a-f]{64}$/.test(relation.fingerprint)) diagnostics.push(diagnostic(record, "INVALID_RELATION_FINGERPRINT", "error", `Relation fingerprint must be a sha256 value.`, target.data.id));
        else if (definition.propagatesImpact && !draftParent && relation.fingerprint !== `sha256:${dependencyFingerprint(target, repository.config.relations)}`) {
          const verification = target.type === "verification";
          diagnostics.push(diagnostic(record, verification ? "VERIFICATION_UPDATE_PENDING" : "PARENT_UPDATE_PENDING", "warning", `${target.data.id} differs from the version acknowledged by this relation.`, target.data.id));
          addHealth(record.data.id, verification ? "verification-update-pending" : "parent-update-pending");
        }
      }
    }

    for (const artifact of record.data.artifacts ?? []) {
      const link = parseArtifactLink(artifact);
      if (!link) diagnostics.push(diagnostic(record, "INVALID_ARTIFACT_LINK", "error", "Each artifact must be one Markdown link string."));
      else await validateArtifact(repository, record, link.target, diagnostics);
    }
    for (const link of extractMarkdownLinks(record.body)) await validateArtifact(repository, record, link, diagnostics, true);
  }

  detectCycles(repository, diagnostics, addHealth);
  propagateUpstream(repository, health);
  const statuses = [...repository.records.values()].sort((a, b) => a.data.id.localeCompare(b.data.id)).map((record) => ({
    id: record.data.id,
    status: record.status,
    health: health.get(record.data.id)?.size ? [...health.get(record.data.id)!] : ["clean" as const],
  }));
  await repository.cache.save();
  return { diagnostics, statuses };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function validateArtifact(repository: ReqlyRepository, record: ReqlyRecord, target: string, diagnostics: Diagnostic[], markdown = false): Promise<void> {
  if (!target || target.startsWith("#") || HTTP.test(target) || target.startsWith("mailto:")) return;
  const cleanTarget = decodeURIComponent(target.split("#")[0] ?? "");
  const resolved = path.resolve(record.directory, cleanTarget);
  const relative = path.relative(repository.root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    diagnostics.push(diagnostic(record, "PATH_TRAVERSAL", "error", `Link escapes the repository: ${target}`));
    return;
  }
  try {
    const normalized = relative.replaceAll("\\", "/");
    const size = (await stat(resolved)).size;
    await access(resolved);
    if (size > repository.config.artifacts.lfsWarningBytes) {
      const filter = await repository.git.lfsFilter(normalized);
      if (filter !== "lfs") diagnostics.push(diagnostic(record, "LARGE_FILE_NOT_LFS", "warning", `${target} is larger than the configured threshold and is not tracked by Git LFS.`));
    }
  } catch {
    diagnostics.push(diagnostic(record, markdown ? "BROKEN_MARKDOWN_LINK" : "BROKEN_ARTIFACT", markdown ? "warning" : "error", `Missing local ${markdown ? "link" : "artifact"}: ${target}`));
  }
}

function detectCycles(repository: ReqlyRepository, diagnostics: Diagnostic[], addHealth: (id: string, health: "cycle") => void): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    if (visiting.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      for (const member of cycle) addHealth(member, "cycle");
      diagnostics.push({ code: "RELATION_CYCLE", severity: "error", message: `Acyclic relation cycle: ${cycle.join(" -> ")}`, itemId: id });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const record = repository.records.get(id);
    for (const relation of record?.data.relations ?? []) if (repository.config.relations[relation.type]?.acyclic) visit(relation.target, [...stack, id]);
    visiting.delete(id); visited.add(id);
  };
  for (const id of repository.records.keys()) visit(id, []);
}

function propagateUpstream(repository: ReqlyRepository, health: Map<string, Set<ItemStatus["health"][number]>>): void {
  const affected = new Set([...health].filter(([, values]) => values.has("parent-update-pending") || values.has("verification-update-pending") || values.has("draft-parent")).map(([id]) => id));
  let frontier = new Set(affected);
  while (frontier.size) {
    const next = new Set<string>();
    for (const record of repository.records.values()) {
      for (const relation of record.data.relations ?? []) {
        if (repository.config.relations[relation.type]?.propagatesImpact && frontier.has(relation.target) && !affected.has(record.data.id)) {
          affected.add(record.data.id); next.add(record.data.id); health.get(record.data.id)?.add("upstream-update-pending");
        }
      }
    }
    frontier = next;
  }
}
