import { createHash } from "node:crypto";
import { parseDocument, stringify, type Document } from "yaml";
import {
  REQUIREMENT_SCHEMA,
  VERIFICATION_SCHEMA,
  ReqlyError,
  type ArtifactLink,
  type MarkdownSection,
  type RecordData,
  type RelationDefinition,
  type ReqlyRecord,
} from "./types.js";

const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;
const SECTION = /^##\s+(.+?)\s*$/gm;
const ARTIFACT_LINK = /^\[((?:\\.|[^\]\\\r\n])*)\]\(((?:\\.|[^)\\\r\n])+?)\)$/;

export function contentVersion(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function splitFrontmatter(raw: string): { yaml: string; body: string; lineEnding: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new ReqlyError("INVALID_FRONTMATTER", "The file must begin with YAML frontmatter.");
  return { yaml: match[1] ?? "", body: match[2] ?? "", lineEnding: raw.includes("\r\n") ? "\r\n" : "\n" };
}

export function parseSections(body: string): MarkdownSection[] {
  const matches = [...body.matchAll(SECTION)];
  return matches.map((match, index) => {
    const headingStart = match.index ?? 0;
    const contentStart = headingStart + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? body.length;
    return { name: (match[1] ?? "").trim(), content: body.slice(contentStart, contentEnd).replace(/^\r?\n/, "").trimEnd() };
  });
}

export function replaceSections(body: string, updates: Record<string, string>): string {
  const sections = parseSections(body);
  const existing = new Map(sections.map((section) => [section.name.toLowerCase(), section]));
  for (const [name, content] of Object.entries(updates)) {
    const key = name.toLowerCase();
    if (existing.has(key)) existing.get(key)!.content = content.trim();
    else sections.push({ name, content: content.trim() });
  }
  return `${sections.map((section) => `## ${section.name}\n\n${section.content}`.trimEnd()).join("\n\n")}\n`;
}

export function parseRecord(raw: string, filePath: string, root: string): ReqlyRecord {
  const { yaml, body } = splitFrontmatter(raw);
  const document = parseDocument(yaml);
  if (document.errors.length) throw new ReqlyError("INVALID_YAML", document.errors.map((error) => error.message).join("; "));
  const data = document.toJS() as RecordData;
  const type = data.schema === REQUIREMENT_SCHEMA ? "requirement" : data.schema === VERIFICATION_SCHEMA ? "verification" : undefined;
  if (!type) throw new ReqlyError("INVALID_SCHEMA", `Unsupported record schema: ${String(data.schema)}`);
  if (typeof data.status !== "string" || !data.status.trim()) throw new ReqlyError("INVALID_STATUS", "A Reqly item needs a status.");
  if ("lifecycle" in data) throw new ReqlyError("INVALID_STATUS", "lifecycle is not supported; store only the current status.");
  const normalizedPath = filePath.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const status = data.status;
  return {
    type,
    data,
    body,
    sections: parseSections(body),
    filePath,
    directory: filePath.slice(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))),
    relativePath: normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath,
    raw,
    version: contentVersion(raw),
    status,
  };
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

export function normativeFingerprint(record: ReqlyRecord, relationDefinitions?: Record<string, RelationDefinition>): string {
  const data = record.data;
  const relations = (data.relations ?? [])
    .filter((relation) => relationDefinitions?.[relation.type]?.normative !== false)
    .map(({ type, target }) => ({ type, target }))
    .sort((a, b) => `${a.type}:${a.target}`.localeCompare(`${b.type}:${b.target}`));
  const normativeSections = record.sections
    .filter((section) => section.name.toLowerCase() !== "notes")
    .map((section) => ({ name: section.name, content: normalizeText(section.content) }));
  const canonical = JSON.stringify({
    title: data.title,
    relations,
    sections: normativeSections,
  });
  return contentVersion(canonical);
}

export function dependencyFingerprint(record: ReqlyRecord, relationDefinitions?: Record<string, RelationDefinition>): string {
  const relations = (record.data.relations ?? [])
    .filter((relation) => relationDefinitions?.[relation.type]?.normative !== false)
    .map(({ type, target }) => ({ type, target }))
    .sort((a, b) => `${a.type}:${a.target}`.localeCompare(`${b.type}:${b.target}`));
  const sections = record.sections
    .filter((section) => section.name.toLowerCase() !== "notes")
    .map((section) => ({ name: section.name, content: normalizeText(section.content) }));
  const artifacts = (record.data.artifacts ?? [])
    .map((value) => parseArtifactLink(value)?.target ?? value)
    .sort((a, b) => a.localeCompare(b));
  return contentVersion(JSON.stringify({
    title: record.data.title,
    status: record.status,
    relations,
    artifacts,
    sections,
  }));
}

export function extractMarkdownLinks(body: string): string[] {
  const links: string[] = [];
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of body.matchAll(pattern)) links.push(match[1] ?? "");
  return links;
}

export function formatArtifactLink(artifact: ArtifactLink): string {
  const target = artifact.target.trim();
  const label = artifact.label?.trim() || target;
  if (!target || /[\r\n]/.test(target) || /[\r\n]/.test(label)) throw new ReqlyError("INVALID_ARTIFACT_LINK", "Artifact targets and labels must fit on one line.");
  const escapedLabel = label.replace(/([\\\]])/g, "\\$1");
  const escapedTarget = target.replace(/([\\()])/g, "\\$1");
  return `[${escapedLabel}](${escapedTarget})`;
}

export function parseArtifactLink(value: string): ArtifactLink | null {
  if (typeof value !== "string") return null;
  const match = ARTIFACT_LINK.exec(value);
  if (!match) return null;
  const unescape = (text: string) => text.replace(/\\(.)/g, "$1");
  return { label: unescape(match[1] ?? ""), target: unescape(match[2] ?? "") };
}

export function serializeRecord(record: ReqlyRecord, data: RecordData, body: string): string {
  const { yaml, lineEnding } = splitFrontmatter(record.raw);
  const document = parseDocument(yaml) as Document;
  const current = document.toJS() as Record<string, unknown>;
  for (const key of Object.keys(current)) if (!(key in data)) document.delete(key);
  for (const [key, value] of Object.entries(data)) document.set(key, value);
  const rendered = `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n${body.replace(/^\s*\n/, "")}`;
  return rendered.replaceAll("\n", lineEnding);
}

export function createRecordText(data: RecordData, body: string): string {
  return `---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}
