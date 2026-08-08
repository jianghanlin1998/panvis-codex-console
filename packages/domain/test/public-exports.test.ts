import { describe, expect, it } from "vitest";

import {
  BudgetPolicySchema,
  ContextItemSchema,
  DurableTaskSchema,
  NativeSubagentOwnershipSchema,
  SubtaskDependencySchema,
  validateBudgetPolicy,
  validateSubtaskDependencies,
  validateSubtaskTransition,
} from "../src/index.js";

describe("domain package public exports", () => {
  it("exposes the deliberate runtime contract surface", () => {
    expect(DurableTaskSchema).toBeDefined();
    expect(ContextItemSchema).toBeDefined();
    expect(SubtaskDependencySchema).toBeDefined();
    expect(NativeSubagentOwnershipSchema).toBeDefined();
    expect(BudgetPolicySchema).toBeDefined();
    expect(validateSubtaskDependencies).toBeTypeOf("function");
    expect(validateSubtaskTransition).toBeTypeOf("function");
    expect(validateBudgetPolicy).toBeTypeOf("function");
  });
});
