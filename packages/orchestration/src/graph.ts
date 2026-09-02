import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  validateSubtaskDependencies,
} from "@codex-task-console/domain";
import type {
  BigTaskId,
  ProjectId,
  SubtaskDependency,
  SubtaskId,
} from "@codex-task-console/domain";

import {
  MATERIALIZED_GRAPH_CHANGE_KINDS,
  WORKFLOW_PROFILES,
} from "./contracts.js";
import type {
  GraphValidationError,
  GraphValidationErrorCode,
  GraphValidationResult,
  MaterializedGraph,
  MaterializedGraphChangeKind,
  MaterializedGraphChangeResult,
  PlanCandidate,
  ProposedSubtask,
  WorkflowProfile,
} from "./contracts.js";

type CandidateParseErrorCode = "INVALID_PLAN_CANDIDATE" | "INVALID_DEPENDENCY";

type CandidateParseResult =
  | { readonly valid: true; readonly candidate: PlanCandidate }
  | { readonly valid: false; readonly code: CandidateParseErrorCode };

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value).sort(compareCodeUnits);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === [...expectedKeys].sort(compareCodeUnits)[index])
  );
};

const isCanonicalBigTaskId = (value: unknown): value is BigTaskId => {
  const parsed = BigTaskIdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
};

const isCanonicalProjectId = (value: unknown): value is ProjectId => {
  const parsed = ProjectIdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
};

const isCanonicalSubtaskId = (value: unknown): value is SubtaskId => {
  const parsed = SubtaskIdSchema.safeParse(value);
  return parsed.success && parsed.data === value;
};

const isWorkflowProfile = (value: unknown): value is WorkflowProfile =>
  typeof value === "string" && WORKFLOW_PROFILES.some((profile) => profile === value);

const freezeDependency = (dependency: SubtaskDependency): SubtaskDependency =>
  Object.freeze({ ...dependency });

const freezeSubtask = (subtask: ProposedSubtask): ProposedSubtask =>
  Object.freeze({ ...subtask });

const freezeCandidate = (candidate: PlanCandidate): PlanCandidate =>
  Object.freeze({
    ...candidate,
    subtasks: Object.freeze(candidate.subtasks.map(freezeSubtask)),
    dependencies: Object.freeze(candidate.dependencies.map(freezeDependency)),
  });

const parseProposedSubtask = (input: unknown): ProposedSubtask | null => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "bigTaskId",
      "id",
      "profile",
      "taskContractRef",
      "writeEnabled",
    ]) ||
    !isCanonicalSubtaskId(input.id) ||
    !isCanonicalBigTaskId(input.bigTaskId) ||
    !isWorkflowProfile(input.profile) ||
    typeof input.taskContractRef !== "string" ||
    input.taskContractRef.length === 0 ||
    input.taskContractRef.length > 1_000 ||
    input.taskContractRef.trim() !== input.taskContractRef ||
    typeof input.writeEnabled !== "boolean"
  ) {
    return null;
  }

  return freezeSubtask({
    id: input.id,
    bigTaskId: input.bigTaskId,
    profile: input.profile,
    taskContractRef: input.taskContractRef,
    writeEnabled: input.writeEnabled,
  });
};

const parseDependency = (input: unknown): SubtaskDependency | null => {
  const parsed = SubtaskDependencySchema.safeParse(input);
  if (!parsed.success || !isRecord(input)) {
    return null;
  }
  const dependency = parsed.data;
  if (
    dependency.upstreamSubtaskId !== input.upstreamSubtaskId ||
    dependency.downstreamSubtaskId !== input.downstreamSubtaskId ||
    dependency.dependencyType !== input.dependencyType ||
    dependency.requiredGate !== input.requiredGate ||
    dependency.reason !== input.reason
  ) {
    return null;
  }
  return freezeDependency(dependency);
};

export const parsePlanCandidate = (input: unknown): CandidateParseResult => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "bigTaskId",
      "dependencies",
      "kind",
      "projectId",
      "revision",
      "subtasks",
    ]) ||
    input.kind !== "PLAN_CANDIDATE" ||
    !isCanonicalProjectId(input.projectId) ||
    !isCanonicalBigTaskId(input.bigTaskId) ||
    !Number.isSafeInteger(input.revision) ||
    typeof input.revision !== "number" ||
    input.revision < 1 ||
    !Array.isArray(input.subtasks) ||
    input.subtasks.length === 0 ||
    !Array.isArray(input.dependencies)
  ) {
    return { valid: false, code: "INVALID_PLAN_CANDIDATE" };
  }

  const subtasks: ProposedSubtask[] = [];
  for (const subtaskInput of input.subtasks) {
    const subtask = parseProposedSubtask(subtaskInput);
    if (subtask === null) {
      return { valid: false, code: "INVALID_PLAN_CANDIDATE" };
    }
    subtasks.push(subtask);
  }

  const dependencies: SubtaskDependency[] = [];
  for (const dependencyInput of input.dependencies) {
    const dependency = parseDependency(dependencyInput);
    if (dependency === null) {
      return { valid: false, code: "INVALID_DEPENDENCY" };
    }
    dependencies.push(dependency);
  }

  return {
    valid: true,
    candidate: freezeCandidate({
      kind: "PLAN_CANDIDATE",
      projectId: input.projectId,
      bigTaskId: input.bigTaskId,
      revision: input.revision,
      subtasks,
      dependencies: sortDependencies(dependencies),
    }),
  };
};

const dependencyKey = (dependency: SubtaskDependency): string =>
  [
    dependency.upstreamSubtaskId,
    dependency.downstreamSubtaskId,
    dependency.dependencyType,
    dependency.requiredGate,
    dependency.reason,
  ].join("\u0000");

const sortDependencies = (
  dependencies: readonly SubtaskDependency[],
): readonly SubtaskDependency[] =>
  Object.freeze(
    [...dependencies]
      .sort((left, right) => compareCodeUnits(dependencyKey(left), dependencyKey(right)))
      .map(freezeDependency),
  );

const freezeGraphValidationErrors = (
  errors: readonly GraphValidationError[],
): readonly GraphValidationError[] =>
  Object.freeze(
    errors.map((error) =>
      Object.freeze({
        code: error.code,
        subtaskIds: Object.freeze([...error.subtaskIds]),
      }),
    ),
  );

export const validatePlanCandidateGraph = (input: unknown): GraphValidationResult => {
  const parsed = parsePlanCandidate(input);
  if (!parsed.valid) {
    return {
      valid: false,
      errors: freezeGraphValidationErrors([
        { code: parsed.code, subtaskIds: [] },
      ]),
    };
  }

  const { candidate } = parsed;
  const errors: GraphValidationError[] = [];
  const seenSubtaskIds = new Set<SubtaskId>();

  for (const subtask of candidate.subtasks) {
    if (seenSubtaskIds.has(subtask.id)) {
      errors.push({ code: "DUPLICATE_SUBTASK_ID", subtaskIds: [subtask.id] });
    }
    seenSubtaskIds.add(subtask.id);
    if (subtask.bigTaskId !== candidate.bigTaskId) {
      errors.push({
        code: "BIG_TASK_OWNERSHIP_MISMATCH",
        subtaskIds: [subtask.id],
      });
    }
  }

  const dependencies = sortDependencies(candidate.dependencies);
  const domainValidation = validateSubtaskDependencies(candidate.subtasks, dependencies);
  if (!domainValidation.valid) {
    for (const error of domainValidation.errors) {
      errors.push({
        code: error.code as GraphValidationErrorCode,
        subtaskIds: error.subtaskIds,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors: freezeGraphValidationErrors(errors) };
  }

  const normalizedCandidate = freezeCandidate({
    ...candidate,
    dependencies,
  });
  return Object.freeze({
    valid: true,
    candidate: normalizedCandidate,
    orderedSubtaskIds: Object.freeze(candidate.subtasks.map(({ id }) => id)),
    dependencies,
  });
};

const freezeMaterializedGraph = (graph: MaterializedGraph): MaterializedGraph =>
  Object.freeze({
    ...graph,
    subtasks: Object.freeze(graph.subtasks.map(freezeSubtask)),
    dependencies: Object.freeze(graph.dependencies.map(freezeDependency)),
  });

export const parseMaterializedGraph = (input: unknown): MaterializedGraph | null => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "bigTaskId",
      "dependencies",
      "kind",
      "planRevision",
      "projectId",
      "subtasks",
    ]) ||
    input.kind !== "MATERIALIZED_GRAPH"
  ) {
    return null;
  }
  const validation = validatePlanCandidateGraph({
    kind: "PLAN_CANDIDATE",
    projectId: input.projectId,
    bigTaskId: input.bigTaskId,
    revision: input.planRevision,
    subtasks: input.subtasks,
    dependencies: input.dependencies,
  });
  if (!validation.valid) {
    return null;
  }
  return freezeMaterializedGraph({
    kind: "MATERIALIZED_GRAPH",
    projectId: validation.candidate.projectId,
    bigTaskId: validation.candidate.bigTaskId,
    planRevision: validation.candidate.revision,
    subtasks: validation.candidate.subtasks,
    dependencies: validation.dependencies,
  });
};

const isMaterializedGraphChangeKind = (
  input: unknown,
): input is MaterializedGraphChangeKind =>
  typeof input === "string" &&
  MATERIALIZED_GRAPH_CHANGE_KINDS.some((changeKind) => changeKind === input);

export const rejectMaterializedGraphChange = (
  graphInput: Readonly<MaterializedGraph>,
  changeKindInput: MaterializedGraphChangeKind,
): MaterializedGraphChangeResult => {
  const graph = parseMaterializedGraph(graphInput);
  if (graph === null) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "INVALID_MATERIALIZED_GRAPH",
    });
  }
  if (!isMaterializedGraphChangeKind(changeKindInput)) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "INVALID_CHANGE_KIND",
    });
  }
  return Object.freeze({
    kind: "HUMAN_REQUIRED",
    reason: "REPLAN_REQUIRED",
    graph,
  });
};
