export const API_VERSION = "reqly/v1" as const;
export const REQUIREMENT_SCHEMA = "reqly/requirement/v1" as const;
export const VERIFICATION_SCHEMA = "reqly/verification/v1" as const;

export type ItemType = "requirement" | "verification";
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

export type RecordData = RequirementData | VerificationData;

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
  };
  ids: {
    requirement: { prefix: string; width: number };
    verification: { prefix: string; width: number };
  };
  requirements: {
    statuses: string[];
  };
  verifications: {
    statuses: Array<"pass" | "fail">;
  };
  relations: Record<string, RelationDefinition>;
  artifacts: {
    lfsWarningBytes: number;
  };
  baselines: {
    tagPrefix: string;
  };
  ai: {
    maxResourceBytes: number;
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

export interface RepositoryInfo {
  root: string;
  head: string | null;
  dirty: boolean;
}

export interface ApiEnvelope<T> {
  apiVersion: typeof API_VERSION;
  repository: Omit<RepositoryInfo, "root">;
  data: T;
  diagnostics: Diagnostic[];
  nextCursor?: string;
}

export interface SearchFilters {
  query?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  includeBody?: boolean;
}

export interface ContextOptions {
  depth?: 0 | 1 | 2;
  includeBody?: boolean;
  includeArtifacts?: boolean;
  includeDiagnostics?: boolean;
}

export interface ItemView {
  id: string;
  type: ItemType;
  title: string;
  status: string;
  version: string;
  path: string;
  relations: Relation[];
  artifacts?: string[];
  verified?: boolean;
  body?: string;
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
