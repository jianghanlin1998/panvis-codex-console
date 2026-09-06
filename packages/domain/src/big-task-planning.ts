import { z } from "zod";

import { BigTaskSchema } from "./tasks.js";
import { isWellFormedUnicode } from "./well-formed-unicode.js";
import { NormalizedUsageSchema, ProviderModelReferenceSchema, ProviderRunReferenceSchema, ProviderThreadReferenceSchema } from "./execution.js";

const text = z.string().min(1).max(1_000)
  .refine((value) => value.trim() === value && isWellFormedUnicode(value))
  .refine((value) => Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && (code < 0x7f || code > 0x9f);
  }));
const texts = z.array(text).max(24);

/** Human intake contains intent, never a caller-authored execution graph. */
export const BigTaskPlanningIntakeSchema = z.object({
  bigTask: BigTaskSchema.extend({ status: z.literal("IN_PROGRESS") }).strict(),
  approved: z.literal(true),
  productDecisions: texts,
  planningTokenLimit: z.number().int().min(1).max(120_000),
}).strict();
export type BigTaskPlanningIntake = z.infer<typeof BigTaskPlanningIntakeSchema>;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const proposedTask = z.object({
  key,
  title: text,
  goal: text,
  scopeIn: texts.min(1),
  scopeOut: texts,
  acceptanceCriteria: texts.min(1),
  untouchedAreas: texts,
  promptSeed: text,
  profile: z.enum(["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"]),
  writeEnabled: z.boolean(),
}).strict();
const proposedDependency = z.object({
  upstreamKey: key,
  downstreamKey: key,
  requiredGate: z.enum(["HARDENED", "ACCEPTED"]),
  reason: text,
}).strict();

export const PlannerResponseSchema = z.object({
  outcome: z.enum(["PROPOSE", "HUMAN_REQUIRED"]),
  questions: texts,
  tasks: z.array(proposedTask).max(24),
  dependencies: z.array(proposedDependency).max(64),
}).strict().superRefine((value, context) => {
  if (value.outcome === "PROPOSE"
    ? value.questions.length !== 0 || value.tasks.length === 0
    : value.questions.length === 0 || value.tasks.length !== 0 || value.dependencies.length !== 0) {
    context.addIssue({ code: "custom", message: "Inconsistent planning outcome" });
  }
});
export type PlannerResponse = z.infer<typeof PlannerResponseSchema>;

/** A Reviewer cannot return or replace tasks, contracts or dependencies. */
export const PlannerReviewResponseSchema = z.object({
  outcome: z.enum(["APPROVE", "REJECT", "ESCALATE"]),
  // The provider echoes a compact digest; storage resolves it to the exact durable binding.
  candidateBinding: z.string().regex(/^[0-9a-f]{64}$/),
  planRevision: z.number().int().min(1).max(3),
  revisionRequirements: texts,
  questions: texts,
}).strict().superRefine((value, context) => {
  if ((value.outcome === "REJECT") !== (value.revisionRequirements.length > 0)
    || (value.outcome === "ESCALATE") !== (value.questions.length > 0)) {
    context.addIssue({ code: "custom", message: "Inconsistent review outcome" });
  }
});
export type PlannerReviewResponse = z.infer<typeof PlannerReviewResponseSchema>;

export const PLANNER_OUTPUT_SCHEMA = z.toJSONSchema(PlannerResponseSchema);
export const PLANNER_REVIEW_OUTPUT_SCHEMA = z.toJSONSchema(PlannerReviewResponseSchema);

export const PlanningRunRecordSchema = z.object({
  sequence: z.number().int().min(1).max(6),
  role: z.enum(["PLANNER", "REVIEWER"]),
  status: z.enum(["RUNNING", "COMPLETED", "HUMAN_REQUIRED"]),
  inputBinding: z.string().regex(/^[0-9a-f]{64}$/),
  inputText: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  providerThread: ProviderThreadReferenceSchema.nullable(),
  providerRun: ProviderRunReferenceSchema.nullable(),
  model: ProviderModelReferenceSchema.nullable(),
  normalizedUsage: NormalizedUsageSchema.nullable(),
  stopReason: z.enum(["PRODUCT_QUESTION", "REVIEW_ESCALATED", "PLAN_REVIEW_EXHAUSTED", "PROVIDER_FAILED", "INVALID_OUTPUT", "USAGE_UNKNOWN", "BUDGET_BLOCKED", "CONTEXT_CHANGED", "CONTEXT_LIMIT", "INTERRUPTED"]).nullable(),
  questions: texts,
}).strict().superRefine((value, context) => {
  if ((value.status === "RUNNING") !== (value.endedAt === null)
    || (value.status === "HUMAN_REQUIRED") !== (value.stopReason !== null)
    || (value.endedAt !== null && value.endedAt < value.startedAt)) {
    context.addIssue({ code: "custom", message: "Inconsistent planning run" });
  }
});
export type PlanningRunRecord = z.infer<typeof PlanningRunRecordSchema>;
