import { z } from "zod";

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

const BudgetPolicyShapeSchema = z
  .object({
    compiledContext: z
      .object({
        normalTargetBytes: positiveInteger,
        absoluteCapBytes: positiveInteger,
      })
      .strict(),
    rawHistory: z
      .object({
        singleRetrievalTokens: positiveInteger,
        automaticPerTurnTokens: positiveInteger,
        automaticPerExecutionTokens: positiveInteger,
      })
      .strict(),
    promotedContext: z
      .object({
        targetTokens: positiveInteger,
        hardCapTokens: positiveInteger,
      })
      .strict(),
    thread: z
      .object({
        warningTokens: positiveInteger,
        rolloverTargetTokens: positiveInteger,
      })
      .strict(),
    subtask: z
      .object({
        warningTokens: positiveInteger,
        hardPauseTokens: positiveInteger,
        humanApprovedExtensionTokens: positiveInteger,
        maximumHumanApprovedExtensions: z.literal(1),
        absoluteContinuationCeilingTokens: positiveInteger,
      })
      .strict(),
    concurrency: z
      .object({
        maximumActivePrimaryTurnsPerSubtask: positiveInteger,
        maximumActiveCodingSubtasksPerProject: positiveInteger,
        maximumConcurrentNativeSubagents: nonNegativeInteger,
      })
      .strict(),
    retry: z
      .object({
        automaticTransportRetriesPerFailedRequest: nonNegativeInteger,
        automaticSemanticRetryLoops: nonNegativeInteger,
      })
      .strict(),
  })
  .strict();

export const BudgetPolicyValidationErrorCodeSchema = z.enum([
  "INVALID_POLICY_SHAPE",
  "COMPILED_CONTEXT_TARGET_EXCEEDS_CAP",
  "HISTORY_LIMITS_OUT_OF_ORDER",
  "PROMOTED_CONTEXT_TARGET_EXCEEDS_CAP",
  "THREAD_WARNING_NOT_BELOW_ROLLOVER",
  "SUBTASK_WARNING_NOT_BELOW_HARD_PAUSE",
  "SUBTASK_EXTENSION_CEILING_MISMATCH",
  "NATIVE_SUBAGENT_CONCURRENCY_EXCEEDED",
  "ACTIVE_PRIMARY_TURN_LIMIT_EXCEEDED",
  "ACTIVE_CODING_SUBTASK_LIMIT_EXCEEDED",
  "TRANSPORT_RETRY_LIMIT_EXCEEDED",
  "SEMANTIC_RETRY_LOOPS_NOT_ZERO",
]);

export type BudgetPolicy = z.infer<typeof BudgetPolicyShapeSchema>;
export type BudgetPolicyValidationErrorCode = z.infer<
  typeof BudgetPolicyValidationErrorCodeSchema
>;

export interface BudgetPolicyValidationError {
  readonly code: BudgetPolicyValidationErrorCode;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type BudgetPolicyValidationResult =
  | { readonly valid: true; readonly policy: BudgetPolicy; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly BudgetPolicyValidationError[] };

export type CompiledContextByteBudgetDecision =
  | Readonly<{
      status: "WITHIN_TARGET" | "ABOVE_TARGET";
      allowed: true;
      utf8Bytes: number;
      normalTargetBytes: 40_000;
      absoluteCapBytes: 64_000;
    }>
  | Readonly<{
      status: "HARD_CAP_EXCEEDED";
      allowed: false;
      utf8Bytes: number;
      normalTargetBytes: 40_000;
      absoluteCapBytes: 64_000;
    }>;

const validateBudgetInvariants = (
  policy: BudgetPolicy,
): readonly BudgetPolicyValidationError[] => {
  const errors: BudgetPolicyValidationError[] = [];
  const addError = (
    code: BudgetPolicyValidationErrorCode,
    path: readonly (string | number)[],
    message: string,
  ): void => {
    errors.push({ code, path, message });
  };

  if (policy.compiledContext.normalTargetBytes > policy.compiledContext.absoluteCapBytes) {
    addError(
      "COMPILED_CONTEXT_TARGET_EXCEEDS_CAP",
      ["compiledContext", "normalTargetBytes"],
      "The compiled-context normal target cannot exceed its absolute cap.",
    );
  }

  if (
    policy.rawHistory.singleRetrievalTokens > policy.rawHistory.automaticPerTurnTokens ||
    policy.rawHistory.automaticPerTurnTokens > policy.rawHistory.automaticPerExecutionTokens
  ) {
    addError(
      "HISTORY_LIMITS_OUT_OF_ORDER",
      ["rawHistory"],
      "Raw-history limits must be ordered single retrieval, per turn, then per execution.",
    );
  }

  if (policy.promotedContext.targetTokens > policy.promotedContext.hardCapTokens) {
    addError(
      "PROMOTED_CONTEXT_TARGET_EXCEEDS_CAP",
      ["promotedContext", "targetTokens"],
      "The Promoted Context target cannot exceed its hard cap.",
    );
  }

  if (policy.thread.warningTokens >= policy.thread.rolloverTargetTokens) {
    addError(
      "THREAD_WARNING_NOT_BELOW_ROLLOVER",
      ["thread", "warningTokens"],
      "The thread warning must be below the rollover target.",
    );
  }

  if (policy.subtask.warningTokens >= policy.subtask.hardPauseTokens) {
    addError(
      "SUBTASK_WARNING_NOT_BELOW_HARD_PAUSE",
      ["subtask", "warningTokens"],
      "The Subtask warning must be below the hard pause.",
    );
  }

  if (
    policy.subtask.hardPauseTokens + policy.subtask.humanApprovedExtensionTokens !==
      policy.subtask.absoluteContinuationCeilingTokens ||
    policy.subtask.absoluteContinuationCeilingTokens !== 160_000
  ) {
    addError(
      "SUBTASK_EXTENSION_CEILING_MISMATCH",
      ["subtask", "absoluteContinuationCeilingTokens"],
      "One extension must produce the approved 160,000-token continuation ceiling.",
    );
  }

  if (policy.concurrency.maximumConcurrentNativeSubagents > 3) {
    addError(
      "NATIVE_SUBAGENT_CONCURRENCY_EXCEEDED",
      ["concurrency", "maximumConcurrentNativeSubagents"],
      "V1 allows at most three concurrent native subagents.",
    );
  }

  if (policy.concurrency.maximumActivePrimaryTurnsPerSubtask > 1) {
    addError(
      "ACTIVE_PRIMARY_TURN_LIMIT_EXCEEDED",
      ["concurrency", "maximumActivePrimaryTurnsPerSubtask"],
      "V1 allows at most one active primary turn per Subtask.",
    );
  }

  if (policy.concurrency.maximumActiveCodingSubtasksPerProject > 2) {
    addError(
      "ACTIVE_CODING_SUBTASK_LIMIT_EXCEEDED",
      ["concurrency", "maximumActiveCodingSubtasksPerProject"],
      "V1 allows at most two active coding Subtasks per Project.",
    );
  }

  if (policy.retry.automaticTransportRetriesPerFailedRequest > 1) {
    addError(
      "TRANSPORT_RETRY_LIMIT_EXCEEDED",
      ["retry", "automaticTransportRetriesPerFailedRequest"],
      "V1 allows at most one automatic transport retry per failed request.",
    );
  }

  if (policy.retry.automaticSemanticRetryLoops !== 0) {
    addError(
      "SEMANTIC_RETRY_LOOPS_NOT_ZERO",
      ["retry", "automaticSemanticRetryLoops"],
      "V1 does not allow automatic semantic retry loops.",
    );
  }

  return errors;
};

export const BudgetPolicySchema = BudgetPolicyShapeSchema.superRefine((policy, context) => {
  for (const error of validateBudgetInvariants(policy)) {
    context.addIssue({
      code: "custom",
      path: [...error.path],
      message: `${error.code}: ${error.message}`,
    });
  }
});

export const validateBudgetPolicy = (input: unknown): BudgetPolicyValidationResult => {
  const shapeResult = BudgetPolicyShapeSchema.safeParse(input);
  if (!shapeResult.success) {
    return {
      valid: false,
      errors: shapeResult.error.issues.map((issue) => ({
        code: "INVALID_POLICY_SHAPE" as const,
        path: issue.path.map((segment) =>
          typeof segment === "symbol" ? (segment.description ?? segment.toString()) : segment,
        ),
        message: issue.message,
      })),
    };
  }

  const errors = validateBudgetInvariants(shapeResult.data);
  return errors.length === 0
    ? { valid: true, policy: shapeResult.data, errors: [] }
    : { valid: false, errors };
};

export const DEFAULT_V1_BUDGET_POLICY = Object.freeze({
  compiledContext: Object.freeze({
    normalTargetBytes: 40_000,
    absoluteCapBytes: 64_000,
  }),
  rawHistory: Object.freeze({
    singleRetrievalTokens: 4_000,
    automaticPerTurnTokens: 8_000,
    automaticPerExecutionTokens: 16_000,
  }),
  promotedContext: Object.freeze({
    targetTokens: 1_000,
    hardCapTokens: 1_500,
  }),
  thread: Object.freeze({
    warningTokens: 32_000,
    rolloverTargetTokens: 40_000,
  }),
  subtask: Object.freeze({
    warningTokens: 80_000,
    hardPauseTokens: 120_000,
    humanApprovedExtensionTokens: 40_000,
    maximumHumanApprovedExtensions: 1,
    absoluteContinuationCeilingTokens: 160_000,
  }),
  concurrency: Object.freeze({
    maximumActivePrimaryTurnsPerSubtask: 1,
    maximumActiveCodingSubtasksPerProject: 2,
    maximumConcurrentNativeSubagents: 3,
  }),
  retry: Object.freeze({
    automaticTransportRetriesPerFailedRequest: 1,
    automaticSemanticRetryLoops: 0,
  }),
}) satisfies Readonly<BudgetPolicy>;

/**
 * Classifies supplied byte-count DATA under the fixed V1 compiled-context
 * policy. This does not measure trusted execution input or authorize execution.
 */
export const evaluateCompiledContextByteBudget = (
  utf8Bytes: number,
): CompiledContextByteBudgetDecision => {
  if (!Number.isSafeInteger(utf8Bytes) || utf8Bytes < 0) {
    throw new TypeError("The compiled-context UTF-8 byte measurement is invalid.");
  }

  const { normalTargetBytes, absoluteCapBytes } =
    DEFAULT_V1_BUDGET_POLICY.compiledContext;
  if (utf8Bytes <= normalTargetBytes) {
    return Object.freeze({
      status: "WITHIN_TARGET",
      allowed: true,
      utf8Bytes,
      normalTargetBytes,
      absoluteCapBytes,
    });
  }
  if (utf8Bytes <= absoluteCapBytes) {
    return Object.freeze({
      status: "ABOVE_TARGET",
      allowed: true,
      utf8Bytes,
      normalTargetBytes,
      absoluteCapBytes,
    });
  }
  return Object.freeze({
    status: "HARD_CAP_EXCEEDED",
    allowed: false,
    utf8Bytes,
    normalTargetBytes,
    absoluteCapBytes,
  });
};
