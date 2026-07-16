import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "./defaults.js";
import { ReqlyCache } from "./cache.js";
import { GitRepository } from "./git.js";
import { parseRecord } from "./markdown.js";
import { ReqlyError, type Diagnostic, type ReqlyConfig, type ReqlyRecord } from "./types.js";

async function findIndexFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findIndexFiles(target));
    else if (entry.isFile() && entry.name === "index.md") files.push(target);
  }
  return files;
}

export class ReqlyRepository {
  readonly git: GitRepository;
  private constructor(
    public readonly root: string,
    public readonly config: ReqlyConfig,
    public readonly records: Map<string, ReqlyRecord>,
    public readonly parseDiagnostics: Diagnostic[],
    public readonly cache: ReqlyCache,
  ) {
    this.git = new GitRepository(root);
  }

  static async open(root: string): Promise<ReqlyRepository> {
    const absolute = path.resolve(root);
    const git = new GitRepository(absolute);
    try { if (!(await stat(path.join(absolute, defaultConfig.roots.requirements))).isDirectory()) throw new Error("Not a directory"); } catch { throw new ReqlyError("PROJECT_NOT_FOUND", `No Reqly project found at ${absolute}. Run 'Reqly: Initialize Project' in VS Code.`); }
    const config = defaultConfig;
    const records = new Map<string, ReqlyRecord>();
    const diagnostics: Diagnostic[] = [];
    const roots = [config.roots.requirements, config.roots.verifications, config.roots.folders];
    const files = (await Promise.all(roots.map((folder) => findIndexFiles(path.join(absolute, folder))))).flat().sort();
    for (const file of files) {
      try {
        const record = parseRecord(await readFile(file, "utf8"), file, absolute);
        if (records.has(record.data.id)) {
          diagnostics.push({ code: "DUPLICATE_ID", severity: "error", message: `Duplicate ID ${record.data.id}.`, itemId: record.data.id, path: record.relativePath });
        } else records.set(record.data.id, record);
      } catch (error) {
        diagnostics.push({ code: error instanceof ReqlyError ? error.code : "PARSE_ERROR", severity: "error", message: (error as Error).message, path: path.relative(absolute, file).replaceAll("\\", "/") });
      }
    }
    const cache = await ReqlyCache.open(await git.gitPath("reqly/cache-v1.json"));
    return new ReqlyRepository(absolute, config, records, diagnostics, cache);
  }

  get(id: string): ReqlyRecord {
    const record = this.records.get(id);
    if (!record) throw new ReqlyError("REQ_NOT_FOUND", `No Reqly item with ID ${id}.`);
    return record;
  }

  async refreshFile(filePath: string): Promise<void> {
    const absolute = path.resolve(filePath);
    const relativePath = path.relative(this.root, absolute).replaceAll("\\", "/");
    const previous = [...this.records.values()].find((record) => path.resolve(record.filePath) === absolute);
    if (previous) this.records.delete(previous.data.id);
    for (let index = this.parseDiagnostics.length - 1; index >= 0; index--) if (this.parseDiagnostics[index]?.path === relativePath) this.parseDiagnostics.splice(index, 1);
    try {
      const record = parseRecord(await readFile(absolute, "utf8"), absolute, this.root);
      if (this.records.has(record.data.id)) this.parseDiagnostics.push({ code: "DUPLICATE_ID", severity: "error", message: `Duplicate ID ${record.data.id}.`, itemId: record.data.id, path: relativePath });
      else this.records.set(record.data.id, record);
    } catch (error) {
      this.parseDiagnostics.push({ code: error instanceof ReqlyError ? error.code : "PARSE_ERROR", severity: "error", message: (error as Error).message, path: relativePath });
    }
  }

  verificationState(id: string, visiting = new Set<string>()): boolean | undefined {
    const record = this.records.get(id);
    if (!record || visiting.has(id)) return undefined;
    if (record.type === "verification") return record.status === "pass" ? true : record.status === "fail" ? false : undefined;
    const nextVisiting = new Set(visiting).add(id);
    const evidence: Array<boolean | undefined> = [];
    if (record.type === "folder") {
      for (const relation of record.data.relations ?? []) {
        if (relation.type === "contains") evidence.push(this.verificationState(relation.target, nextVisiting));
      }
    }
    for (const relation of record.data.relations ?? []) {
      const definition = this.config.relations[relation.type];
      if (definition?.source === "requirement" && definition.target === "verification") evidence.push(this.verificationState(relation.target, nextVisiting));
    }
    for (const child of this.records.values()) {
      if (child.type === "requirement" && (child.data.relations ?? []).some((relation) => this.config.relations[relation.type]?.acyclic === true && relation.target === id)) evidence.push(this.verificationState(child.data.id, nextVisiting));
    }
    if (!evidence.length) return undefined;
    if (evidence.some((value) => value === false)) return false;
    return evidence.every((value) => value === true) ? true : undefined;
  }

  hierarchyChildren(id: string): ReqlyRecord[] {
    const parent = this.records.get(id);
    if (!parent) return [];
    const children: ReqlyRecord[] = [];
    if (parent.type === "folder") {
      for (const relation of parent.data.relations ?? []) {
        if (relation.type !== "contains") continue;
        const child = this.records.get(relation.target);
        if (child) children.push(child);
      }
    }
    if (parent.type === "requirement") {
      for (const record of this.records.values()) {
        if (record.type === "requirement" && (record.data.relations ?? []).some((relation) => this.config.relations[relation.type]?.acyclic === true && relation.target === id)) children.push(record);
      }
      for (const relation of parent.data.relations ?? []) {
        const definition = this.config.relations[relation.type]; const target = this.records.get(relation.target);
        if (definition?.source === "requirement" && definition.target === "verification" && target) children.push(target);
      }
    }
    return [...new Map(children.map((record) => [record.data.id, record])).values()];
  }

  hasHierarchyParent(record: ReqlyRecord): boolean {
    if ([...this.records.values()].some((candidate) => candidate.type === "folder" && (candidate.data.relations ?? []).some((relation) => relation.type === "contains" && relation.target === record.data.id))) return true;
    if (record.type === "requirement") return (record.data.relations ?? []).some((relation) => this.config.relations[relation.type]?.acyclic === true && this.records.has(relation.target));
    if (record.type === "verification") return [...this.records.values()].some((candidate) => candidate.type === "requirement" && (candidate.data.relations ?? []).some((relation) => this.config.relations[relation.type]?.target === "verification" && relation.target === record.data.id));
    return false;
  }

}
