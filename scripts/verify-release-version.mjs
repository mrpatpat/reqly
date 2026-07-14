import { readFile } from "node:fs/promises";

const tag = process.argv[2];
if (!tag) {
  process.stderr.write("Usage: npm run verify:release-version -- vMAJOR.MINOR.PATCH\n");
  process.exit(2);
}

const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
if (!match) {
  process.stderr.write(`${tag} is not a stable semantic version tag such as v1.2.3.\n`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(new URL("../packages/vscode/package.json", import.meta.url), "utf8"));
const version = tag.slice(1);
if (manifest.version !== version) {
  process.stderr.write(`Tag ${tag} does not match VS Code extension version ${manifest.version}.\n`);
  process.exit(1);
}

process.stdout.write(`${version}\n`);
