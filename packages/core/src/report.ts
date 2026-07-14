import type { ReqlyRepository } from "./repository.js";

export function graphData(repository: ReqlyRepository): { nodes: unknown[]; edges: unknown[] } {
  return {
    nodes: [...repository.records.values()].map((record) => ({
      id: record.data.id,
      label: record.data.title,
      type: record.type,
      status: record.status,
      ...(record.type === "requirement" ? { verified: repository.verificationState(record.data.id) } : {}),
    })),
    edges: [...repository.records.values()].flatMap((record) => (record.data.relations ?? []).map((relation) => ({
      source: record.data.id,
      target: relation.target,
      type: relation.type,
      fingerprint: relation.fingerprint,
    }))),
  };
}
