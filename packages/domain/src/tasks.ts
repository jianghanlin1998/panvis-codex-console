import { z } from "zod";

import { BigTaskIdSchema, ProjectIdSchema, SubtaskIdSchema } from "./identifiers.js";

const nonEmptyText = z.string().trim().min(1);
const nonEmptyTextList = z.array(nonEmptyText).min(1);

export const BigTaskStatusSchema = z.enum(["IN_PROGRESS", "DONE"]);
export const SubtaskStatusSchema = z.enum([
  "TODO",
  "IN_PROGRESS",
  "QA_DEBUG",
  "DONE",
  "DROPPED",
  "ARCHIVED",
]);
export const SubtaskStartPolicySchema = z.enum(["MANUAL", "WHEN_READY"]);
export const SubtaskDelegationPolicySchema = z.enum([
  "NONE",
  "READ_ONLY_AUXILIARY",
  "REVIEW_ONLY",
]);
export const ReasoningLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "XHIGH"]);

export const RepositoryReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("PATH"),
      path: nonEmptyText,
    })
    .strict(),
  z
    .object({
      kind: z.literal("REFERENCE"),
      reference: nonEmptyText,
    })
    .strict(),
]);

export const ProjectSchema = z
  .object({
    recordType: z.literal("PROJECT"),
    id: ProjectIdSchema,
    name: nonEmptyText,
    slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    repository: RepositoryReferenceSchema,
    defaultBranch: nonEmptyText,
    maxActiveCodingSubtasks: z.number().int().min(1).max(2),
  })
  .strict();

export const BigTaskSchema = z
  .object({
    recordType: z.literal("BIG_TASK"),
    id: BigTaskIdSchema,
    projectId: ProjectIdSchema,
    title: nonEmptyText,
    goal: nonEmptyText,
    rationale: nonEmptyText,
    scopeIn: nonEmptyTextList,
    scopeOut: z.array(nonEmptyText),
    acceptanceCriteria: nonEmptyTextList,
    status: BigTaskStatusSchema,
  })
  .strict();

export const SubtaskSchema = z
  .object({
    recordType: z.literal("SUBTASK"),
    id: SubtaskIdSchema,
    bigTaskId: BigTaskIdSchema,
    title: nonEmptyText,
    goal: nonEmptyText,
    scopeIn: nonEmptyTextList,
    scopeOut: z.array(nonEmptyText),
    acceptanceCriteria: nonEmptyTextList,
    untouchedAreas: z.array(nonEmptyText),
    status: SubtaskStatusSchema,
    startPolicy: SubtaskStartPolicySchema,
    delegationPolicy: SubtaskDelegationPolicySchema,
    recommendedReasoningLevel: ReasoningLevelSchema,
    // Stable intent only. A later start-time compiler may turn this into a final prompt.
    promptSeed: nonEmptyText,
  })
  .strict();

export const DurableTaskSchema = z.discriminatedUnion("recordType", [
  ProjectSchema,
  BigTaskSchema,
  SubtaskSchema,
]);

export type BigTaskStatus = z.infer<typeof BigTaskStatusSchema>;
export type SubtaskStatus = z.infer<typeof SubtaskStatusSchema>;
export type SubtaskStartPolicy = z.infer<typeof SubtaskStartPolicySchema>;
export type SubtaskDelegationPolicy = z.infer<typeof SubtaskDelegationPolicySchema>;
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;
export type RepositoryReference = z.infer<typeof RepositoryReferenceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type BigTask = z.infer<typeof BigTaskSchema>;
export type Subtask = z.infer<typeof SubtaskSchema>;
export type DurableTask = z.infer<typeof DurableTaskSchema>;
