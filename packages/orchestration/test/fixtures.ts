import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  DependencyRequiredGate,
  SubtaskDependency,
  SubtaskMaturity,
} from "@codex-task-console/domain";
import type {
  DispatchExecutionFacts,
  DispatchExecutionFactsSnapshot,
  DispatchSubtaskState,
  DispatchSubtaskStateSnapshot,
  MaterializedGraph,
  PlanCandidate,
  PlanReviewState,
  ProjectWriteCapacitySnapshot,
  ProposedSubtask,
  ReviewDecision,
  StageEvidenceFacts,
  StageEvidenceSnapshot,
  WorkflowProfile,
  WorkflowStage,
} from "../src/index.js";
import {
  applyReviewerDecision,
  beginPlanReview,
  materializeApprovedPlan,
} from "../src/index.js";

export const proposedSubtask = (
  id: string,
  profile: WorkflowProfile = "STANDARD",
  bigTaskId = "bt_orchestration",
): ProposedSubtask => ({
  id: SubtaskIdSchema.parse(id),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
  profile,
  taskContractRef: `contracts/${id}.md`,
  writeEnabled: true,
});

export const blockingDependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  requiredGate: Exclude<DependencyRequiredGate, "NONE"> = "HARDENED",
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "BLOCKING",
    requiredGate,
    reason: `${upstreamSubtaskId} must satisfy ${requiredGate} before ${downstreamSubtaskId}.`,
  });

export const planCandidate = ({
  revision = 1,
  subtasks = [proposedSubtask("st_a")],
  dependencies = [],
  bigTaskId = "bt_orchestration",
  projectId = "prj_orchestration",
}: {
  readonly revision?: number;
  readonly subtasks?: readonly ProposedSubtask[];
  readonly dependencies?: readonly SubtaskDependency[];
  readonly bigTaskId?: string;
  readonly projectId?: string;
} = {}): PlanCandidate => ({
  kind: "PLAN_CANDIDATE",
  projectId: ProjectIdSchema.parse(projectId),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
  revision,
  subtasks,
  dependencies,
});

export const reviewStateFor = (candidate: PlanCandidate): PlanReviewState => {
  const result = beginPlanReview(candidate);
  if (result.kind !== "REVIEW_STATE") {
    throw new Error("Expected a valid review state fixture.");
  }
  return result.state;
};

export const approvalFor = (
  state: PlanReviewState,
): Extract<ReviewDecision, { readonly outcome: "APPROVE" }> => ({
  outcome: "APPROVE",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

export const rejectionFor = (
  state: PlanReviewState,
  revisionRequirements: readonly string[],
): Extract<ReviewDecision, { readonly outcome: "REJECT" }> => ({
  outcome: "REJECT",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
  revisionRequirements,
});

export const escalationFor = (
  state: PlanReviewState,
): Extract<ReviewDecision, { readonly outcome: "ESCALATE" }> => ({
  outcome: "ESCALATE",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

export const materializedGraphFor = (candidate: PlanCandidate): MaterializedGraph => {
  const started = reviewStateFor(candidate);
  const approved = applyReviewerDecision(started, approvalFor(started));
  if (approved.kind !== "REVIEW_STATE" || approved.state.phase !== "APPROVED") {
    throw new Error("Expected an approved review state fixture.");
  }
  const materialized = materializeApprovedPlan(approved.state);
  if (materialized.kind !== "MATERIALIZED") {
    throw new Error("Expected a materialized graph fixture.");
  }
  return materialized.graph;
};

export const dispatchState = (
  subtaskId: string,
  maturity: SubtaskMaturity = "NOT_STARTED",
  stage: WorkflowStage = "EXECUTE",
): DispatchSubtaskState => ({
  subtaskId: SubtaskIdSchema.parse(subtaskId),
  stage,
  maturity,
});

export const executionFacts = (subtaskId: string): DispatchExecutionFacts => ({
  subtaskId: SubtaskIdSchema.parse(subtaskId),
  repositoryPreflightPassed: true,
  contextPreflightPassed: true,
  budgetAvailable: true,
  worktreeOwnershipAvailable: true,
  humanApprovalSatisfied: true,
});

export const stateSnapshotFor = (
  graph: MaterializedGraph,
  subtaskStates: readonly DispatchSubtaskState[],
): DispatchSubtaskStateSnapshot => ({
  candidateBinding: graph.candidateBinding,
  subtaskStates,
});

export const executionFactsSnapshotFor = (
  graph: MaterializedGraph,
  facts: readonly DispatchExecutionFacts[],
): DispatchExecutionFactsSnapshot => ({
  candidateBinding: graph.candidateBinding,
  executionFacts: facts,
});

export const projectWriteCapacityFor = (
  graph: MaterializedGraph,
  activeWriteSubtaskIds: ProjectWriteCapacitySnapshot["activeWriteSubtaskIds"] = [],
): ProjectWriteCapacitySnapshot => ({
  projectId: graph.projectId,
  activeWriteSubtaskIds,
});

export const stageEvidenceFor = (
  graph: MaterializedGraph,
  facts: Readonly<StageEvidenceFacts>,
  subtaskId = graph.subtasks[0]!.id,
): StageEvidenceSnapshot => ({
  candidateBinding: graph.candidateBinding,
  subtaskId,
  facts,
});
