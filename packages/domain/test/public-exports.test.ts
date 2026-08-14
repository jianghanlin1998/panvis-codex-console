import { describe, expect, it } from "vitest";

import {
  AuditEventSchema,
  BudgetPolicySchema,
  BoundedRetestTargetSchema,
  ContextDigestSchema,
  ContextItemSchema,
  ContextScopeSchema,
  DependencyRequiredGateSchema,
  DurableTaskSchema,
  ExecutionProviderDescriptorSchema,
  NativeSubagentOwnershipSchema,
  NormalizedUsageSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
  QaContextCandidateClassSchema,
  QaContextProfileCandidateSchema,
  QaContextProfileDecisionReasonSchema,
  QaContextProfileKindSchema,
  RepositoryCommitShaSchema,
  SubtaskImplementationCheckpointIdSchema,
  SubtaskImplementationCheckpointSchema,
  buildAllowedContextSet,
  deriveContextScope,
  evaluateContextScopeAccess,
  evaluateQaContextProfileCandidate,
  SubtaskDependencySchema,
  SubtaskMaturitySchema,
  evaluateSubtaskDependencyReadiness,
  validateBudgetPolicy,
  narrowContextCandidatesForQa,
  validateSubtaskDependencies,
  validateSubtaskMaturityTransition,
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
    expect(buildAllowedContextSet).toBeTypeOf("function");
    expect(evaluateContextScopeAccess).toBeTypeOf("function");
    expect(QaContextProfileKindSchema).toBeDefined();
    expect(QaContextCandidateClassSchema).toBeDefined();
    expect(BoundedRetestTargetSchema).toBeDefined();
    expect(QaContextProfileCandidateSchema).toBeDefined();
    expect(QaContextProfileDecisionReasonSchema).toBeDefined();
    expect(evaluateQaContextProfileCandidate).toBeTypeOf("function");
    expect(narrowContextCandidatesForQa).toBeTypeOf("function");
    expect(SubtaskDependencySchema).toBeDefined();
    expect(SubtaskMaturitySchema).toBeDefined();
    expect(DependencyRequiredGateSchema).toBeDefined();
    expect(NativeSubagentOwnershipSchema).toBeDefined();
    expect(BudgetPolicySchema).toBeDefined();
    expect(ExecutionProviderDescriptorSchema).toBeDefined();
    expect(ProviderThreadReferenceSchema).toBeDefined();
    expect(ProviderRunReferenceSchema).toBeDefined();
    expect(NormalizedUsageSchema).toBeDefined();
    expect(RepositoryCommitShaSchema).toBeDefined();
    expect(SubtaskImplementationCheckpointIdSchema).toBeDefined();
    expect(SubtaskImplementationCheckpointSchema).toBeDefined();
    expect(validateSubtaskDependencies).toBeTypeOf("function");
    expect(evaluateSubtaskDependencyReadiness).toBeTypeOf("function");
    expect(validateSubtaskMaturityTransition).toBeTypeOf("function");
    expect(validateSubtaskTransition).toBeTypeOf("function");
    expect(validateBudgetPolicy).toBeTypeOf("function");
  });
});
