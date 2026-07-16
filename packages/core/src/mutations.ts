import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultConfig, folderTemplate, requirementTemplate, verificationTemplate } from "./defaults.js";
import { GitRepository } from "./git.js";
import { createRecordText, contentVersion, dependencyFingerprint, formatArtifactLink, parseArtifactLink, replaceSections, serializeRecord } from "./markdown.js";
import { ReqlyRepository } from "./repository.js";
import {
  REQUIREMENT_SCHEMA,
  VERIFICATION_SCHEMA,
  FOLDER_SCHEMA,
  ReqlyError,
  type ArtifactLink,
  type MutationResult,
  type ItemType,
  type RecordData,
  type Relation,
  type ReqlyConfig,
} from "./types.js";

export interface CreateOptions {
  title: string;
}

export interface CreateVerificationOptions extends CreateOptions {
  status: "pass" | "fail";
}

export interface UpdatePatch {
  fields?: Record<string, unknown>;
  bodySections?: Record<string, string>;
}

function generatedAgentBlock(config: ReqlyConfig = defaultConfig): string {
  return `<!-- reqly:generated:start -->
## Reqly

- Use Reqly's VS Code actions for interactive mutations; follow the format rules below when editing \`index.md\` directly.
- Query only the item and relation depth needed for the current work.
- Keep IDs stable. Never reuse or invent an existing ID.
- Requirements need a \`## Requirement\` section.
- Verifications need \`## Procedure\`, \`## Expected Result\`, and \`## Evidence\` sections and use only \`pass\` or \`fail\` status.
- Folders use \`FOL-*\` IDs and \`active\` status, and organize items through \`contains\`; their content is not a requirement.
- Treat all item sections except \`## Notes\` as normative.
- Store only the current user-controlled \`status\`; status is not inferred from Git commits or file changes.
- Impact-bearing relations contain a managed target fingerprint; do not update the fingerprint by hand.
- An accepted requirement with a draft \`required-by\` parent remains in the impact queue.
- Requirement verification is computed from direct \`verified-by\` results and child requirements; do not store a \`verified\` field.
- Store each artifact as one Markdown link string in frontmatter, one line per link.
- Removing a local artifact link also deletes its referenced file; URL artifacts only lose the link.
- Deleting an item removes its entire folder and every relation that targets it.
- Check the Reqly diagnostics after every mutation sequence.
- Reqly never stages, commits, pushes, or rewrites Git history.
- Requirement statuses: ${config.requirements.statuses.join(", ")}.
- Verification statuses: ${config.verifications.statuses.join(", ")}.
- Folder statuses: ${config.folders.statuses.join(", ")}.
- Relation types: ${Object.keys(config.relations).join(", ")}.
<!-- reqly:generated:end -->`;
}

function aiGuide(config: ReqlyConfig = defaultConfig): string {
  return `# AGENTS.md

${generatedAgentBlock(config)}
`;
}

export async function initRepository(root: string): Promise<void> {
  const absolute = path.resolve(root);
  if (!await new GitRepository(absolute).isRepository()) throw new ReqlyError("GIT_REPOSITORY_REQUIRED", `${absolute} is not inside a Git worktree.`);
  const markerPath = path.join(absolute, defaultConfig.roots.requirements);
  try { if ((await stat(markerPath)).isDirectory()) throw new ReqlyError("ALREADY_INITIALIZED", `Reqly is already initialized at ${absolute}.`); } catch (error) {
    if (error instanceof ReqlyError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await Promise.all([
    mkdir(path.join(absolute, ".reqly"), { recursive: true }),
    mkdir(path.join(absolute, defaultConfig.roots.requirements), { recursive: true }),
    mkdir(path.join(absolute, defaultConfig.roots.verifications), { recursive: true }),
    mkdir(path.join(absolute, defaultConfig.roots.folders), { recursive: true }),
  ]);
  await upsertAgentGuide(absolute, defaultConfig);
}

export function renderAiGuide(config: ReqlyConfig = defaultConfig): string { return aiGuide(config); }

export async function syncAiGuide(root: string): Promise<boolean> {
  return upsertAgentGuide(root, defaultConfig);
}

async function upsertAgentGuide(root: string, config: ReqlyConfig): Promise<boolean> {
  const target = agentsTarget(root, config);
  await mkdir(path.dirname(target), { recursive: true });
  const generated = generatedAgentBlock(config);
  let current = "";
  try { current = await readFile(target, "utf8"); } catch { current = "# AGENTS.md\n\n"; }
  const start = "<!-- reqly:generated:start -->";
  const end = "<!-- reqly:generated:end -->";
  let next: string;
  if (current.includes(start) && current.includes(end)) next = `${current.slice(0, current.indexOf(start))}${generated}${current.slice(current.indexOf(end) + end.length)}`;
  else next = `${current.trimEnd()}\n\n${generated}\n`;
  const changed = current !== next;
  if (changed) await writeFile(target, next, "utf8");
  return changed;
}

export async function checkAiGuide(root: string): Promise<boolean> {
  const config = defaultConfig;
  const target = agentsTarget(root, config);
  let current: string;
  try { current = await readFile(target, "utf8"); } catch { return false; }
  const expected = generatedAgentBlock(config);
  const start = "<!-- reqly:generated:start -->"; const end = "<!-- reqly:generated:end -->";
  const block = (text: string) => text.includes(start) && text.includes(end) ? text.slice(text.indexOf(start), text.indexOf(end) + end.length) : "";
  return block(current) === block(expected);
}

function agentsTarget(root: string, config: ReqlyConfig): string {
  const target = path.resolve(root, config.ai.agentsPath); const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ReqlyError("PATH_TRAVERSAL", "ai.agentsPath must stay inside the repository.");
  return target;
}

export async function nextId(repository: ReqlyRepository, type: ItemType = "requirement"): Promise<string> {
  const settings = repository.config.ids[type];
  let maximum = 0;
  for (const record of repository.records.values()) if (record.data.id.startsWith(settings.prefix)) maximum = Math.max(maximum, Number(record.data.id.slice(settings.prefix.length)) || 0);
  return `${settings.prefix}${String(maximum + 1).padStart(settings.width, "0")}`;
}

export async function createItem(repository: ReqlyRepository, options: CreateOptions, dryRun = false): Promise<MutationResult> {
  const id = await nextId(repository, "requirement");
  const directory = path.join(repository.root, repository.config.roots.requirements, id);
  const filePath = path.join(directory, "index.md");
  const data: RecordData = {
    schema: REQUIREMENT_SCHEMA, id, title: options.title,
    status: "draft",
    relations: [], artifacts: [],
  };
  const text = createRecordText(data, requirementTemplate);
  const result: MutationResult = { changed: true, itemId: id, version: contentVersion(text), unifiedDiff: text.split("\n").map((line) => `+${line}`).join("\n"), affectedItems: [id], diagnostics: [] };
  if (!dryRun) { await mkdir(directory, { recursive: true }); await writeFile(filePath, text, "utf8"); }
  return result;
}

export async function createVerification(repository: ReqlyRepository, options: CreateVerificationOptions, dryRun = false): Promise<MutationResult> {
  if (!repository.config.verifications.statuses.includes(options.status)) throw new ReqlyError("INVALID_STATUS", `Unknown verification status ${options.status}.`);
  const id = await nextId(repository, "verification");
  const directory = path.join(repository.root, repository.config.roots.verifications, id);
  const filePath = path.join(directory, "index.md");
  const data: RecordData = {
    schema: VERIFICATION_SCHEMA, id, title: options.title, status: options.status,
    relations: [], artifacts: [],
  };
  const text = createRecordText(data, verificationTemplate);
  const result: MutationResult = { changed: true, itemId: id, version: contentVersion(text), unifiedDiff: text.split("\n").map((line) => `+${line}`).join("\n"), affectedItems: [id], diagnostics: [] };
  if (!dryRun) { await mkdir(directory, { recursive: true }); await writeFile(filePath, text, "utf8"); }
  return result;
}

export async function createFolder(repository: ReqlyRepository, options: CreateOptions, dryRun = false): Promise<MutationResult> {
  const id = await nextId(repository, "folder");
  const directory = path.join(repository.root, repository.config.roots.folders, id);
  const filePath = path.join(directory, "index.md");
  const data: RecordData = {
    schema: FOLDER_SCHEMA, id, title: options.title, status: "active",
    relations: [], artifacts: [],
  };
  const text = createRecordText(data, folderTemplate);
  const result: MutationResult = { changed: true, itemId: id, version: contentVersion(text), unifiedDiff: text.split("\n").map((line) => `+${line}`).join("\n"), affectedItems: [id], diagnostics: [] };
  if (!dryRun) { await mkdir(directory, { recursive: true }); await writeFile(filePath, text, "utf8"); }
  return result;
}

export async function updateItem(repository: ReqlyRepository, id: string, patch: UpdatePatch, expectedVersion?: string, dryRun = false): Promise<MutationResult> {
  const record = repository.get(id);
  if (expectedVersion && expectedVersion !== record.version) throw new ReqlyError("VERSION_CONFLICT", `${id} changed since it was read.`, { expectedVersion, actualVersion: record.version });
  const data = structuredClone(record.data) as RecordData;
  for (const [key, value] of Object.entries(patch.fields ?? {})) {
    if (["schema", "id", "status"].includes(key)) throw new ReqlyError("IMMUTABLE_FIELD", `${key} is managed by Reqly and cannot be changed with update.`);
    if (value === null) delete (data as unknown as Record<string, unknown>)[key];
    else (data as unknown as Record<string, unknown>)[key] = value;
  }
  const body = patch.bodySections ? replaceSections(record.body, patch.bodySections) : record.body;
  return writeRecordUpdate(repository, record, data, body, dryRun);
}

export async function deleteItem(repository: ReqlyRepository, id: string, expectedVersion?: string, dryRun = false): Promise<MutationResult> {
  const record = repository.get(id);
  if (expectedVersion && expectedVersion !== record.version) throw new ReqlyError("VERSION_CONFLICT", `${id} changed since it was read.`, { expectedVersion, actualVersion: record.version });
  const relativeDirectory = path.relative(repository.root, record.directory);
  if (relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) throw new ReqlyError("PATH_TRAVERSAL", "Item folder escapes the repository.");
  const changes: Array<{ record: ReturnType<ReqlyRepository["get"]>; data: RecordData; body: string }> = [];
  for (const candidate of repository.records.values()) {
    if (candidate.data.id === id || !(candidate.data.relations ?? []).some((relation) => relation.target === id)) continue;
    const data = structuredClone(candidate.data) as RecordData;
    data.relations = (data.relations ?? []).filter((relation) => relation.target !== id);
    changes.push({ record: candidate, data, body: candidate.body });
  }
  const relationResult = await writeRecordUpdates(repository, changes, id, dryRun);
  const deletionDiff = await repository.git.unifiedDiff(record.relativePath, record.raw, "");
  if (!dryRun) await rm(record.directory, { recursive: true, force: true });
  return {
    changed: true,
    itemId: id,
    unifiedDiff: [deletionDiff, relationResult.unifiedDiff].filter(Boolean).join("\n"),
    affectedItems: [id, ...relationResult.affectedItems],
    diagnostics: [],
  };
}

async function writeRecordUpdate(repository: ReqlyRepository, record: ReturnType<ReqlyRepository["get"]>, data: RecordData, body: string, dryRun: boolean): Promise<MutationResult> {
  return writeRecordUpdates(repository, [{ record, data, body }], record.data.id, dryRun);
}

async function writeRecordUpdates(repository: ReqlyRepository, changes: Array<{ record: ReturnType<ReqlyRepository["get"]>; data: RecordData; body: string }>, itemId: string, dryRun: boolean): Promise<MutationResult> {
  const rendered = await Promise.all(changes.map(async ({ record, data, body }) => {
    const next = serializeRecord(record, data, body); const changed = next !== record.raw;
    return { record, next, changed, diff: changed ? await repository.git.unifiedDiff(record.relativePath, record.raw, next) : "" };
  }));
  const changed = rendered.filter((item) => item.changed);
  if (!dryRun) for (const item of changed) await writeFile(item.record.filePath, item.next, "utf8");
  const primary = rendered.find((item) => item.record.data.id === itemId);
  return { changed: changed.length > 0, itemId, version: primary ? contentVersion(primary.next) : undefined, unifiedDiff: changed.map((item) => item.diff).join("\n"), affectedItems: changed.map((item) => item.record.data.id), diagnostics: [] };
}

export async function setRelation(repository: ReqlyRepository, id: string, action: "add" | "update" | "remove", relation: Relation, expectedVersion?: string, dryRun = false): Promise<MutationResult> {
  const record = repository.get(id);
  if (expectedVersion && expectedVersion !== record.version) throw new ReqlyError("VERSION_CONFLICT", `${id} changed since it was read.`, { expectedVersion, actualVersion: record.version });
  if (id === relation.target) throw new ReqlyError("SELF_RELATION", "A Reqly item cannot relate to itself.");
  const definition = repository.config.relations[relation.type];
  if (!definition) throw new ReqlyError("INVALID_RELATION_TYPE", `Unknown relation type ${relation.type}.`);
  const target = repository.get(relation.target);
  if ((definition.source !== "any" && definition.source !== record.type) || (definition.target !== "any" && definition.target !== target.type)) {
    throw new ReqlyError("INVALID_RELATION_ENDPOINT", `${relation.type} cannot connect ${record.type} to ${target.type}.`);
  }
  const managedRelation = action !== "remove" && definition.fingerprintRequired
    ? { type: relation.type, target: relation.target, fingerprint: `sha256:${dependencyFingerprint(target, repository.config.relations)}` }
    : relation;
  const data = structuredClone(record.data) as RecordData;
  data.relations = mutateRelations(data.relations ?? [], action, managedRelation, true, id);
  const changes = [{ record, data, body: record.body }];
  if (definition.inverse) {
    const targetData = structuredClone(target.data) as RecordData;
    const inverseDefinition = repository.config.relations[definition.inverse];
    const inverse: Relation = action !== "remove" && inverseDefinition?.fingerprintRequired
      ? { type: definition.inverse, target: id, fingerprint: `sha256:${dependencyFingerprint({ ...record, data }, repository.config.relations)}` }
      : { type: definition.inverse, target: id };
    targetData.relations = mutateRelations(targetData.relations ?? [], action, inverse, false, relation.target);
    changes.push({ record: target, data: targetData, body: target.body });
  }
  return writeRecordUpdates(repository, changes, id, dryRun);
}

function mutateRelations(relations: Relation[], action: "add" | "update" | "remove", relation: Relation, strict: boolean, ownerId: string): Relation[] {
  const next = structuredClone(relations); const index = next.findIndex((candidate) => candidate.type === relation.type && candidate.target === relation.target);
  if (action === "add") {
    if (index >= 0 && strict) throw new ReqlyError("RELATION_EXISTS", `${ownerId} already has ${relation.type} ${relation.target}.`);
    if (index >= 0) next[index] = relation; else next.push(relation);
  } else if (action === "update") {
    if (index < 0 && strict) throw new ReqlyError("RELATION_NOT_FOUND", `${ownerId} has no ${relation.type} ${relation.target}.`);
    if (index >= 0) next[index] = relation; else next.push(relation);
  } else {
    if (index < 0 && strict) throw new ReqlyError("RELATION_NOT_FOUND", `${ownerId} has no ${relation.type} ${relation.target}.`);
    if (index >= 0) next.splice(index, 1);
  }
  return next;
}

export async function setArtifact(repository: ReqlyRepository, id: string, action: "add" | "update" | "remove", artifact: ArtifactLink, expectedVersion?: string, dryRun = false): Promise<MutationResult> {
  const record = repository.get(id);
  const artifacts = structuredClone(record.data.artifacts ?? []);
  const index = artifacts.findIndex((candidate) => parseArtifactLink(candidate)?.target === artifact.target);
  const link = formatArtifactLink(artifact);
  if (action === "add") {
    if (index >= 0) throw new ReqlyError("ARTIFACT_EXISTS", `${artifact.target} is already linked.`);
    artifacts.push(link);
  } else if (action === "update") {
    if (index < 0) throw new ReqlyError("ARTIFACT_NOT_FOUND", `${artifact.target} is not linked.`);
    artifacts[index] = link;
  } else {
    if (index < 0) throw new ReqlyError("ARTIFACT_NOT_FOUND", `${artifact.target} is not linked.`);
    artifacts.splice(index, 1);
  }
  const deletePath = action === "remove" && !dryRun ? await removableArtifactPath(repository, record, artifact.target) : null;
  const result = await updateItem(repository, id, { fields: { artifacts } }, expectedVersion, dryRun);
  if (deletePath) await rm(deletePath, { force: true });
  return result;
}

async function removableArtifactPath(repository: ReqlyRepository, record: ReturnType<ReqlyRepository["get"]>, target: string): Promise<string | null> {
  if (/^(?:https?:|mailto:)/i.test(target)) return null;
  let cleanTarget: string;
  try { cleanTarget = decodeURIComponent(target.split("#")[0] ?? ""); } catch { throw new ReqlyError("INVALID_ARTIFACT_LINK", `Artifact target is not valid: ${target}`); }
  const resolved = path.resolve(record.directory, cleanTarget);
  const relative = path.relative(repository.root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ReqlyError("PATH_TRAVERSAL", "Artifact path escapes the repository.");
  if ([...repository.records.values()].some((candidate) => path.resolve(candidate.filePath) === resolved)) throw new ReqlyError("ARTIFACT_IS_ITEM", "A Reqly item file cannot be deleted as an artifact.");
  const shared = [...repository.records.values()].find((candidate) => candidate.data.id !== record.data.id && (candidate.data.artifacts ?? []).some((value) => {
    const linked = parseArtifactLink(value); if (!linked || /^(?:https?:|mailto:)/i.test(linked.target)) return false;
    try { return path.resolve(candidate.directory, decodeURIComponent(linked.target.split("#")[0] ?? "")) === resolved; } catch { return false; }
  }));
  if (shared) throw new ReqlyError("ARTIFACT_IN_USE", `${target} is also linked by ${shared.data.id} and was not deleted.`);
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) throw new ReqlyError("ARTIFACT_NOT_FILE", `${target} is a directory and cannot be deleted as an artifact.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

export async function setStatus(repository: ReqlyRepository, id: string, status: string, expectedVersion?: string, dryRun = false): Promise<MutationResult> {
  const record = repository.get(id);
  if (expectedVersion && expectedVersion !== record.version) throw new ReqlyError("VERSION_CONFLICT", `${id} changed since it was read.`, { expectedVersion, actualVersion: record.version });
  const statuses: readonly string[] = record.type === "requirement" ? repository.config.requirements.statuses : record.type === "verification" ? repository.config.verifications.statuses : repository.config.folders.statuses;
  if (!statuses.includes(status)) throw new ReqlyError("INVALID_STATUS", `Unknown ${record.type} status ${status}.`);
  const data = structuredClone(record.data) as RecordData;
  data.status = status;
  return writeRecordUpdate(repository, record, data, record.body, dryRun);
}

export async function acknowledgeImpact(repository: ReqlyRepository, itemId: string, targetId: string, expectedVersion?: string, dryRun = false): Promise<MutationResult> {
  const item = repository.get(itemId);
  repository.get(targetId);
  const relation = (item.data.relations ?? []).find((candidate) => candidate.target === targetId && repository.config.relations[candidate.type]?.propagatesImpact);
  if (!relation) throw new ReqlyError("RELATION_NOT_FOUND", `${itemId} has no impact-bearing relation to ${targetId}.`);
  return setRelation(repository, itemId, "update", { type: relation.type, target: relation.target }, expectedVersion, dryRun);
}

export async function acknowledgeImpacts(repository: ReqlyRepository, itemIds?: Iterable<string>, dryRun = false): Promise<MutationResult> {
  const selected = itemIds ? new Set(itemIds) : undefined;
  const changes: Array<{ record: ReturnType<ReqlyRepository["get"]>; data: RecordData; body: string }> = [];
  for (const record of repository.records.values()) {
    if (selected && !selected.has(record.data.id)) continue;
    let changed = false;
    const data = structuredClone(record.data) as RecordData;
    data.relations = (data.relations ?? []).map((relation) => {
      const definition = repository.config.relations[relation.type];
      const target = repository.records.get(relation.target);
      if (!definition?.propagatesImpact || relation.fingerprint === undefined || !target) return relation;
      const fingerprint = `sha256:${dependencyFingerprint(target, repository.config.relations)}`;
      if (relation.fingerprint === fingerprint) return relation;
      changed = true;
      return { ...relation, fingerprint };
    });
    if (changed) changes.push({ record, data, body: record.body });
  }
  if (!changes.length) return { changed: false, unifiedDiff: "", affectedItems: [], diagnostics: [] };
  return writeRecordUpdates(repository, changes, changes[0]!.record.data.id, dryRun);
}

export async function renumberItem(repository: ReqlyRepository, oldId: string, newId: string, dryRun = false): Promise<MutationResult> {
  if (repository.records.has(newId)) throw new ReqlyError("DUPLICATE_ID", `${newId} already exists.`);
  const source = repository.get(oldId);
  const changes: Array<{ record: typeof source; next: string }> = [];
  for (const record of repository.records.values()) {
    const data = structuredClone(record.data) as RecordData;
    let changed = false;
    if (record.data.id === oldId) { data.id = newId; changed = true; }
    data.relations = (data.relations ?? []).map((relation) => relation.target === oldId ? (changed = true, { ...relation, target: newId }) : relation);
    if (changed) changes.push({ record, next: serializeRecord(record, data, record.body) });
  }
  if (!dryRun) {
    for (const change of changes) await writeFile(change.record.filePath, change.next, "utf8");
    const newDirectory = path.join(path.dirname(source.directory), newId);
    await rename(source.directory, newDirectory);
  }
  return { changed: true, itemId: newId, unifiedDiff: changes.map((change) => `--- ${change.record.relativePath}\n+++ ${change.record.relativePath}\nID/reference ${oldId} -> ${newId}`).join("\n"), affectedItems: changes.map((change) => change.record.data.id), diagnostics: [] };
}

export async function removeItemDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
