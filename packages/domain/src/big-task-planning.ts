import { z } from "zod";
import { ConsoleWorkflowPreferencesSchema } from "./console-workspace.js";

import { ContextItemSchema } from "./context.js";
import { BigTaskIdSchema } from "./identifiers.js";
import { BigTaskSchema } from "./tasks.js";
import { isWellFormedUnicode } from "./well-formed-unicode.js";
import { NormalizedUsageSchema, ProviderModelReferenceSchema, ProviderRunReferenceSchema, ProviderThreadReferenceSchema } from "./execution.js";

/** Planning-only byte limits; execution context and token budgets are unchanged. */
export const BIG_TASK_PLANNING_LIMITS = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxIntakeBytes: 1024 * 1024,
  maxStoredIntakeBytes: 2 * 1024 * 1024,
  // Wire envelope includes JSON escaping and multiple 1 MiB content blocks.
  maxInputBytes: 4 * 1024 * 1024,
});

const text = z.string().min(1).max(1_000)
  .refine((value) => value.trim() === value && isWellFormedUnicode(value))
  .refine((value) => Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && (code < 0x7f || code > 0x9f);
  }));
const texts = z.array(text).max(24);

/** Explicit, immutable authority for one intake; never a new default budget. */
export const PlanningBudgetExceptionSchema = z.object({
  approved: z.literal(true),
  mode: z.literal("MEASURE_ONLY"),
  reason: text,
  expiresAt: z.iso.datetime(),
}).strict();

export const PlanningProviderDiagnosticsSchema = z.object({
  failureCode: z.enum([
    "INVALID_INPUT", "PREFLIGHT_FAILED", "PREFLIGHT_BLOCKED", "ACTIVE_RUNTIME_REQUIRED",
    "APP_SERVER_START_FAILED", "APP_SERVER_PROTOCOL_ERROR", "APP_SERVER_TIMEOUT", "APP_SERVER_EXITED",
    "JSONL_LIMIT_EXCEEDED", "CHATGPT_AUTH_REQUIRED", "AUTH_RESPONSE_MALFORMED", "EPHEMERAL_THREAD_REQUIRED",
    "READ_ONLY_POLICY_REQUIRED", "TURN_FAILED", "TURN_INTERRUPTED", "TERMINAL_EVENT_REQUIRED",
    "AGENT_RESPONSE_LIMIT_EXCEEDED", "APPROVAL_REQUESTED", "TOOL_ACTION_ATTEMPTED",
    "UNEXPECTED_SERVER_REQUEST", "PROCESS_CLEANUP_FAILED", "WORKSPACE_CLEANUP_FAILED",
  ]).nullable(),
  notificationsReceived: z.number().int().nonnegative(),
  unknownNotificationsIgnored: z.number().int().nonnegative(),
  interruptRequests: z.number().int().nonnegative(),
  appServerChildCleaned: z.boolean(),
  disposableWorkspaceCleaned: z.boolean(),
}).strict();

/** Human intake contains intent, never a caller-authored execution graph. */
export const ProductDirectionSchema = z.object({
  confirmed: z.literal(true),
  summary: text,
  successCriteria: texts.min(1),
  scopeBoundaries: texts,
}).strict();
export const BigTaskPlanningIntakeSchema = z.object({
  bigTask: BigTaskSchema.extend({ status: z.literal("IN_PROGRESS") }).strict(),
  approved: z.literal(true),
  productDecisions: texts,
  // Frozen human conclusions for this intake; later discussions do not change its authority.
  confirmedContextItems: z.array(ContextItemSchema).max(200).optional(),
  // Optional when reading historical intakes; new intake requires a human-confirmed brief.
  productDirection: ProductDirectionSchema.optional(),
  reviewIntensity: z.enum(["LIGHT", "STANDARD", "THOROUGH"]).optional(),
  taskSize: z.literal("SMALL").optional(),
  consoleReviewPolicy: z.literal(true).optional(),
  consoleWorkflow: ConsoleWorkflowPreferencesSchema.optional(),
  planningRevisionOf: BigTaskIdSchema.optional(),
  consoleTaskReviewLevels: z.array(z.object({ title: text, reviewLevel: z.enum(["LIGHT", "STANDARD", "THOROUGH"]) }).strict()).max(24).optional(),
  suggestedSubtasks: z.array(z.object({ title: text, goal: text, scopeIn: texts.min(1), scopeOut: texts, successCriteria: texts.min(1) }).strict()).max(24).optional(),
  planningTokenLimit: z.number().int().min(1).max(10_000_000),
  budgetException: PlanningBudgetExceptionSchema.optional(),
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
  requiredGate: z.enum(["VERIFIED", "HARDENED", "ACCEPTED"]),
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
  providerDiagnostics: PlanningProviderDiagnosticsSchema.optional(),
  stopReason: z.enum(["PRODUCT_QUESTION", "ENGINEERING_PREPARATION", "USER_PAUSED", "REVIEW_ESCALATED", "PLAN_REVIEW_EXHAUSTED", "PROVIDER_FAILED", "INVALID_OUTPUT", "USAGE_UNKNOWN", "BUDGET_BLOCKED", "TIME_LIMIT_REACHED", "CONTEXT_CHANGED", "CONTEXT_LIMIT", "INTERRUPTED"]).nullable(),
  questions: texts,
}).strict().superRefine((value, context) => {
  if ((value.status === "RUNNING") !== (value.endedAt === null)
    || (value.status === "HUMAN_REQUIRED") !== (value.stopReason !== null)
    || (value.endedAt !== null && value.endedAt < value.startedAt)) {
    context.addIssue({ code: "custom", message: "Inconsistent planning run" });
  }
});
export type PlanningRunRecord = z.infer<typeof PlanningRunRecordSchema>;
