import {
  ProjectIdSchema,
  SubtaskIdSchema,
  SubtaskMaturitySchema,
  evaluateSubtaskDependencyReadiness,
} from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";

import { WORKFLOW_STAGES } from "./contracts.js";
import type {
  DispatchBlockReason,
  DispatchExecutionFacts,
  DispatchSubtaskState,
  SerialDispatchInput,
  SerialDispatchResult,
  WorkflowProfile,
  WorkflowStage,
} from "./contracts.js";
import { parseMaterializedGraph } from "./graph.js";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
};

const isCanonicalSubtaskId = (value: unknown): value is SubtaskId => {
  const parsed = SubtaskIdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
};

const isCanonicalProjectId = (value: unknown): boolean => {
  const parsed = ProjectIdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
};

const isWorkflowStage = (value: unknown): value is WorkflowStage =>
  typeof value === "string" && WORKFLOW_STAGES.some((stage) => stage === value);

const isStageAllowedForProfile = (
  profile: WorkflowProfile,
  stage: WorkflowStage,
): boolean => {
  switch (profile) {
    case "LOW":
      return stage === "EXECUTE" || stage === "VERIFY" || stage === "COMPLETE";
    case "STANDARD":
      return (
        stage === "PLAN" ||
        stage === "REVIEW" ||
        stage === "MATERIALIZE" ||
        stage === "EXECUTE" ||
        stage === "VERIFY" ||
        stage === "COMPLETE"
      );
    case "HIGH_RISK_FOUNDATION":
      return stage !== "VERIFY";
  }
};

const isMaturityCompatibleWithStage = (
  stage: WorkflowStage,
  maturity: DispatchSubtaskState["maturity"],
): boolean => {
  if (stage === "PLAN" || stage === "REVIEW" || stage === "MATERIALIZE") {
    return true;
  }
  return stage === "EXECUTE"
    ? maturity === "NOT_STARTED"
    : maturity !== "NOT_STARTED";
};

const parseSubtaskState = (input: unknown): DispatchSubtaskState | null => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["maturity", "stage", "subtaskId"]) ||
    !isCanonicalSubtaskId(input.subtaskId) ||
    !isWorkflowStage(input.stage)
  ) {
    return null;
  }
  const maturity = SubtaskMaturitySchema.safeParse(input.maturity);
  if (!maturity.success || maturity.data !== input.maturity) {
    return null;
  }
  return Object.freeze({
    subtaskId: input.subtaskId,
    stage: input.stage,
    maturity: maturity.data,
  });
};

const parseExecutionFacts = (input: unknown): DispatchExecutionFacts | null => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "budgetAvailable",
      "contextPreflightPassed",
      "humanApprovalSatisfied",
      "repositoryPreflightPassed",
      "subtaskId",
      "worktreeOwnershipAvailable",
    ]) ||
    !isCanonicalSubtaskId(input.subtaskId) ||
    typeof input.repositoryPreflightPassed !== "boolean" ||
    typeof input.contextPreflightPassed !== "boolean" ||
    typeof input.budgetAvailable !== "boolean" ||
    typeof input.worktreeOwnershipAvailable !== "boolean" ||
    typeof input.humanApprovalSatisfied !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    subtaskId: input.subtaskId,
    repositoryPreflightPassed: input.repositoryPreflightPassed,
    contextPreflightPassed: input.contextPreflightPassed,
    budgetAvailable: input.budgetAvailable,
    worktreeOwnershipAvailable: input.worktreeOwnershipAvailable,
    humanApprovalSatisfied: input.humanApprovalSatisfied,
  });
};

const blocked = (
  reason: DispatchBlockReason,
  eligibleSubtaskIds: readonly SubtaskId[] = [],
): SerialDispatchResult =>
  Object.freeze({
    kind: "BLOCKED",
    reason,
    eligibleSubtaskIds: Object.freeze([...eligibleSubtaskIds]),
  });

const humanRequired = (
  eligibleSubtaskIds: readonly SubtaskId[] = [],
): SerialDispatchResult =>
  Object.freeze({
    kind: "HUMAN_REQUIRED",
    reason: "AUTHORITY_BLOCKED",
    eligibleSubtaskIds: Object.freeze([...eligibleSubtaskIds]),
  });

const firstBlockReason = (
  blockers: readonly DispatchBlockReason[],
): DispatchBlockReason => {
  const priority: readonly DispatchBlockReason[] = [
    "DEPENDENCY_BLOCKED",
    "PREFLIGHT_BLOCKED",
    "BUDGET_BLOCKED",
    "AUTHORITY_BLOCKED",
  ];
  return priority.find((reason) => blockers.includes(reason)) ?? "NO_ELIGIBLE_SUBTASK";
};

export const selectSerialWriteDispatch = (
  inputValue: Readonly<SerialDispatchInput>,
): SerialDispatchResult => {
  if (
    !isRecord(inputValue) ||
    !hasExactKeys(inputValue, [
      "executionFactsSnapshot",
      "graph",
      "projectWriteCapacity",
      "subtaskStateSnapshot",
    ]) ||
    !isRecord(inputValue.subtaskStateSnapshot) ||
    !hasExactKeys(inputValue.subtaskStateSnapshot, [
      "candidateBinding",
      "subtaskStates",
    ]) ||
    !isRecord(inputValue.executionFactsSnapshot) ||
    !hasExactKeys(inputValue.executionFactsSnapshot, [
      "candidateBinding",
      "executionFacts",
    ]) ||
    !isRecord(inputValue.projectWriteCapacity) ||
    !hasExactKeys(inputValue.projectWriteCapacity, [
      "activeWriteSubtaskIds",
      "projectId",
    ]) ||
    !Array.isArray(inputValue.subtaskStateSnapshot.subtaskStates) ||
    !Array.isArray(inputValue.executionFactsSnapshot.executionFacts) ||
    !Array.isArray(inputValue.projectWriteCapacity.activeWriteSubtaskIds)
  ) {
    return blocked("INVALID_INPUT");
  }
  const graph = parseMaterializedGraph(inputValue.graph);
  if (graph === null) {
    return blocked("INVALID_INPUT");
  }
  if (
    inputValue.subtaskStateSnapshot.candidateBinding !== graph.candidateBinding ||
    inputValue.executionFactsSnapshot.candidateBinding !== graph.candidateBinding ||
    !isCanonicalProjectId(inputValue.projectWriteCapacity.projectId) ||
    inputValue.projectWriteCapacity.projectId !== graph.projectId
  ) {
    return blocked("INVALID_INPUT");
  }

  const stateById = new Map<SubtaskId, DispatchSubtaskState>();
  for (const stateInput of inputValue.subtaskStateSnapshot.subtaskStates) {
    const state = parseSubtaskState(stateInput);
    if (state === null || stateById.has(state.subtaskId)) {
      return blocked("INVALID_INPUT");
    }
    stateById.set(state.subtaskId, state);
  }

  const factsById = new Map<SubtaskId, DispatchExecutionFacts>();
  for (const factsInput of inputValue.executionFactsSnapshot.executionFacts) {
    const facts = parseExecutionFacts(factsInput);
    if (facts === null || factsById.has(facts.subtaskId)) {
      return blocked("INVALID_INPUT");
    }
    factsById.set(facts.subtaskId, facts);
  }

  const graphSubtaskIds = new Set(graph.subtasks.map(({ id }) => id));
  if (
    stateById.size !== graph.subtasks.length ||
    factsById.size !== graph.subtasks.length ||
    [...stateById.keys()].some((id) => !graphSubtaskIds.has(id)) ||
    [...factsById.keys()].some((id) => !graphSubtaskIds.has(id))
  ) {
    return blocked("INVALID_INPUT");
  }
  for (const subtask of graph.subtasks) {
    const state = stateById.get(subtask.id);
    if (
      state === undefined ||
      !isStageAllowedForProfile(subtask.profile, state.stage) ||
      !isMaturityCompatibleWithStage(state.stage, state.maturity)
    ) {
      return blocked("INVALID_INPUT");
    }
  }

  const activeWriteIds = new Set<SubtaskId>();
  for (const activeId of inputValue.projectWriteCapacity.activeWriteSubtaskIds) {
    if (!isCanonicalSubtaskId(activeId) || activeWriteIds.has(activeId)) {
      return blocked("INVALID_INPUT");
    }
    activeWriteIds.add(activeId);
  }
  if (activeWriteIds.size > 1) {
    return blocked("INVALID_INPUT");
  }

  const readinessSubtasks = graph.subtasks.map((subtask) => {
    const state = stateById.get(subtask.id);
    return {
      id: subtask.id,
      bigTaskId: subtask.bigTaskId,
      maturity: state?.maturity ?? "NOT_STARTED",
    };
  });

  const eligibleSubtaskIds: SubtaskId[] = [];
  const candidateBlockers: DispatchBlockReason[] = [];

  for (const subtask of graph.subtasks) {
    const state = stateById.get(subtask.id);
    const facts = factsById.get(subtask.id);
    if (state === undefined || facts === undefined) {
      return blocked("INVALID_INPUT");
    }
    if (
      !subtask.writeEnabled ||
      state.stage !== "EXECUTE" ||
      activeWriteIds.has(subtask.id)
    ) {
      continue;
    }

    const readiness = evaluateSubtaskDependencyReadiness(
      readinessSubtasks,
      graph.dependencies,
      subtask.id,
    );
    if (!readiness.valid) {
      return blocked("INVALID_INPUT");
    }

    const blockers: DispatchBlockReason[] = [];
    if (!readiness.ready) {
      blockers.push("DEPENDENCY_BLOCKED");
    }
    if (!facts.repositoryPreflightPassed || !facts.contextPreflightPassed) {
      blockers.push("PREFLIGHT_BLOCKED");
    }
    if (!facts.budgetAvailable) {
      blockers.push("BUDGET_BLOCKED");
    }
    if (!facts.worktreeOwnershipAvailable) {
      blockers.push("PREFLIGHT_BLOCKED");
    }
    if (!facts.humanApprovalSatisfied) {
      blockers.push("AUTHORITY_BLOCKED");
    }

    if (blockers.length === 0) {
      eligibleSubtaskIds.push(subtask.id);
    } else {
      candidateBlockers.push(...blockers);
    }
  }

  if (activeWriteIds.size >= 1) {
    return blocked("CONCURRENCY_BLOCKED", eligibleSubtaskIds);
  }
  const selectedSubtaskId = eligibleSubtaskIds[0];
  if (selectedSubtaskId === undefined) {
    const reason = firstBlockReason(candidateBlockers);
    return reason === "AUTHORITY_BLOCKED" ? humanRequired() : blocked(reason);
  }
  return Object.freeze({
    kind: "DISPATCH_SELECTED",
    selectedSubtaskId,
    eligibleSubtaskIds: Object.freeze([...eligibleSubtaskIds]),
    eligibleButNotSelectedSubtaskIds: Object.freeze(eligibleSubtaskIds.slice(1)),
  });
};
