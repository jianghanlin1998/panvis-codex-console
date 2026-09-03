import type {
  BigTaskId,
  ProjectId,
  SubtaskId,
  SubtaskImplementationCheckpointId,
  SubtaskMaturity,
  SubtaskStatus,
} from "@codex-task-console/domain";
import type {
  MaterializedGraphChangeKind,
  StageTransitionResult,
  WorkflowInitializationStage,
  WorkflowProfile,
  WorkflowStage,
} from "@codex-task-console/orchestration";

export const DURABLE_WORKFLOW_EVIDENCE_KINDS = Object.freeze([
  "REPOSITORY_PREFLIGHT_PASSED",
  "CONTEXT_PREFLIGHT_PASSED",
  "BUDGET_AVAILABLE",
  "CONCURRENCY_AVAILABLE",
  "WORKTREE_OWNERSHIP_AVAILABLE",
  "HUMAN_APPROVAL_SATISFIED",
  "VERIFICATION_EVIDENCE_PASSED",
  "HARDENING_EVIDENCE_PASSED",
  "FRESH_QA_OUTCOME_RECORDED",
  "REPAIR_EVIDENCE_PASSED",
  "FOCUSED_RE_QA_OUTCOME_RECORDED",
  "NO_UNRESOLVED_BLOCKING_FINDING",
  "HANDOFF_PRESENT",
  "PROMOTED_CONTEXT_DISPOSITION_RECORDED",
] as const);

export type DurableWorkflowEvidenceKind =
  (typeof DURABLE_WORKFLOW_EVIDENCE_KINDS)[number];

export const DURABLE_WORKFLOW_EVIDENCE_PRODUCERS = Object.freeze([
  "OPERATIONAL_GATE",
  "WORKFLOW_ROLE",
  "HUMAN_AUTHORITY",
  "DELIVERY_CONTROL",
] as const);

export type DurableWorkflowEvidenceProducer =
  (typeof DURABLE_WORKFLOW_EVIDENCE_PRODUCERS)[number];

export type DurableWorkflowEvidenceOutcome = "PASS" | "BLOCKING_FAIL";

export const DURABLE_WORKFLOW_EVIDENCE_AUTHORITY_SOURCE_TYPES = Object.freeze([
  "REPOSITORY_PREFLIGHT",
  "CONTEXT_PREFLIGHT",
  "BUDGET_GATE",
  "CONCURRENCY_GATE",
  "WORKTREE_OWNERSHIP",
  "HUMAN_APPROVAL",
  "VERIFICATION_ROLE",
  "HARDENING_ROLE",
  "FRESH_INDEPENDENT_QA",
  "REPAIR_ROLE",
  "FOCUSED_RE_QA",
  "BLOCKING_FINDING_CONTROL",
  "HANDOFF_CONTROL",
  "PROMOTED_CONTEXT_DISPOSITION",
] as const);

export type DurableWorkflowEvidenceAuthoritySourceType =
  (typeof DURABLE_WORKFLOW_EVIDENCE_AUTHORITY_SOURCE_TYPES)[number];

export interface DurableWorkflowEvidence {
  readonly evidenceId: string;
  readonly authorityId: string;
  readonly authoritySourceType: DurableWorkflowEvidenceAuthoritySourceType;
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly expectedSequence: number;
  readonly observedStage: WorkflowStage;
  readonly observedRepairCyclesUsed: 0 | 1;
  readonly kind: DurableWorkflowEvidenceKind;
  readonly outcome: DurableWorkflowEvidenceOutcome;
  readonly producer: DurableWorkflowEvidenceProducer;
  readonly sourceReference: string;
  readonly occurredAt: string;
  readonly acceptedAt: string;
}

export type DurableWorkflowEvidenceReference =
  | Readonly<{
      sourceType: "WORKFLOW_EVIDENCE";
      sourceReference: string;
    }>
  | Readonly<{
      sourceType: "IMPLEMENTATION_CHECKPOINT";
      sourceReference: SubtaskImplementationCheckpointId;
    }>;

export type DurableWorkflowTransitionEvidenceReference =
  | DurableWorkflowEvidenceReference
  | Readonly<{
      sourceType: "CANONICAL_MATERIALIZATION";
      sourceReference: string;
    }>
  | Readonly<{
      sourceType: "PERSISTED_DEPENDENCY_READINESS";
      sourceReference: string;
    }>;

export interface AdvanceDurableWorkflowInput {
  readonly operationId: string;
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly requestedNextStage: WorkflowStage;
  readonly evidenceReferences: readonly DurableWorkflowEvidenceReference[];
}

export interface DurableWorkflowTransition {
  readonly operationId: string;
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly sequence: number;
  readonly priorStage: WorkflowStage;
  readonly resultingStage: WorkflowStage;
  readonly priorRepairCyclesUsed: 0 | 1;
  readonly resultingRepairCyclesUsed: 0 | 1;
  readonly evidenceReferences: readonly DurableWorkflowTransitionEvidenceReference[];
  readonly occurredAt: string;
}

export interface DurableWorkflowHumanRequirement {
  readonly operationId: string;
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly scope: "BIG_TASK" | "SUBTASK";
  readonly subtaskId: SubtaskId | null;
  readonly sequence: number | null;
  readonly currentStage: WorkflowStage | null;
  readonly requestedNextStage: WorkflowStage | null;
  readonly repairCyclesUsed: 0 | 1 | null;
  readonly reason:
    | "REPLAN_REQUIRED"
    | "REPAIR_REQA_EXHAUSTED"
    | "AUTHORITY_BLOCKED";
  readonly evidenceReferences: readonly DurableWorkflowTransitionEvidenceReference[];
  readonly sourceReference: string;
  readonly createdAt: string;
}

export interface DurableWorkflowControlView {
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly profile: WorkflowProfile;
  readonly writeEnabled: boolean;
  readonly initialStage: WorkflowInitializationStage;
  readonly initializedAt: string;
  readonly currentStage: WorkflowStage;
  readonly initialRepairCyclesUsed: 0;
  readonly repairCyclesUsed: 0 | 1;
  readonly boardStatus: SubtaskStatus;
  readonly deliveryMaturity: SubtaskMaturity;
  readonly transitionCount: number;
  readonly transitions: readonly DurableWorkflowTransition[];
  readonly unresolvedHumanRequired: DurableWorkflowHumanRequirement | null;
}

export type AdvanceDurableWorkflowResult =
  | Readonly<{
      kind: "TRANSITION_RECORDED";
      transition: DurableWorkflowTransition;
      view: DurableWorkflowControlView;
    }>
  | Readonly<{
      kind: "BLOCKED";
      decision: Extract<StageTransitionResult, { readonly kind: "BLOCKED" }>;
      view: DurableWorkflowControlView;
    }>
  | Readonly<{
      kind: "HUMAN_REQUIRED";
      requirement: DurableWorkflowHumanRequirement;
      view: DurableWorkflowControlView;
    }>;

export interface RequestDurableMaterializedGraphChangeInput {
  readonly operationId: string;
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly candidateBinding: string;
  readonly changeKind: MaterializedGraphChangeKind;
}

export interface RequestDurableMaterializedGraphChangeResult {
  readonly kind: "HUMAN_REQUIRED";
  readonly requirement: DurableWorkflowHumanRequirement;
}
