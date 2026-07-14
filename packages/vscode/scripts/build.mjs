import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await Promise.all([
  build({ entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", bundle: true, platform: "node", format: "cjs", target: "node22", external: ["vscode"], sourcemap: true }),
  build({ entryPoints: ["src/webviews/graph.tsx"], outfile: "dist/graph.js", bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true }),
]);
