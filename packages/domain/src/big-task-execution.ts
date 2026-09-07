import { z } from "zod";
import { BigTaskIdSchema, SubtaskIdSchema, ExecutionRunIdSchema } from "./identifiers.js";
import { RepositoryCommitShaSchema } from "./implementation-checkpoint.js";

export const BigTaskExecutionLimitsSchema = z.object({
  durationMilliseconds: z.number().int().min(1).max(10_800_000),
  totalTokenLimit: z.number().int().min(1).max(2_880_000),
  roleCallLimit: z.number().int().min(1).max(192),
  repairCycleLimit: z.union([z.literal(1), z.literal(2)]),
}).strict();
export const BigTaskExecutionApprovalSchema = z.object({
  bigTaskId: BigTaskIdSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  repositoryHeadSha: RepositoryCommitShaSchema,
  limits: BigTaskExecutionLimitsSchema,
}).strict();
export type BigTaskExecutionApproval = z.infer<typeof BigTaskExecutionApprovalSchema>;
export type BigTaskExecutionLimits = z.infer<typeof BigTaskExecutionLimitsSchema>;

/** Explicit one-time recovery of a known failed implementation; never a budget reset. */
export const BigTaskExecutionRecoverySchema = z.object({
  bigTaskId: BigTaskIdSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  repositoryHeadSha: RepositoryCommitShaSchema,
  failedAuthorizationId: z.string().regex(/^gra_[a-f0-9]{48}$/u),
  failedExecutionRunId: ExecutionRunIdSchema,
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  model: z.literal("gpt-5.6-sol"),
  reasoningEffort: z.literal("xhigh"),
  subtaskBudgetMode: z.literal("WARNING_ONLY"),
}).strict();
export type BigTaskExecutionRecovery = z.infer<typeof BigTaskExecutionRecoverySchema>;
export const BigTaskExecutionRecoveryReviewSchema = z.object({
  request: BigTaskExecutionRecoverySchema,
  knownTokens: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ precision: 3 }),
}).strict();
const recovery = BigTaskExecutionRecoverySchema.extend({ authorizationId: z.string().regex(/^gra_[a-f0-9]{48}$/u) }).strict();

export const BigTaskExecutionAcceptanceSchema = z.object({ bigTaskId: BigTaskIdSchema, headSha: RepositoryCommitShaSchema }).strict();
const timestamp = z.string().datetime({ precision: 3 });
const integration = z.object({ subtaskId: SubtaskIdSchema.nullable(), fromSha: RepositoryCommitShaSchema, toSha: RepositoryCommitShaSchema }).strict();
export const BigTaskExecutionStatusSchema = z.object({
  bigTaskId: BigTaskIdSchema, planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  phase: z.enum(["APPROVED", "RUNNING", "PAUSED", "HUMAN_REQUIRED", "AWAITING_ACCEPTANCE", "ACCEPTED"]),
  stopReason: z.enum(["USER_PAUSED", "DAEMON_STOPPING", "CHECKPOINT_RECOVERED", "INTERRUPTED", "TIME_LIMIT_REACHED", "TOKEN_LIMIT_REACHED", "ROLE_LIMIT_REACHED", "USAGE_UNKNOWN", "GOVERNED_BLOCKED", "LOCAL_OPERATION_FAILED"]).nullable(),
  startedAt: timestamp.nullable(), expiresAt: timestamp.nullable(), limits: BigTaskExecutionLimitsSchema,
  roleCalls: z.number().int().nonnegative().max(192), knownTokens: z.number().int().nonnegative(), usageComplete: z.boolean(), activeRoleCount: z.number().int().min(0).max(1), unknownCompletedUsage: z.boolean(),
  recovery: recovery.optional(),
  resultRef: z.string().regex(/^refs\/heads\/codex\/execution\/[a-f0-9]{32}$/u), resultHeadSha: RepositoryCommitShaSchema,
  integratedSubtaskIds: z.array(SubtaskIdSchema).max(24), pendingIntegration: integration.nullable(), resultRefCreated: z.boolean(),
}).strict().refine(v => v.roleCalls <= v.limits.roleCallLimit && v.usageComplete === (v.activeRoleCount === 0 && !v.unknownCompletedUsage) && new Set(v.integratedSubtaskIds).size === v.integratedSubtaskIds.length &&
  (v.phase === "APPROVED" ? v.startedAt === null && v.expiresAt === null && v.roleCalls === 0 :
    v.startedAt !== null && v.expiresAt !== null && Date.parse(v.expiresAt) - Date.parse(v.startedAt) === v.limits.durationMilliseconds) &&
  (v.phase === "PAUSED" || v.phase === "HUMAN_REQUIRED" ? v.stopReason !== null : v.stopReason === null) &&
  (!["AWAITING_ACCEPTANCE", "ACCEPTED"].includes(v.phase) || v.resultRefCreated && v.pendingIntegration === null && v.usageComplete));
