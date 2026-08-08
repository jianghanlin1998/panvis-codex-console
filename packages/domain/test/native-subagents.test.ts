import { describe, expect, it } from "vitest";

import { NativeSubagentOwnershipSchema } from "../src/index.js";

const validOwnership = {
  recordType: "NATIVE_SUBAGENT",
  childThreadId: "thr_child_review",
  owningSubtaskId: "st_s0a",
  parent: {
    parentType: "PRIMARY_THREAD",
    primaryThreadId: "thr_primary",
  },
  purpose: "QA_REVIEW",
  lifecycleScope: "AUXILIARY",
  usageAttribution: "OWNING_SUBTASK",
} as const;

describe("native-subagent ownership", () => {
  it("parses valid auxiliary ownership", () => {
    expect(NativeSubagentOwnershipSchema.parse(validOwnership).owningSubtaskId).toBe("st_s0a");
  });

  it("rejects missing owning Subtask ownership", () => {
    const withoutOwner = {
      recordType: validOwnership.recordType,
      childThreadId: validOwnership.childThreadId,
      parent: validOwnership.parent,
      purpose: validOwnership.purpose,
      lifecycleScope: validOwnership.lifecycleScope,
      usageAttribution: validOwnership.usageAttribution,
    };
    expect(NativeSubagentOwnershipSchema.safeParse(withoutOwner).success).toBe(false);
  });

  it("rejects a missing parent primary thread or execution", () => {
    const withoutParent = {
      recordType: validOwnership.recordType,
      childThreadId: validOwnership.childThreadId,
      owningSubtaskId: validOwnership.owningSubtaskId,
      purpose: validOwnership.purpose,
      lifecycleScope: validOwnership.lifecycleScope,
      usageAttribution: validOwnership.usageAttribution,
    };
    expect(NativeSubagentOwnershipSchema.safeParse(withoutParent).success).toBe(false);
  });

  it("rejects an unsupported auxiliary purpose", () => {
    expect(
      NativeSubagentOwnershipSchema.safeParse({
        ...validOwnership,
        purpose: "FEATURE_IMPLEMENTATION",
      }).success,
    ).toBe(false);
  });

  it("rejects independent budget or Handoff ownership fields", () => {
    expect(
      NativeSubagentOwnershipSchema.safeParse({
        ...validOwnership,
        independentBudgetTokens: 10_000,
      }).success,
    ).toBe(false);
    expect(
      NativeSubagentOwnershipSchema.safeParse({
        ...validOwnership,
        handoff: { summary: "Independent child handoff" },
      }).success,
    ).toBe(false);
    expect(
      NativeSubagentOwnershipSchema.safeParse({
        ...validOwnership,
        promotedContext: [],
      }).success,
    ).toBe(false);
  });
});
