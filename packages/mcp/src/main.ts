#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ReqlyError,
  ReqlyRepository,
  acknowledgeImpact,
  compareBaselines,
  createBaseline,
  createItem,
  createVerification,
  deleteItem,
  graphData,
  renumberItem,
  renderAiGuide,
  schemas,
  setArtifact,
  setRelation,
  traceabilityReport,
  setStatus,
  updateItem,
  validateRepository,
} from "@reqly/core";

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag >= 0 && process.argv[rootFlag + 1] ? process.argv[rootFlag + 1]! : process.cwd());
const open = () => ReqlyRepository.open(root);
const jsonContent = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

async function result<T>(operation: (repository: ReqlyRepository) => Promise<T>, revision?: string): Promise<ReturnType<typeof jsonContent>> {
  try {
    const repository = await ReqlyRepository.open(root, revision);
    return jsonContent(await repository.envelope(await operation(repository)));
  } catch (error) {
    const reqlyError = error instanceof ReqlyError ? error : new ReqlyError("INTERNAL_ERROR", (error as Error).message);
    return { ...jsonContent({ apiVersion: "reqly/v1", error: { code: reqlyError.code, message: reqlyError.message, details: reqlyError.details } }), isError: true } as ReturnType<typeof jsonContent>;
  }
}

const server = new McpServer({ name: "reqly", version: "0.1.0" });

const readAgents = async () => {
  const repository = await open(); const target = path.resolve(root, repository.config.ai.agentsPath); const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ReqlyError("PATH_TRAVERSAL", "ai.agentsPath must stay inside the repository.");
  return readFile(target, "utf8").catch(() => renderAiGuide(repository.config));
};
server.registerResource("agents", "reqly://project/agents", { title: "Repository AGENTS.md", mimeType: "text/markdown" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readAgents() }],
}));
server.registerResource("ai-guide", "reqly://project/ai-guide", { title: "Reqly AI authoring guide compatibility alias", mimeType: "text/markdown" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readAgents() }],
}));
for (const name of Object.keys(schemas) as Array<keyof typeof schemas>) server.registerResource(`schema-${name}`, `reqly://schema/${name}/v1`, { title: `Reqly ${name} schema`, mimeType: "application/schema+json" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "application/schema+json", text: JSON.stringify(schemas[name], null, 2) }],
}));

server.registerResource("item", new ResourceTemplate("reqly://item/{id}", { list: undefined }), { title: "Reqly item", mimeType: "application/json" }, async (uri, variables) => {
  const repository = await open(); const record = repository.get(String(variables.id));
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await repository.envelope(repository.toView(record, { includeBody: true, includeArtifacts: true })), null, 2) }] };
});
server.registerResource("item-markdown", new ResourceTemplate("reqly://item/{id}/markdown", { list: undefined }), { title: "Reqly source Markdown", mimeType: "text/markdown" }, async (uri, variables) => {
  const repository = await open(); const record = repository.get(String(variables.id));
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: record.raw }] };
});
server.registerResource("baseline-item", new ResourceTemplate("reqly://baseline/{tag}/item/{id}", { list: undefined }), { title: "Reqly item at baseline", mimeType: "application/json" }, async (uri, variables) => {
  const repository = await ReqlyRepository.open(root, decodeURIComponent(String(variables.tag))); const record = repository.get(String(variables.id));
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await repository.envelope(repository.toView(record, { includeBody: true, includeArtifacts: true })), null, 2) }] };
});
server.registerResource("item-artifact", new ResourceTemplate("reqly://item/{id}/artifact/{target}", { list: undefined }), { title: "Reqly linked artifact" }, async (uri, variables) => {
  const repository = await open(); const id = String(variables.id); const target = decodeURIComponent(String(variables.target));
  const metadata = await repository.artifactMetadata(id, target);
  if (metadata.size > repository.config.ai.maxResourceBytes) throw new ReqlyError("RESOURCE_TOO_LARGE", `${metadata.path} exceeds ai.maxResourceBytes.`, metadata);
  const data = await readFile(path.join(repository.root, metadata.path));
  const textual = metadata.mime.startsWith("text/") || ["application/json", "application/yaml"].includes(metadata.mime);
  return { contents: [{ uri: uri.href, mimeType: metadata.mime, ...(textual ? { text: data.toString("utf8") } : { blob: data.toString("base64") }) }] };
});

server.registerTool("search_items", {
  title: "Search Reqly items", description: "Search requirements and verifications with compact, deterministic results.", annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { query: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().optional(), includeBody: z.boolean().optional(), ref: z.string().optional() },
}, async ({ ref, ...input }) => result(async (repository) => repository.search(input), ref));

server.registerTool("get_context", {
  title: "Get bounded Reqly context", description: "Read one item and its inbound/outbound graph neighborhood.", annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { id: z.string(), depth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(), includeBody: z.boolean().optional(), includeArtifacts: z.boolean().optional(), ref: z.string().optional() },
}, async ({ id, ref, ...options }) => result(async (repository) => repository.context(id, options), ref));

server.registerTool("get_impacts", { title: "Get Reqly impacts", description: "List current status and computed health, including changed parent fingerprints.", annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: {} }, async () => result(async (repository) => validateRepository(repository)));
server.registerTool("get_graph", { title: "Get Reqly graph", description: "Return graph nodes and typed edges.", annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: { ref: z.string().optional() } }, async ({ ref }) => result(async (repository) => graphData(repository), ref));
server.registerTool("validate", { title: "Validate Reqly", description: "Validate schemas, statuses, links, and graph invariants.", annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: { ref: z.string().optional() } }, async ({ ref }) => result(async (repository) => validateRepository(repository), ref));
server.registerTool("traceability_report", { title: "Generate traceability report", description: "Generate structured traceability data and Markdown.", annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: { ref: z.string().optional() } }, async ({ ref }) => result(async (repository) => traceabilityReport(repository), ref));

server.registerTool("create_requirement", {
  title: "Create a requirement", description: "Create a requirement in its own folder.", annotations: { destructiveHint: false, openWorldHint: false },
  inputSchema: { title: z.string().min(1), dryRun: z.boolean().optional() },
}, async ({ dryRun, ...options }) => result(async (repository) => createItem(repository, options, dryRun)));

server.registerTool("create_verification", {
  title: "Create a verification", description: "Create a pass/fail verification procedure in its own folder.", annotations: { destructiveHint: false, openWorldHint: false },
  inputSchema: { title: z.string().min(1), status: z.enum(["pass", "fail"]), dryRun: z.boolean().optional() },
}, async ({ dryRun, ...options }) => result(async (repository) => createVerification(repository, options, dryRun)));

server.registerTool("update_item", {
  title: "Update Reqly fields or sections", description: "Apply a focused metadata or named-Markdown-section update with optimistic concurrency.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { id: z.string(), fields: z.record(z.unknown()).optional(), bodySections: z.record(z.string()).optional(), expectedVersion: z.string(), dryRun: z.boolean().optional() },
}, async ({ id, expectedVersion, dryRun, fields, bodySections }) => result(async (repository) => updateItem(repository, id, { fields, bodySections }, expectedVersion, dryRun)));

server.registerTool("delete_item", {
  title: "Delete a Reqly item", description: "Delete an item's folder and remove every relation targeting it.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { id: z.string(), expectedVersion: z.string(), dryRun: z.boolean().optional() },
}, async ({ id, expectedVersion, dryRun }) => result(async (repository) => deleteItem(repository, id, expectedVersion, dryRun)));

server.registerTool("set_relation", {
  title: "Add, update, or remove a relation", description: "Mutate one typed relation without rewriting the item.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { id: z.string(), action: z.enum(["add", "update", "remove"]), type: z.string(), target: z.string(), expectedVersion: z.string(), dryRun: z.boolean().optional() },
}, async ({ id, action, expectedVersion, dryRun, ...relation }) => result(async (repository) => setRelation(repository, id, action, relation, expectedVersion, dryRun)));

server.registerTool("set_artifact", {
  title: "Add, update, or remove an artifact", description: "Mutate one artifact link. Removing a local artifact also deletes its referenced file.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { id: z.string(), action: z.enum(["add", "update", "remove"]), target: z.string(), label: z.string().optional(), expectedVersion: z.string(), dryRun: z.boolean().optional() },
}, async ({ id, action, expectedVersion, dryRun, ...artifact }) => result(async (repository) => setArtifact(repository, id, action, artifact, expectedVersion, dryRun)));

server.registerTool("set_status", {
  title: "Set item status", description: "Replace a requirement or verification's current user-controlled status.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { id: z.string(), status: z.string(), expectedVersion: z.string(), dryRun: z.boolean().optional() },
}, async ({ id, status, expectedVersion, dryRun }) => result(async (repository) => setStatus(repository, id, status, expectedVersion, dryRun)));

server.registerTool("acknowledge_impact", {
  title: "Acknowledge related update", description: "Refresh an impact-bearing relation fingerprint after handling its target update.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { item: z.string(), target: z.string(), expectedVersion: z.string(), dryRun: z.boolean().optional() },
}, async ({ item, target, expectedVersion, dryRun }) => result(async (repository) => acknowledgeImpact(repository, item, target, expectedVersion, dryRun)));

server.registerTool("renumber_item", {
  title: "Renumber a Reqly item", description: "Change a stable readable ID and update all repository references atomically.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { oldId: z.string(), newId: z.string(), dryRun: z.boolean().optional() },
}, async ({ oldId, newId, dryRun }) => result(async (repository) => renumberItem(repository, oldId, newId, dryRun)));

server.registerTool("create_baseline", {
  title: "Create Reqly baseline", description: "Validate and create a non-overwriting annotated Git tag. This mutates Git refs.", annotations: { destructiveHint: true, openWorldHint: false },
  inputSchema: { name: z.string().min(1) },
}, async ({ name }) => result(async (repository) => ({ tag: await createBaseline(repository, name) })));
server.registerTool("compare_baselines", {
  title: "Compare Reqly baselines", description: "Compare normative and metadata changes between two Git tags.", annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { left: z.string(), right: z.string() },
}, async ({ left, right }) => result(async (repository) => compareBaselines(repository, left, right)));

const transport = new StdioServerTransport();
await server.connect(transport);
