import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initRepository, createItem, createVerification, deleteItem, setStatus, setRelation, setArtifact, updateItem, acknowledgeImpact, createBaseline, checkAiGuide, syncAiGuide } from "./mutations.js";
import { ReqlyRepository } from "./repository.js";
import { dependencyFingerprint, normativeFingerprint, parseRecord, replaceSections } from "./markdown.js";
import { validateRepository } from "./validate.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "reqly-test-")); temporary.push(root);
  git(root, "init"); git(root, "config", "user.email", "test@reqly.dev"); git(root, "config", "user.name", "Reqly Test"); git(root, "config", "core.autocrlf", "false");
  await initRepository(root); return root;
}

async function commit(root: string, message: string): Promise<string> {
  git(root, "add", "."); git(root, "commit", "-m", message); return git(root, "rev-parse", "HEAD");
}

async function setStatusAndCommit(root: string, id: string, status: string): Promise<string> {
  const repository = await ReqlyRepository.open(root); await setStatus(repository, id, status); return commit(root, `${id} ${status}`);
}

describe("Markdown model", () => {
  it("creates .reqly/AGENTS.md and preserves existing Reqly instructions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reqly-agents-")); temporary.push(root);
    git(root, "init"); await mkdir(path.join(root, ".reqly")); await writeFile(path.join(root, ".reqly", "AGENTS.md"), "# Project agents\n\nKeep this instruction.\n", "utf8");
    await initRepository(root);
    const agents = await readFile(path.join(root, ".reqly", "AGENTS.md"), "utf8");
    expect(agents).toContain("Keep this instruction."); expect(agents).toContain("<!-- reqly:generated:start -->"); expect(await checkAiGuide(root)).toBe(true);
    await expect(readFile(path.join(root, ".reqly", "config.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await syncAiGuide(root);
  });

  it("excludes Notes and operational metadata from the normative fingerprint", () => {
    const base = `---\nschema: reqly/requirement/v1\nid: REQ-0001\ntitle: EMC\nstatus: draft\nrelations: []\nartifacts:\n  - "[Initial evidence](evidence.pdf)"\n---\n## Requirement\n\nThe product shall comply.\n\n## Notes\n\nFirst note.\n`;
    const first = parseRecord(base, "/repo/.reqly/requirements/REQ-0001/index.md", "/repo");
    const noteChanged = parseRecord(base.replace("Initial evidence", "Updated evidence label").replace("First note.", "Second note."), "/repo/.reqly/requirements/REQ-0001/index.md", "/repo");
    const requirementChanged = parseRecord(base.replace("shall comply", "shall demonstrably comply"), "/repo/.reqly/requirements/REQ-0001/index.md", "/repo");
    expect(normativeFingerprint(noteChanged)).toBe(normativeFingerprint(first));
    expect(normativeFingerprint(requirementChanged)).not.toBe(normativeFingerprint(first));
    expect(dependencyFingerprint(noteChanged)).toBe(dependencyFingerprint(first));
    expect(dependencyFingerprint(requirementChanged)).not.toBe(dependencyFingerprint(first));
    expect(dependencyFingerprint(parseRecord(base.replace("status: draft", "status: accepted"), "/repo/.reqly/requirements/REQ-0001/index.md", "/repo"))).not.toBe(dependencyFingerprint(first));
    expect(dependencyFingerprint(parseRecord(base.replace("evidence.pdf", "new-evidence.pdf"), "/repo/.reqly/requirements/REQ-0001/index.md", "/repo"))).not.toBe(dependencyFingerprint(first));
  });

  it("updates one named section without dropping neighboring sections", () => {
    const body = "## Requirement\n\nOld\n\n## Rationale\n\nBecause\n\n## Notes\n\nKeep me\n";
    const updated = replaceSections(body, { Requirement: "New" });
    expect(updated).toContain("## Requirement\n\nNew"); expect(updated).toContain("## Rationale\n\nBecause"); expect(updated).toContain("## Notes\n\nKeep me");
  });

  it("rejects the removed lifecycle format", () => {
    const old = `---\nschema: reqly/requirement/v1\nid: REQ-0001\ntitle: Old format\nlifecycle:\n  - sequence: 1\n    state: draft\n    at: 2026-07-13T10:00:00.000Z\n---\n## Requirement\n\nOld.\n`;
    expect(() => parseRecord(old, "/repo/.reqly/requirements/REQ-0001/index.md", "/repo")).toThrow("status");
  });

});

describe("Status and impact", () => {
  it("tracks parent fingerprints and supports acknowledgment", async () => {
    const root = await fixture();
    let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Comply with EMC" });
    await commit(root, "parent draft"); await setStatusAndCommit(root, "REQ-0001", "accepted");

    repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Limit hardware emissions" });
    repository = await ReqlyRepository.open(root);
    await setRelation(repository, "REQ-0002", "add", { type: "required-by", target: "REQ-0001" });
    await commit(root, "child draft"); await setStatusAndCommit(root, "REQ-0002", "accepted");
    repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").data.relations).toContainEqual({ type: "requires", target: "REQ-0002" });
    expect(repository.get("REQ-0002").data.relations).toContainEqual({ type: "required-by", target: "REQ-0001", fingerprint: `sha256:${dependencyFingerprint(repository.get("REQ-0001"), repository.config.relations)}` });
    expect((await validateRepository(repository)).diagnostics).toEqual([]);

    const edit = await updateItem(repository, "REQ-0001", { bodySections: { Requirement: "The product shall comply with the current EMC directive." } });
    expect(edit.unifiedDiff).toContain("current EMC directive");
    await commit(root, "change parent");
    repository = await ReqlyRepository.open(root);
    const changed = await validateRepository(repository);
    expect(changed.diagnostics.some((item) => item.code === "PARENT_UPDATE_PENDING" && item.itemId === "REQ-0002")).toBe(true);

    const childVersion = repository.get("REQ-0002").version;
    await acknowledgeImpact(repository, "REQ-0002", "REQ-0001", childVersion); await commit(root, "acknowledge parent change");
    repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").data.relations?.find((relation) => relation.type === "requires")?.fingerprint).toBeUndefined();
    expect(repository.get("REQ-0002").data.relations?.find((relation) => relation.type === "required-by")?.fingerprint).toBe(`sha256:${dependencyFingerprint(repository.get("REQ-0001"), repository.config.relations)}`);
    expect((await validateRepository(repository)).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(await createBaseline(repository, "verified")).toBe("reqly/verified");
    expect(git(root, "tag", "--list", "reqly/verified")).toBe("reqly/verified");
    const baseline = await ReqlyRepository.open(root, "reqly/verified");
    expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/);
    expect((await validateRepository(baseline)).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("adds and removes inverse relations from either direction", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Parent" }); repository = await ReqlyRepository.open(root); await createItem(repository, { title: "Child" });
    repository = await ReqlyRepository.open(root); await setRelation(repository, "REQ-0002", "add", { type: "required-by", target: "REQ-0001" });
    repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").data.relations).toContainEqual({ type: "requires", target: "REQ-0002" });
    await setRelation(repository, "REQ-0001", "remove", { type: "requires", target: "REQ-0002" }); repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").data.relations).toEqual([]); expect(repository.get("REQ-0002").data.relations).toEqual([]);
    await setRelation(repository, "REQ-0001", "add", { type: "requires", target: "REQ-0002" }); repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0002").data.relations).toContainEqual({ type: "required-by", target: "REQ-0001", fingerprint: `sha256:${dependencyFingerprint(repository.get("REQ-0001"), repository.config.relations)}` });
  });

  it("queues accepted requirements whose parent is draft", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Draft parent" }); repository = await ReqlyRepository.open(root); await createItem(repository, { title: "Accepted child" });
    repository = await ReqlyRepository.open(root); await setRelation(repository, "REQ-0002", "add", { type: "required-by", target: "REQ-0001" });
    repository = await ReqlyRepository.open(root); await setStatus(repository, "REQ-0002", "accepted"); repository = await ReqlyRepository.open(root);
    const validation = await validateRepository(repository);
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({ code: "PARENT_DRAFT", itemId: "REQ-0002", relatedId: "REQ-0001" }));
    expect(validation.statuses.find((item) => item.id === "REQ-0002")?.health).toContain("draft-parent");
    expect(validation.diagnostics.some((item) => item.code === "PARENT_UPDATE_PENDING" && item.itemId === "REQ-0002")).toBe(false);
  });

  it("computes direct verification state and fingerprints verification changes", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Emission limits" }); repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").sections.some((section) => section.name === "Verification")).toBe(false);
    await createVerification(repository, { title: "Measure radiated emissions", status: "pass" }); repository = await ReqlyRepository.open(root);
    expect(repository.get("VER-0001").sections.find((section) => section.name === "Procedure")?.content).toContain("Describe the verification procedure");
    expect(repository.get("VER-0001").sections.find((section) => section.name === "Expected Result")?.content).toContain("observable passing result");
    expect(repository.get("VER-0001").sections.find((section) => section.name === "Evidence")?.content).toContain("evidence produced");
    await setRelation(repository, "REQ-0001", "add", { type: "verified-by", target: "VER-0001" }); repository = await ReqlyRepository.open(root);

    expect(repository.get("REQ-0001").data.relations).toContainEqual({
      type: "verified-by",
      target: "VER-0001",
      fingerprint: `sha256:${dependencyFingerprint(repository.get("VER-0001"), repository.config.relations)}`,
    });
    expect(repository.get("VER-0001").data.relations).toContainEqual({ type: "verifies", target: "REQ-0001" });
    expect(repository.verificationState("REQ-0001")).toBe(true);
    expect(repository.toView(repository.get("REQ-0001")).verified).toBe(true);

    await setStatus(repository, "VER-0001", "fail"); repository = await ReqlyRepository.open(root);
    expect(repository.verificationState("REQ-0001")).toBe(false);
    expect((await validateRepository(repository)).diagnostics).toContainEqual(expect.objectContaining({
      code: "VERIFICATION_UPDATE_PENDING",
      itemId: "REQ-0001",
      relatedId: "VER-0001",
    }));
    expect((await validateRepository(repository)).statuses.find((item) => item.id === "REQ-0001")?.health).toContain("verification-update-pending");

    await acknowledgeImpact(repository, "REQ-0001", "VER-0001", repository.get("REQ-0001").version);
    repository = await ReqlyRepository.open(root);
    expect(repository.verificationState("REQ-0001")).toBe(false);
    expect((await validateRepository(repository)).diagnostics.some((item) => item.code === "VERIFICATION_UPDATE_PENDING")).toBe(false);
  });

  it("derives a parent verification state from all child requirements", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Parent" }); repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "First child" }); repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Second child" }); repository = await ReqlyRepository.open(root);
    await setRelation(repository, "REQ-0002", "add", { type: "required-by", target: "REQ-0001" }); repository = await ReqlyRepository.open(root);
    await setRelation(repository, "REQ-0003", "add", { type: "required-by", target: "REQ-0001" }); repository = await ReqlyRepository.open(root);
    await createVerification(repository, { title: "First test", status: "pass" }); repository = await ReqlyRepository.open(root);
    await setRelation(repository, "REQ-0002", "add", { type: "verified-by", target: "VER-0001" }); repository = await ReqlyRepository.open(root);

    expect(repository.verificationState("REQ-0002")).toBe(true);
    expect(repository.verificationState("REQ-0003")).toBeUndefined();
    expect(repository.verificationState("REQ-0001")).toBeUndefined();

    await createVerification(repository, { title: "Second test", status: "fail" }); repository = await ReqlyRepository.open(root);
    await setRelation(repository, "REQ-0003", "add", { type: "verified-by", target: "VER-0002" }); repository = await ReqlyRepository.open(root);
    expect(repository.verificationState("REQ-0003")).toBe(false);
    expect(repository.verificationState("REQ-0001")).toBe(false);

    await setStatus(repository, "VER-0002", "pass"); repository = await ReqlyRepository.open(root);
    expect(repository.verificationState("REQ-0003")).toBe(true);
    expect(repository.verificationState("REQ-0001")).toBe(true);
  });

  it("rejects relations whose item types do not match the relation contract", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Requirement" }); repository = await ReqlyRepository.open(root);
    await createVerification(repository, { title: "Verification", status: "pass" }); repository = await ReqlyRepository.open(root);
    await expect(setRelation(repository, "VER-0001", "add", { type: "verified-by", target: "REQ-0001" })).rejects.toMatchObject({ code: "INVALID_RELATION_ENDPOINT" });
  });

  it("deletes an item's folder and every relation targeting it", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Parent" }); repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Child to delete" }); repository = await ReqlyRepository.open(root);
    await setRelation(repository, "REQ-0002", "add", { type: "required-by", target: "REQ-0001" }); repository = await ReqlyRepository.open(root);
    await createVerification(repository, { title: "Child verification", status: "pass" }); repository = await ReqlyRepository.open(root);
    await setRelation(repository, "REQ-0002", "add", { type: "verified-by", target: "VER-0001" }); repository = await ReqlyRepository.open(root);
    const itemPath = repository.get("REQ-0002").filePath; const version = repository.get("REQ-0002").version;

    const preview = await deleteItem(repository, "REQ-0002", version, true);
    expect(preview.affectedItems).toEqual(expect.arrayContaining(["REQ-0001", "REQ-0002", "VER-0001"]));
    repository = await ReqlyRepository.open(root); expect(repository.get("REQ-0002").data.id).toBe("REQ-0002");

    await deleteItem(repository, "REQ-0002", version); repository = await ReqlyRepository.open(root);
    expect(repository.records.has("REQ-0002")).toBe(false);
    expect(repository.get("REQ-0001").data.relations).toEqual([]);
    expect(repository.get("VER-0001").data.relations).toEqual([]);
    await expect(readFile(itemPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await validateRepository(repository)).diagnostics).toEqual([]);
  });

  it("allows user-set accepted status without Git history", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "User-controlled requirement" }); repository = await ReqlyRepository.open(root);
    await setStatus(repository, "REQ-0001", "accepted");
    repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").status).toBe("accepted");
    expect((await validateRepository(repository)).diagnostics).toEqual([]);
  });

  it("rejects artifact paths outside the repository", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Unsafe link" }); repository = await ReqlyRepository.open(root);
    await updateItem(repository, "REQ-0001", { fields: { artifacts: ["[outside](../../../../outside.pdf)"] } });
    repository = await ReqlyRepository.open(root);
    expect((await validateRepository(repository)).diagnostics.some((item) => item.code === "PATH_TRAVERSAL")).toBe(true);
  });

  it("stores each managed artifact as one Markdown link line", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Linked evidence" }); repository = await ReqlyRepository.open(root);
    await setArtifact(repository, "REQ-0001", "add", { target: "artifacts/evidence (final).pdf", label: "Final evidence" });
    repository = await ReqlyRepository.open(root); const record = repository.get("REQ-0001");
    expect(record.data.artifacts).toEqual(["[Final evidence](artifacts/evidence \\(final\\).pdf)"]);
    expect(record.raw).toContain('  - "[Final evidence](artifacts/evidence \\\\(final\\\\).pdf)"');
  });

  it("deletes a local artifact file when its managed link is removed", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Disposable evidence" });
    const file = path.join(root, ".reqly", "requirements", "REQ-0001", "evidence.pdf");
    await writeFile(file, "evidence", "utf8"); repository = await ReqlyRepository.open(root);
    await setArtifact(repository, "REQ-0001", "add", { target: "evidence.pdf", label: "Evidence" }); repository = await ReqlyRepository.open(root);
    await setArtifact(repository, "REQ-0001", "remove", { target: "evidence.pdf" }); repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").data.artifacts).toEqual([]);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores only the current user-driven status", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Direct acceptance" }); repository = await ReqlyRepository.open(root);
    await setStatus(repository, "REQ-0001", "accepted");
    repository = await ReqlyRepository.open(root);
    expect(repository.get("REQ-0001").data.status).toBe("accepted");
    expect(repository.get("REQ-0001").raw).not.toContain("lifecycle:");
    expect((await validateRepository(repository)).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("keeps status independent from content updates", async () => {
    const root = await fixture(); let repository = await ReqlyRepository.open(root);
    await createItem(repository, { title: "Re-accepted requirement" }); await commit(root, "draft");
    await setStatusAndCommit(root, "REQ-0001", "accepted");
    repository = await ReqlyRepository.open(root); await updateItem(repository, "REQ-0001", { bodySections: { Requirement: "Reviewed replacement content." } });
    await commit(root, "change and re-accept"); repository = await ReqlyRepository.open(root);
    expect((await validateRepository(repository)).diagnostics).toEqual([]);
    expect(repository.get("REQ-0001").data.status).toBe("accepted");
  });

});
