import { describe, expect, it } from "vitest";

import {
  ContextItemSchema,
  ContextScopeSchema,
  deriveContextScope,
} from "../src/index.js";

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

  it("normalizes valid effective timestamps to UTC", () => {
    const contextItem = ContextItemSchema.parse({
      ...validContextItem,
      provenance: {
        ...validContextItem.provenance,
        effectiveAt: "2026-08-08T09:00:00+09:00",
      },
    });
    expect(contextItem.provenance.effectiveAt).toBe("2026-08-08T00:00:00.000Z");
  });

  it("accepts compact title bounds and trims values", () => {
    expect(ContextItemSchema.parse({ ...validContextItem, title: " x " }).title).toBe("x");
    expect(
      ContextItemSchema.safeParse({ ...validContextItem, title: "x".repeat(256) }).success,
    ).toBe(true);
  });

  it("rejects titles above 256 characters without truncation", () => {
    const title = "x".repeat(257);
    expect(ContextItemSchema.safeParse({ ...validContextItem, title }).success).toBe(false);
    expect(title).toHaveLength(257);
  });

  it("accepts body values from 1 through 4,000 characters", () => {
    expect(ContextItemSchema.safeParse({ ...validContextItem, body: "x" }).success).toBe(true);
    expect(
      ContextItemSchema.safeParse({ ...validContextItem, body: "x".repeat(4_000) }).success,
    ).toBe(true);
  });

  it("rejects body values above 4,000 characters", () => {
    expect(
      ContextItemSchema.safeParse({ ...validContextItem, body: "x".repeat(4_001) }).success,
    ).toBe(false);
  });

  it("enforces the 2,048-character source-reference maximum", () => {
    expect(
      ContextItemSchema.safeParse({
        ...validContextItem,
        provenance: {
          ...validContextItem.provenance,
          sourceReference: "x".repeat(2_048),
        },
      }).success,
    ).toBe(true);
    expect(
      ContextItemSchema.safeParse({
        ...validContextItem,
        provenance: {
          ...validContextItem.provenance,
          sourceReference: "x".repeat(2_049),
        },
      }).success,
    ).toBe(false);
  });

  it("enforces flat Context Item hierarchy structure", () => {
    const projectItem = {
      ...validContextItem,
      bigTaskId: undefined,
    };
    expect(ContextItemSchema.safeParse(projectItem).success).toBe(false);
    expect(
      ContextItemSchema.safeParse({
        ...validContextItem,
        bigTaskId: undefined,
        subtaskId: "st_a",
      }).success,
    ).toBe(false);
    expect(
      ContextItemSchema.safeParse({ ...validContextItem, subtaskId: "st_a" }).success,
    ).toBe(true);
  });
});

describe("Context Scope", () => {
  const projectScope = { scopeType: "PROJECT", projectId: "prj_console" } as const;
  const bigTaskScope = {
    scopeType: "BIG_TASK",
    projectId: "prj_console",
    bigTaskId: "bt_v1",
  } as const;
  const subtaskScope = {
    scopeType: "SUBTASK",
    projectId: "prj_console",
    bigTaskId: "bt_v1",
    subtaskId: "st_a",
  } as const;

  it("parses exactly the Project, Big Task, and Subtask scopes", () => {
    expect(ContextScopeSchema.parse(projectScope)).toEqual(projectScope);
    expect(ContextScopeSchema.parse(bigTaskScope)).toEqual(bigTaskScope);
    expect(ContextScopeSchema.parse(subtaskScope)).toEqual(subtaskScope);
  });

  it("rejects a Subtask scope without its Big Task", () => {
    expect(
      ContextScopeSchema.safeParse({
        scopeType: "SUBTASK",
        projectId: "prj_console",
        subtaskId: "st_a",
      }).success,
    ).toBe(false);
  });

  it("derives exact scope deterministically from valid Context Items", () => {
    expect(
      deriveContextScope(
        ContextItemSchema.parse({
          id: validContextItem.id,
          projectId: validContextItem.projectId,
          kind: validContextItem.kind,
          status: validContextItem.status,
          authority: validContextItem.authority,
          title: validContextItem.title,
          body: validContextItem.body,
          provenance: validContextItem.provenance,
        }),
      ),
    ).toEqual(projectScope);
    expect(deriveContextScope(ContextItemSchema.parse(validContextItem))).toEqual(bigTaskScope);
    expect(
      deriveContextScope(
        ContextItemSchema.parse({ ...validContextItem, subtaskId: "st_a" }),
      ),
    ).toEqual(subtaskScope);
  });
});
