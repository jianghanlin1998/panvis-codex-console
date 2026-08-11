import { z } from "zod";

import { BigTaskIdSchema, SubtaskIdSchema } from "./identifiers.js";
import type { BigTaskId, SubtaskId } from "./identifiers.js";
import { SubtaskMaturitySchema } from "./tasks.js";
import type { SubtaskMaturity } from "./tasks.js";

export const DependencyTypeSchema = z.enum(["BLOCKING", "INFORMATIONAL"]);
export const DependencyRequiredGateSchema = z.enum(["NONE", "HARDENED", "ACCEPTED"]);

const dependencyReason = z.string().trim().min(1).max(1_000);
const dependencyEndpoints = {
  upstreamSubtaskId: SubtaskIdSchema,
  downstreamSubtaskId: SubtaskIdSchema,
  reason: dependencyReason,
} as const;

export const SubtaskDependencySchema = z.discriminatedUnion("dependencyType", [
  z
    .object({
      ...dependencyEndpoints,
      dependencyType: z.literal("BLOCKING"),
      requiredGate: z.enum(["HARDENED", "ACCEPTED"]),
    })
    .strict(),
  z
    .object({
      ...dependencyEndpoints,
      dependencyType: z.literal("INFORMATIONAL"),
      requiredGate: z.literal("NONE"),
    })
    .strict(),
]);

export const DependencyValidationErrorCodeSchema = z.enum([
  "SELF_DEPENDENCY",
  "DUPLICATE_DEPENDENCY",
  "MISSING_UPSTREAM_SUBTASK",
  "MISSING_DOWNSTREAM_SUBTASK",
  "CROSS_BIG_TASK_DEPENDENCY",
  "DEPENDENCY_CYCLE",
]);

export type DependencyType = z.infer<typeof DependencyTypeSchema>;
export type DependencyRequiredGate = z.infer<typeof DependencyRequiredGateSchema>;
export type SubtaskDependency = z.infer<typeof SubtaskDependencySchema>;
export type DependencyValidationErrorCode = z.infer<typeof DependencyValidationErrorCodeSchema>;

export interface DependencySubtask {
  readonly id: SubtaskId;
  readonly bigTaskId: BigTaskId;
}

export interface DependencyReadinessSubtask extends DependencySubtask {
  readonly maturity: SubtaskMaturity;
}

const DependencyReadinessSubtaskSchema = z
  .object({
    id: SubtaskIdSchema,
    bigTaskId: BigTaskIdSchema,
    maturity: SubtaskMaturitySchema,
  })
  .strict();

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
  const blockingGraphEdges: SubtaskDependency[] = [];

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
      dependency.dependencyType === "BLOCKING" &&
      upstream !== undefined &&
      downstream !== undefined &&
      upstream.bigTaskId === downstream.bigTaskId &&
      upstreamId !== downstreamId
    ) {
      blockingGraphEdges.push(dependency);
    }
  });

  const cycleIds = findCycleMembers(subtasks, blockingGraphEdges);
  if (cycleIds.length > 0) {
    errors.push({
      code: "DEPENDENCY_CYCLE",
      message: "The blocking Subtask dependency graph must be acyclic.",
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

export interface DependencyReadinessBlocker {
  readonly upstreamSubtaskId: SubtaskId;
  readonly requiredGate: Exclude<DependencyRequiredGate, "NONE">;
  readonly actualMaturity: SubtaskMaturity;
  readonly reason: string;
}

export interface DependencyReadinessResult {
  readonly valid: boolean;
  readonly ready: boolean;
  readonly blockers: readonly DependencyReadinessBlocker[];
  readonly errors: readonly DependencyValidationError[];
  readonly errorCodes: readonly DependencyValidationErrorCode[];
}

const malformedReadinessInput = (): DependencyReadinessResult => ({
  valid: false,
  ready: false,
  blockers: [],
  errors: [],
  errorCodes: [],
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const satisfiesRequiredGate = (
  maturity: SubtaskMaturity,
  requiredGate: DependencyRequiredGate,
): boolean => {
  switch (requiredGate) {
    case "NONE":
      return true;
    case "HARDENED":
      return maturity === "HARDENED" || maturity === "ACCEPTED";
    case "ACCEPTED":
      return maturity === "ACCEPTED";
  }
};

export const evaluateSubtaskDependencyReadiness = (
  subtasks: readonly DependencyReadinessSubtask[],
  dependencies: readonly SubtaskDependency[],
  downstreamSubtaskId: SubtaskId,
): DependencyReadinessResult => {
  if (!Array.isArray(subtasks) || !Array.isArray(dependencies)) {
    return malformedReadinessInput();
  }

  const parsedDownstreamSubtaskId = SubtaskIdSchema.safeParse(downstreamSubtaskId);
  if (
    !parsedDownstreamSubtaskId.success ||
    parsedDownstreamSubtaskId.data !== downstreamSubtaskId
  ) {
    return malformedReadinessInput();
  }

  const parsedSubtasks: DependencyReadinessSubtask[] = [];
  const seenSubtaskIds = new Set<SubtaskId>();
  for (const input of subtasks) {
    const parsed = DependencyReadinessSubtaskSchema.safeParse(input);
    if (
      !parsed.success ||
      !isRecord(input) ||
      parsed.data.id !== input.id ||
      parsed.data.bigTaskId !== input.bigTaskId ||
      parsed.data.maturity !== input.maturity ||
      seenSubtaskIds.has(parsed.data.id)
    ) {
      return malformedReadinessInput();
    }
    seenSubtaskIds.add(parsed.data.id);
    parsedSubtasks.push(parsed.data);
  }

  const parsedDependencies: SubtaskDependency[] = [];
  for (const input of dependencies) {
    const parsed = SubtaskDependencySchema.safeParse(input);
    if (
      !parsed.success ||
      !isRecord(input) ||
      parsed.data.upstreamSubtaskId !== input.upstreamSubtaskId ||
      parsed.data.downstreamSubtaskId !== input.downstreamSubtaskId ||
      parsed.data.dependencyType !== input.dependencyType ||
      parsed.data.requiredGate !== input.requiredGate ||
      parsed.data.reason !== input.reason
    ) {
      return malformedReadinessInput();
    }
    parsedDependencies.push(parsed.data);
  }

  const validation = validateSubtaskDependencies(parsedSubtasks, parsedDependencies);
  const downstreamExists = parsedSubtasks.some(
    ({ id }) => id === parsedDownstreamSubtaskId.data,
  );
  const errors: DependencyValidationError[] = validation.valid
    ? []
    : [...validation.errors];

  if (
    !downstreamExists &&
    !errors.some(
      (error) =>
        error.code === "MISSING_DOWNSTREAM_SUBTASK" &&
        error.subtaskIds.includes(parsedDownstreamSubtaskId.data),
    )
  ) {
    errors.push({
      code: "MISSING_DOWNSTREAM_SUBTASK",
      message: "The downstream Subtask evaluated for readiness does not exist.",
      subtaskIds: [parsedDownstreamSubtaskId.data],
    });
  }

  if (errors.length > 0) {
    return {
      valid: false,
      ready: false,
      blockers: [],
      errors,
      errorCodes: errors.map(({ code }) => code),
    };
  }

  const subtasksById = new Map(parsedSubtasks.map((subtask) => [subtask.id, subtask]));
  const blockers = parsedDependencies
    .filter(
      (
        dependency,
      ): dependency is Extract<
        SubtaskDependency,
        { readonly dependencyType: "BLOCKING" }
      > =>
        dependency.dependencyType === "BLOCKING" &&
        dependency.downstreamSubtaskId === parsedDownstreamSubtaskId.data,
    )
    .flatMap((dependency): DependencyReadinessBlocker[] => {
      const upstream = subtasksById.get(dependency.upstreamSubtaskId);
      if (
        upstream === undefined ||
        satisfiesRequiredGate(upstream.maturity, dependency.requiredGate)
      ) {
        return [];
      }
      return [
        {
          upstreamSubtaskId: dependency.upstreamSubtaskId,
          requiredGate: dependency.requiredGate,
          actualMaturity: SubtaskMaturitySchema.parse(upstream.maturity),
          reason: dependency.reason,
        },
      ];
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.upstreamSubtaskId, right.upstreamSubtaskId) ||
        compareCodeUnits(left.requiredGate, right.requiredGate) ||
        compareCodeUnits(left.reason, right.reason),
    );

  return {
    valid: true,
    ready: blockers.length === 0,
    blockers,
    errors: [],
    errorCodes: [],
  };
};
