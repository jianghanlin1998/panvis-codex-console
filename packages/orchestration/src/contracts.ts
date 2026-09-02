import type {
  BigTaskId,
  ProjectId,
  SubtaskDependency,
  SubtaskId,
  SubtaskMaturity,
} from "@codex-task-console/domain";

export const WORKFLOW_PROFILES = [
  "LOW",
  "STANDARD",
  "HIGH_RISK_FOUNDATION",
] as const;

export type WorkflowProfile = (typeof WORKFLOW_PROFILES)[number];

export const WORKFLOW_STAGES = [
  "PLAN",
  "REVIEW",
  "MATERIALIZE",
  "EXECUTE",
  "VERIFY",
  "HARDEN",
  "FRESH_QA",
  "REPAIR",
  "FOCUSED_RE_QA",
  "COMPLETE",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const HUMAN_REQUIRED_REASONS = [
  "PLAN_REVIEW_EXHAUSTED",
  "REVIEW_ESCALATED",
  "REPLAN_REQUIRED",
  "REPAIR_REQA_EXHAUSTED",
  "DEPENDENCY_BLOCKED",
  "BUDGET_BLOCKED",
  "CONCURRENCY_BLOCKED",
  "AUTHORITY_BLOCKED",
] as const;

export type HumanRequiredReason = (typeof HUMAN_REQUIRED_REASONS)[number];

export interface ProposedSubtask {
  readonly id: SubtaskId;
  readonly bigTaskId: BigTaskId;
  readonly profile: WorkflowProfile;
  readonly taskContractRef: string;
  readonly writeEnabled: boolean;
}

export interface PlanCandidate {
  readonly kind: "PLAN_CANDIDATE";
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly revision: number;
  readonly subtasks: readonly ProposedSubtask[];
  readonly dependencies: readonly SubtaskDependency[];
}

export type ReviewDecision =
  | {
      readonly outcome: "APPROVE";
      readonly planRevision: number;
    }
  | {
      readonly outcome: "REJECT";
      readonly planRevision: number;
      readonly revisionRequirements: readonly string[];
    }
  | {
      readonly outcome: "ESCALATE";
      readonly planRevision: number;
    };

interface PlanReviewStateBase {
  readonly candidate: PlanCandidate;
  readonly initialPlanRevision: number;
  readonly automaticRevisionsUsed: 0 | 1 | 2;
}

export type PlanReviewState =
  | (PlanReviewStateBase & {
      readonly phase: "AWAITING_REVIEW";
    })
  | (PlanReviewStateBase & {
      readonly phase: "AWAITING_REVISION";
      readonly revisionRequirements: readonly string[];
    })
  | (PlanReviewStateBase & {
      readonly phase: "APPROVED";
    })
  | (PlanReviewStateBase & {
      readonly phase: "HUMAN_REQUIRED";
      readonly humanReason: Extract<
        HumanRequiredReason,
        "PLAN_REVIEW_EXHAUSTED" | "REVIEW_ESCALATED"
      >;
    });

export type PlanReviewInvalidReason =
  | "INVALID_PLAN_CANDIDATE"
  | "INVALID_REVIEW_STATE"
  | "INVALID_REVIEW_DECISION"
  | "REVIEW_NOT_PENDING"
  | "REVISION_NOT_EXPECTED"
  | "STALE_REVIEW_DECISION"
  | "INVALID_PLAN_REVISION"
  | "BIG_TASK_MISMATCH";

export type PlanReviewOperationResult =
  | {
      readonly kind: "REVIEW_STATE";
      readonly state: PlanReviewState;
    }
  | {
      readonly kind: "INVALID_OPERATION";
      readonly reason: PlanReviewInvalidReason;
    };

export const GRAPH_VALIDATION_ERROR_CODES = [
  "INVALID_PLAN_CANDIDATE",
  "DUPLICATE_SUBTASK_ID",
  "BIG_TASK_OWNERSHIP_MISMATCH",
  "INVALID_DEPENDENCY",
  "SELF_DEPENDENCY",
  "DUPLICATE_DEPENDENCY",
  "MISSING_UPSTREAM_SUBTASK",
  "MISSING_DOWNSTREAM_SUBTASK",
  "CROSS_BIG_TASK_DEPENDENCY",
  "DEPENDENCY_CYCLE",
] as const;

export type GraphValidationErrorCode =
  (typeof GRAPH_VALIDATION_ERROR_CODES)[number];

export interface GraphValidationError {
  readonly code: GraphValidationErrorCode;
  readonly subtaskIds: readonly SubtaskId[];
}

export type GraphValidationResult =
  | {
      readonly valid: true;
      readonly candidate: PlanCandidate;
      readonly orderedSubtaskIds: readonly SubtaskId[];
      readonly dependencies: readonly SubtaskDependency[];
    }
  | {
      readonly valid: false;
      readonly errors: readonly GraphValidationError[];
    };

export interface MaterializedGraph {
  readonly kind: "MATERIALIZED_GRAPH";
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly planRevision: number;
  readonly subtasks: readonly ProposedSubtask[];
  readonly dependencies: readonly SubtaskDependency[];
}

export type MaterializationResult =
  | {
      readonly kind: "MATERIALIZED";
      readonly graph: MaterializedGraph;
    }
  | {
      readonly kind: "GRAPH_INVALID";
      readonly validation: Extract<GraphValidationResult, { readonly valid: false }>;
    }
  | {
      readonly kind: "HUMAN_REQUIRED";
      readonly reason: "AUTHORITY_BLOCKED";
    };

export const MATERIALIZED_GRAPH_CHANGE_KINDS = [
  "ADD_SUBTASK",
  "REMOVE_SUBTASK",
  "SPLIT_SUBTASK",
  "MERGE_SUBTASKS",
  "REPLACE_SUBTASK",
  "CHANGE_DEPENDENCIES",
] as const;

export type MaterializedGraphChangeKind =
  (typeof MATERIALIZED_GRAPH_CHANGE_KINDS)[number];

export type MaterializedGraphChangeResult =
  | {
      readonly kind: "HUMAN_REQUIRED";
      readonly reason: "REPLAN_REQUIRED";
      readonly graph: MaterializedGraph;
    }
  | {
      readonly kind: "INVALID_OPERATION";
      readonly reason: "INVALID_MATERIALIZED_GRAPH" | "INVALID_CHANGE_KIND";
    };

export const STAGE_EVIDENCE_CODES = [
  "PLAN_CANDIDATE_PRESENT",
  "PLAN_REVIEW_SATISFIED",
  "GRAPH_MATERIALIZED",
  "DEPENDENCIES_READY",
  "REPOSITORY_PREFLIGHT_PASSED",
  "CONTEXT_PREFLIGHT_PASSED",
  "BUDGET_AVAILABLE",
  "CONCURRENCY_AVAILABLE",
  "WORKTREE_OWNERSHIP_AVAILABLE",
  "HUMAN_APPROVAL_SATISFIED",
  "EXECUTION_EVIDENCE_PASSED",
  "VERIFICATION_EVIDENCE_PASSED",
  "HARDENING_EVIDENCE_PASSED",
  "FRESH_QA_OUTCOME_RECORDED",
  "REPAIR_EVIDENCE_PASSED",
  "FOCUSED_RE_QA_OUTCOME_RECORDED",
] as const;

export type StageEvidenceCode = (typeof STAGE_EVIDENCE_CODES)[number];

export type QaOutcome = "NOT_RUN" | "PASS" | "BLOCKING_FAIL";

export interface StageEvidenceFacts {
  readonly planCandidatePresent?: boolean;
  readonly planReviewSatisfied?: boolean;
  readonly graphMaterialized?: boolean;
  readonly dependenciesReady?: boolean;
  readonly repositoryPreflightPassed?: boolean;
  readonly contextPreflightPassed?: boolean;
  readonly budgetAvailable?: boolean;
  readonly concurrencyAvailable?: boolean;
  readonly worktreeOwnershipAvailable?: boolean;
  readonly humanApprovalSatisfied?: boolean;
  readonly executionEvidencePassed?: boolean;
  readonly verificationEvidencePassed?: boolean;
  readonly hardeningEvidencePassed?: boolean;
  readonly freshQaOutcome?: QaOutcome;
  readonly repairEvidencePassed?: boolean;
  readonly focusedReQaOutcome?: QaOutcome;
}

export interface StageTransitionInput {
  readonly profile: WorkflowProfile;
  readonly currentStage: WorkflowStage;
  readonly requestedNextStage: WorkflowStage;
  readonly evidence: Readonly<StageEvidenceFacts>;
  readonly repairCyclesUsed: 0 | 1;
}

export type StageBlockReason =
  | "INVALID_INPUT"
  | "INVALID_STAGE_TRANSITION"
  | "EVIDENCE_BLOCKED"
  | "DEPENDENCY_BLOCKED"
  | "BUDGET_BLOCKED"
  | "CONCURRENCY_BLOCKED"
  | "AUTHORITY_BLOCKED";

export type StageTransitionResult =
  | {
      readonly kind: "ELIGIBLE";
      readonly currentStage: WorkflowStage;
      readonly nextStage: WorkflowStage;
      readonly requiredEvidence: readonly StageEvidenceCode[];
      readonly missingEvidence: readonly StageEvidenceCode[];
      readonly repairCyclesUsed: 0 | 1;
    }
  | {
      readonly kind: "BLOCKED";
      readonly reason: StageBlockReason;
      readonly currentStage: WorkflowStage | null;
      readonly nextStage: WorkflowStage | null;
      readonly requiredEvidence: readonly StageEvidenceCode[];
      readonly missingEvidence: readonly StageEvidenceCode[];
      readonly repairCyclesUsed: 0 | 1 | null;
    }
  | {
      readonly kind: "HUMAN_REQUIRED";
      readonly reason: "REPAIR_REQA_EXHAUSTED" | "AUTHORITY_BLOCKED";
      readonly currentStage: WorkflowStage;
      readonly nextStage: null;
      readonly requiredEvidence: readonly StageEvidenceCode[];
      readonly missingEvidence: readonly StageEvidenceCode[];
      readonly repairCyclesUsed: 0 | 1;
    };

export interface DispatchSubtaskState {
  readonly subtaskId: SubtaskId;
  readonly stage: WorkflowStage;
  readonly maturity: SubtaskMaturity;
}

export interface DispatchExecutionFacts {
  readonly subtaskId: SubtaskId;
  readonly repositoryPreflightPassed: boolean;
  readonly contextPreflightPassed: boolean;
  readonly budgetAvailable: boolean;
  readonly worktreeOwnershipAvailable: boolean;
  readonly humanApprovalSatisfied: boolean;
}

export interface SerialDispatchInput {
  readonly graph: MaterializedGraph;
  readonly subtaskStates: readonly DispatchSubtaskState[];
  readonly executionFacts: readonly DispatchExecutionFacts[];
  readonly activeProjectWriteSubtaskIds: readonly SubtaskId[];
}

export type DispatchBlockReason =
  | "INVALID_INPUT"
  | "NO_ELIGIBLE_SUBTASK"
  | "DEPENDENCY_BLOCKED"
  | "PREFLIGHT_BLOCKED"
  | "BUDGET_BLOCKED"
  | "CONCURRENCY_BLOCKED"
  | "AUTHORITY_BLOCKED";

export type SerialDispatchResult =
  | {
      readonly kind: "DISPATCH_SELECTED";
      readonly selectedSubtaskId: SubtaskId;
      readonly eligibleSubtaskIds: readonly SubtaskId[];
      readonly eligibleButNotSelectedSubtaskIds: readonly SubtaskId[];
    }
  | {
      readonly kind: "BLOCKED";
      readonly reason: DispatchBlockReason;
      readonly eligibleSubtaskIds: readonly SubtaskId[];
    }
  | {
      readonly kind: "HUMAN_REQUIRED";
      readonly reason: "AUTHORITY_BLOCKED";
      readonly eligibleSubtaskIds: readonly SubtaskId[];
    };

export type BigTaskCompletionResult =
  | {
      readonly kind: "BIG_TASK_COMPLETION_ELIGIBLE";
      readonly bigTaskId: BigTaskId;
    }
  | {
      readonly kind: "BLOCKED";
      readonly reason: "INVALID_INPUT" | "REQUIRED_WORK_INCOMPLETE";
      readonly incompleteSubtaskIds: readonly SubtaskId[];
    };
