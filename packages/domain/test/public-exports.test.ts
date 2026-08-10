import { describe, expect, it } from "vitest";

import {
  AuditEventSchema,
  BudgetPolicySchema,
  ContextDigestSchema,
  ContextItemSchema,
  ContextScopeSchema,
  DurableTaskSchema,
  ExecutionProviderDescriptorSchema,
  NativeSubagentOwnershipSchema,
  NormalizedUsageSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
  deriveContextScope,
  SubtaskDependencySchema,
  validateBudgetPolicy,
  validateSubtaskDependencies,
  validateSubtaskTransition,
} from "../src/index.js";

describe("domain package public exports", () => {
  it("exposes the deliberate runtime contract surface", () => {
    expect(DurableTaskSchema).toBeDefined();
    expect(AuditEventSchema).toBeDefined();
    expect(ContextDigestSchema).toBeDefined();
    expect(ContextItemSchema).toBeDefined();
    expect(ContextScopeSchema).toBeDefined();
    expect(deriveContextScope).toBeTypeOf("function");
    expect(SubtaskDependencySchema).toBeDefined();
    expect(NativeSubagentOwnershipSchema).toBeDefined();
    expect(BudgetPolicySchema).toBeDefined();
    expect(ExecutionProviderDescriptorSchema).toBeDefined();
    expect(ProviderThreadReferenceSchema).toBeDefined();
    expect(ProviderRunReferenceSchema).toBeDefined();
    expect(NormalizedUsageSchema).toBeDefined();
    expect(validateSubtaskDependencies).toBeTypeOf("function");
    expect(validateSubtaskTransition).toBeTypeOf("function");
    expect(validateBudgetPolicy).toBeTypeOf("function");
  });
});
