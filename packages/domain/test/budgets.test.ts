import { describe, expect, it } from "vitest";

import {
  BudgetPolicySchema,
  DEFAULT_V1_BUDGET_POLICY,
  validateBudgetPolicy,
} from "../src/index.js";

const validationCodes = (policy: unknown): readonly string[] => {
  const result = validateBudgetPolicy(policy);
  return result.valid ? [] : result.errors.map(({ code }) => code);
};

describe("V1 budget policy", () => {
  it("exactly matches every approved default", () => {
    expect(DEFAULT_V1_BUDGET_POLICY).toEqual({
      compiledContext: { normalTargetTokens: 10_000, absoluteCapTokens: 16_000 },
      rawHistory: {
        singleRetrievalTokens: 4_000,
        automaticPerTurnTokens: 8_000,
        automaticPerExecutionTokens: 16_000,
      },
      promotedContext: { targetTokens: 1_000, hardCapTokens: 1_500 },
      thread: { warningTokens: 32_000, rolloverTargetTokens: 40_000 },
      subtask: {
        warningTokens: 80_000,
        hardPauseTokens: 120_000,
        humanApprovedExtensionTokens: 40_000,
        maximumHumanApprovedExtensions: 1,
        absoluteContinuationCeilingTokens: 160_000,
      },
      concurrency: {
        maximumActivePrimaryTurnsPerSubtask: 1,
        maximumActiveCodingSubtasksPerProject: 2,
        maximumConcurrentNativeSubagents: 3,
      },
      retry: {
        automaticTransportRetriesPerFailedRequest: 1,
        automaticSemanticRetryLoops: 0,
      },
    });
    expect(BudgetPolicySchema.safeParse(DEFAULT_V1_BUDGET_POLICY).success).toBe(true);
    expect(Object.isFrozen(DEFAULT_V1_BUDGET_POLICY.subtask)).toBe(true);
  });

  it("rejects a compiled target above its cap", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      compiledContext: { ...DEFAULT_V1_BUDGET_POLICY.compiledContext, normalTargetTokens: 16_001 },
    };
    expect(validationCodes(policy)).toContain("COMPILED_CONTEXT_TARGET_EXCEEDS_CAP");
  });

  it("rejects raw-history limits in the wrong order", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      rawHistory: { ...DEFAULT_V1_BUDGET_POLICY.rawHistory, singleRetrievalTokens: 8_001 },
    };
    expect(validationCodes(policy)).toContain("HISTORY_LIMITS_OUT_OF_ORDER");
  });

  it("rejects a Promoted Context target above its cap", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      promotedContext: { ...DEFAULT_V1_BUDGET_POLICY.promotedContext, targetTokens: 1_501 },
    };
    expect(validationCodes(policy)).toContain("PROMOTED_CONTEXT_TARGET_EXCEEDS_CAP");
  });

  it("rejects a thread warning at or above rollover", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      thread: { ...DEFAULT_V1_BUDGET_POLICY.thread, warningTokens: 40_000 },
    };
    expect(validationCodes(policy)).toContain("THREAD_WARNING_NOT_BELOW_ROLLOVER");
  });

  it("rejects a Subtask warning at or above hard pause", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      subtask: { ...DEFAULT_V1_BUDGET_POLICY.subtask, warningTokens: 120_000 },
    };
    expect(validationCodes(policy)).toContain("SUBTASK_WARNING_NOT_BELOW_HARD_PAUSE");
  });

  it("rejects extension math inconsistent with the approved ceiling", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      subtask: {
        ...DEFAULT_V1_BUDGET_POLICY.subtask,
        humanApprovedExtensionTokens: 39_999,
      },
    };
    expect(validationCodes(policy)).toContain("SUBTASK_EXTENSION_CEILING_MISMATCH");
  });

  it("rejects native-subagent concurrency above three", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      concurrency: {
        ...DEFAULT_V1_BUDGET_POLICY.concurrency,
        maximumConcurrentNativeSubagents: 4,
      },
    };
    expect(validationCodes(policy)).toContain("NATIVE_SUBAGENT_CONCURRENCY_EXCEEDED");
  });

  it("rejects semantic retry loops above zero", () => {
    const policy = {
      ...DEFAULT_V1_BUDGET_POLICY,
      retry: { ...DEFAULT_V1_BUDGET_POLICY.retry, automaticSemanticRetryLoops: 1 },
    };
    expect(validationCodes(policy)).toContain("SEMANTIC_RETRY_LOOPS_NOT_ZERO");
    expect(BudgetPolicySchema.safeParse(policy).success).toBe(false);
  });
});
