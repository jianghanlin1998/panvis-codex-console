import { z } from "zod";

import { ContextScopeSchema } from "./context.js";
import type { ContextScope } from "./context.js";
import { BigTaskSchema, ProjectSchema, SubtaskSchema } from "./tasks.js";
import type { BigTask, Project, Subtask } from "./tasks.js";
import { captureJointlyStableStructuralDataList } from "./structural-capture.js";

type ProjectContextScope = Extract<ContextScope, { readonly scopeType: "PROJECT" }>;
type BigTaskContextScope = Extract<ContextScope, { readonly scopeType: "BIG_TASK" }>;
type SubtaskContextScope = Extract<ContextScope, { readonly scopeType: "SUBTASK" }>;

export interface ContextAccessTarget {
  readonly projectId: Project["id"];
  readonly bigTaskId: BigTask["id"];
  readonly subtaskId: Subtask["id"];
}

export type AllowedRawContextScopes = readonly [
  ProjectContextScope,
  BigTaskContextScope,
  SubtaskContextScope,
];

export interface AllowedContextSet {
  readonly target: ContextAccessTarget;
  readonly allowedRawScopes: AllowedRawContextScopes;
}

export type AllowedContextSetBuildErrorCode =
  | "INVALID_TARGET_SHAPE"
  | "BIG_TASK_PROJECT_MISMATCH"
  | "SUBTASK_BIG_TASK_MISMATCH";

export type AllowedContextSetBuildResult =
  | {
      readonly valid: true;
      readonly allowedContextSet: AllowedContextSet;
      readonly errorCodes: readonly [];
    }
  | {
      readonly valid: false;
      readonly errorCodes: readonly AllowedContextSetBuildErrorCode[];
    };

export type ContextScopeAccessReason =
  | "TARGET_PROJECT_SCOPE"
  | "TARGET_BIG_TASK_SCOPE"
  | "TARGET_SUBTASK_SCOPE"
  | "OTHER_PROJECT_EXCLUDED"
  | "UNRELATED_BIG_TASK_EXCLUDED"
  | "SIBLING_SUBTASK_EXCLUDED"
  | "INVALID_ALLOWED_CONTEXT_SET"
  | "INVALID_CONTEXT_SCOPE";

export interface ContextScopeAccessDecision {
  readonly allowed: boolean;
  readonly reason: ContextScopeAccessReason;
}

const ContextAccessTargetSchema = z
  .object({
    projectId: ProjectSchema.shape.id,
    bigTaskId: BigTaskSchema.shape.id,
    subtaskId: SubtaskSchema.shape.id,
  })
  .strict();

const ProjectContextScopeSchema = z
  .object({
    scopeType: z.literal("PROJECT"),
    projectId: ProjectSchema.shape.id,
  })
  .strict();

const BigTaskContextScopeSchema = z
  .object({
    scopeType: z.literal("BIG_TASK"),
    projectId: ProjectSchema.shape.id,
    bigTaskId: BigTaskSchema.shape.id,
  })
  .strict();

const SubtaskContextScopeSchema = z
  .object({
    scopeType: z.literal("SUBTASK"),
    projectId: ProjectSchema.shape.id,
    bigTaskId: BigTaskSchema.shape.id,
    subtaskId: SubtaskSchema.shape.id,
  })
  .strict();

const AllowedContextSetSchema = z
  .object({
    target: ContextAccessTargetSchema,
    allowedRawScopes: z.tuple([
      ProjectContextScopeSchema,
      BigTaskContextScopeSchema,
      SubtaskContextScopeSchema,
    ]),
  })
  .strict()
  .superRefine(({ target, allowedRawScopes }, context) => {
    const [projectScope, bigTaskScope, subtaskScope] = allowedRawScopes;
    if (
      projectScope.projectId !== target.projectId ||
      bigTaskScope.projectId !== target.projectId ||
      bigTaskScope.bigTaskId !== target.bigTaskId ||
      subtaskScope.projectId !== target.projectId ||
      subtaskScope.bigTaskId !== target.bigTaskId ||
      subtaskScope.subtaskId !== target.subtaskId
    ) {
      context.addIssue({
        code: "custom",
        message: "Allowed raw scopes must exactly match the target hierarchy.",
      });
    }
  });

const PROJECT_KEYS = [
  "recordType",
  "id",
  "name",
  "slug",
  "repository",
  "defaultBranch",
  "maxActiveCodingSubtasks",
] as const;
const BIG_TASK_KEYS = [
  "recordType",
  "id",
  "projectId",
  "title",
  "goal",
  "rationale",
  "scopeIn",
  "scopeOut",
  "acceptanceCriteria",
  "status",
] as const;
const SUBTASK_KEYS = [
  "recordType",
  "id",
  "bigTaskId",
  "title",
  "goal",
  "scopeIn",
  "scopeOut",
  "acceptanceCriteria",
  "untouchedAreas",
  "status",
  "maturity",
  "startPolicy",
  "delegationPolicy",
  "recommendedReasoningLevel",
  "promptSeed",
] as const;

const captureStableStructuralDataList = (inputs: readonly unknown[]): unknown[] | null => {
  const capture = captureJointlyStableStructuralDataList(inputs);
  return capture.jointlyConsistent ? [...capture.data] : null;
};

const captureStableStructuralData = (input: unknown): unknown | null =>
  captureStableStructuralDataList([input])?.[0] ?? null;

const hasExactOwnDataProperties = (
  value: unknown,
  expectedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => ownKeys.includes(key))
  );
};

const ownDataValue = (value: Readonly<Record<string, unknown>>, key: string): unknown =>
  Object.getOwnPropertyDescriptor(value, key)?.value;

const hasDenseOwnDataElements = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const hasRepositoryReferenceShape = (value: unknown): boolean => {
  if (hasExactOwnDataProperties(value, ["kind", "path"])) {
    return ownDataValue(value, "kind") === "PATH";
  }
  if (hasExactOwnDataProperties(value, ["kind", "reference"])) {
    return ownDataValue(value, "kind") === "REFERENCE";
  }
  return false;
};

const hasProjectEvidenceShape = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  hasExactOwnDataProperties(value, PROJECT_KEYS) &&
  hasRepositoryReferenceShape(ownDataValue(value, "repository"));

const hasBigTaskEvidenceShape = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  hasExactOwnDataProperties(value, BIG_TASK_KEYS) &&
  hasDenseOwnDataElements(ownDataValue(value, "scopeIn")) &&
  hasDenseOwnDataElements(ownDataValue(value, "scopeOut")) &&
  hasDenseOwnDataElements(ownDataValue(value, "acceptanceCriteria"));

const hasSubtaskEvidenceShape = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  hasExactOwnDataProperties(value, SUBTASK_KEYS) &&
  hasDenseOwnDataElements(ownDataValue(value, "scopeIn")) &&
  hasDenseOwnDataElements(ownDataValue(value, "scopeOut")) &&
  hasDenseOwnDataElements(ownDataValue(value, "acceptanceCriteria")) &&
  hasDenseOwnDataElements(ownDataValue(value, "untouchedAreas"));

const isCanonicalContextScope = (input: unknown, parsed: ContextScope): boolean => {
  const expectedKeys =
    parsed.scopeType === "PROJECT"
      ? ["scopeType", "projectId"]
      : parsed.scopeType === "BIG_TASK"
        ? ["scopeType", "projectId", "bigTaskId"]
        : ["scopeType", "projectId", "bigTaskId", "subtaskId"];
  if (
    !hasExactOwnDataProperties(input, expectedKeys) ||
    ownDataValue(input, "scopeType") !== parsed.scopeType ||
    ownDataValue(input, "projectId") !== parsed.projectId
  ) {
    return false;
  }
  switch (parsed.scopeType) {
    case "PROJECT":
      return true;
    case "BIG_TASK":
      return ownDataValue(input, "bigTaskId") === parsed.bigTaskId;
    case "SUBTASK":
      return (
        ownDataValue(input, "bigTaskId") === parsed.bigTaskId &&
        ownDataValue(input, "subtaskId") === parsed.subtaskId
      );
  }
};

const parseCanonicalAllowedContextSet = (input: unknown): AllowedContextSet | null => {
  try {
    const parsed = AllowedContextSetSchema.safeParse(input);
    if (!parsed.success || !hasExactOwnDataProperties(input, ["target", "allowedRawScopes"])) {
      return null;
    }

    const rawTarget = ownDataValue(input, "target");
    const rawScopes = ownDataValue(input, "allowedRawScopes");
    if (
      !hasExactOwnDataProperties(rawTarget, ["projectId", "bigTaskId", "subtaskId"]) ||
      !hasDenseOwnDataElements(rawScopes) ||
      rawScopes.length !== 3 ||
      ownDataValue(rawTarget, "projectId") !== parsed.data.target.projectId ||
      ownDataValue(rawTarget, "bigTaskId") !== parsed.data.target.bigTaskId ||
      ownDataValue(rawTarget, "subtaskId") !== parsed.data.target.subtaskId ||
      !parsed.data.allowedRawScopes.every((scope, index) =>
        isCanonicalContextScope(rawScopes[index], scope),
      )
    ) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
};

const freezeAllowedContextSet = (target: ContextAccessTarget): AllowedContextSet => {
  const frozenTarget = Object.freeze({ ...target });
  const allowedRawScopes = Object.freeze([
    Object.freeze({
      scopeType: "PROJECT" as const,
      projectId: target.projectId,
    }),
    Object.freeze({
      scopeType: "BIG_TASK" as const,
      projectId: target.projectId,
      bigTaskId: target.bigTaskId,
    }),
    Object.freeze({
      scopeType: "SUBTASK" as const,
      projectId: target.projectId,
      bigTaskId: target.bigTaskId,
      subtaskId: target.subtaskId,
    }),
  ]) as AllowedRawContextScopes;

  return Object.freeze({ target: frozenTarget, allowedRawScopes });
};

export const buildAllowedContextSet = (
  project: Project,
  bigTask: BigTask,
  subtask: Subtask,
): AllowedContextSetBuildResult => {
  try {
    const capturedEvidence = captureStableStructuralDataList([project, bigTask, subtask]);
    if (capturedEvidence === null) {
      return { valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] };
    }
    const [capturedProject, capturedBigTask, capturedSubtask] = capturedEvidence;
    if (
      !hasProjectEvidenceShape(capturedProject) ||
      !hasBigTaskEvidenceShape(capturedBigTask) ||
      !hasSubtaskEvidenceShape(capturedSubtask)
    ) {
      return { valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] };
    }

    const parsedProject = ProjectSchema.safeParse(capturedProject);
    const parsedBigTask = BigTaskSchema.safeParse(capturedBigTask);
    const parsedSubtask = SubtaskSchema.safeParse(capturedSubtask);
    if (
      !parsedProject.success ||
      !parsedBigTask.success ||
      !parsedSubtask.success ||
      ownDataValue(capturedProject, "id") !== parsedProject.data.id ||
      ownDataValue(capturedBigTask, "id") !== parsedBigTask.data.id ||
      ownDataValue(capturedBigTask, "projectId") !== parsedBigTask.data.projectId ||
      ownDataValue(capturedSubtask, "id") !== parsedSubtask.data.id ||
      ownDataValue(capturedSubtask, "bigTaskId") !== parsedSubtask.data.bigTaskId
    ) {
      return { valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] };
    }

    const errorCodes: AllowedContextSetBuildErrorCode[] = [];
    if (parsedBigTask.data.projectId !== parsedProject.data.id) {
      errorCodes.push("BIG_TASK_PROJECT_MISMATCH");
    }
    if (parsedSubtask.data.bigTaskId !== parsedBigTask.data.id) {
      errorCodes.push("SUBTASK_BIG_TASK_MISMATCH");
    }
    if (errorCodes.length > 0) {
      return { valid: false, errorCodes };
    }

    return {
      valid: true,
      allowedContextSet: freezeAllowedContextSet({
        projectId: parsedProject.data.id,
        bigTaskId: parsedBigTask.data.id,
        subtaskId: parsedSubtask.data.id,
      }),
      errorCodes: [],
    };
  } catch {
    return { valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] };
  }
};

const accessDecision = (
  allowed: boolean,
  reason: ContextScopeAccessReason,
): ContextScopeAccessDecision => Object.freeze({ allowed, reason });

export const evaluateContextScopeAccess = (
  allowedContextSet: AllowedContextSet,
  candidateScope: ContextScope,
): ContextScopeAccessDecision => {
  let capturedAllowedContextSet: unknown;
  let capturedCandidate: unknown;
  try {
    const capturedEvidence = captureStableStructuralDataList([
      allowedContextSet,
      candidateScope,
    ]);
    if (capturedEvidence === null) {
      const stableSet = captureStableStructuralData(allowedContextSet);
      return parseCanonicalAllowedContextSet(stableSet) === null
        ? accessDecision(false, "INVALID_ALLOWED_CONTEXT_SET")
        : accessDecision(false, "INVALID_CONTEXT_SCOPE");
    }
    [capturedAllowedContextSet, capturedCandidate] = capturedEvidence;
  } catch {
    return accessDecision(false, "INVALID_ALLOWED_CONTEXT_SET");
  }
  const parsedAllowedContextSet = parseCanonicalAllowedContextSet(capturedAllowedContextSet);
  if (parsedAllowedContextSet === null) {
    return accessDecision(false, "INVALID_ALLOWED_CONTEXT_SET");
  }

  let parsedCandidate: ContextScope;
  try {
    const result = ContextScopeSchema.safeParse(capturedCandidate);
    if (!result.success || !isCanonicalContextScope(capturedCandidate, result.data)) {
      return accessDecision(false, "INVALID_CONTEXT_SCOPE");
    }
    parsedCandidate = result.data;
  } catch {
    return accessDecision(false, "INVALID_CONTEXT_SCOPE");
  }

  const { target } = parsedAllowedContextSet;
  if (parsedCandidate.projectId !== target.projectId) {
    return accessDecision(false, "OTHER_PROJECT_EXCLUDED");
  }

  switch (parsedCandidate.scopeType) {
    case "PROJECT":
      return accessDecision(true, "TARGET_PROJECT_SCOPE");
    case "BIG_TASK":
      return parsedCandidate.bigTaskId === target.bigTaskId
        ? accessDecision(true, "TARGET_BIG_TASK_SCOPE")
        : accessDecision(false, "UNRELATED_BIG_TASK_EXCLUDED");
    case "SUBTASK":
      if (parsedCandidate.bigTaskId !== target.bigTaskId) {
        return accessDecision(false, "UNRELATED_BIG_TASK_EXCLUDED");
      }
      return parsedCandidate.subtaskId === target.subtaskId
        ? accessDecision(true, "TARGET_SUBTASK_SCOPE")
        : accessDecision(false, "SIBLING_SUBTASK_EXCLUDED");
  }
};
