import { z } from "zod";
import { ExecutionProgressSchema } from "./execution-progress.js";
import { BigTaskIdSchema, ProjectIdSchema, SubtaskIdSchema } from "./identifiers.js";
import { NormalizedUsageSchema } from "./execution.js";
import { isWellFormedUnicode } from "./well-formed-unicode.js";

const text = (max: number) => z.string().trim().min(1).max(max).refine(isWellFormedUnicode)
  .refine(value => Array.from(value).every(char => { const code = char.codePointAt(0)!; return code >= 32 && code !== 127 || code === 9 || code === 10 || code === 13; }));
const payloadText = text(1024 * 1024).refine(value => new TextEncoder().encode(value).byteLength <= 1024 * 1024);
export const ConsoleRequestIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/);
export const ConsoleScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PROJECT"), id: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal("BIG_TASK"), id: BigTaskIdSchema }).strict(),
  z.object({ kind: z.literal("SUBTASK"), id: SubtaskIdSchema }).strict(),
  z.object({ kind: z.literal("DRAFT"), id: z.string().regex(/^draft_[a-zA-Z0-9_-]{8,80}$/) }).strict(),
]);
export type ConsoleScope = z.infer<typeof ConsoleScopeSchema>;
export const ConsoleReviewLevelSchema = z.enum(["LIGHT", "STANDARD", "THOROUGH"]);
export type ConsoleReviewLevel = z.infer<typeof ConsoleReviewLevelSchema>;
export const ConsoleLifecycleSchema = z.enum(["ACTIVE", "PAUSED", "ENDED"]);
export const ConsoleAssetSchema = z.object({ id: z.string().regex(/^asset_[a-f0-9]{32}$/), name: text(200), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), bytes: z.number().int().positive().max(4 * 1024 * 1024) }).strict();
export const ConsoleModelSelectionSchema = z.object({ model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/), reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/) }).strict();
export type ConsoleModelSelection = z.infer<typeof ConsoleModelSelectionSchema>;
export const ConsoleWorkflowPreferencesSchema = z.object({
  planReview: z.enum(["SELF", "INDEPENDENT"]), budgetMode: z.enum(["MEASURE", "HARD"]),
  planningTokenLimit: z.number().int().min(1000).max(10_000_000),
  executionTokenLimit: z.number().int().min(1000).max(100_000_000),
  durationMinutes: z.number().int().min(1).max(1440),
}).strict();
export const ConsoleSettingsChangeSchema = z.object({
  requestId: ConsoleRequestIdSchema, scope: ConsoleScopeSchema,
  expectedRevision: z.number().int().nonnegative(),
  reviewLevel: ConsoleReviewLevelSchema.nullable().optional(), projectClosed: z.boolean().optional(),
  lifecycle: ConsoleLifecycleSchema.optional(), endOutcome: z.enum(["COMPLETED", "STOPPED"]).optional(),
  modelSelection: ConsoleModelSelectionSchema.nullable().optional(), preferences: ConsoleWorkflowPreferencesSchema.optional(),
}).strict().refine(value => value.reviewLevel !== undefined || value.projectClosed !== undefined || value.lifecycle !== undefined || value.preferences !== undefined || value.modelSelection !== undefined);
export const ConsolePlanReviewChangeSchema = z.object({
  requestId: ConsoleRequestIdSchema, bigTaskId: BigTaskIdSchema,
  expectedBinding: z.string().regex(/^[a-f0-9]{32}$/),
  changes: z.array(z.object({ subtaskId: SubtaskIdSchema, reviewLevel: ConsoleReviewLevelSchema }).strict()).min(1).max(24),
}).strict();
export const ConsoleScopeSettingsSchema = z.object({
  scope: ConsoleScopeSchema, revision: z.number().int().nonnegative(),
  reviewLevel: ConsoleReviewLevelSchema.nullable(), projectClosed: z.boolean(), lifecycle: ConsoleLifecycleSchema.optional(), endOutcome: z.enum(["COMPLETED", "STOPPED"]).optional(), modelSelection: ConsoleModelSelectionSchema.nullable().optional(), preferences: ConsoleWorkflowPreferencesSchema.optional(), updatedAt: z.iso.datetime().nullable(),
}).strict();
export const ConsoleBriefSchema = z.object({
  title: text(200), goal: text(1000),
  scopeIn: z.array(text(1000)).min(1).max(12),
  scopeOut: z.array(text(1000)).max(12),
  successCriteria: z.array(text(1000)).min(1).max(12),
}).strict();
export const ConsoleDraftCreateSchema = z.object({
  requestId: ConsoleRequestIdSchema, projectId: ProjectIdSchema,
  kind: z.enum(["BIG_TASK", "SMALL_TASK"]), title: text(200), goal: text(1000),
  relatedBigTaskId: BigTaskIdSchema.optional(), parentDraftId: z.string().optional(),
  sourceTurnId: ConsoleRequestIdSchema.optional(), suggestedBrief: ConsoleBriefSchema.optional(),
  suggestedSubtasks: z.array(ConsoleBriefSchema).max(24).optional(), reviewLevel: ConsoleReviewLevelSchema.optional(),
}).strict();
export const ConsoleDirectionConfirmSchema = z.object({
  draftId: z.string(), revision: z.number().int().nonnegative(), brief: ConsoleBriefSchema,
  reviewIntensity: z.enum(["LIGHT", "STANDARD", "THOROUGH"]),
  planningTokenLimit: z.number().int().min(1000).max(10_000_000),
  workflow: ConsoleWorkflowPreferencesSchema.optional(),
  planningMeasureOnlyMinutes: z.number().int().min(1).max(180).optional(),
}).strict();
export const ConsoleDraftSchema = ConsoleDraftCreateSchema.omit({ requestId: true }).extend({
  id: z.string(), revision: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(), confirmedBigTaskId: BigTaskIdSchema.nullable(),
  confirmation: ConsoleDirectionConfirmSchema.nullable(),
}).strict();
export type ConsoleDraft = z.infer<typeof ConsoleDraftSchema>;
export const ConsoleDiscussionInputSchema = z.object({
  requestId: ConsoleRequestIdSchema, scope: ConsoleScopeSchema, message: payloadText, attachments: z.array(ConsoleAssetSchema).max(6).optional(),
}).strict();
const taskActionScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BIG_TASK"), id: BigTaskIdSchema }).strict(),
  z.object({ kind: z.literal("SUBTASK"), id: SubtaskIdSchema }).strict(),
]);
const discussionAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RECOVER_TASK"), bigTaskId: BigTaskIdSchema, planDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().nonnegative(), acknowledgeUnknownUsage: z.boolean(), durationMinutes: z.number().int().min(1).max(180).nullable() }).strict(),
  z.object({ kind: z.literal("CONFIRM_DRAFT"), draftId: z.string(), revision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("APPROVE_PLAN"), bigTaskId: BigTaskIdSchema, expectedBinding: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  z.object({ kind: z.literal("ADVANCE_TASK"), scope: taskActionScope }).strict(),
  z.object({ kind: z.literal("PAUSE_TASK"), scope: taskActionScope }).strict(),
  ConsolePlanReviewChangeSchema.omit({ requestId: true }).extend({ kind: z.literal("AMEND_PLAN_REVIEW") }).strict(),
  z.object({ kind: z.literal("CREATE_TASK"), taskKind: z.enum(["BIG_TASK", "SMALL_TASK"]),
    brief: ConsoleBriefSchema, suggestedSubtasks: z.array(ConsoleBriefSchema).max(24),
    relatedBigTaskId: BigTaskIdSchema.nullable(), reviewLevel: ConsoleReviewLevelSchema.nullable(),
  }).strict(),
  z.object({ kind: z.literal("SET_REVIEW_LEVEL"), scope: ConsoleScopeSchema,
    expectedRevision: z.number().int().nonnegative(), reviewLevel: ConsoleReviewLevelSchema.nullable(),
  }).strict(),
]);
export const ConsoleDiscussionAnswerSchema = z.object({
  reply: payloadText, contextSummary: payloadText.optional(), proposal: ConsoleBriefSchema.nullable(),
  actions: z.array(discussionAction).max(12).optional(),
}).strict();
export type ConsoleDiscussionAnswer = z.infer<typeof ConsoleDiscussionAnswerSchema>;
export const CONSOLE_DISCUSSION_OUTPUT_SCHEMA = z.toJSONSchema(ConsoleDiscussionAnswerSchema.extend({ actions: z.array(discussionAction).max(12), contextSummary: payloadText }), {
  override: ({ zodSchema, jsonSchema }) => {
    // The provider's structured-output subset accepts anyOf, not oneOf.
    // Distinct required kind literals keep these branches mutually exclusive.
    if (zodSchema instanceof z.ZodDiscriminatedUnion && jsonSchema.oneOf) {
      jsonSchema.anyOf = jsonSchema.oneOf;
      delete jsonSchema.oneOf;
    }
  },
});
export const ConsoleDiscussionTurnSchema = z.object({
  id: ConsoleRequestIdSchema, scope: ConsoleScopeSchema, sequence: z.number().int().positive(),
  message: payloadText, attachments: z.array(ConsoleAssetSchema).max(6).optional(), status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED"]),
  answer: ConsoleDiscussionAnswerSchema.nullable(), usage: NormalizedUsageSchema.nullable(),
  failureCode: z.string().regex(/^[A-Z_]{1,80}$/).nullable(),
  createdAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(),
  progress: ExecutionProgressSchema.optional(), modelSelection: ConsoleModelSelectionSchema.nullable().optional(), actualModel: z.string().max(200).optional(),
  completionBinding: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  effects: z.array(z.object({ kind: z.enum(["TASK_CREATED", "REVIEW_LEVEL_CHANGED", "PLAN_REVIEW_CHANGED", "TASK_ADVANCE_REQUESTED", "TASK_PAUSE_REQUESTED", "TASK_CONTROL_REQUESTED", "TASK_ADVANCED", "TASK_PAUSED", "TASK_ACTION_FAILED", "EXECUTION_CONFIRMATION_REQUIRED"]), targetId: z.string(), description: text(1000) }).strict()).max(12).optional(),
}).strict();
export type ConsoleDiscussionTurn = z.infer<typeof ConsoleDiscussionTurnSchema>;
export const ConsoleProjectCreateSchema = z.object({
  requestId: ConsoleRequestIdSchema, name: text(200), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  repositoryPath: text(2000), defaultBranch: text(100),
}).strict();
export const ConsoleContextDecisionSchema = z.object({
  requestId: ConsoleRequestIdSchema, scope: ConsoleScopeSchema, title: text(200), body: payloadText,
}).strict();
