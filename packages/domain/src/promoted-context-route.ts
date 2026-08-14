import { z } from "zod";

import { SubtaskDependencySchema, validateSubtaskDependencies } from "./dependencies.js";
import type { SubtaskDependency } from "./dependencies.js";
import { BigTaskIdSchema, ProjectIdSchema, SubtaskIdSchema } from "./identifiers.js";

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

type StructuralObservation =
  | { readonly kind: "PRIMITIVE"; readonly value: unknown }
  | {
      readonly kind: "OBJECT" | "ARRAY";
      readonly prototype: "OBJECT" | "NULL" | "ARRAY";
      readonly keys: readonly string[];
      readonly descriptors: readonly {
        readonly key: string;
        readonly enumerable: boolean;
        readonly configurable: boolean;
        readonly writable: boolean;
        readonly value: StructuralObservation;
      }[];
    };

interface StructuralCapture {
  readonly data: unknown;
  readonly observation: StructuralObservation;
}

type StableStructuralCaptureResult =
  | { readonly valid: true; readonly data: readonly unknown[] }
  | { readonly valid: false; readonly inputIndex: number };

const structuralObservationsEqual = (
  left: StructuralObservation,
  right: StructuralObservation,
): boolean => {
  if (left.kind === "PRIMITIVE" || right.kind === "PRIMITIVE") {
    return (
      left.kind === "PRIMITIVE" &&
      right.kind === "PRIMITIVE" &&
      Object.is(left.value, right.value)
    );
  }
  if (
    left.kind !== right.kind ||
    left.prototype !== right.prototype ||
    left.keys.length !== right.keys.length ||
    left.keys.some((key, index) => key !== right.keys[index]) ||
    left.descriptors.length !== right.descriptors.length
  ) {
    return false;
  }
  return left.descriptors.every((descriptor, index) => {
    const other = right.descriptors[index];
    return (
      other !== undefined &&
      descriptor.key === other.key &&
      descriptor.enumerable === other.enumerable &&
      descriptor.configurable === other.configurable &&
      descriptor.writable === other.writable &&
      structuralObservationsEqual(descriptor.value, other.value)
    );
  });
};

const captureStructuralDataOnce = (
  input: unknown,
  ancestors: Set<object>,
): StructuralCapture | null => {
  try {
    if ((typeof input !== "object" && typeof input !== "function") || input === null) {
      return {
        data: input,
        observation: { kind: "PRIMITIVE", value: input },
      };
    }
    if (typeof input === "function" || ancestors.has(input)) {
      return null;
    }

    const isArray = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return null;
    }

    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.some((key) => typeof key !== "string")) {
      return null;
    }
    const keys = ownKeys as string[];
    const descriptors = keys.map((key) => ({
      key,
      descriptor: Object.getOwnPropertyDescriptor(input, key),
    }));
    if (
      descriptors.some(
        ({ descriptor }) => descriptor === undefined || !("value" in descriptor),
      )
    ) {
      return null;
    }

    if (isArray) {
      const lengthDescriptor = descriptors.find(({ key }) => key === "length")?.descriptor;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable ||
        lengthDescriptor.configurable ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return null;
      }
      const length = lengthDescriptor.value as number;
      const expectedKeys = [
        ...Array.from({ length }, (_, index) => String(index)),
        "length",
      ];
      if (
        keys.length !== expectedKeys.length ||
        keys.some((key, index) => key !== expectedKeys[index]) ||
        descriptors.some(
          ({ key, descriptor }) =>
            key !== "length" && descriptor !== undefined && !descriptor.enumerable,
        )
      ) {
        return null;
      }
    } else if (descriptors.some(({ descriptor }) => !descriptor?.enumerable)) {
      return null;
    }

    ancestors.add(input);
    try {
      const capturedDescriptors: Array<{
        readonly key: string;
        readonly descriptor: PropertyDescriptor & { readonly value: unknown };
        readonly capture: StructuralCapture;
      }> = [];
      for (const { key, descriptor } of descriptors) {
        if (descriptor === undefined || !("value" in descriptor)) {
          return null;
        }
        const capture = captureStructuralDataOnce(descriptor.value, ancestors);
        if (capture === null) {
          return null;
        }
        capturedDescriptors.push({
          key,
          descriptor: descriptor as PropertyDescriptor & { readonly value: unknown },
          capture,
        });
      }

      let data: unknown;
      if (isArray) {
        const lengthDescriptor = descriptors.find(({ key }) => key === "length")!.descriptor!;
        const length = (lengthDescriptor as PropertyDescriptor & { value: number }).value;
        data = Array.from({ length }, (_, index) =>
          capturedDescriptors.find(({ key }) => key === String(index))!.capture.data,
        );
      } else {
        const capturedRecord = Object.create(
          prototype === null ? null : Object.prototype,
        ) as Record<string, unknown>;
        for (const { key, capture } of capturedDescriptors) {
          Object.defineProperty(capturedRecord, key, {
            value: capture.data,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
        data = capturedRecord;
      }

      return {
        data,
        observation: {
          kind: isArray ? "ARRAY" : "OBJECT",
          prototype: isArray ? "ARRAY" : prototype === null ? "NULL" : "OBJECT",
          keys,
          descriptors: capturedDescriptors.map(({ key, descriptor, capture }) => ({
            key,
            enumerable: descriptor.enumerable ?? false,
            configurable: descriptor.configurable ?? false,
            writable: descriptor.writable ?? false,
            value: capture.observation,
          })),
        },
      };
    } finally {
      ancestors.delete(input);
    }
  } catch {
    return null;
  }
};

const captureStableStructuralDataList = (
  inputs: readonly unknown[],
): StableStructuralCaptureResult => {
  const passes: StructuralCapture[][] = [];
  for (let passIndex = 0; passIndex < 3; passIndex += 1) {
    const pass: StructuralCapture[] = [];
    for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
      const capture = captureStructuralDataOnce(
        inputs[inputIndex],
        new Set<object>(),
      );
      if (capture === null) {
        return { valid: false, inputIndex };
      }
      pass.push(capture);
    }
    passes.push(pass);
  }

  const firstPass = passes[0]!;
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const first = firstPass[inputIndex]!;
    if (
      passes.slice(1).some(
        (pass) =>
          !structuralObservationsEqual(first.observation, pass[inputIndex]!.observation),
      )
    ) {
      return { valid: false, inputIndex };
    }
  }
  return { valid: true, data: firstPass.map(({ data }) => data) };
};

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
    const capturedEvidence = captureStableStructuralDataList([route, topology]);
    if (!capturedEvidence.valid) {
      return capturedEvidence.inputIndex === 0
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
