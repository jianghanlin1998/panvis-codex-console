import { describe, expect, it } from "vitest";

import { ContextItemSchema } from "../src/index.js";

const validContextItem = {
  id: "ctx_architecture_decision",
  projectId: "prj_console",
  bigTaskId: "bt_v1",
  kind: "DECISION",
  status: "ACTIVE",
  authority: "HUMAN",
  title: "Use a local-first architecture",
  body: "The V1 workbench runs locally.",
  provenance: {
    sourceType: "MANUAL",
    sourceReference: "architecture-v1.1#0",
    effectiveAt: "2026-08-08T00:00:00Z",
  },
} as const;

describe("context schemas", () => {
  it("parses a valid active human Decision", () => {
    const contextItem = ContextItemSchema.parse(validContextItem);
    expect(contextItem.authority).toBe("HUMAN");
    expect(contextItem.status).toBe("ACTIVE");
  });

  it("rejects invalid authority and status values", () => {
    expect(
      ContextItemSchema.safeParse({
        ...validContextItem,
        authority: "MODEL",
        status: "CURRENT",
      }).success,
    ).toBe(false);
  });

  it("allows superseding context to reference the prior item", () => {
    const contextItem = ContextItemSchema.parse({
      ...validContextItem,
      id: "ctx_architecture_decision_v2",
      provenance: {
        ...validContextItem.provenance,
        supersedesContextItemId: "ctx_architecture_decision",
      },
    });

    expect(contextItem.provenance.supersedesContextItemId).toBe("ctx_architecture_decision");
  });

  it("rejects malformed provenance", () => {
    expect(
      ContextItemSchema.safeParse({
        ...validContextItem,
        provenance: {
          sourceType: "MANUAL",
          sourceReference: "",
          effectiveAt: "not-a-date",
        },
      }).success,
    ).toBe(false);
  });
});
