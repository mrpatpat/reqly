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

const updatePackage = async (relativePath, update) => {
  const file = path.join(root, relativePath);
  const packageJson = JSON.parse(await readFile(file, "utf8"));
  update(packageJson);
  await writeFile(file, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
};

await updatePackage("packages/vscode/package.json", (packageJson) => {
  packageJson.version = version;
  packageJson.dependencies["@mrpatpat/reqly-core"] = version;
});
await updatePackage("packages/core/package.json", (packageJson) => {
  packageJson.version = version;
});
await updatePackage("packages/mcp/package.json", (packageJson) => {
  packageJson.version = version;
  packageJson.dependencies["@mrpatpat/reqly-core"] = version;
});
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
