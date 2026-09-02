import { SubtaskIdSchema, SubtaskMaturitySchema } from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";

import { WORKFLOW_STAGES } from "./contracts.js";
import type {
  BigTaskCompletionSnapshot,
  BigTaskCompletionResult,
  DispatchSubtaskState,
  MaterializedGraph,
  WorkflowStage,
} from "./contracts.js";
import { parseMaterializedGraph } from "./graph.js";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCanonicalSubtaskId = (value: unknown): value is SubtaskId => {
  const parsed = SubtaskIdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
};

const isWorkflowStage = (value: unknown): value is WorkflowStage =>
  typeof value === "string" && WORKFLOW_STAGES.some((stage) => stage === value);

const parseState = (input: unknown): DispatchSubtaskState | null => {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 3 ||
    !Object.hasOwn(input, "maturity") ||
    !Object.hasOwn(input, "stage") ||
    !Object.hasOwn(input, "subtaskId") ||
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

const invalid = (): BigTaskCompletionResult =>
  Object.freeze({
    kind: "BLOCKED",
    reason: "INVALID_INPUT",
    incompleteSubtaskIds: Object.freeze([]),
  });

export const evaluateBigTaskCompletion = (
  graphInput: Readonly<MaterializedGraph>,
  snapshotInput: Readonly<BigTaskCompletionSnapshot>,
): BigTaskCompletionResult => {
  const graph = parseMaterializedGraph(graphInput);
  if (
    graph === null ||
    !isRecord(snapshotInput) ||
    Object.keys(snapshotInput).length !== 2 ||
    !Object.hasOwn(snapshotInput, "candidateBinding") ||
    !Object.hasOwn(snapshotInput, "subtaskStates") ||
    snapshotInput.candidateBinding !== graph.candidateBinding ||
    !Array.isArray(snapshotInput.subtaskStates)
  ) {
    return invalid();
  }

  const statesById = new Map<SubtaskId, DispatchSubtaskState>();
  for (const stateInput of snapshotInput.subtaskStates) {
    const state = parseState(stateInput);
    if (state === null || statesById.has(state.subtaskId)) {
      return invalid();
    }
    statesById.set(state.subtaskId, state);
  }
  const graphIds = new Set(graph.subtasks.map(({ id }) => id));
  if (
    statesById.size !== graph.subtasks.length ||
    [...statesById.keys()].some((id) => !graphIds.has(id)) ||
    [...statesById.values()].some(
      ({ stage, maturity }) => stage === "COMPLETE" && maturity === "NOT_STARTED",
    )
  ) {
    return invalid();
  }

  const incompleteSubtaskIds = graph.subtasks
    .filter(({ id }) => statesById.get(id)?.stage !== "COMPLETE")
    .map(({ id }) => id);
  if (incompleteSubtaskIds.length > 0) {
    return Object.freeze({
      kind: "BLOCKED",
      reason: "REQUIRED_WORK_INCOMPLETE",
      incompleteSubtaskIds: Object.freeze(incompleteSubtaskIds),
    });
  }
  return Object.freeze({
    kind: "BIG_TASK_COMPLETION_ELIGIBLE",
    bigTaskId: graph.bigTaskId,
  });
};
