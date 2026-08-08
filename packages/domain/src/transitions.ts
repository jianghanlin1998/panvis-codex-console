import type { SubtaskStatus } from "./tasks.js";

export const TRANSITION_PREREQUISITES = [
  "DEPENDENCIES_READY",
  "REPOSITORY_PREFLIGHT_PASSED",
  "CONTEXT_PREFLIGHT_PASSED",
  "CONCURRENCY_AVAILABLE",
  "IMPLEMENTATION_CHECKPOINT_PRESENT",
  "REQUIRED_TESTS_PASSED",
  "NO_UNRESOLVED_BLOCKING_ISSUE",
  "HANDOFF_PRESENT",
  "PROMOTED_CONTEXT_DISPOSITION_RECORDED",
] as const;

export type TransitionPrerequisite = (typeof TRANSITION_PREREQUISITES)[number];
export type TransitionErrorCode = "UNSUPPORTED_TRANSITION" | `MISSING_${TransitionPrerequisite}`;

export interface SubtaskTransitionContext {
  readonly dependenciesReady?: boolean;
  readonly repositoryPreflightPassed?: boolean;
  readonly contextPreflightPassed?: boolean;
  readonly concurrencyAvailable?: boolean;
  readonly implementationCheckpointPresent?: boolean;
  readonly requiredTestsPassed?: boolean;
  readonly noUnresolvedBlockingIssue?: boolean;
  readonly handoffPresent?: boolean;
  readonly promotedContextDispositionRecorded?: boolean;
}

export interface TransitionReason {
  readonly code: TransitionErrorCode;
  readonly message: string;
}

export interface SubtaskTransitionResult {
  readonly allowed: boolean;
  readonly reasons: readonly TransitionReason[];
  readonly missingPrerequisites: readonly TransitionPrerequisite[];
  readonly errorCodes: readonly TransitionErrorCode[];
}

const ALLOWED_TRANSITIONS = {
  TODO: new Set<SubtaskStatus>(["IN_PROGRESS", "DROPPED"]),
  IN_PROGRESS: new Set<SubtaskStatus>(["QA_DEBUG", "DROPPED"]),
  QA_DEBUG: new Set<SubtaskStatus>(["IN_PROGRESS", "DONE", "DROPPED"]),
  DONE: new Set<SubtaskStatus>(["ARCHIVED"]),
  DROPPED: new Set<SubtaskStatus>(["ARCHIVED"]),
  ARCHIVED: new Set<SubtaskStatus>(),
} satisfies Record<SubtaskStatus, ReadonlySet<SubtaskStatus>>;

const prerequisiteChecks: Readonly<
  Partial<
    Record<
      `${SubtaskStatus}->${SubtaskStatus}`,
      readonly [TransitionPrerequisite, keyof SubtaskTransitionContext][]
    >
  >
> = {
  "TODO->IN_PROGRESS": [
    ["DEPENDENCIES_READY", "dependenciesReady"],
    ["REPOSITORY_PREFLIGHT_PASSED", "repositoryPreflightPassed"],
    ["CONTEXT_PREFLIGHT_PASSED", "contextPreflightPassed"],
    ["CONCURRENCY_AVAILABLE", "concurrencyAvailable"],
  ],
  "IN_PROGRESS->QA_DEBUG": [
    ["IMPLEMENTATION_CHECKPOINT_PRESENT", "implementationCheckpointPresent"],
  ],
  "QA_DEBUG->DONE": [
    ["REQUIRED_TESTS_PASSED", "requiredTestsPassed"],
    ["NO_UNRESOLVED_BLOCKING_ISSUE", "noUnresolvedBlockingIssue"],
    ["HANDOFF_PRESENT", "handoffPresent"],
    ["PROMOTED_CONTEXT_DISPOSITION_RECORDED", "promotedContextDispositionRecorded"],
  ],
};

export const validateSubtaskTransition = (
  from: SubtaskStatus,
  to: SubtaskStatus,
  context: Readonly<SubtaskTransitionContext> = {},
): SubtaskTransitionResult => {
  if (!ALLOWED_TRANSITIONS[from].has(to)) {
    const reason: TransitionReason = {
      code: "UNSUPPORTED_TRANSITION",
      message: `Transition ${from} -> ${to} is not supported.`,
    };
    return {
      allowed: false,
      reasons: [reason],
      missingPrerequisites: [],
      errorCodes: [reason.code],
    };
  }

  const transitionKey = `${from}->${to}` as const;
  const checks = prerequisiteChecks[transitionKey] ?? [];
  const missingPrerequisites = checks
    .filter(([, contextKey]) => context[contextKey] !== true)
    .map(([prerequisite]) => prerequisite);
  const reasons = missingPrerequisites.map((prerequisite) => ({
    code: `MISSING_${prerequisite}` as const,
    message: `Required transition prerequisite is missing: ${prerequisite}.`,
  }));

  return {
    allowed: reasons.length === 0,
    reasons,
    missingPrerequisites,
    errorCodes: reasons.map(({ code }) => code),
  };
};
