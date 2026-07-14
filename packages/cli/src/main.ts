#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  ReqlyError,
  ReqlyRepository,
  acknowledgeImpact,
  checkAiGuide,
  compareBaselines,
  createBaseline,
  createItem,
  createVerification,
  deleteItem,
  graphData,
  initRepository,
  renumberItem,
  renderAiGuide,
  schemas,
  setArtifact,
  setRelation,
  syncAiGuide,
  traceabilityReport,
  setStatus,
  updateItem,
  validateRepository,
  type SearchFilters,
} from "@reqly/core";

const program = new Command();
program.name("reqly").description("Git-native product requirements, verification, and traceability").version("0.1.0").option("-r, --root <path>", "Reqly repository root", process.cwd());

const root = () => program.opts<{ root: string }>().root;
const open = (revision?: string) => ReqlyRepository.open(root(), revision);
const print = (value: unknown, format = "json") => {
  if (format === "json") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${String(value)}\n`);
};
const parseList = (value?: string): string[] => value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
const parseJson = async (value: string): Promise<Record<string, unknown>> => JSON.parse(value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value) as Record<string, unknown>;

program.command("init").description("Initialize Reqly in a Git repository").action(async () => {
  await initRepository(root());
  print({ initialized: true, root: root() });
});

program.command("get").argument("<id>").option("--include <values>", "body,artifacts", "").option("--ref <ref>").option("--format <format>", "json or markdown", "json").action(async (id, options) => {
  const repository = await open(options.ref); const include = parseList(options.include);
  const view = repository.toView(repository.get(id), { includeBody: include.includes("body"), includeArtifacts: include.includes("artifacts") });
  if (options.format === "markdown") print(repository.get(id).raw, "text");
  else print(await repository.envelope(view));
});

program.command("search").option("-q, --query <query>").option("--status <status>").option("--limit <number>", "page size", "100").option("--cursor <id>").option("--include-body").option("--ref <ref>").action(async (options) => {
  const repository = await open(options.ref); const result = repository.search({ ...options, limit: Number(options.limit), includeBody: options.includeBody } as SearchFilters);
  print(await repository.envelope(result.items, [], result.nextCursor));
});

program.command("context").argument("<id>").option("--depth <number>", "0, 1, or 2", "1").option("--include <values>", "body,artifacts", "").option("--ref <ref>").option("--format <format>", "json or markdown", "json").action(async (id, options) => {
  const repository = await open(options.ref); const include = parseList(options.include); const depth = Math.min(2, Math.max(0, Number(options.depth))) as 0 | 1 | 2;
  const items = repository.context(id, { depth, includeBody: include.includes("body"), includeArtifacts: include.includes("artifacts") });
  if (options.format === "markdown") print(items.map((item) => `# ${item.id}: ${item.title}\n\n${item.body ?? ""}`).join("\n\n---\n\n"), "text");
  else print(await repository.envelope(items));
});

program.command("new").description("Create a requirement").requiredOption("--title <title>").option("--dry-run").action(async (options) => {
  const repository = await open(); const result = await createItem(repository, { title: options.title }, options.dryRun);
  print(await repository.envelope(result));
});

program.command("new-verification").description("Create a verification").requiredOption("--title <title>").requiredOption("--status <pass-or-fail>").option("--dry-run").action(async (options) => {
  const repository = await open(); const result = await createVerification(repository, { title: options.title, status: options.status }, options.dryRun);
  print(await repository.envelope(result));
});

program.command("update").argument("<id>").requiredOption("--patch <json>").option("--expected-version <hash>").option("--dry-run").action(async (id, options) => {
  const repository = await open(); const result = await updateItem(repository, id, await parseJson(options.patch), options.expectedVersion, options.dryRun);
  print(await repository.envelope(result));
});

program.command("delete").description("Delete an item, its folder, and all relations to it").argument("<id>").option("--expected-version <hash>").option("--dry-run").action(async (id, options) => {
  const repository = await open(); print(await repository.envelope(await deleteItem(repository, id, options.expectedVersion, options.dryRun)));
});

const relation = program.command("relation");
for (const action of ["add", "update", "remove"] as const) relation.command(action).argument("<id>").requiredOption("--type <type>").requiredOption("--target <id>").option("--expected-version <hash>").option("--dry-run").action(async (id, options) => {
  const repository = await open(); const result = await setRelation(repository, id, action, { type: options.type, target: options.target }, options.expectedVersion, options.dryRun);
  print(await repository.envelope(result));
});

const artifact = program.command("artifact");
for (const action of ["add", "update", "remove"] as const) artifact.command(action).argument("<id>").requiredOption("--target <path-or-url>").option("--label <label>").option("--expected-version <hash>").option("--dry-run").action(async (id, options) => {
  const repository = await open(); const result = await setArtifact(repository, id, action, { target: options.target, label: options.label }, options.expectedVersion, options.dryRun);
  print(await repository.envelope(result));
});

program.command("validate").option("--format <format>", "text or json", "text").option("--ref <ref>").action(async (options) => {
  const repository = await open(options.ref); const result = await validateRepository(repository);
  if (options.format === "json") print(await repository.envelope(result, result.diagnostics));
  else {
    for (const item of result.diagnostics) process.stdout.write(`${item.severity.toUpperCase()} ${item.code}${item.itemId ? ` [${item.itemId}]` : ""}: ${item.message}\n`);
    process.stdout.write(`${result.diagnostics.filter((item) => item.severity === "error").length} error(s), ${result.diagnostics.filter((item) => item.severity === "warning").length} warning(s)\n`);
  }
  if (result.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
});

const status = program.command("status");
status.option("--format <format>", "text or json", "text").option("--ref <ref>").action(async (options) => {
  const repository = await open(options.ref); const result = await validateRepository(repository);
  if (options.format === "json") print(await repository.envelope(result.statuses, result.diagnostics));
  else for (const item of result.statuses) process.stdout.write(`${item.id}\t${item.status}\t${item.health.join(",")}\n`);
});

status.command("set").argument("<id>").argument("<status>").option("--expected-version <hash>").option("--dry-run").action(async (id, value, options) => {
  const repository = await open(); print(await repository.envelope(await setStatus(repository, id, value, options.expectedVersion, options.dryRun)));
});
const impact = program.command("impact");
impact.command("acknowledge").argument("<item>").requiredOption("--target <id>").option("--expected-version <hash>").option("--dry-run").action(async (item, options) => {
  const repository = await open(); print(await repository.envelope(await acknowledgeImpact(repository, item, options.target, options.expectedVersion, options.dryRun)));
});

program.command("renumber").argument("<old-id>").argument("<new-id>").option("--dry-run").action(async (oldId, newId, options) => {
  const repository = await open(); print(await repository.envelope(await renumberItem(repository, oldId, newId, options.dryRun)));
});

program.command("graph").option("--format <format>", "json or dot", "json").option("--ref <ref>").action(async (options) => {
  const repository = await open(options.ref); const graph = graphData(repository);
  if (options.format === "dot") print(`digraph reqly {\n${graph.nodes.map((node: any) => `  \"${node.id}\" [label=\"${node.id}: ${node.label.replaceAll('"', '\\\"')}\"];`).join("\n")}\n${graph.edges.map((edge: any) => `  \"${edge.source}\" -> \"${edge.target}\" [label=\"${edge.type}\"];`).join("\n")}\n}`, "text");
  else print(await repository.envelope(graph));
});

const report = program.command("report");
report.command("traceability").option("--format <format>", "markdown or json", "markdown").option("--ref <ref>").action(async (options) => {
  const repository = await open(options.ref); const result = await traceabilityReport(repository); print(options.format === "json" ? await repository.envelope(result.json) : result.markdown, options.format === "json" ? "json" : "text");
});
const baseline = program.command("baseline");
baseline.command("create").argument("<name>").action(async (name) => { const repository = await open(); print(await repository.envelope({ tag: await createBaseline(repository, name) })); });
baseline.command("compare").argument("<tag-a>").argument("<tag-b>").action(async (left, right) => { const repository = await open(); print(await repository.envelope(await compareBaselines(repository, left, right))); });

const schema = program.command("schema");
schema.command("export").option("--name <name>", "requirement or verification").action((options) => print(options.name ? schemas[options.name as keyof typeof schemas] : schemas));
const ai = program.command("ai"); const guide = ai.command("guide");
guide.command("show").action(async () => print(renderAiGuide((await open()).config), "text"));
guide.command("check").action(async () => { const ok = await checkAiGuide(root()); print({ valid: ok }); if (!ok) process.exitCode = 1; });
guide.command("sync").action(async () => print({ changed: await syncAiGuide(root()) }));
const agents = program.command("agents").description("Manage the generated Reqly block in AGENTS.md");
agents.command("show").action(async () => print(renderAiGuide((await open()).config), "text"));
agents.command("check").action(async () => { const ok = await checkAiGuide(root()); print({ valid: ok }); if (!ok) process.exitCode = 1; });
agents.command("sync").action(async () => print({ changed: await syncAiGuide(root()) }));

program.parseAsync().catch((error: unknown) => {
  const reqlyError = error instanceof ReqlyError ? error : new ReqlyError("INTERNAL_ERROR", (error as Error).message);
  process.stderr.write(`${JSON.stringify({ apiVersion: "reqly/v1", error: { code: reqlyError.code, message: reqlyError.message, details: reqlyError.details } }, null, 2)}\n`);
  process.exitCode = reqlyError.code === "VALIDATION_FAILED" ? 1 : 2;
});
