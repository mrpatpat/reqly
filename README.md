# Reqly

Reqly is a VS Code extension for Git-native requirements, verification, and traceability in product repositories. Requirements and verifications are ordinary Markdown files with YAML frontmatter, stored with their attachments in stable ID-named folders.

It provides:

- Long-lived requirement graphs with managed dependency fingerprints.
- User-controlled status, computed verification state, and impact health.
- Typed links to PDFs, images, tests, evidence, designs, and source files.
- A VS Code explorer, impact queue, Markdown assistance, and requirement graph.

## Prerequisites

- Node.js 24 LTS
- Git
- VS Code 1.107 or newer for the extension

## Build

```sh
npm install
npm run check
npm test
npm run build
```

Create a local extension package with `npm run package:vscode`.

## VS Code extension releases

The VS Code extension is released automatically from `main` using [Conventional Commits](https://www.conventionalcommits.org/) and [Semantic Versioning](https://semver.org/). The private core library is bundled into the extension and is not published separately. Pull requests and `main` are tested on Linux and Windows, and CI retains a packaged VSIX artifact for 14 days.

Pull request titles must use Conventional Commits syntax. When changes are squash-merged, the title becomes the commit analyzed by `semantic-release`:

- `fix: correct artifact cleanup` creates a patch release.
- `feat: add verification filtering` creates a minor release.
- `feat!: change the requirement schema` creates a major release.
- `docs:`, `test:`, `ci:`, `chore:`, and similar maintenance commits create no release.

Versions are calculated exclusively from commits since the previous release, starting from the existing `v0.1.0` baseline. Do not edit the extension version or create release tags manually: during the release job, Reqly stamps the calculated version into the packaged extension without committing generated version changes.

After all CI jobs succeed on a push to `main`, `semantic-release` analyzes the commits. If a release is required, it creates `vMAJOR.MINOR.PATCH`, packages `reqly-vscode-MAJOR.MINOR.PATCH.vsix`, creates a SHA-256 checksum and provenance attestation, and publishes the GitHub Release with generated notes. The release job uses the `github-release` GitHub environment. Marketplace publication remains intentionally excluded.

## Start a project

Open the product repository in VS Code, then run `Reqly: Initialize Project` from the Command Palette. Use the Reqly activity-bar view or its CodeLens actions to create requirements and verifications, manage relations and artifacts, change status, inspect impacts, and validate the project.

Each requirement is created as `.reqly/requirements/REQ-0001/index.md`; each verification is created as `.reqly/verifications/VER-0001/index.md`. Put item-specific documents beside `index.md`. Frontmatter stores every artifact as one Markdown link string on one line, making it clickable even when it is not repeated in the body:

```yaml
artifacts:
  - "[RoHS statement](artifacts/rohs-statement.pdf)"
  - "[Supplier page](https://example.com/material)"
```

Each requirement stores only its current user-controlled status. There is no lifecycle sequence, timestamp, reason, or Git-derived state:

```yaml
status: accepted
```

A verification contains required `Procedure`, `Expected Result`, and `Evidence` sections. Its user-controlled status is either `pass` or `fail`:

```yaml
schema: reqly/verification/v1
id: VER-0001
title: Measure radiated emissions
status: pass
relations:
  - type: verifies
    target: REQ-0001
artifacts: []
```

`required-by` is the default hierarchical relation. A child points to the parent that requires it, and Reqly maintains the parent's inverse `requires` link automatically. The child relation stores a managed fingerprint of the parent's title, status, normative sections, normative relation targets, and artifact targets. Direct content or status changes therefore place the child in the impact queue until acknowledgment refreshes the fingerprint. Notes, artifact labels, inverse links, and stored fingerprints are excluded. No Git data is involved. `superseded-by` similarly maintains `supersedes`.

A requirement links to a verification with `verified-by`; Reqly creates the inverse `verifies` relation. The `verified-by` relation carries the verification fingerprint, so changing the procedure, expected result, status, normative links, or artifact targets creates an impact entry until acknowledged. Verification is a computed tri-state and is never stored in frontmatter:

- `true` when every direct verification passes and every child requirement is verified.
- `false` when any direct verification fails or any child requirement has failed verification.
- Undefined when no verification evidence exists or any downstream verification is incomplete.

The VS Code Requirements view renders requirements as a parent-first tree and linked verifications below them. A green check means verified/pass, a red cross means failed, and the existing item icon means the result is undefined. The CodeLens above every `index.md` provides guided status, relation, and artifact management. The relation action can link an existing compatible item or create and link a new one. The artifact action can copy a selected file into the item's own `artifacts/` folder or link a relative path or URL. Removing a local artifact also deletes its referenced file; removing a URL only removes the link.

Deleting an item removes its entire owned folder, including artifacts, and removes every relation that targets the deleted ID. VS Code requires an explicit destructive confirmation.

An accepted requirement whose `required-by` parent is draft appears in the impact queue until the parent leaves draft or the child is no longer accepted. This condition does not mutate either status.

Reqly keeps its default configuration inside the extension; projects do not contain a configuration file. The `.reqly/AGENTS.md` generated during initialization explains the fixed repository contract to coding agents and marks the repository as a Reqly project. Reqly owns only its delimited generated block, preserving all other project instructions.

## Git workflow

Reqly never stages, commits, pushes, or rewrites history. Git does not determine requirement status. A typical parent/child flow is:

1. Create the parent and set its status explicitly.
2. Link the child; Reqly records the parent's current dependency fingerprint.
3. Change the parent's status or content; Reqly detects the fingerprint mismatch.
4. Update the child if needed, then acknowledge the impact; Reqly refreshes the fingerprint automatically.
