const relation = {
  type: "object",
  required: ["type", "target"],
  properties: {
    type: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    fingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
  },
  additionalProperties: false,
} as const;

const commonProperties = {
  id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 },
  status: { type: "string", minLength: 1 },
  relations: { type: "array", items: relation }, artifacts: { type: "array", items: { type: "string", pattern: "^\\[[^\\r\\n]*\\]\\([^\\r\\n]+\\)$" } },
} as const;

export const schemas = {
  requirement: {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "reqly/requirement/v1", type: "object",
    required: ["schema", "id", "title", "status"],
    properties: { schema: { const: "reqly/requirement/v1" }, ...commonProperties, id: { type: "string", pattern: "^REQ-[0-9]{4,}$" }, status: { enum: ["draft", "accepted", "rejected", "superseded", "retired"] } },
    patternProperties: { "^x-": true }, additionalProperties: false,
  },
  verification: {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: "reqly/verification/v1", type: "object",
    required: ["schema", "id", "title", "status"],
    properties: { schema: { const: "reqly/verification/v1" }, ...commonProperties, id: { type: "string", pattern: "^VER-[0-9]{4,}$" }, status: { enum: ["pass", "fail"] } },
    patternProperties: { "^x-": true }, additionalProperties: false,
  },
} as const;
