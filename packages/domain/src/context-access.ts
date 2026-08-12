import { z } from "zod";

import { ContextScopeSchema } from "./context.js";
import type { ContextScope } from "./context.js";
import { BigTaskSchema, ProjectSchema, SubtaskSchema } from "./tasks.js";
import type { BigTask, Project, Subtask } from "./tasks.js";

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isCanonicalContextScope = (input: unknown, parsed: ContextScope): boolean => {
  if (!isRecord(input) || input.projectId !== parsed.projectId) {
    return false;
  }
  switch (parsed.scopeType) {
    case "PROJECT":
      return true;
    case "BIG_TASK":
      return input.bigTaskId === parsed.bigTaskId;
    case "SUBTASK":
      return input.bigTaskId === parsed.bigTaskId && input.subtaskId === parsed.subtaskId;
  }
};

const parseCanonicalAllowedContextSet = (input: unknown): AllowedContextSet | null => {
  const parsed = AllowedContextSetSchema.safeParse(input);
  if (!parsed.success || !isRecord(input)) {
    return null;
  }

  const rawTarget = input.target;
  const rawScopes = input.allowedRawScopes;
  if (
    !isRecord(rawTarget) ||
    !Array.isArray(rawScopes) ||
    rawTarget.projectId !== parsed.data.target.projectId ||
    rawTarget.bigTaskId !== parsed.data.target.bigTaskId ||
    rawTarget.subtaskId !== parsed.data.target.subtaskId ||
    !parsed.data.allowedRawScopes.every((scope, index) =>
      isCanonicalContextScope(rawScopes[index], scope),
    )
  ) {
    return null;
  }

  return parsed.data;
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
  const parsedProject = ProjectSchema.safeParse(project);
  const parsedBigTask = BigTaskSchema.safeParse(bigTask);
  const parsedSubtask = SubtaskSchema.safeParse(subtask);
  if (
    !parsedProject.success ||
    !parsedBigTask.success ||
    !parsedSubtask.success ||
    !isRecord(project) ||
    !isRecord(bigTask) ||
    !isRecord(subtask) ||
    project.id !== parsedProject.data.id ||
    bigTask.id !== parsedBigTask.data.id ||
    bigTask.projectId !== parsedBigTask.data.projectId ||
    subtask.id !== parsedSubtask.data.id ||
    subtask.bigTaskId !== parsedSubtask.data.bigTaskId
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
};

const accessDecision = (
  allowed: boolean,
  reason: ContextScopeAccessReason,
): ContextScopeAccessDecision => Object.freeze({ allowed, reason });

export const evaluateContextScopeAccess = (
  allowedContextSet: AllowedContextSet,
  candidateScope: ContextScope,
): ContextScopeAccessDecision => {
  const parsedAllowedContextSet = parseCanonicalAllowedContextSet(allowedContextSet);
  if (parsedAllowedContextSet === null) {
    return accessDecision(false, "INVALID_ALLOWED_CONTEXT_SET");
  }

  const parsedCandidate = ContextScopeSchema.safeParse(candidateScope);
  if (
    !parsedCandidate.success ||
    !isCanonicalContextScope(candidateScope, parsedCandidate.data)
  ) {
    return accessDecision(false, "INVALID_CONTEXT_SCOPE");
  }

  const { target } = parsedAllowedContextSet;
  if (parsedCandidate.data.projectId !== target.projectId) {
    return accessDecision(false, "OTHER_PROJECT_EXCLUDED");
  }

  switch (parsedCandidate.data.scopeType) {
    case "PROJECT":
      return accessDecision(true, "TARGET_PROJECT_SCOPE");
    case "BIG_TASK":
      return parsedCandidate.data.bigTaskId === target.bigTaskId
        ? accessDecision(true, "TARGET_BIG_TASK_SCOPE")
        : accessDecision(false, "UNRELATED_BIG_TASK_EXCLUDED");
    case "SUBTASK":
      if (parsedCandidate.data.bigTaskId !== target.bigTaskId) {
        return accessDecision(false, "UNRELATED_BIG_TASK_EXCLUDED");
      }
      return parsedCandidate.data.subtaskId === target.subtaskId
        ? accessDecision(true, "TARGET_SUBTASK_SCOPE")
        : accessDecision(false, "SIBLING_SUBTASK_EXCLUDED");
  }
};
