import type { ReqlyConfig } from "./types.js";

export const defaultConfig: ReqlyConfig = {
  roots: { requirements: ".reqly/requirements", verifications: ".reqly/verifications", folders: ".reqly/folders" },
  ids: {
    requirement: { prefix: "REQ-", width: 4 },
    verification: { prefix: "VER-", width: 4 },
    folder: { prefix: "FOL-", width: 4 },
  },
  requirements: {
    statuses: ["draft", "accepted", "rejected", "superseded", "retired"],
  },
  verifications: { statuses: ["pass", "fail"] },
  folders: { statuses: ["active"] },
  relations: {
    contains: { source: "folder", target: "any", inverse: "contained-by", normative: false, acyclic: true, propagatesImpact: true },
    "contained-by": { source: "any", target: "folder", inverse: "contains", normative: false },
    "required-by": {
      source: "requirement",
      target: "requirement",
      inverse: "requires",
      acyclic: true,
      propagatesImpact: true,
      fingerprintRequired: true,
    },
    requires: { source: "requirement", target: "requirement", inverse: "required-by", normative: false },
    "verified-by": {
      source: "requirement",
      target: "verification",
      inverse: "verifies",
      propagatesImpact: true,
      fingerprintRequired: true,
    },
    verifies: { source: "verification", target: "requirement", inverse: "verified-by", normative: false },
    "superseded-by": { source: "requirement", target: "requirement", inverse: "supersedes" },
    supersedes: { source: "requirement", target: "requirement", inverse: "superseded-by", normative: false },
  },
  artifacts: {
    lfsWarningBytes: 10 * 1024 * 1024,
  },
  ai: { agentsPath: ".reqly/AGENTS.md" },
};

export const requirementTemplate = `## Requirement

State the requirement unambiguously.

## Rationale

Explain why this requirement exists.

## Notes

`;

export const verificationTemplate = `## Procedure

Describe the verification procedure step by step.

## Expected Result

Describe the observable passing result.

## Evidence

Record or link the evidence produced by this verification.

## Notes

`;

export const folderTemplate = `## Notes

Use this folder to organize Reqly items.
`;
