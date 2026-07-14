import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheFile {
  version: 1;
  values: Record<string, unknown>;
}

export class ReqlyCache {
  private dirty = false;
  private constructor(private readonly filePath: string, private readonly values: Map<string, unknown>) {}

  static async open(filePath: string): Promise<ReqlyCache> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as CacheFile;
      if (parsed.version === 1 && parsed.values && typeof parsed.values === "object") return new ReqlyCache(filePath, new Map(Object.entries(parsed.values)));
    } catch { /* A missing or corrupt cache is rebuilt transparently. */ }
    return new ReqlyCache(filePath, new Map());
  }

  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  set(key: string, value: unknown): void { this.values.set(key, value); this.dirty = true; }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const values = Object.fromEntries([...this.values.entries()].slice(-20_000));
      await writeFile(temporary, JSON.stringify({ version: 1, values } satisfies CacheFile), "utf8");
      await rename(temporary, this.filePath);
      this.dirty = false;
    } catch { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}
