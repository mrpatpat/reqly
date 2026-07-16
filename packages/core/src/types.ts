export const REQUIREMENT_SCHEMA = "reqly/requirement/v1" as const;
export const VERIFICATION_SCHEMA = "reqly/verification/v1" as const;
export const FOLDER_SCHEMA = "reqly/folder/v1" as const;

export type ItemType = "requirement" | "verification" | "folder";
export type Severity = "error" | "warning" | "info";

export interface Relation {
  type: string;
  target: string;
  fingerprint?: string;
}

export interface ArtifactLink {
  target: string;
  label?: string;
}

export interface BaseRecordData {
  schema: string;
  id: string;
  title: string;
  status: string;
  relations?: Relation[];
  artifacts?: string[];
  [key: `x-${string}`]: unknown;
}

export interface RequirementData extends BaseRecordData {
  schema: typeof REQUIREMENT_SCHEMA;
}

export interface VerificationData extends BaseRecordData {
  schema: typeof VERIFICATION_SCHEMA;
}

export interface FolderData extends BaseRecordData {
  schema: typeof FOLDER_SCHEMA;
  status: "active";
}

export type RecordData = RequirementData | VerificationData | FolderData;

export interface MarkdownSection {
  name: string;
  content: string;
}

export interface ReqlyRecord<T extends RecordData = RecordData> {
  type: ItemType;
  data: T;
  body: string;
  sections: MarkdownSection[];
  filePath: string;
  directory: string;
  relativePath: string;
  raw: string;
  version: string;
  status: string;
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  itemId?: string;
  path?: string;
  relatedId?: string;
}

export interface RelationDefinition {
  source: ItemType | "any";
  target: ItemType | "any";
  inverse?: string;
  normative?: boolean;
  acyclic?: boolean;
  propagatesImpact?: boolean;
  fingerprintRequired?: boolean;
}

export interface ReqlyConfig {
  roots: {
    requirements: string;
    verifications: string;
    folders: string;
  };
  ids: {
    requirement: { prefix: string; width: number };
    verification: { prefix: string; width: number };
    folder: { prefix: string; width: number };
  };
  requirements: {
    statuses: string[];
  };
  verifications: {
    statuses: Array<"pass" | "fail">;
  };
  folders: {
    statuses: Array<"active">;
  };
  relations: Record<string, RelationDefinition>;
  artifacts: {
    lfsWarningBytes: number;
  };
  ai: {
    agentsPath: string;
  };
}

export type HealthCode =
  | "clean"
  | "parent-update-pending"
  | "verification-update-pending"
  | "draft-parent"
  | "upstream-update-pending"
  | "broken-reference"
  | "cycle";

export interface ItemStatus {
  id: string;
  status: string;
  health: HealthCode[];
}

export interface MutationResult {
  changed: boolean;
  itemId?: string;
  version?: string;
  unifiedDiff: string;
  affectedItems: string[];
  diagnostics: Diagnostic[];
}

export class ReqlyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ReqlyError";
  }
}
