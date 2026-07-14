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

  async lfsFilter(relativePath: string): Promise<string | null> {
    const output = await this.run(["check-attr", "filter", "--", relativePath], true);
    const value = output.split(":").at(-1)?.trim();
    return value && value !== "unspecified" ? value : null;
  }

}
