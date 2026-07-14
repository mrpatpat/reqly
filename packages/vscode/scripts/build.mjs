import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await build({ entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", bundle: true, platform: "node", format: "cjs", target: "node22", external: ["vscode"], sourcemap: true });
