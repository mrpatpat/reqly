#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFolder, createItem, createVerification, setRelation, setStatus, validateRepository } from "@mrpatpat/reqly-core";
import { ReqlyRepository } from "@mrpatpat/reqly-core";
import * as z from "zod";

const server = new McpServer({ name: "reqly", version: "0.1.0" });

function repositoryRoot(): string {
  return process.env.REQLY_ROOT ?? process.cwd();
}

async function repository(): Promise<ReqlyRepository> {
  return ReqlyRepository.open(repositoryRoot());
}

function summary(record: Awaited<ReturnType<ReqlyRepository["get"]>>): Record<string, unknown> {
  return { id: record.data.id, type: record.type, title: record.data.title, status: record.status, relations: record.data.relations ?? [], artifacts: record.data.artifacts ?? [], filePath: record.filePath };
}

server.registerTool("reqly_list_items", {
  description: "List Reqly requirements, verifications, and organizational folders. Use this to discover item IDs before reading or changing items.",
  inputSchema: { type: z.enum(["requirement", "verification", "folder"]).optional(), status: z.string().optional() },
}, async ({ type, status }) => {
  const repo = await repository();
  const items = [...repo.records.values()].filter((record) => (!type || record.type === type) && (!status || record.status === status)).sort((a, b) => a.data.id.localeCompare(b.data.id)).map(summary);
  return { content: [{ type: "text", text: JSON.stringify({ items }, null, 2) }] };
});

server.registerTool("reqly_get_item", {
  description: "Read one Reqly item by ID, including its relations, artifacts, Markdown sections, and body.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const record = (await repository()).get(id);
  return { content: [{ type: "text", text: JSON.stringify({ ...summary(record), body: record.body, sections: record.sections }, null, 2) }] };
});

server.registerTool("reqly_validate", {
  description: "Validate the current Reqly repository and return diagnostics and health statuses.",
  inputSchema: {},
}, async () => {
  const repo = await repository();
  const validation = await validateRepository(repo);
  return { content: [{ type: "text", text: JSON.stringify({ diagnostics: validation.diagnostics, statuses: validation.statuses }, null, 2) }] };
});

server.registerTool("reqly_create_requirement", {
  description: "Create a new draft requirement, optionally linked as a sub-requirement of parentId.",
  inputSchema: { title: z.string(), parentId: z.string().optional() },
}, async ({ title, parentId }) => {
  let repo = await repository();
  const created = await createItem(repo, { title });
  if (!created.itemId) throw new Error("Reqly did not return the new requirement ID.");
  if (parentId) {
    repo = await repository();
    const child = repo.get(created.itemId); const parent = repo.get(parentId);
    await setRelation(repo, child.data.id, "add", { type: "required-by", target: parent.data.id }, child.version);
  }
  repo = await repository();
  return { content: [{ type: "text", text: JSON.stringify({ created: created.itemId, parentId, item: summary(repo.get(created.itemId)) }, null, 2) }] };
});

server.registerTool("reqly_create_verification", {
  description: "Create a pass or fail verification, optionally linked to a requirement with verified-by.",
  inputSchema: { title: z.string(), status: z.enum(["pass", "fail"]), requirementId: z.string().optional() },
}, async ({ title, status, requirementId }) => {
  let repo = await repository();
  const created = await createVerification(repo, { title, status });
  if (!created.itemId) throw new Error("Reqly did not return the new verification ID.");
  if (requirementId) {
    repo = await repository();
    const verification = repo.get(created.itemId); const requirement = repo.get(requirementId);
    await setRelation(repo, requirement.data.id, "add", { type: "verified-by", target: verification.data.id }, requirement.version);
  }
  repo = await repository();
  return { content: [{ type: "text", text: JSON.stringify({ created: created.itemId, requirementId, item: summary(repo.get(created.itemId)) }, null, 2) }] };
});

server.registerTool("reqly_create_folder", {
  description: "Create an organizational folder, optionally containing existing Reqly items.",
  inputSchema: { title: z.string(), itemIds: z.array(z.string()).optional() },
}, async ({ title, itemIds }) => {
  let repo = await repository();
  const created = await createFolder(repo, { title });
  if (!created.itemId) throw new Error("Reqly did not return the new folder ID.");
  for (const itemId of itemIds ?? []) {
    repo = await repository();
    const folder = repo.get(created.itemId);
    await setRelation(repo, folder.data.id, "add", { type: "contains", target: itemId }, folder.version);
  }
  repo = await repository();
  return { content: [{ type: "text", text: JSON.stringify({ created: created.itemId, itemIds: itemIds ?? [], item: summary(repo.get(created.itemId)) }, null, 2) }] };
});

server.registerTool("reqly_set_status", {
  description: "Change a Reqly requirement or verification to a configured status. Folder status is fixed to active.",
  inputSchema: { id: z.string(), status: z.string() },
}, async ({ id, status }) => {
  const repo = await repository(); const record = repo.get(id);
  await setStatus(repo, id, status, record.version);
  return { content: [{ type: "text", text: JSON.stringify({ updated: id, status }, null, 2) }] };
});

server.registerTool("reqly_set_relation", {
  description: "Add, update, or remove a configured relation. Inverse relations are maintained automatically.",
  inputSchema: { id: z.string(), action: z.enum(["add", "update", "remove"]), type: z.string(), target: z.string() },
}, async ({ id, action, type, target }) => {
  const repo = await repository(); const record = repo.get(id);
  await setRelation(repo, id, action, { type, target }, record.version);
  return { content: [{ type: "text", text: JSON.stringify({ changed: true, id, action, type, target }, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
