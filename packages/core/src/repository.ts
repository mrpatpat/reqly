import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "./defaults.js";
import { ReqlyCache } from "./cache.js";
import { GitRepository } from "./git.js";
import { parseRecord } from "./markdown.js";
import {
  API_VERSION,
  ReqlyError,
  type ApiEnvelope,
  type ContextOptions,
  type Diagnostic,
  type ItemView,
  type ReqlyConfig,
  type ReqlyRecord,
  type SearchFilters,
} from "./types.js";

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
    public readonly revision: string | null = null,
  ) {
    this.git = new GitRepository(root);
  }

  static async open(root: string, revision?: string): Promise<ReqlyRepository> {
    const absolute = path.resolve(root);
    const git = new GitRepository(absolute);
    const resolvedRevision = revision ? await git.resolveRevision(revision) : undefined;
    const marker = defaultConfig.ai.agentsPath;
    if (resolvedRevision) {
      if (!await git.showFile(resolvedRevision, marker)) throw new ReqlyError("PROJECT_NOT_FOUND", `No Reqly project exists at ${revision}.`);
    } else {
      try { if (!(await stat(path.join(absolute, defaultConfig.roots.requirements))).isDirectory()) throw new Error("Not a directory"); } catch { throw new ReqlyError("PROJECT_NOT_FOUND", `No Reqly project found at ${absolute}. Run 'reqly init'.`); }
    }
    const config = defaultConfig;
    const records = new Map<string, ReqlyRecord>();
    const diagnostics: Diagnostic[] = [];
    const roots = [config.roots.requirements, config.roots.verifications];
    const files = resolvedRevision ? await git.listFiles(resolvedRevision, roots) : (await Promise.all(roots.map((folder) => findIndexFiles(path.join(absolute, folder))))).flat().sort();
    for (const file of files) {
      try {
        const filePath = resolvedRevision ? path.join(absolute, file) : file;
        const raw = resolvedRevision ? await git.showFile(resolvedRevision, file) : await readFile(file, "utf8");
        if (raw === null) continue;
        const record = parseRecord(raw, filePath, absolute);
        if (records.has(record.data.id)) {
          diagnostics.push({ code: "DUPLICATE_ID", severity: "error", message: `Duplicate ID ${record.data.id}.`, itemId: record.data.id, path: record.relativePath });
        } else records.set(record.data.id, record);
      } catch (error) {
        diagnostics.push({ code: error instanceof ReqlyError ? error.code : "PARSE_ERROR", severity: "error", message: (error as Error).message, path: path.relative(absolute, file).replaceAll("\\", "/") });
      }
    }
    const cache = await ReqlyCache.open(await git.gitPath("reqly/cache-v1.json"));
    return new ReqlyRepository(absolute, config, records, diagnostics, cache, resolvedRevision ?? null);
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

  async info(): Promise<{ head: string | null; dirty: boolean }> {
    return this.revision ? { head: this.revision, dirty: false } : { head: await this.git.head(), dirty: await this.git.isDirty() };
  }

  toView(record: ReqlyRecord, options: { includeBody?: boolean; includeArtifacts?: boolean } = {}): ItemView {
    return {
      id: record.data.id,
      type: record.type,
      title: record.data.title,
      status: record.status,
      version: record.version,
      path: record.relativePath,
      relations: record.data.relations ?? [],
      artifacts: options.includeArtifacts ? record.data.artifacts ?? [] : undefined,
      verified: record.type === "requirement" ? this.verificationState(record.data.id) : undefined,
      body: options.includeBody ? record.body : undefined,
    };
  }

  async envelope<T>(data: T, diagnostics: Diagnostic[] = [], nextCursor?: string): Promise<ApiEnvelope<T>> {
    const info = await this.info();
    return { apiVersion: API_VERSION, repository: info, data, diagnostics, ...(nextCursor ? { nextCursor } : {}) };
  }

  search(filters: SearchFilters = {}): { items: ItemView[]; nextCursor?: string } {
    const all = [...this.records.values()].filter((record) => {
      if (filters.status && record.status !== filters.status) return false;
      if (filters.query) {
        const haystack = `${record.data.id} ${record.data.title} ${record.body}`.toLowerCase();
        if (!haystack.includes(filters.query.toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) => a.data.id.localeCompare(b.data.id));
    const start = filters.cursor ? Math.max(0, all.findIndex((item) => item.data.id === filters.cursor) + 1) : 0;
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const page = all.slice(start, start + limit);
    return {
      items: page.map((record) => this.toView(record, { includeBody: filters.includeBody })),
      nextCursor: start + limit < all.length ? page.at(-1)?.data.id : undefined,
    };
  }

  context(id: string, options: ContextOptions = {}): ItemView[] {
    const depth = options.depth ?? 1;
    const selected = new Set([id]);
    let frontier = new Set([id]);
    for (let level = 0; level < depth; level++) {
      const next = new Set<string>();
      for (const record of this.records.values()) {
        for (const relation of record.data.relations ?? []) {
          if (frontier.has(record.data.id) && this.records.has(relation.target)) next.add(relation.target);
          if (frontier.has(relation.target)) next.add(record.data.id);
        }
      }
      for (const value of next) selected.add(value);
      frontier = next;
    }
    return [...selected].sort().map((itemId) => this.toView(this.get(itemId), options));
  }

  verificationState(id: string, visiting = new Set<string>()): boolean | undefined {
    const record = this.records.get(id);
    if (!record || visiting.has(id)) return undefined;
    if (record.type === "verification") return record.status === "pass" ? true : record.status === "fail" ? false : undefined;
    const nextVisiting = new Set(visiting).add(id);
    const evidence: Array<boolean | undefined> = [];
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

  async readAtRevision(id: string, revision: string): Promise<ReqlyRecord | null> {
    const current = this.records.get(id);
    if (current) {
      const raw = await this.git.showFile(revision, current.relativePath);
      if (raw) {
        try {
          const parsed = parseRecord(raw, path.join(this.root, current.relativePath), this.root);
          if (parsed.data.id === id) return parsed;
        } catch { /* The current format may begin after older or malformed history. */ }
      }
    }
    const configuredFiles = await this.git.listFiles(revision, [this.config.roots.requirements, this.config.roots.verifications]);
    for (const files of [configuredFiles, (await this.git.listIndexFiles(revision)).filter((file) => !configuredFiles.includes(file))]) {
      for (const relativePath of files) {
        const raw = await this.git.showFile(revision, relativePath);
        if (!raw) continue;
        try {
          const parsed = parseRecord(raw, path.join(this.root, relativePath), this.root);
          if (parsed.data.id === id) return parsed;
        } catch { /* Ignore unrelated malformed historic records. */ }
      }
    }
    return null;
  }

  async artifactMetadata(id: string, target: string): Promise<{ path: string; size: number; mime: string }> {
    const record = this.get(id);
    const resolved = path.resolve(record.directory, target);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ReqlyError("PATH_TRAVERSAL", "Artifact path escapes the repository.");
    const info = await stat(resolved);
    return { path: relative.replaceAll("\\", "/"), size: info.size, mime: mimeForPath(resolved) };
  }
}

export function mimeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({ ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml" } as Record<string, string>)[extension] ?? "application/octet-stream";
}
