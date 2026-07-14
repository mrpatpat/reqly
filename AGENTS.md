# Agent Instructions

## Project

Reqly is an npm-workspace TypeScript project for a Git-native requirements and traceability VS Code extension.

- `packages/core` is the extension's private implementation library for formats, schemas, Git behavior, validation, reports, and mutations.
- `packages/vscode` contains the VS Code extension and requirement graph webview.

Keep Markdown and YAML files as the source of truth. Caches, build output, webviews, and reports must remain disposable projections.

## Working Rules

- Use `apply_patch` for source edits and preserve unrelated working-tree changes.
- Do not edit `dist/`, `node_modules/`, `package-lock.json` by hand, or the generated `reqly.vsix`.
- Changes to record formats must update types, JSON Schemas, parsing, validation, VS Code interactions, documentation, and tests together.
- Preserve hand-authored Markdown, YAML comments, unknown `x-*` fields, and line endings during focused mutations.
- Never make Reqly stage, commit, push, or rewrite Git history.

## Verification

Run these commands after changes:

```sh
npm run check
npm test
npm run build
```

For extension changes, also run `npm run package:vscode`.
