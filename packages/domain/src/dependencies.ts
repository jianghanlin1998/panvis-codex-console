import { z } from "zod";

import { SubtaskIdSchema } from "./identifiers.js";
import type { BigTaskId, SubtaskId } from "./identifiers.js";

export const DependencyTypeSchema = z.enum(["BLOCKING", "INFORMATIONAL"]);

export const SubtaskDependencySchema = z
  .object({
    upstreamSubtaskId: SubtaskIdSchema,
    downstreamSubtaskId: SubtaskIdSchema,
    dependencyType: DependencyTypeSchema,
  })
  .strict();

export const DependencyValidationErrorCodeSchema = z.enum([
  "SELF_DEPENDENCY",
  "DUPLICATE_DEPENDENCY",
  "MISSING_UPSTREAM_SUBTASK",
  "MISSING_DOWNSTREAM_SUBTASK",
  "CROSS_BIG_TASK_DEPENDENCY",
  "DEPENDENCY_CYCLE",
]);

export type DependencyType = z.infer<typeof DependencyTypeSchema>;
export type SubtaskDependency = z.infer<typeof SubtaskDependencySchema>;
export type DependencyValidationErrorCode = z.infer<typeof DependencyValidationErrorCodeSchema>;

export interface DependencySubtask {
  readonly id: SubtaskId;
  readonly bigTaskId: BigTaskId;
}

export interface DependencyValidationError {
  readonly code: DependencyValidationErrorCode;
  readonly message: string;
  readonly edgeIndex?: number;
  readonly subtaskIds: readonly SubtaskId[];
}

export type DependencyValidationResult =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly DependencyValidationError[] };

export const validateSubtaskDependencies = (
  subtasks: readonly DependencySubtask[],
  dependencies: readonly SubtaskDependency[],
): DependencyValidationResult => {
  const errors: DependencyValidationError[] = [];
  const subtasksById = new Map<SubtaskId, DependencySubtask>();
  for (const subtask of subtasks) {
    subtasksById.set(subtask.id, subtask);
  }

  const seenEdges = new Set<string>();
  const graphEdges: SubtaskDependency[] = [];

  dependencies.forEach((dependency, edgeIndex) => {
    const { upstreamSubtaskId: upstreamId, downstreamSubtaskId: downstreamId } = dependency;
    const edgeKey = `${upstreamId}->${downstreamId}`;

    if (upstreamId === downstreamId) {
      errors.push({
        code: "SELF_DEPENDENCY",
        message: "A Subtask cannot depend on itself.",
        edgeIndex,
        subtaskIds: [upstreamId],
      });
    }

    if (seenEdges.has(edgeKey)) {
      errors.push({
        code: "DUPLICATE_DEPENDENCY",
        message: "A dependency edge may appear only once.",
        edgeIndex,
        subtaskIds: [upstreamId, downstreamId],
      });
    }
    seenEdges.add(edgeKey);

    const upstream = subtasksById.get(upstreamId);
    const downstream = subtasksById.get(downstreamId);

    if (upstream === undefined) {
      errors.push({
        code: "MISSING_UPSTREAM_SUBTASK",
        message: "The upstream Subtask does not exist.",
        edgeIndex,
        subtaskIds: [upstreamId],
      });
    }
    if (downstream === undefined) {
      errors.push({
        code: "MISSING_DOWNSTREAM_SUBTASK",
        message: "The downstream Subtask does not exist.",
        edgeIndex,
        subtaskIds: [downstreamId],
      });
    }

    if (upstream !== undefined && downstream !== undefined && upstream.bigTaskId !== downstream.bigTaskId) {
      errors.push({
        code: "CROSS_BIG_TASK_DEPENDENCY",
        message: "Dependency endpoints must belong to the same Big Task.",
        edgeIndex,
        subtaskIds: [upstreamId, downstreamId],
      });
    }

    if (
      upstream !== undefined &&
      downstream !== undefined &&
      upstream.bigTaskId === downstream.bigTaskId &&
      upstreamId !== downstreamId
    ) {
      graphEdges.push(dependency);
    }
  });

  const cycleIds = findCycleMembers(subtasks, graphEdges);
  if (cycleIds.length > 0) {
    errors.push({
      code: "DEPENDENCY_CYCLE",
      message: "The Subtask dependency graph must be acyclic.",
      subtaskIds: cycleIds,
    });
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
};

const findCycleMembers = (
  subtasks: readonly DependencySubtask[],
  dependencies: readonly SubtaskDependency[],
): readonly SubtaskId[] => {
  const indegree = new Map<SubtaskId, number>();
  const outgoing = new Map<SubtaskId, SubtaskId[]>();

  for (const subtask of subtasks) {
    indegree.set(subtask.id, 0);
    outgoing.set(subtask.id, []);
  }
  for (const dependency of dependencies) {
    outgoing.get(dependency.upstreamSubtaskId)?.push(dependency.downstreamSubtaskId);
    indegree.set(
      dependency.downstreamSubtaskId,
      (indegree.get(dependency.downstreamSubtaskId) ?? 0) + 1,
    );
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  let visitedCount = 0;

  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) {
      break;
    }
    visitedCount += 1;
    const nextIds = outgoing.get(current) ?? [];
    for (const nextId of nextIds) {
      const nextDegree = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextDegree);
      if (nextDegree === 0) {
        ready.push(nextId);
        ready.sort();
      }
    }
  }

  if (visitedCount === indegree.size) {
    return [];
  }
  return [...indegree.entries()]
    .filter(([, degree]) => degree > 0)
    .map(([id]) => id)
    .sort();
};
