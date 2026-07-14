# Agent Instructions

## Project

Reqly is an npm-workspace TypeScript project for Git-native requirements and traceability.

- `packages/core` owns formats, schemas, Git behavior, validation, reports, and mutations.
- `packages/cli` exposes the core through deterministic command-line contracts.
- `packages/mcp` exposes the same behavior through a local stdio MCP server.
- `packages/vscode` contains the VS Code extension and requirement graph webview.

Keep Markdown and YAML files as the source of truth. Caches, build output, webviews, and reports must remain disposable projections.

## Working Rules

- Use `apply_patch` for source edits and preserve unrelated working-tree changes.
- Do not edit `dist/`, `node_modules/`, `package-lock.json` by hand, or the generated `reqly.vsix`.
- Changes to record formats must update types, JSON Schemas, parsing, validation, CLI/MCP contracts, documentation, and tests together.
- CLI and MCP mutations must use the shared core rather than duplicating domain logic.
- Preserve hand-authored Markdown, YAML comments, unknown `x-*` fields, and line endings during focused mutations.
- Never make Reqly stage, commit, push, or rewrite Git history. Baseline creation may create only a non-overwriting annotated tag.
- Keep MCP stdio stdout protocol-only; send diagnostics or logs to stderr.

## Verification

Run these commands after changes:

```sh
npm run check
npm test
npm run build
```

For extension changes, also run `npm run package:vscode`. For MCP changes, perform a client handshake and call at least one affected tool or resource.
