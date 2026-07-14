import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ReqlyError } from "./types.js";

const execFileAsync = promisify(execFile);

export class GitRepository {
  constructor(public readonly root: string) {}

  private async run(args: string[], allowFailure = false): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: this.root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return stdout.trim();
    } catch (error) {
      if (allowFailure) return String((error as { stdout?: string }).stdout ?? "").trim();
      const message = (error as { stderr?: string; message?: string }).stderr || (error as Error).message;
      throw new ReqlyError("GIT_ERROR", String(message).trim(), { args });
    }
  }

  async isRepository(): Promise<boolean> {
    return (await this.run(["rev-parse", "--is-inside-work-tree"], true)) === "true";
  }

  async gitPath(relativePath: string): Promise<string> {
    const value = await this.run(["rev-parse", "--path-format=absolute", "--git-path", relativePath]);
    return path.resolve(this.root, value);
  }

  async head(): Promise<string | null> {
    const value = await this.run(["rev-parse", "HEAD"], true);
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  }

  async resolveRevision(revision: string): Promise<string> {
    const resolved = await this.run(["rev-parse", "--verify", `${revision}^{commit}`], true);
    if (!resolved) throw new ReqlyError("GIT_HISTORY_MISSING", `Unknown commit or tag ${revision}.`);
    return resolved;
  }

  async isDirty(): Promise<boolean> {
    return (await this.run(["status", "--porcelain"])) !== "";
  }

  async dirtyFiles(): Promise<Set<string>> {
    const output = await this.run(["status", "--porcelain"]);
    return new Set(output ? output.split(/\r?\n/).map((line) => (line.slice(3).split(" -> ").at(-1) ?? "").replaceAll("\\", "/").replace(/^"|"$/g, "")) : []);
  }

  async trackedFiles(): Promise<Set<string>> {
    const output = await this.run(["ls-files"]);
    return new Set(output ? output.split(/\r?\n/).map((file) => file.replaceAll("\\", "/")) : []);
  }

  async isFileDirty(relativePath: string): Promise<boolean> {
    return (await this.run(["status", "--porcelain", "--", relativePath])) !== "";
  }

  async isTracked(relativePath: string): Promise<boolean> {
    return (await this.run(["ls-files", "--error-unmatch", "--", relativePath], true)) !== "";
  }

  async showFile(revision: string, relativePath: string): Promise<string | null> {
    const normalized = relativePath.replaceAll("\\", "/");
    try {
      const { stdout } = await execFileAsync("git", ["show", `${revision}:${normalized}`], { cwd: this.root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch { return null; }
  }

  async listFiles(revision: string, roots: string[]): Promise<string[]> {
    const output = await this.run(["ls-tree", "-r", "--name-only", revision, "--", ...roots]);
    return output ? output.split(/\r?\n/).filter((file) => file.endsWith("/index.md")) : [];
  }

  async listIndexFiles(revision: string): Promise<string[]> {
    const output = await this.run(["ls-tree", "-r", "--name-only", revision]);
    return output ? output.split(/\r?\n/).filter((file) => file.endsWith("/index.md")) : [];
  }

  async isAncestor(revision: string, descendant = "HEAD"): Promise<boolean> {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", revision, descendant], { cwd: this.root });
      return true;
    } catch {
      return false;
    }
  }

  async logForPath(relativePath: string, revision?: string): Promise<string[]> {
    const output = await this.run(["log", "--format=%H", "--follow", ...(revision ? [revision] : []), "--", relativePath]);
    return output ? output.split(/\r?\n/) : [];
  }

  async unifiedDiff(relativePath: string, oldText: string, newText: string): Promise<string> {
    if (oldText === newText) return "";
    const directory = await mkdtemp(path.join(tmpdir(), "reqly-diff-"));
    const before = path.join(directory, "before");
    const after = path.join(directory, "after");
    await writeFile(before, oldText, "utf8");
    await writeFile(after, newText, "utf8");
    try {
      const output = await this.run(["diff", "--no-index", "--", before, after], true);
      return output.replaceAll(before.replaceAll("\\", "/"), `a/${relativePath}`).replaceAll(after.replaceAll("\\", "/"), `b/${relativePath}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async objectSize(revision: string, relativePath: string): Promise<number | null> {
    const output = await this.run(["cat-file", "-s", `${revision}:${relativePath.replaceAll("\\", "/")}`], true);
    return output && Number.isFinite(Number(output)) ? Number(output) : null;
  }

  async lfsFilter(relativePath: string, revision?: string): Promise<string | null> {
    const output = await this.run(["check-attr", ...(revision ? [`--source=${revision}`] : []), "filter", "--", relativePath], true);
    const value = output.split(":").at(-1)?.trim();
    return value && value !== "unspecified" ? value : null;
  }

  async createAnnotatedTag(name: string, message: string): Promise<void> {
    const exists = await this.run(["rev-parse", "--verify", `refs/tags/${name}`], true);
    if (exists) throw new ReqlyError("TAG_EXISTS", `Tag ${name} already exists.`);
    await this.run(["tag", "-a", name, "-m", message]);
  }

  async listTags(prefix: string): Promise<string[]> {
    const output = await this.run(["tag", "--list", `${prefix}*`, "--sort=refname"]);
    return output ? output.split(/\r?\n/) : [];
  }
}
