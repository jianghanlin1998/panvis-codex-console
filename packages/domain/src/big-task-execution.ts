import { z } from "zod";
import { BigTaskIdSchema, SubtaskIdSchema, ExecutionRunIdSchema } from "./identifiers.js";
import { RepositoryCommitShaSchema } from "./implementation-checkpoint.js";
import { ExecutionProgressSchema, ExecutionUsageBreakdownSchema } from "./execution-progress.js";

export const BigTaskExecutionLimitsSchema = z.object({
  durationMilliseconds: z.number().int().min(1).max(86_400_000),
  totalTokenLimit: z.number().int().min(1).max(100_000_000),
  roleCallLimit: z.number().int().min(1).max(10_000),
  budgetMode: z.enum(["MEASURE", "HARD"]).optional(),
  repairCycleLimit: z.union([z.literal(1), z.literal(2)]),
}).strict().refine(value => value.budgetMode !== undefined || value.durationMilliseconds <= 10_800_000 && value.totalTokenLimit <= 2_880_000 && value.roleCallLimit <= 192);
export const BigTaskExecutionApprovalSchema = z.object({
  bigTaskId: BigTaskIdSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  repositoryHeadSha: RepositoryCommitShaSchema,
  limits: BigTaskExecutionLimitsSchema,
}).strict();
export type BigTaskExecutionApproval = z.infer<typeof BigTaskExecutionApprovalSchema>;
export type BigTaskExecutionLimits = z.infer<typeof BigTaskExecutionLimitsSchema>;

export const BigTaskExecutionAdjustmentValuesSchema = z.object({
  totalTokenLimit: z.number().int().min(1).max(100_000_000),
  roleCallLimit: z.number().int().min(1).max(10_000),
  budgetMode: z.enum(["MEASURE", "HARD"]),
  recoveryAttemptLimit: z.number().int().min(1).max(100),
  acknowledgedUnknownRunIds: z.array(ExecutionRunIdSchema).max(10000).optional(),
  networkAccess: z.boolean().optional(),
}).strict();
export const BigTaskExecutionAdjustmentSchema = z.object({
  bigTaskId: BigTaskIdSchema, planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedRevision: z.number().int().nonnegative(), values: BigTaskExecutionAdjustmentValuesSchema,
}).strict();
export type BigTaskExecutionAdjustment = z.infer<typeof BigTaskExecutionAdjustmentSchema>;

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
  totalBudgetMode: z.literal("WARNING_ONLY").optional(),
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
  "RESULT_CANDIDATE_REJECTED", "RESULT_CHECKPOINT_FAILED", "RESULT_USAGE_INVALID", "RESULT_SAVE_FAILED", "RESULT_RECONCILIATION_FAILED",
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
    "PLANNING_AUTHORITY_NOT_READY", "DEPENDENCY_BLOCKED", "REPOSITORY_PREFLIGHT_BLOCKED", "CONTEXT_PREFLIGHT_BLOCKED",
    "BUDGET_BLOCKED", "CONCURRENCY_BLOCKED", "WORKTREE_BLOCKED", "PROVIDER_ROLE_FAILED", "ROLE_RESULT_BLOCKED",
    "NO_ELIGIBLE_ACTION", "MANUAL_START_REQUIRED", "BUDGET_EXTENSION_REQUIRED", "REPAIR_REQA_EXHAUSTED", "AUTHORITY_BLOCKED", "REPLAN_REQUIRED",
  ]),
}).strict();
export type BigTaskControlFailure = z.infer<typeof BigTaskControlFailureSchema>;
export const hasUnacknowledgedExecutionUsage = (status: { unknownCompletedUsage: boolean; unacknowledgedUnknownUsage?: boolean | undefined }): boolean =>
  status.unacknowledgedUnknownUsage ?? status.unknownCompletedUsage;
export const executionUsageSettled = (status: { activeRoleCount: number; unknownCompletedUsage: boolean; unacknowledgedUnknownUsage?: boolean | undefined }): boolean =>
  status.activeRoleCount === 0 && !hasUnacknowledgedExecutionUsage(status);

export const executionTokenLimitReached = (state: { knownTokens: number; limits: { totalTokenLimit: number }; totalBudgetMode?: "WARNING_ONLY" | undefined }): boolean =>
  state.totalBudgetMode !== "WARNING_ONLY" && state.knownTokens >= state.limits.totalTokenLimit;

export const BigTaskExecutionAcceptanceSchema = z.object({ bigTaskId: BigTaskIdSchema, headSha: RepositoryCommitShaSchema }).strict();
export const BigTaskExecutionCloseoutSchema = BigTaskExecutionAcceptanceSchema.extend({
  reason: z.string().trim().min(1).max(2_000),
}).strict();
export type BigTaskExecutionCloseout = z.infer<typeof BigTaskExecutionCloseoutSchema>;
const timestamp = z.string().datetime({ precision: 3 });
const integration = z.object({ subtaskId: SubtaskIdSchema.nullable(), fromSha: RepositoryCommitShaSchema, toSha: RepositoryCommitShaSchema }).strict();
export const BigTaskExecutionStatusSchema = z.object({
  bigTaskId: BigTaskIdSchema, planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  phase: z.enum(["APPROVED", "RUNNING", "PAUSED", "HUMAN_REQUIRED", "AWAITING_ACCEPTANCE", "ACCEPTED", "CLOSED"]),
  closeout: z.object({ at: timestamp, reason: z.string().trim().min(1).max(2_000), productAccepted: z.literal(false) }).strict().optional(),
  stopReason: z.enum(["USER_PAUSED", "DAEMON_STOPPING", "CHECKPOINT_RECOVERED", "INTERRUPTED", "TIME_LIMIT_REACHED", "TOKEN_LIMIT_REACHED", "ROLE_LIMIT_REACHED", "USAGE_UNKNOWN", "GOVERNED_BLOCKED", "LOCAL_OPERATION_FAILED"]).nullable(),
  startedAt: timestamp.nullable(), expiresAt: timestamp.nullable(), limits: BigTaskExecutionLimitsSchema,
  roleCalls: z.number().int().nonnegative().max(10_000), knownTokens: z.number().int().nonnegative(), usageComplete: z.boolean(), activeRoleCount: z.number().int().min(0).max(1), unknownCompletedUsage: z.boolean(),
  usageBreakdown: ExecutionUsageBreakdownSchema.optional(),
  activeRole: z.object({ runId: ExecutionRunIdSchema, subtaskId: SubtaskIdSchema,
    role: z.string().min(1).max(32), usageState: z.literal("IN_PROGRESS"), progress: ExecutionProgressSchema.nullable() }).strict().optional(),
  recovery: recovery.optional(),
  totalBudgetMode: z.literal("WARNING_ONLY").optional(),
  additionalRecoveries: z.array(recovery).min(1).optional(),
  limitAdjustment: z.object({revision:z.number().int().positive(),values:BigTaskExecutionAdjustmentValuesSchema}).strict().optional(),
  windowRenewal: windowRenewal.optional(),
  additionalWindowRenewals: z.array(windowRenewal).min(1).optional(),
  unknownUsageRunIds: z.array(ExecutionRunIdSchema).max(10000).optional(),
  qaRecovery: qaRecovery.optional(), unacknowledgedUnknownUsage: z.boolean().optional(),
  lastRoleFailure: BigTaskRoleFailureSchema.extend({ at: timestamp }).strict().optional(),
  lastControlFailure: BigTaskControlFailureSchema.extend({ at: timestamp }).strict().optional(),
  resultRef: z.string().regex(/^refs\/heads\/codex\/execution\/[a-f0-9]{32}$/u), resultHeadSha: RepositoryCommitShaSchema,
  integratedSubtaskIds: z.array(SubtaskIdSchema).max(24), pendingIntegration: integration.nullable(), resultRefCreated: z.boolean(),
}).strict().refine(v => v.roleCalls <= v.limits.roleCallLimit && v.usageComplete === (v.activeRoleCount === 0 && !v.unknownCompletedUsage) && new Set(v.integratedSubtaskIds).size === v.integratedSubtaskIds.length &&
  (v.activeRole === undefined || v.activeRoleCount === 1) &&
  (v.usageBreakdown === undefined || v.usageBreakdown.completedRuns + v.activeRoleCount <= v.roleCalls) &&
  (v.totalBudgetMode === "WARNING_ONLY") === (v.limitAdjustment ? v.limitAdjustment.values.budgetMode === "MEASURE" : v.limits.budgetMode === "MEASURE" || [v.recovery, ...(v.additionalRecoveries ?? [])].some(r => r?.totalBudgetMode === "WARNING_ONLY")) &&
  (v.additionalRecoveries === undefined || v.recovery !== undefined &&
    new Set([v.recovery, ...v.additionalRecoveries].map(r => r.failedAuthorizationId)).size === v.additionalRecoveries.length + 1) &&
  (v.qaRecovery === undefined ? (v.limits.budgetMode === "MEASURE" ? v.unacknowledgedUnknownUsage !== undefined : v.unacknowledgedUnknownUsage === undefined) : v.recovery !== undefined && v.unknownCompletedUsage &&
    v.unacknowledgedUnknownUsage !== undefined && (v.limitAdjustment !== undefined || v.limits.totalTokenLimit === v.qaRecovery.knownTokenLimit)) &&
  (() => {
    if (v.phase === "APPROVED") return v.startedAt === null && v.expiresAt === null && v.roleCalls === 0 &&
      v.windowRenewal === undefined && v.additionalWindowRenewals === undefined && v.qaRecovery === undefined;
    if (v.startedAt === null || v.expiresAt === null || v.additionalWindowRenewals !== undefined && v.windowRenewal === undefined) return false;
    const windows = v.windowRenewal === undefined ? [] : [v.windowRenewal, ...(v.additionalWindowRenewals ?? [])];
    if (windows.some((window, index) => index > 0 && window.renewedAt < windows[index - 1]!.renewedAt)) return false;
    const amendments = windows.map(window => ({ ...window, at: window.renewedAt, expiredOnly: true }));
    if (v.qaRecovery !== undefined) amendments.push({ previousExpiresAt: v.qaRecovery.previousExpiresAt,
      durationMilliseconds: v.qaRecovery.durationMilliseconds, renewedAt: v.qaRecovery.authorizedAt, at: v.qaRecovery.authorizedAt, expiredOnly: false });
    amendments.sort((left, right) => left.at.localeCompare(right.at));
    let expiry = Date.parse(v.startedAt) + v.limits.durationMilliseconds;
    for (const amendment of amendments) {
      if (Date.parse(amendment.previousExpiresAt) !== expiry || amendment.at < v.startedAt ||
        amendment.expiredOnly && Date.parse(amendment.at) < expiry) return false;
      expiry = Date.parse(amendment.at) + amendment.durationMilliseconds;
    }
    return Date.parse(v.expiresAt) === expiry;
  })() &&
  (v.phase === "PAUSED" || v.phase === "HUMAN_REQUIRED" ? v.stopReason !== null : v.stopReason === null) &&
  ((v.phase === "CLOSED") === (v.closeout !== undefined)) &&
  (!["AWAITING_ACCEPTANCE", "ACCEPTED", "CLOSED"].includes(v.phase) || v.resultRefCreated && v.pendingIntegration === null && executionUsageSettled(v)));
