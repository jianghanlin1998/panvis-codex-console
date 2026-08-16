import { z } from "zod";

import { SubtaskDependencySchema, validateSubtaskDependencies } from "./dependencies.js";
import type { SubtaskDependency } from "./dependencies.js";
import { BigTaskIdSchema, ProjectIdSchema, SubtaskIdSchema } from "./identifiers.js";
import { captureJointlyStableStructuralDataList } from "./structural-capture.js";

const PromotedContextRouteProjectSchema = z
  .object({
    id: ProjectIdSchema,
  })
  .strict();

const PromotedContextRouteBigTaskSchema = z
  .object({
    id: BigTaskIdSchema,
    projectId: ProjectIdSchema,
  })
  .strict();

const PromotedContextRouteSubtaskSchema = z
  .object({
    id: SubtaskIdSchema,
    bigTaskId: BigTaskIdSchema,
  })
  .strict();

export const PromotedContextRouteAudienceKindSchema = z.enum([
  "PARENT_BIG_TASK",
  "DOWNSTREAM_SUBTASK",
]);

export const PromotedContextRouteSchema = z.discriminatedUnion("audienceKind", [
  z
    .object({
      sourceSubtaskId: SubtaskIdSchema,
      audienceKind: z.literal("PARENT_BIG_TASK"),
      targetBigTaskId: BigTaskIdSchema,
    })
    .strict(),
  z
    .object({
      sourceSubtaskId: SubtaskIdSchema,
      audienceKind: z.literal("DOWNSTREAM_SUBTASK"),
      targetSubtaskId: SubtaskIdSchema,
    })
    .strict(),
]);

/**
 * Minimal deterministic ownership and dependency evidence for route evaluation.
 * These views reuse the canonical identifier and dependency contracts and carry
 * no context content, acceptance state, or persistence identity.
 */
export const PromotedContextRouteTopologySchema = z
  .object({
    projects: z.array(PromotedContextRouteProjectSchema),
    bigTasks: z.array(PromotedContextRouteBigTaskSchema),
    subtasks: z.array(PromotedContextRouteSubtaskSchema),
    dependencies: z.array(SubtaskDependencySchema),
  })
  .strict();

export const PromotedContextRouteReasonSchema = z.enum([
  "ELIGIBLE_PARENT_BIG_TASK",
  "ELIGIBLE_EXPLICIT_DEPENDENCY",
  "SOURCE_SUBTASK_NOT_FOUND",
  "TARGET_BIG_TASK_NOT_FOUND",
  "TARGET_SUBTASK_NOT_FOUND",
  "NOT_SOURCE_PARENT_BIG_TASK",
  "NO_EXPLICIT_DEPENDENCY",
  "REVERSE_DIRECTION_NOT_ALLOWED",
  "CROSS_BIG_TASK_NOT_ALLOWED",
  "CROSS_PROJECT_NOT_ALLOWED",
  "INVALID_TOPOLOGY",
  "INVALID_ROUTE",
]);

export type PromotedContextRouteAudienceKind = z.infer<
  typeof PromotedContextRouteAudienceKindSchema
>;
export type PromotedContextRoute = z.infer<typeof PromotedContextRouteSchema>;
export type PromotedContextRouteTopology = z.infer<
  typeof PromotedContextRouteTopologySchema
>;
export type PromotedContextRouteReason = z.infer<
  typeof PromotedContextRouteReasonSchema
>;

export interface PromotedContextRouteEvaluation {
  readonly valid: boolean;
  readonly eligible: boolean;
  readonly reason: PromotedContextRouteReason;
}

const decision = (
  valid: boolean,
  eligible: boolean,
  reason: PromotedContextRouteReason,
): PromotedContextRouteEvaluation => Object.freeze({ valid, eligible, reason });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasDuplicateIds = (records: readonly { readonly id: string }[]): boolean => {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      return true;
    }
    seen.add(record.id);
  }
  return false;
};

const parseCanonicalRoute = (input: unknown): PromotedContextRoute | null => {
  try {
    const parsed = PromotedContextRouteSchema.safeParse(input);
    if (!parsed.success || !isRecord(input)) {
      return null;
    }
    if (
      parsed.data.sourceSubtaskId !== input.sourceSubtaskId ||
      parsed.data.audienceKind !== input.audienceKind
    ) {
      return null;
    }
    if (parsed.data.audienceKind === "PARENT_BIG_TASK") {
      return parsed.data.targetBigTaskId === input.targetBigTaskId ? parsed.data : null;
    }
    return parsed.data.targetSubtaskId === input.targetSubtaskId ? parsed.data : null;
  } catch {
    return null;
  }
};

const dependencyIsCanonical = (
  parsed: SubtaskDependency,
  input: unknown,
): boolean =>
  isRecord(input) &&
  parsed.upstreamSubtaskId === input.upstreamSubtaskId &&
  parsed.downstreamSubtaskId === input.downstreamSubtaskId &&
  parsed.dependencyType === input.dependencyType &&
  parsed.requiredGate === input.requiredGate &&
  parsed.reason === input.reason;

const parseCanonicalTopology = (
  input: unknown,
): PromotedContextRouteTopology | null => {
  const parsed = PromotedContextRouteTopologySchema.safeParse(input);
  if (!parsed.success || !isRecord(input)) {
    return null;
  }

  const rawProjects = input.projects;
  const rawBigTasks = input.bigTasks;
  const rawSubtasks = input.subtasks;
  const rawDependencies = input.dependencies;
  if (
    !Array.isArray(rawProjects) ||
    !Array.isArray(rawBigTasks) ||
    !Array.isArray(rawSubtasks) ||
    !Array.isArray(rawDependencies) ||
    parsed.data.projects.some(
      (project, index) =>
        !isRecord(rawProjects[index]) || project.id !== rawProjects[index].id,
    ) ||
    parsed.data.bigTasks.some(
      (bigTask, index) =>
        !isRecord(rawBigTasks[index]) ||
        bigTask.id !== rawBigTasks[index].id ||
        bigTask.projectId !== rawBigTasks[index].projectId,
    ) ||
    parsed.data.subtasks.some(
      (subtask, index) =>
        !isRecord(rawSubtasks[index]) ||
        subtask.id !== rawSubtasks[index].id ||
        subtask.bigTaskId !== rawSubtasks[index].bigTaskId,
    ) ||
    parsed.data.dependencies.some((dependency, index) =>
      !dependencyIsCanonical(dependency, rawDependencies[index]),
    ) ||
    hasDuplicateIds(parsed.data.projects) ||
    hasDuplicateIds(parsed.data.bigTasks) ||
    hasDuplicateIds(parsed.data.subtasks)
  ) {
    return null;
  }

  const projectIds = new Set(parsed.data.projects.map(({ id }) => id));
  const bigTasksById = new Map(parsed.data.bigTasks.map((bigTask) => [bigTask.id, bigTask]));
  if (
    parsed.data.bigTasks.some(({ projectId }) => !projectIds.has(projectId)) ||
    parsed.data.subtasks.some(({ bigTaskId }) => !bigTasksById.has(bigTaskId)) ||
    !validateSubtaskDependencies(parsed.data.subtasks, parsed.data.dependencies).valid
  ) {
    return null;
  }

  return parsed.data;
};

/**
 * Evaluates structural route eligibility only. An eligible route grants no raw
 * context access and says nothing about content validity, acceptance, readiness,
 * persistence, retrieval, or compiler inclusion.
 */
export const evaluatePromotedContextRoute = (
  topology: PromotedContextRouteTopology,
  route: PromotedContextRoute,
): PromotedContextRouteEvaluation => {
  try {
    const capturedEvidence = captureJointlyStableStructuralDataList([
      route,
      topology,
    ]);
    if (!capturedEvidence.jointlyConsistent) {
      return !capturedEvidence.stable[0]
        ? decision(false, false, "INVALID_ROUTE")
        : decision(false, false, "INVALID_TOPOLOGY");
    }
    const [capturedRoute, capturedTopology] = capturedEvidence.data;
    const parsedRoute = parseCanonicalRoute(capturedRoute);
    if (parsedRoute === null) {
      return decision(false, false, "INVALID_ROUTE");
    }
    const parsedTopology = parseCanonicalTopology(capturedTopology);
    if (parsedTopology === null) {
      return decision(false, false, "INVALID_TOPOLOGY");
    }

    const source = parsedTopology.subtasks.find(
      ({ id }) => id === parsedRoute.sourceSubtaskId,
    );
    if (source === undefined) {
      return decision(false, false, "SOURCE_SUBTASK_NOT_FOUND");
    }
    const bigTasksById = new Map(
      parsedTopology.bigTasks.map((bigTask) => [bigTask.id, bigTask]),
    );
    const sourceBigTask = bigTasksById.get(source.bigTaskId);
    if (sourceBigTask === undefined) {
      return decision(false, false, "INVALID_TOPOLOGY");
    }

    if (parsedRoute.audienceKind === "PARENT_BIG_TASK") {
      const targetBigTask = bigTasksById.get(parsedRoute.targetBigTaskId);
      if (targetBigTask === undefined) {
        return decision(false, false, "TARGET_BIG_TASK_NOT_FOUND");
      }
      if (targetBigTask.projectId !== sourceBigTask.projectId) {
        return decision(true, false, "CROSS_PROJECT_NOT_ALLOWED");
      }
      return targetBigTask.id === sourceBigTask.id
        ? decision(true, true, "ELIGIBLE_PARENT_BIG_TASK")
        : decision(true, false, "NOT_SOURCE_PARENT_BIG_TASK");
    }

    const target = parsedTopology.subtasks.find(
      ({ id }) => id === parsedRoute.targetSubtaskId,
    );
    if (target === undefined) {
      return decision(false, false, "TARGET_SUBTASK_NOT_FOUND");
    }
    const targetBigTask = bigTasksById.get(target.bigTaskId);
    if (targetBigTask === undefined) {
      return decision(false, false, "INVALID_TOPOLOGY");
    }
    if (targetBigTask.projectId !== sourceBigTask.projectId) {
      return decision(true, false, "CROSS_PROJECT_NOT_ALLOWED");
    }
    if (target.bigTaskId !== source.bigTaskId) {
      return decision(true, false, "CROSS_BIG_TASK_NOT_ALLOWED");
    }

    const hasExactDependency = parsedTopology.dependencies.some(
      ({ upstreamSubtaskId, downstreamSubtaskId }) =>
        upstreamSubtaskId === source.id && downstreamSubtaskId === target.id,
    );
    if (hasExactDependency) {
      return decision(true, true, "ELIGIBLE_EXPLICIT_DEPENDENCY");
    }
    const hasReverseDependency = parsedTopology.dependencies.some(
      ({ upstreamSubtaskId, downstreamSubtaskId }) =>
        upstreamSubtaskId === target.id && downstreamSubtaskId === source.id,
    );
    return hasReverseDependency
      ? decision(true, false, "REVERSE_DIRECTION_NOT_ALLOWED")
      : decision(true, false, "NO_EXPLICIT_DEPENDENCY");
  } catch {
    return decision(false, false, "INVALID_TOPOLOGY");
  }
};
