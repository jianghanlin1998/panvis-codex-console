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
export const BigTaskExecutionWindowRenewalSchema = z.object({
  bigTaskId: BigTaskIdSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  previousExpiresAt: z.string().datetime({ precision: 3 }),
  durationMilliseconds: z.number().int().min(1).max(10_800_000),
}).strict();
export type BigTaskExecutionWindowRenewal = z.infer<typeof BigTaskExecutionWindowRenewalSchema>;
const windowRenewal = BigTaskExecutionWindowRenewalSchema.omit({ bigTaskId: true, planDigest: true })
  .extend({ renewedAt: z.string().datetime({ precision: 3 }) }).strict();
export const BigTaskExecutionRecoveryReviewSchema = z.object({
  request: BigTaskExecutionRecoverySchema,
  knownTokens: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ precision: 3 }),
}).strict();
const recovery = BigTaskExecutionRecoverySchema.extend({ authorizationId: z.string().regex(/^gra_[a-f0-9]{48}$/u) }).strict();

export const BigTaskQaRecoverySchema = z.object({
  bigTaskId: BigTaskIdSchema, planDigest: z.string().regex(/^[a-f0-9]{64}$/u), repositoryHeadSha: RepositoryCommitShaSchema,
  failedAuthorizationId: z.string().regex(/^gra_[a-f0-9]{48}$/u), failedExecutionRunId: ExecutionRunIdSchema,
  candidateSha: RepositoryCommitShaSchema, previousExpiresAt: z.string().datetime({ precision: 3 }),
  acknowledgedKnownTokens: z.number().int().nonnegative(), acknowledgeUnknownUsage: z.literal(true),
  knownTokenLimit: z.literal(2_000_000), durationMilliseconds: z.literal(10_800_000),
}).strict();
export type BigTaskQaRecovery = z.infer<typeof BigTaskQaRecoverySchema>;
const qaRecovery = BigTaskQaRecoverySchema.extend({ authorizationId: z.string().regex(/^gra_[a-f0-9]{48}$/u), authorizedAt: z.string().datetime({ precision: 3 }) }).strict();
export const BigTaskQaRecoveryReviewSchema = z.object({ request: BigTaskQaRecoverySchema }).strict();

export const GovernedExecutionFailureCodeSchema = z.enum([
  "INVALID_INPUT", "PREFLIGHT_FAILED", "PREFLIGHT_BLOCKED", "ACTIVE_RUNTIME_REQUIRED", "APP_SERVER_START_FAILED",
  "APP_SERVER_PROTOCOL_ERROR", "APP_SERVER_TIMEOUT", "APP_SERVER_EXITED", "JSONL_LIMIT_EXCEEDED", "CHATGPT_AUTH_REQUIRED",
  "AUTH_RESPONSE_MALFORMED", "EPHEMERAL_THREAD_REQUIRED", "READ_ONLY_POLICY_REQUIRED", "TURN_FAILED", "TURN_INTERRUPTED",
  "TERMINAL_EVENT_REQUIRED", "AGENT_RESPONSE_LIMIT_EXCEEDED", "APPROVAL_REQUESTED", "TOOL_ACTION_ATTEMPTED",
  "UNEXPECTED_SERVER_REQUEST", "PROCESS_CLEANUP_FAILED", "WORKSPACE_CLEANUP_FAILED", "ACTIVE_WORKTREE_REQUIRED",
  "WORKTREE_AUTHORITY_DRIFT", "DURABLE_THREAD_PERSISTENCE_FAILED", "DURABLE_RUN_PERSISTENCE_FAILED", "PRIMARY_EXECUTION_CONFLICT",
  "WRITE_POLICY_REQUIRED", "WORKTREE_FILESYSTEM_UNSAFE", "GOVERNED_AUTHORITY_REQUIRED", "STRUCTURED_RESULT_INVALID",
]);
const diagnosticCount = z.number().int().min(0).max(1_000_000);
export const BigTaskRoleFailureSchema = z.object({
  authorizationId: z.string().regex(/^gra_[a-f0-9]{48}$/u), failureCode: GovernedExecutionFailureCodeSchema,
  phase: z.enum(["BEFORE_TURN", "TURN", "RESULT"]),
  diagnostics: z.object({ approvalRequestsDeclined: diagnosticCount, interruptRequests: diagnosticCount,
    notificationsReceived: diagnosticCount, serverRequestsReceived: diagnosticCount, toolActionsObserved: diagnosticCount,
    turnStartRequests: diagnosticCount, unknownNotificationsIgnored: diagnosticCount }).strict(),
  appServerChildCleaned: z.boolean(), transientRuntimeCleaned: z.boolean(),
}).strict();
export type BigTaskRoleFailure = z.infer<typeof BigTaskRoleFailureSchema>;
export const BigTaskControlFailureSchema = z.object({
  phase: z.enum(["CHECK_LIMITS", "PREPARE_ROLE", "EXECUTE_ROLE", "PERSIST_ROLE_FAILURE", "DELIVER", "STOP"]),
  failureCode: z.enum([
    "DATABASE_OPEN_FAILED", "DATABASE_CLOSE_FAILED", "DATABASE_CLOSED", "MIGRATION_FAILED", "INVALID_INPUT", "CONFLICT",
    "PARENT_NOT_FOUND", "DEPENDENCY_VALIDATION_FAILED", "MALFORMED_STORED_DATA", "STORAGE_OPERATION_FAILED", "TRANSACTION_FAILED",
    "INVALID_SUBTASK_ID", "TASK_HIERARCHY_UNAVAILABLE", "INELIGIBLE_SUBTASK_STATUS", "UNSUPPORTED_REPOSITORY_REFERENCE",
    "REPOSITORY_PATH_UNAVAILABLE", "NOT_GIT_REPOSITORY", "REPOSITORY_ROOT_MISMATCH", "UNSAFE_WORKTREE_ROOT", "OWNERSHIP_CONFLICT",
    "PROJECT_CAPACITY_EXCEEDED", "OWNERSHIP_COLLISION", "OWNERSHIP_NOT_ACTIVE", "OWNERSHIP_DRIFT", "ACTIVE_EXECUTION_EXISTS",
    "WORKTREE_DIRTY", "GIT_OPERATION_FAILED", "RECOVERY_REQUIRED", "MALFORMED_STORED_OWNERSHIP", "STORAGE_UNAVAILABLE", "UNCLASSIFIED",
  ]),
}).strict();
export type BigTaskControlFailure = z.infer<typeof BigTaskControlFailureSchema>;
export const hasUnacknowledgedExecutionUsage = (status: { unknownCompletedUsage: boolean; unacknowledgedUnknownUsage?: boolean | undefined }): boolean =>
  status.unacknowledgedUnknownUsage ?? status.unknownCompletedUsage;
export const executionUsageSettled = (status: { activeRoleCount: number; unknownCompletedUsage: boolean; unacknowledgedUnknownUsage?: boolean | undefined }): boolean =>
  status.activeRoleCount === 0 && !hasUnacknowledgedExecutionUsage(status);

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
  windowRenewal: windowRenewal.optional(),
  qaRecovery: qaRecovery.optional(), unacknowledgedUnknownUsage: z.boolean().optional(),
  lastRoleFailure: BigTaskRoleFailureSchema.extend({ at: timestamp }).strict().optional(),
  lastControlFailure: BigTaskControlFailureSchema.extend({ at: timestamp }).strict().optional(),
  resultRef: z.string().regex(/^refs\/heads\/codex\/execution\/[a-f0-9]{32}$/u), resultHeadSha: RepositoryCommitShaSchema,
  integratedSubtaskIds: z.array(SubtaskIdSchema).max(24), pendingIntegration: integration.nullable(), resultRefCreated: z.boolean(),
}).strict().refine(v => v.roleCalls <= v.limits.roleCallLimit && v.usageComplete === (v.activeRoleCount === 0 && !v.unknownCompletedUsage) && new Set(v.integratedSubtaskIds).size === v.integratedSubtaskIds.length &&
  (v.qaRecovery === undefined ? v.unacknowledgedUnknownUsage === undefined : v.recovery !== undefined && v.unknownCompletedUsage &&
    v.unacknowledgedUnknownUsage !== undefined && v.limits.totalTokenLimit === v.qaRecovery.knownTokenLimit) &&
  (v.phase === "APPROVED" ? v.startedAt === null && v.expiresAt === null && v.roleCalls === 0 && v.windowRenewal === undefined && v.qaRecovery === undefined :
    v.startedAt !== null && v.expiresAt !== null && (v.qaRecovery !== undefined
      ? Date.parse(v.expiresAt) - Date.parse(v.qaRecovery.authorizedAt) === v.qaRecovery.durationMilliseconds &&
        Date.parse(v.qaRecovery.previousExpiresAt) === (v.windowRenewal === undefined ? Date.parse(v.startedAt) + v.limits.durationMilliseconds : Date.parse(v.windowRenewal.renewedAt) + v.windowRenewal.durationMilliseconds)
      : v.windowRenewal === undefined
      ? Date.parse(v.expiresAt) - Date.parse(v.startedAt) === v.limits.durationMilliseconds
      : v.recovery !== undefined && Date.parse(v.windowRenewal.previousExpiresAt) - Date.parse(v.startedAt) === v.limits.durationMilliseconds &&
        Date.parse(v.windowRenewal.renewedAt) >= Date.parse(v.windowRenewal.previousExpiresAt) &&
        Date.parse(v.expiresAt) - Date.parse(v.windowRenewal.renewedAt) === v.windowRenewal.durationMilliseconds)) &&
  (v.phase === "PAUSED" || v.phase === "HUMAN_REQUIRED" ? v.stopReason !== null : v.stopReason === null) &&
  (!["AWAITING_ACCEPTANCE", "ACCEPTED"].includes(v.phase) || v.resultRefCreated && v.pendingIntegration === null && executionUsageSettled(v)));
