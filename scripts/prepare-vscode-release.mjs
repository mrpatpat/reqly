import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const version = process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  process.stderr.write("A stable MAJOR.MINOR.PATCH version is required.\n");
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, "..");
const run = (args) => {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const commandArguments = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
  execFileSync(command, commandArguments, { cwd: root, stdio: "inherit" });
};

run(["version", version, "--workspace", "reqly-vscode", "--no-git-tag-version", "--allow-same-version"]);
run(["version", version, "--workspace", "@reqly/core", "--no-git-tag-version", "--allow-same-version"]);
run(["version", version, "--workspace", "@reqly/mcp", "--no-git-tag-version", "--allow-same-version"]);
run(["pkg", "set", `dependencies.@reqly/core=${version}`, "--workspace", "@reqly/mcp"]);
run(["install", "--package-lock-only"]);
run(["run", "package:vscode"]);

const outputDirectory = path.join(root, "release");
const source = path.join(root, "reqly.vsix");
const assetName = `reqly-vscode-${version}.vsix`;
const asset = path.join(outputDirectory, assetName);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await rename(source, asset);
const digest = createHash("sha256").update(await readFile(asset)).digest("hex");
await writeFile(`${asset}.sha256`, `${digest}  ${assetName}\n`, "utf8");
