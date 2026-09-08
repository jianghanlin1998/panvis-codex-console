import { z } from "zod";
import { BigTaskIdSchema, ProjectIdSchema, SubtaskIdSchema } from "./identifiers.js";
import { NormalizedUsageSchema } from "./execution.js";
import { isWellFormedUnicode } from "./well-formed-unicode.js";

const text = (max: number) => z.string().trim().min(1).max(max).refine(isWellFormedUnicode)
  .refine(value => Array.from(value).every(char => { const code = char.codePointAt(0)!; return code >= 32 && code !== 127 || code === 9 || code === 10 || code === 13; }));
export const ConsoleRequestIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/);
export const ConsoleScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PROJECT"), id: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal("BIG_TASK"), id: BigTaskIdSchema }).strict(),
  z.object({ kind: z.literal("SUBTASK"), id: SubtaskIdSchema }).strict(),
  z.object({ kind: z.literal("DRAFT"), id: z.string().regex(/^draft_[a-zA-Z0-9_-]{8,80}$/) }).strict(),
]);
export type ConsoleScope = z.infer<typeof ConsoleScopeSchema>;
export const ConsoleBriefSchema = z.object({
  title: text(200), goal: text(1000),
  scopeIn: z.array(text(1000)).min(1).max(12),
  scopeOut: z.array(text(1000)).max(12),
  successCriteria: z.array(text(1000)).min(1).max(12),
}).strict();
export const ConsoleDraftCreateSchema = z.object({
  requestId: ConsoleRequestIdSchema, projectId: ProjectIdSchema,
  kind: z.enum(["BIG_TASK", "SMALL_TASK"]), title: text(200), goal: text(1000),
  relatedBigTaskId: BigTaskIdSchema.optional(),
}).strict();
export const ConsoleDirectionConfirmSchema = z.object({
  draftId: z.string(), revision: z.number().int().nonnegative(), brief: ConsoleBriefSchema,
  reviewIntensity: z.enum(["LIGHT", "STANDARD", "THOROUGH"]),
  planningTokenLimit: z.number().int().min(1000).max(120_000),
  planningMeasureOnlyMinutes: z.number().int().min(1).max(180).optional(),
}).strict();
export const ConsoleDraftSchema = ConsoleDraftCreateSchema.omit({ requestId: true }).extend({
  id: z.string(), revision: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(), confirmedBigTaskId: BigTaskIdSchema.nullable(),
  confirmation: ConsoleDirectionConfirmSchema.nullable(),
}).strict();
export type ConsoleDraft = z.infer<typeof ConsoleDraftSchema>;
export const ConsoleDiscussionInputSchema = z.object({
  requestId: ConsoleRequestIdSchema, scope: ConsoleScopeSchema, message: text(8000),
}).strict();
export const ConsoleDiscussionAnswerSchema = z.object({
  reply: text(12_000), proposal: ConsoleBriefSchema.nullable(),
}).strict();
export type ConsoleDiscussionAnswer = z.infer<typeof ConsoleDiscussionAnswerSchema>;
export const CONSOLE_DISCUSSION_OUTPUT_SCHEMA = z.toJSONSchema(ConsoleDiscussionAnswerSchema);
export const ConsoleDiscussionTurnSchema = z.object({
  id: ConsoleRequestIdSchema, scope: ConsoleScopeSchema, sequence: z.number().int().positive(),
  message: text(8000), status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED"]),
  answer: ConsoleDiscussionAnswerSchema.nullable(), usage: NormalizedUsageSchema.nullable(),
  failureCode: z.string().regex(/^[A-Z_]{1,80}$/).nullable(),
  createdAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(),
}).strict();
export type ConsoleDiscussionTurn = z.infer<typeof ConsoleDiscussionTurnSchema>;
export const ConsoleProjectCreateSchema = z.object({
  requestId: ConsoleRequestIdSchema, name: text(200), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  repositoryPath: text(2000), defaultBranch: text(100),
}).strict();
export const ConsoleContextDecisionSchema = z.object({
  requestId: ConsoleRequestIdSchema, scope: ConsoleScopeSchema, title: text(200), body: text(4000),
}).strict();
