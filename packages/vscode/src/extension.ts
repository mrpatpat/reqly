import * as vscode from "vscode";
import path from "node:path";
import {
  ReqlyError,
  ReqlyRepository,
  acknowledgeImpact,
  createItem,
  createVerification,
  deleteItem,
  initRepository,
  parseArtifactLink,
  setArtifact,
  setRelation,
  setStatus,
  validateRepository,
  type Diagnostic,
  type ItemType,
  type ItemStatus,
  type Relation,
  type ReqlyRecord,
} from "@reqly/core";

interface ImpactEntry { record: ReqlyRecord; relatedId?: string; message: string; }

class ItemNode extends vscode.TreeItem {
  constructor(public readonly record: ReqlyRecord, health: string[] = [], verified?: boolean, public readonly lineage: string[] = [], collapsible = false) {
    super(`${record.data.id}: ${record.data.title}`, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const verificationLabel = record.type === "requirement" ? verified === true ? "verified" : verified === false ? "failed" : "verification incomplete" : "";
    this.description = `${record.status}${verificationLabel ? ` · ${verificationLabel}` : ""}${health.length ? ` · ${health.join(", ")}` : ""}`;
    this.tooltip = `${record.data.id}\n${record.data.title}\n${this.description}`;
    this.contextValue = record.type === "requirement" ? "reqlyRequirement" : "reqlyItem";
    const result = record.type === "verification" ? record.status === "pass" ? true : record.status === "fail" ? false : undefined : verified;
    this.iconPath = result === true ? new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed")) : result === false ? new vscode.ThemeIcon("close", new vscode.ThemeColor("testing.iconFailed")) : new vscode.ThemeIcon("symbol-interface");
    this.command = { command: "reqly.openItem", title: "Open Item", arguments: [this] };
  }
}

class ImpactNode extends vscode.TreeItem {
  constructor(public readonly entry: ImpactEntry) {
    super(`${entry.record.data.id}: ${entry.record.data.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = entry.message;
    this.tooltip = entry.relatedId ? `${entry.message}\nRelated item: ${entry.relatedId}` : entry.message;
    this.contextValue = entry.relatedId ? "reqlyImpactAcknowledgeable" : "reqlyImpact";
    this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
    this.command = { command: "reqly.openItem", title: "Open Requirement", arguments: [this] };
  }
}

class RequirementsProvider implements vscode.TreeDataProvider<ItemNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private repository?: ReqlyRepository;
  private statuses = new Map<string, ItemStatus>();
  set(repository: ReqlyRepository | undefined, statuses: ItemStatus[] = []): void { this.repository = repository; this.statuses = new Map(statuses.map((status) => [status.id, status])); this.changed.fire(); }
  getTreeItem(item: ItemNode): vscode.TreeItem { return item; }
  getChildren(element?: ItemNode): ItemNode[] {
    if (!this.repository) return [];
    const records = [...this.repository.records.values()];
    const isHierarchyRelation = (relation: Relation) => this.repository?.config.relations[relation.type]?.acyclic === true;
    const childrenOf = (id: string) => {
      const parent = this.repository?.records.get(id);
      const requirementChildren = records.filter((record) => record.type === "requirement" && (record.data.relations ?? []).some((relation) => isHierarchyRelation(relation) && relation.target === id));
      const verificationChildren = parent?.type === "requirement" ? (parent.data.relations ?? []).flatMap((relation) => {
        const definition = this.repository?.config.relations[relation.type]; const target = this.repository?.records.get(relation.target);
        return definition?.source === "requirement" && definition.target === "verification" && target ? [target] : [];
      }) : [];
      return [...requirementChildren, ...verificationChildren];
    };
    const hasTreeParent = (record: ReqlyRecord) => record.type === "requirement"
      ? (record.data.relations ?? []).some((relation) => isHierarchyRelation(relation) && this.repository?.records.has(relation.target))
      : records.some((candidate) => candidate.type === "requirement" && (candidate.data.relations ?? []).some((relation) => this.repository?.config.relations[relation.type]?.target === "verification" && relation.target === record.data.id));
    let candidates: ReqlyRecord[]; let lineage: string[];
    if (element) {
      lineage = [...element.lineage, element.record.data.id];
      candidates = childrenOf(element.record.data.id).filter((record) => !lineage.includes(record.data.id));
    } else {
      lineage = [];
      const roots = records.filter((record) => !hasTreeParent(record));
      const reachable = new Set<string>(); const queue = roots.map((record) => record.data.id);
      while (queue.length) { const id = queue.shift()!; if (reachable.has(id)) continue; reachable.add(id); queue.push(...childrenOf(id).map((record) => record.data.id)); }
      candidates = [...roots, ...records.filter((record) => !reachable.has(record.data.id))];
    }
    return [...new Map(candidates.map((record) => [record.data.id, record])).values()]
      .sort((a, b) => a.data.id.localeCompare(b.data.id))
      .map((record) => new ItemNode(record, (this.statuses.get(record.data.id)?.health ?? []).filter((value) => value !== "clean"), this.repository?.verificationState(record.data.id), lineage, childrenOf(record.data.id).some((child) => !lineage.includes(child.data.id))));
  }
}

class ImpactsProvider implements vscode.TreeDataProvider<ImpactNode> {
  private readonly changed = new vscode.EventEmitter<void>(); readonly onDidChangeTreeData = this.changed.event;
  private entries: ImpactEntry[] = [];
  set(repository: ReqlyRepository | undefined, diagnostics: Diagnostic[]): void {
    this.entries = repository ? diagnostics.filter((item) => ["PARENT_UPDATE_PENDING", "VERIFICATION_UPDATE_PENDING", "PARENT_DRAFT", "BROKEN_REFERENCE", "RELATION_CYCLE"].includes(item.code) && item.itemId && repository.records.has(item.itemId)).map((item) => ({ record: repository.get(item.itemId!), relatedId: ["PARENT_UPDATE_PENDING", "VERIFICATION_UPDATE_PENDING", "PARENT_DRAFT"].includes(item.code) ? item.relatedId : undefined, message: item.message })) : [];
    this.changed.fire();
  }
  getTreeItem(item: ImpactNode): vscode.TreeItem { return item; }
  getChildren(): ImpactNode[] { return this.entries.map((entry) => new ImpactNode(entry)); }
}

class ReqlyCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly state: ExtensionState) {}
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const record = [...(this.state.repository?.records.values() ?? [])].find((candidate) => path.normalize(candidate.filePath) === path.normalize(document.uri.fsPath));
    if (!record) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const status = this.state.statuses.get(record.data.id);
    const verified = record.type === "requirement" ? this.state.repository?.verificationState(record.data.id) : undefined;
    return [
      new vscode.CodeLens(range, { title: `Status: ${record.status} · ${(status?.health ?? ["clean"]).join(", ")}`, command: "reqly.setStatus", arguments: [record.data.id] }),
      ...(record.type === "requirement" ? [new vscode.CodeLens(range, { title: `Verified: ${verified === true ? "yes" : verified === false ? "no" : "incomplete"}`, command: "reqly.manageRelations", arguments: [record.data.id] })] : []),
      new vscode.CodeLens(range, { title: `Relations: ${(record.data.relations ?? []).length} · Manage`, command: "reqly.manageRelations", arguments: [record.data.id] }),
      new vscode.CodeLens(range, { title: `Artifacts: ${(record.data.artifacts ?? []).length} · Manage`, command: "reqly.manageArtifacts", arguments: [record.data.id] }),
      new vscode.CodeLens(range, { title: "Open Markdown Preview", command: "reqly.previewItem", arguments: [new ItemNode(record)] }),
    ];
  }
}

class ExtensionState {
  repository?: ReqlyRepository;
  statuses = new Map<string, ItemStatus>();
  diagnostics: Diagnostic[] = [];
  root?: string;
  constructor(
    readonly requirements: RequirementsProvider,
    readonly impacts: ImpactsProvider,
    readonly collection: vscode.DiagnosticCollection,
  ) {}

  async refresh(): Promise<void> {
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!this.root) { this.repository = undefined; this.requirements.set(undefined); this.impacts.set(undefined, []); return; }
    try {
      this.repository = await ReqlyRepository.open(this.root);
      await this.revalidate();
      await vscode.commands.executeCommand("setContext", "reqly.initialized", true);
    } catch (error) {
      if (error instanceof ReqlyError && error.code === "PROJECT_NOT_FOUND") {
        this.repository = undefined; this.requirements.set(undefined); this.impacts.set(undefined, []); this.collection.clear();
        await vscode.commands.executeCommand("setContext", "reqly.initialized", false); return;
      }
      void vscode.window.showErrorMessage(`Reqly: ${(error as Error).message}`);
    }
  }

  async refreshChanged(uris: vscode.Uri[]): Promise<void> {
    if (!this.repository || !this.root || uris.some((uri) => uri.fsPath.includes(`${path.sep}.reqly${path.sep}`))) { await this.refresh(); return; }
    for (const uri of uris) if (path.basename(uri.fsPath) === "index.md") await this.repository.refreshFile(uri.fsPath);
    await this.revalidate();
  }

  private async revalidate(): Promise<void> {
    if (!this.repository) return;
    const validation = await validateRepository(this.repository);
    this.statuses = new Map(validation.statuses.map((status) => [status.id, status]));
    this.diagnostics = validation.diagnostics;
    this.requirements.set(this.repository, validation.statuses);
    this.impacts.set(this.repository, validation.diagnostics);
    this.publishDiagnostics(validation.diagnostics);
  }

  private publishDiagnostics(items: Diagnostic[]): void {
    this.collection.clear();
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const item of items) {
      if (!item.path || !this.root) continue;
      const target = path.join(this.root, item.path);
      const diagnostics = grouped.get(target) ?? [];
      const severity = item.severity === "error" ? vscode.DiagnosticSeverity.Error : item.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER), `[${item.code}] ${item.message}`, severity);
      diagnostic.source = "Reqly"; diagnostic.code = item.code; diagnostics.push(diagnostic); grouped.set(target, diagnostics);
    }
    for (const [file, diagnostics] of grouped) this.collection.set(vscode.Uri.file(file), diagnostics);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const requirements = new RequirementsProvider(); const impacts = new ImpactsProvider(); const collection = vscode.languages.createDiagnosticCollection("reqly");
  const state = new ExtensionState(requirements, impacts, collection);
  context.subscriptions.push(collection, vscode.window.registerTreeDataProvider("reqly.requirements", requirements), vscode.window.registerTreeDataProvider("reqly.impacts", impacts));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "markdown", pattern: "**/{requirements,verifications}/**/index.md" }, new ReqlyCodeLensProvider(state)));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider("markdown", {
    provideDefinition(document, position) {
      const range = document.getWordRangeAtPosition(position, /(?:REQ|VER)-\d+/); const id = range ? document.getText(range) : undefined;
      const target = id ? state.repository?.records.get(id) : undefined;
      return target ? new vscode.Location(vscode.Uri.file(target.filePath), new vscode.Position(0, 0)) : undefined;
    },
  }));
  context.subscriptions.push(vscode.languages.registerHoverProvider("markdown", {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position, /(?:REQ|VER)-\d+/); const target = range ? state.repository?.records.get(document.getText(range)) : undefined;
      return target ? new vscode.Hover(`**${target.data.id}: ${target.data.title}**\n\nStatus: ${target.status}`) : undefined;
    },
  }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider("markdown", {
    provideCompletionItems(document, position) {
      if (!document.lineAt(position.line).text.match(/target:/)) return [];
      return [...(state.repository?.records.values() ?? [])].map((record) => { const item = new vscode.CompletionItem(record.data.id, vscode.CompletionItemKind.Reference); item.detail = record.data.title; return item; });
    },
  }, "-"));

  const register = (command: string, callback: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  register("reqly.refresh", () => state.refresh());
  register("reqly.init", async () => { const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) return; await initRepository(root); await state.refresh(); });
  register("reqly.newRequirement", async () => createFromUi(state));
  register("reqly.newSubRequirement", async (node: ItemNode | string) => createSubRequirementFromUi(state, node));
  register("reqly.newVerification", async () => createVerificationFromUi(state));
  register("reqly.openItem", (node: ItemNode | ImpactNode | string) => openItem(state, node));
  register("reqly.previewItem", async (node: ItemNode | ImpactNode | string) => { const record = resolveRecord(state, node); if (record) await vscode.commands.executeCommand("markdown.showPreviewToSide", vscode.Uri.file(record.filePath)); });
  register("reqly.validate", async () => { await state.refresh(); const errors = state.diagnostics.filter((item) => item.severity === "error").length; const warnings = state.diagnostics.filter((item) => item.severity === "warning").length; void vscode.window.showInformationMessage(`Reqly: ${errors} error(s), ${warnings} warning(s).`); });
  register("reqly.setStatus", async (node: ItemNode | ImpactNode | string) => setStatusFromUi(state, node));
  register("reqly.manageRelations", async (node: ItemNode | ImpactNode | string) => manageRelationsFromUi(state, node));
  register("reqly.manageArtifacts", async (node: ItemNode | ImpactNode | string) => manageArtifactsFromUi(state, node));
  register("reqly.deleteItem", async (node: ItemNode | ImpactNode | string) => deleteItemFromUi(state, node));
  register("reqly.acknowledgeImpact", async (node: ImpactNode) => acknowledgeFromUi(state, node));

  const watcher = vscode.workspace.createFileSystemWatcher("**/{.reqly,requirements}/**/*");
  let timer: NodeJS.Timeout | undefined; const changed = new Map<string, vscode.Uri>();
  const scheduleChange = (uri: vscode.Uri) => { changed.set(uri.fsPath, uri); if (timer) clearTimeout(timer); timer = setTimeout(() => { const targets = [...changed.values()]; changed.clear(); if (targets.length) void state.refreshChanged(targets); }, 150); };
  const scheduleFull = () => { changed.clear(); if (timer) clearTimeout(timer); timer = setTimeout(() => void state.refresh(), 150); };
  watcher.onDidChange(scheduleChange); watcher.onDidCreate(scheduleFull); watcher.onDidDelete(scheduleFull); context.subscriptions.push(watcher);
  await state.refresh();
}

function resolveRecord(state: ExtensionState, value: ItemNode | ImpactNode | string): ReqlyRecord | undefined {
  if (typeof value === "string") return state.repository?.records.get(value);
  if (value instanceof ItemNode) return value.record;
  return value?.entry.record;
}

async function openItem(state: ExtensionState, value: ItemNode | ImpactNode | string): Promise<void> {
  const record = resolveRecord(state, value); if (record) await vscode.window.showTextDocument(vscode.Uri.file(record.filePath), { preview: false });
}

async function createFromUi(state: ExtensionState): Promise<void> {
  const itemId = await promptCreateItem(state, "requirement"); await state.refresh();
  if (itemId) await openItem(state, itemId);
}

async function createSubRequirementFromUi(state: ExtensionState, value: ItemNode | string): Promise<void> {
  if (!state.repository) return;
  const parent = resolveRecord(state, value);
  if (!parent || parent.type !== "requirement" || !await ensureSaved(parent)) return;
  const title = await vscode.window.showInputBox({ title: `New sub-requirement · ${parent.data.id}`, prompt: `Title for a child of ${parent.data.id}`, validateInput: (input) => input.trim() ? undefined : "A title is required." });
  if (!title) return;
  const created = await createItem(state.repository, { title: title.trim() });
  const childId = created.itemId;
  if (!childId) return;
  await state.refresh();
  const child = state.repository.records.get(childId);
  if (!child) return;
  await setRelation(state.repository, child.data.id, "add", { type: "required-by", target: parent.data.id }, child.version);
  await state.refresh();
  await openItem(state, childId);
}

async function createVerificationFromUi(state: ExtensionState): Promise<void> {
  const itemId = await promptCreateItem(state, "verification"); await state.refresh();
  if (itemId) await openItem(state, itemId);
}

async function promptCreateItem(state: ExtensionState, type: ItemType): Promise<string | undefined> {
  if (!state.repository) return;
  const title = await vscode.window.showInputBox({ title: `New ${type}`, prompt: type === "verification" ? "Procedure title" : "Title", validateInput: (value) => value.trim() ? undefined : "A title is required." });
  if (!title) return;
  if (type === "requirement") return (await createItem(state.repository, { title })).itemId;
  const status = await vscode.window.showQuickPick(["pass", "fail"] as const, { title: "Verification result", placeHolder: "Select the current result" }); if (!status) return;
  return (await createVerification(state.repository, { title, status: status as "pass" | "fail" })).itemId;
}

async function setStatusFromUi(state: ExtensionState, value: ItemNode | ImpactNode | string): Promise<void> {
  if (!state.repository) return; const record = resolveRecord(state, value); if (!record || !await ensureSaved(record)) return;
  const statuses: readonly string[] = record.type === "requirement" ? state.repository.config.requirements.statuses : state.repository.config.verifications.statuses;
  const selected = await vscode.window.showQuickPick(statuses.filter((status) => status !== record.status), { title: `Status · ${record.data.id}`, placeHolder: `Current status: ${record.status}` }); if (!selected) return;
  await setStatus(state.repository, record.data.id, selected, record.version); await state.refresh();
}

async function manageRelationsFromUi(state: ExtensionState, value: ItemNode | ImpactNode | string): Promise<void> {
  if (!state.repository) return; const record = resolveRecord(state, value); if (!record || !await ensureSaved(record)) return;
  const existing = record.data.relations ?? [];
  const selected = await vscode.window.showQuickPick([
    { label: "$(add) Add relation", action: "add" as const },
    ...existing.map((relation) => ({ label: `$(references) ${relation.type} → ${relation.target}`, description: relation.fingerprint ? `tracking ${relation.fingerprint.slice(7, 15)}` : "managed inverse", action: "existing" as const, relation })),
  ], { title: `Relations · ${record.data.id}`, placeHolder: "Add or manage a relation" });
  if (!selected) return;
  if (selected.action === "add") { await addRelationFromUi(state, record); return; }
  const relation = selected.relation!;
  const action = await vscode.window.showQuickPick([
    { label: "$(go-to-file) Open target", value: "open" },
    { label: "$(trash) Remove relation", value: "remove" },
  ], { title: `${relation.type} → ${relation.target}` });
  if (!action) return;
  if (action.value === "open") { await openItem(state, relation.target); return; }
  if (action.value === "remove") await setRelation(state.repository, record.data.id, "remove", relation, record.version);
  await state.refresh();
}

async function addRelationFromUi(state: ExtensionState, record: ReqlyRecord): Promise<void> {
  if (!state.repository) return;
  const type = await vscode.window.showQuickPick(Object.entries(state.repository.config.relations).filter(([, definition]) => definition.source === "any" || definition.source === record.type).map(([label]) => label), { title: `Add relation · ${record.data.id}`, placeHolder: "Relation type" }); if (!type) return;
  const definition = state.repository.config.relations[type]!;
  const targets = [...state.repository.records.values()].filter((candidate) => candidate.data.id !== record.data.id && (definition.target === "any" || definition.target === candidate.type));
  const newTypes: ItemType[] = definition.target === "any" ? ["requirement", "verification"] : [definition.target];
  const target = await vscode.window.showQuickPick([
    ...newTypes.map((itemType) => ({ label: `$(add) Create new ${itemType}`, description: "Create it and add this relation", action: "new" as const, itemType })),
    ...targets.map((candidate) => ({ label: candidate.data.id, description: `${candidate.status} · ${candidate.data.title}`, action: "existing" as const, targetId: candidate.data.id })),
  ], { title: `Add ${type}`, placeHolder: "Create or select the target item", matchOnDescription: true }); if (!target) return;
  let targetId: string; let openCreated = false;
  if (target.action === "new") {
    const created = await promptCreateItem(state, target.itemType); if (!created) return;
    targetId = created; openCreated = true; await state.refresh();
  } else targetId = target.targetId;
  const repository = state.repository; const current = repository?.records.get(record.data.id);
  if (!repository || !current) return;
  await setRelation(repository, current.data.id, "add", { type, target: targetId }, current.version); await state.refresh();
  if (openCreated) await openItem(state, targetId);
}

async function manageArtifactsFromUi(state: ExtensionState, value: ItemNode | ImpactNode | string): Promise<void> {
  if (!state.repository) return; const record = resolveRecord(state, value); if (!record || !await ensureSaved(record)) return;
  const existing = (record.data.artifacts ?? []).flatMap((value) => {
    const artifact = parseArtifactLink(value); return artifact ? [artifact] : [];
  });
  const selected = await vscode.window.showQuickPick([
    { label: "$(file-add) Attach file", action: "file" as const, description: "Copy into this item's artifacts folder" },
    { label: "$(link) Add path or URL", action: "target" as const },
    ...existing.map((artifact) => ({ label: `$(file) ${artifact.label || artifact.target}`, description: artifact.target, action: "existing" as const, artifact })),
  ], { title: `Artifacts · ${record.data.id}`, placeHolder: "Attach or manage an artifact" });
  if (!selected) return;
  if (selected.action === "file") { await attachFileFromUi(state, record); return; }
  if (selected.action === "target") { await addArtifactTargetFromUi(state, record); return; }
  const artifact = selected.artifact!;
  const action = await vscode.window.showQuickPick([
    { label: "$(go-to-file) Open", value: "open" },
    { label: "$(edit) Edit label", value: "label" },
    { label: `$(trash) ${/^(?:https?:|mailto:)/i.test(artifact.target) ? "Remove link" : "Delete artifact and file"}`, value: "remove" },
  ], { title: artifact.label || artifact.target }); if (!action) return;
  if (action.value === "open") {
    if (/^https?:\/\//i.test(artifact.target)) await vscode.env.openExternal(vscode.Uri.parse(artifact.target));
    else await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path.resolve(record.directory, artifact.target)));
    return;
  }
  if (action.value === "remove") {
    const external = /^(?:https?:|mailto:)/i.test(artifact.target);
    const confirmation = await vscode.window.showWarningMessage(external ? `Remove the artifact link ${artifact.target}?` : `Delete ${artifact.target} from disk and remove its artifact link?`, { modal: true }, external ? "Remove Link" : "Delete File");
    if (!confirmation) return;
    await setArtifact(state.repository, record.data.id, "remove", artifact, record.version);
  }
  if (action.value === "label") {
    const label = await vscode.window.showInputBox({ title: `Label · ${artifact.target}`, value: artifact.label ?? "", prompt: "Leave empty to use the target path" }); if (label === undefined) return;
    await setArtifact(state.repository, record.data.id, "update", { target: artifact.target, ...(label.trim() ? { label: label.trim() } : {}) }, record.version);
  }
  await state.refresh();
}

async function attachFileFromUi(state: ExtensionState, record: ReqlyRecord): Promise<void> {
  if (!state.repository) return;
  const picked = await vscode.window.showOpenDialog({ title: `Attach file to ${record.data.id}`, canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: "Attach" }); const source = picked?.[0]; if (!source) return;
  const label = await vscode.window.showInputBox({ title: `Artifact label · ${record.data.id}`, prompt: "Optional display label" }); if (label === undefined) return;
  const inside = path.relative(record.directory, source.fsPath);
  let target: string;
  if (!inside.startsWith("..") && !path.isAbsolute(inside)) target = inside.replaceAll("\\", "/");
  else {
    const folder = vscode.Uri.file(path.join(record.directory, "artifacts")); const destination = vscode.Uri.joinPath(folder, path.basename(source.fsPath)); target = `artifacts/${path.basename(source.fsPath)}`;
    await vscode.workspace.fs.createDirectory(folder);
    try { await vscode.workspace.fs.stat(destination); const useExisting = await vscode.window.showWarningMessage(`${target} already exists. Link the existing file?`, { modal: true }, "Link existing"); if (useExisting !== "Link existing") return; }
    catch { await vscode.workspace.fs.copy(source, destination, { overwrite: false }); }
  }
  await setArtifact(state.repository, record.data.id, "add", { target, ...(label.trim() ? { label: label.trim() } : {}) }, record.version); await state.refresh();
}

async function addArtifactTargetFromUi(state: ExtensionState, record: ReqlyRecord): Promise<void> {
  if (!state.repository) return;
  const target = await vscode.window.showInputBox({ title: `Add artifact · ${record.data.id}`, prompt: "Relative path or HTTP(S) URL", validateInput: (value) => value.trim() ? undefined : "A target is required." }); if (!target) return;
  const label = await vscode.window.showInputBox({ title: `Artifact label · ${record.data.id}`, prompt: "Optional display label" }); if (label === undefined) return;
  await setArtifact(state.repository, record.data.id, "add", { target: target.trim(), ...(label.trim() ? { label: label.trim() } : {}) }, record.version); await state.refresh();
}

async function deleteItemFromUi(state: ExtensionState, value?: ItemNode | ImpactNode | string): Promise<void> {
  if (!state.repository) return;
  let record = value ? resolveRecord(state, value) : undefined;
  if (!record) {
    const selected = await vscode.window.showQuickPick([...state.repository.records.values()].sort((a, b) => a.data.id.localeCompare(b.data.id)).map((candidate) => ({ label: candidate.data.id, description: `${candidate.status} · ${candidate.data.title}`, record: candidate })), { title: "Delete Reqly item", placeHolder: "Select the item to delete", matchOnDescription: true });
    record = selected?.record;
  }
  if (!record || !await ensureSaved(record)) return;
  const inbound = [...state.repository.records.values()].reduce((count, candidate) => count + (candidate.data.relations ?? []).filter((relation) => relation.target === record.data.id).length, 0);
  const confirmation = await vscode.window.showWarningMessage(`Delete ${record.data.id}, its entire folder, and ${inbound} incoming relation${inbound === 1 ? "" : "s"}?`, { modal: true }, "Delete Item");
  if (confirmation !== "Delete Item") return;
  await deleteItem(state.repository, record.data.id, record.version); await state.refresh();
}

async function ensureSaved(record: ReqlyRecord): Promise<boolean> {
  const document = vscode.workspace.textDocuments.find((candidate) => path.normalize(candidate.uri.fsPath) === path.normalize(record.filePath));
  if (!document?.isDirty) return true;
  void vscode.window.showWarningMessage(`Save ${record.data.id} before using Reqly actions.`); return false;
}

async function acknowledgeFromUi(state: ExtensionState, node: ImpactNode): Promise<void> {
  if (!state.repository || !node?.entry.relatedId) return;
  const confirmation = await vscode.window.showWarningMessage(`Acknowledge ${node.entry.relatedId} for ${node.entry.record.data.id}?`, { modal: true }, "Acknowledge");
  if (confirmation !== "Acknowledge") return;
  await acknowledgeImpact(state.repository, node.entry.record.data.id, node.entry.relatedId, node.entry.record.version); await state.refresh();
}

export function deactivate(): void {}
