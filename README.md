# Reqly

Reqly is a VS Code extension and MCP server for requirements, verification, and traceability in Git repositories. It keeps the source of truth in ordinary Markdown files with YAML frontmatter, so the records are reviewable, diffable, and easy to keep with the product code.

## Try it with one feature

Imagine you are adding a low-battery warning to a device.

### 1. Install Reqly

Install the generated `reqly.vsix` in VS Code with **Extensions: Install from VSIX...**.

### 2. Initialize the repository

Open the product repository in VS Code and run `Reqly: Initialize Project` from the Command Palette. Reqly creates the `.reqly/` folders and a small `.reqly/AGENTS.md` that documents the repository contract.

Use the Reqly activity-bar view, or the CodeLens above an `index.md`, for the actions below.

### 3. Capture the requirement

Create a requirement and set its status explicitly:

```yaml
schema: reqly/requirement/v1
id: REQ-0001
title: Show a low-battery warning
status: accepted
relations: []
artifacts: []
```

The file lives at `.reqly/requirements/REQ-0001/index.md`. Add the requirement text in Markdown and keep related files in that folder, for example:

```yaml
artifacts:
  - "[Battery specification](artifacts/battery-spec.pdf)"
```

Reqly can copy a local file into the item's `artifacts/` folder or link a relative path or URL. Links are clickable in VS Code.

### 4. Break it down

Create a child requirement, such as "Display the warning below 10% capacity", and relate it to `REQ-0001` with `required-by`. Reqly maintains the parent's inverse `requires` relation automatically.

Now the Requirements view shows the product requirement as a parent-first tree. The same view also places linked verifications beneath their requirements.

### 5. Add evidence

Create a verification and link it to the requirement with `verified-by`:

```yaml
schema: reqly/verification/v1
id: VER-0001
title: Check the low-battery warning
status: pass
relations:
  - type: verifies
    target: REQ-0001
artifacts:
  - "[Test recording](artifacts/low-battery-test.mp4)"
```

The verification document contains `Procedure`, `Expected Result`, and `Evidence` sections. Reqly computes the requirement's verification result from its direct verifications and child requirements:

- green check: everything is verified;
- red cross: something failed;
- item icon: evidence is missing or incomplete.

### 6. Let changes find their impact

Later, the battery specification changes. Edit the parent requirement or its linked normative data. Reqly detects that the child or verification was based on an older dependency fingerprint and puts it in the impact queue.

Review the affected items, update the requirement or repeat the test, then acknowledge the impact. Reqly refreshes the fingerprint. It never stages, commits, pushes, or rewrites Git history; use your normal Git workflow to review and commit the Markdown and YAML changes.

## Where things live

```text
.reqly/
├── requirements/REQ-0001/index.md
│   └── artifacts/
└── verifications/VER-0001/index.md
    └── artifacts/
```

Requirements and verifications are stable ID-named folders. Deleting an item requires confirmation and removes its owned artifacts and incoming relations. Unknown `x-*` fields and hand-authored Markdown remain yours.

## Install and develop

Reqly currently targets VS Code 1.107+ and Node.js 24 LTS. To build the extension locally:

```sh
npm install
npm run package:vscode
```

Before opening a pull request, run:

```sh
npm run check
npm test
npm run build
```

Extension changes should also pass `npm run package:vscode`.

### Agent integrations

Reqly's universal agent interface is the standalone `@mrpatpat/reqly-mcp` package. It runs as a local stdio MCP server and works with Codex, Claude, Cursor, and other MCP clients:

Install it directly from the agent's terminal:

Codex:

```sh
codex mcp add reqly -- npx -y @mrpatpat/reqly-mcp
```

Claude Code:

```sh
claude mcp add reqly -- npx -y @mrpatpat/reqly-mcp
```

```toml
[mcp_servers.reqly]
command = "npx"
args = ["-y", "@mrpatpat/reqly-mcp"]
```

The server uses the current working directory as the Reqly repository. Set `REQLY_ROOT` when the repository is elsewhere.
