import { BigTaskQaRecoverySchema, BigTaskQaRecoveryReviewSchema, BigTaskExecutionWindowRenewalSchema, BigTaskExecutionRecoverySchema, BigTaskExecutionRecoveryReviewSchema, BigTaskExecutionApprovalSchema, BigTaskExecutionAcceptanceSchema, BigTaskExecutionStatusSchema, TaskContractV0Schema } from "@codex-task-console/domain";
import type { BigTaskQaRecovery, BigTaskExecutionWindowRenewal, BigTaskExecutionRecovery, BigTaskExecutionApproval } from "@codex-task-console/domain";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { hasUnambiguousJsonStructure } from "@codex-task-console/domain";
import { isUtf8 } from "node:buffer";
import { request } from "node:http";
import type { ClientRequest } from "node:http";

import {
  GOVERNED_ROLE_CODEX_EXECUTION_FAILURE_CODES,
  OWNED_WORKTREE_CODEX_EXECUTION_FAILURE_CODES,
} from "@codex-task-console/codex-adapter";
import {
  BigTaskPlanningIntakeSchema,
  PlanningBudgetExceptionSchema,
  PlanningRunRecordSchema,
  BigTaskIdSchema,
  ChatThreadIdSchema,
  ChatThreadStatusSchema,
  DEFAULT_V1_BUDGET_POLICY,
  DependencyValidationErrorCodeSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ExecutionRunStatusSchema,
  NormalizedUsageSchema,
  ProviderModelIdSchema,
  ProviderRunIdSchema,
  ProviderThreadIdSchema,
  ProjectIdSchema,
  RepositoryCommitShaSchema,
  SubtaskIdSchema,
  SubtaskMaturitySchema,
  SubtaskStatusSchema,
  WorktreeOwnershipIdSchema,
} from "@codex-task-console/domain";
import type { BigTaskId, SubtaskId, BigTaskPlanningIntake } from "@codex-task-console/domain";
import { GOVERNED_SUBTASK_ROLES } from "@codex-task-console/storage";
import type {
  AggregateSubtaskUsageBudget,
  DurableWorkflowControlView,
  DurableWorkflowHumanRequirement,
  DurableWorkflowTransition,
  GovernedBudgetExtensionAuthority,
  GovernedDispatchReceipt,
  GovernedManualStartAuthority,
  GovernedRoleAuthorization,
} from "@codex-task-console/storage";

import {
  LOCAL_CONTROL_HOST,
  localControlResponseLimitBytes,
} from "./http-server.js";
import {
  LocalStateError,
  productionLocalControlPaths,
  readSessionDescriptor,
} from "./state.js";
import type {
  LocalControlPaths,
  LocalSessionDescriptor,
} from "./state.js";

const DEFAULT_OPERATOR_TIMEOUT_MILLISECONDS = 5 * 60_000;

type ExecutionIdCommand = "execution-qa-recovery-review" | "execution-recovery-review" | "execution-review" | "execution-status" | "execution-start" | "execution-pause";
export type OperatorCommandName =
  | ExecutionIdCommand | "execution-recover-qa" | "execution-renew-window" | "execution-recover" | "execution-approve" | "execution-accept"
  | "planning-intake" | "planning-status" | "planning-run"
  | "ping"
  | "status"
  | "provision"
  | "run"
  | "release"
  | "governed-status"
  | "governed-advance"
  | "governed-manual-start"
  | "governed-budget-extension";

export type OperatorCommand =
  | { readonly name: ExecutionIdCommand; readonly bigTaskId: BigTaskId }
  | { readonly name: "execution-recover"; readonly recovery: BigTaskExecutionRecovery }
  | { readonly name: "execution-recover-qa"; readonly recovery: BigTaskQaRecovery }
  | { readonly name: "execution-renew-window"; readonly renewal: BigTaskExecutionWindowRenewal }
  | { readonly name: "execution-approve"; readonly approval: BigTaskExecutionApproval }
  | { readonly name: "execution-accept"; readonly acceptance: { bigTaskId: BigTaskId; headSha: string } }
  | { readonly name: "planning-intake"; readonly intake: BigTaskPlanningIntake }
  | { readonly name: "planning-status" | "planning-run"; readonly bigTaskId: BigTaskId }
  | { readonly name: "ping" }
  | {
      readonly name: Exclude<OperatorCommandName, ExecutionIdCommand | "execution-recover-qa" | "execution-renew-window" | "execution-recover" | "execution-approve" | "execution-accept" | "ping" | "governed-status" | "governed-advance" | "planning-intake" | "planning-status" | "planning-run">;
      readonly subtaskId: SubtaskId;
    }
  | {
      readonly name: "governed-status" | "governed-advance";
      readonly bigTaskId: BigTaskId;
    };

export interface OperatorResult {
  readonly httpStatus: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly succeeded: boolean;
}

export type LocalOperatorErrorCode =
  | "INVALID_COMMAND"
  | "SESSION_UNAVAILABLE"
  | "OPERATOR_UNAVAILABLE"
  | "OPERATOR_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_MALFORMED";

export class LocalOperatorError extends Error {
  readonly code: LocalOperatorErrorCode;

  constructor(code: LocalOperatorErrorCode) {
    super(code);
    this.name = "LocalOperatorError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readOperatorJson = (path: string): unknown => {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error();
    const bytes = readFileSync(fd);
    if (bytes.byteLength > 16_384 || !isUtf8(bytes)) throw new Error();
    const text = bytes.toString("utf8");
    if (!hasUnambiguousJsonStructure(text)) throw new Error();
    return JSON.parse(text) as unknown;
  } catch { throw new LocalOperatorError("INVALID_COMMAND"); }
  finally { if (fd !== undefined) closeSync(fd); }
};

const isPlanningStatus = (value: Readonly<Record<string, unknown>>, id: BigTaskId): boolean => {
  const exception = "budgetException" in value;
  if ((exception && !PlanningBudgetExceptionSchema.safeParse(value.budgetException).success)
    || !hasExactKeys(value, ["bigTaskId", "phase", "nextRole", "stopReason", "questions", "totalTokens", "usageComplete", "tokenLimit", "warning", "automaticRevisionsUsed", "reviewPhase", "runs", ...(exception ? ["budgetException"] : [])])
    || value.bigTaskId !== id || !["READY", "RUNNING", "APPROVED", "HUMAN_REQUIRED"].includes(value.phase as string)
    || !Array.isArray(value.runs) || value.runs.length > 6
    || !Array.isArray(value.questions) || value.questions.length > 24
    || value.questions.some((question: unknown) => typeof question !== "string" || question.length > 1_000)
    || !Number.isSafeInteger(value.totalTokens) || Number(value.totalTokens) < 0
    || !Number.isSafeInteger(value.tokenLimit) || Number(value.tokenLimit) < 1 || Number(value.tokenLimit) > 120_000
    || ![0, 1, 2].includes(value.automaticRevisionsUsed as number)
    || ![null, "AWAITING_REVIEW", "AWAITING_REVISION", "APPROVED", "HUMAN_REQUIRED"].includes(value.reviewPhase as string | null)
    || typeof value.usageComplete !== "boolean" || typeof value.warning !== "boolean") return false;
  let total = 0;
  let complete = true;
  for (const [index, run] of value.runs.entries()) {
    if (!isRecord(run) || "inputText" in run) return false;
    const parsed = PlanningRunRecordSchema.safeParse({ ...run, inputText: "summary" });
    if (!parsed.success || parsed.data.sequence !== index + 1
      || parsed.data.role !== (index % 2 === 0 ? "PLANNER" : "REVIEWER")
      || (index < value.runs.length - 1 && parsed.data.status !== "COMPLETED")) return false;
    total += parsed.data.normalizedUsage?.totalTokens ?? 0;
    complete &&= parsed.data.normalizedUsage?.totalTokens !== undefined;
  }
  const last = value.runs.at(-1) as Record<string, unknown> | undefined;
  return total === value.totalTokens && complete === value.usageComplete
    && value.warning === (total >= Math.min(80_000, Number(value.tokenLimit)))
    && (value.phase === "READY" ? ["PLANNER", "REVIEWER"].includes(value.nextRole as string) : value.nextRole === null)
    && (value.phase === "RUNNING") === (last?.status === "RUNNING")
    && (value.phase === "HUMAN_REQUIRED" ? ["PRODUCT_QUESTION", "REVIEW_ESCALATED", "PLAN_REVIEW_EXHAUSTED", "PROVIDER_FAILED", "INVALID_OUTPUT", "USAGE_UNKNOWN", "BUDGET_BLOCKED", "TIME_LIMIT_REACHED", "CONTEXT_CHANGED", "CONTEXT_LIMIT", "INTERRUPTED"].includes(value.stopReason as string) : value.stopReason === null)
    && (value.phase !== "APPROVED" || (value.reviewPhase === "APPROVED" && last?.role === "REVIEWER" && last.status === "COMPLETED" && complete && (exception || total < Number(value.tokenLimit))))
    && (value.phase !== "READY" || (complete && (exception || total < Number(value.tokenLimit)) && value.runs.length < 6
      && value.nextRole === (value.reviewPhase === "AWAITING_REVIEW" ? "REVIEWER" : "PLANNER")
      && [null, "AWAITING_REVIEW", "AWAITING_REVISION"].includes(value.reviewPhase as string | null)));
};

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const schemaMatchesExactly = (
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  value: unknown,
): boolean => {
  const result = schema.safeParse(value);
  return result.success && result.data === value;
};

const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const nullableSchemaMatchesExactly = (
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  value: unknown,
): boolean => value === null || schemaMatchesExactly(schema, value);

const OWNED_WORKTREE_FAILURE_CODES = new Set<string>(
  OWNED_WORKTREE_CODEX_EXECUTION_FAILURE_CODES,
);

const isRunSummary = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "status",
      "providerRunId",
      "providerModelId",
      "normalizedUsage",
      "createdAt",
      "updatedAt",
    ])
  ) {
    return false;
  }
  return (
    schemaMatchesExactly(ExecutionRunIdSchema, value.id) &&
    ExecutionRunStatusSchema.safeParse(value.status).success &&
    nullableSchemaMatchesExactly(ProviderRunIdSchema, value.providerRunId) &&
    nullableSchemaMatchesExactly(ProviderModelIdSchema, value.providerModelId) &&
    (value.normalizedUsage === null ||
      NormalizedUsageSchema.safeParse(value.normalizedUsage).success) &&
    isCanonicalTimestamp(value.createdAt) &&
    isCanonicalTimestamp(value.updatedAt)
  );
};

const isThreadSummary = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "status",
      "providerId",
      "createdAt",
      "updatedAt",
      "runs",
    ]) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 8
  ) {
    return false;
  }
  return (
    schemaMatchesExactly(ChatThreadIdSchema, value.id) &&
    ChatThreadStatusSchema.safeParse(value.status).success &&
    schemaMatchesExactly(ExecutionProviderIdSchema, value.providerId) &&
    isCanonicalTimestamp(value.createdAt) &&
    isCanonicalTimestamp(value.updatedAt) &&
    value.runs.every(isRunSummary)
  );
};

const isInspectionResponse = (
  value: Readonly<Record<string, unknown>>,
  subtaskId: SubtaskId,
): boolean => {
  if (
    !hasExactKeys(value, [
      "subtask",
      "dependencyReadiness",
      "worktree",
      "durableExecution",
    ]) ||
    !isRecord(value.subtask) ||
    !hasExactKeys(value.subtask, ["id", "status", "maturity"]) ||
    value.subtask.id !== subtaskId ||
    !schemaMatchesExactly(SubtaskStatusSchema, value.subtask.status) ||
    !schemaMatchesExactly(SubtaskMaturitySchema, value.subtask.maturity) ||
    !isRecord(value.dependencyReadiness) ||
    !hasExactKeys(value.dependencyReadiness, [
      "valid",
      "ready",
      "blockerCount",
      "errorCodes",
    ]) ||
    typeof value.dependencyReadiness.valid !== "boolean" ||
    typeof value.dependencyReadiness.ready !== "boolean" ||
    !Number.isSafeInteger(value.dependencyReadiness.blockerCount) ||
    (value.dependencyReadiness.blockerCount as number) < 0 ||
    !Array.isArray(value.dependencyReadiness.errorCodes) ||
    !value.dependencyReadiness.errorCodes.every((code) =>
      schemaMatchesExactly(DependencyValidationErrorCodeSchema, code),
    )
  ) {
    return false;
  }
  if (value.worktree !== null) {
    if (
      !isRecord(value.worktree) ||
      !hasExactKeys(value.worktree, [
        "id",
        "status",
        "activeAuthorityVerified",
      ]) ||
      !schemaMatchesExactly(WorktreeOwnershipIdSchema, value.worktree.id) ||
      !["PROVISIONING", "ACTIVE", "RELEASING", "RELEASED", "FAILED"].includes(
        value.worktree.status as string,
      ) ||
      typeof value.worktree.activeAuthorityVerified !== "boolean"
    ) {
      return false;
    }
  }
  if (
    !isRecord(value.durableExecution) ||
    !hasExactKeys(value.durableExecution, [
      "chatThreadCount",
      "returnedChatThreadCount",
      "recentChatThreads",
    ]) ||
    !Number.isSafeInteger(value.durableExecution.chatThreadCount) ||
    !Number.isSafeInteger(value.durableExecution.returnedChatThreadCount) ||
    (value.durableExecution.chatThreadCount as number) < 0 ||
    (value.durableExecution.returnedChatThreadCount as number) < 0 ||
    !Array.isArray(value.durableExecution.recentChatThreads) ||
    value.durableExecution.recentChatThreads.length > 8 ||
    value.durableExecution.returnedChatThreadCount !==
      value.durableExecution.recentChatThreads.length ||
    (value.durableExecution.chatThreadCount as number) <
      (value.durableExecution.returnedChatThreadCount as number)
  ) {
    return false;
  }
  return value.durableExecution.recentChatThreads.every(isThreadSummary);
};

const isWorktreeResponse = (
  value: Readonly<Record<string, unknown>>,
  expectedStatus: "ACTIVE" | "RELEASED",
): boolean => {
  if (
    !hasExactKeys(value, ["worktree"]) ||
    !isRecord(value.worktree) ||
    !hasExactKeys(value.worktree, [
      "id",
      "status",
      "startingCommitSha",
      "releaseHeadSha",
    ])
  ) {
    return false;
  }
  return (
    schemaMatchesExactly(WorktreeOwnershipIdSchema, value.worktree.id) &&
    value.worktree.status === expectedStatus &&
    typeof value.worktree.startingCommitSha === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(
      value.worktree.startingCommitSha,
    ) &&
    (expectedStatus === "ACTIVE"
      ? value.worktree.releaseHeadSha === null
      : typeof value.worktree.releaseHeadSha === "string" &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(
          value.worktree.releaseHeadSha,
        ))
  );
};

const isExecutionResponse = (
  value: Readonly<Record<string, unknown>>,
): boolean => {
  if (
    !hasExactKeys(value, ["execution"]) ||
    !isRecord(value.execution) ||
    !hasExactKeys(value.execution, [
      "success",
      "failureCode",
      "chatThreadId",
      "executionRunId",
      "worktreeOwnershipId",
      "providerId",
      "providerThreadId",
      "providerRunId",
      "providerModelId",
      "normalizedUsage",
      "terminalTurnStatus",
      "appServerChildCleaned",
      "transientRuntimeCleaned",
    ]) ||
    typeof value.execution.success !== "boolean" ||
    value.execution.providerId !== "codex-app-server" ||
    !nullableSchemaMatchesExactly(
      ProviderThreadIdSchema,
      value.execution.providerThreadId,
    ) ||
    !nullableSchemaMatchesExactly(
      ProviderRunIdSchema,
      value.execution.providerRunId,
    ) ||
    !nullableSchemaMatchesExactly(
      ProviderModelIdSchema,
      value.execution.providerModelId,
    ) ||
    (value.execution.normalizedUsage !== null &&
      !NormalizedUsageSchema.safeParse(value.execution.normalizedUsage).success) ||
    ![null, "completed", "failed", "interrupted"].includes(
      value.execution.terminalTurnStatus as string | null,
    ) ||
    typeof value.execution.appServerChildCleaned !== "boolean" ||
    typeof value.execution.transientRuntimeCleaned !== "boolean"
  ) {
    return false;
  }
  const idOrNull = (
    schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
    candidate: unknown,
  ): boolean => candidate === null || schemaMatchesExactly(schema, candidate);
  if (
    !idOrNull(ChatThreadIdSchema, value.execution.chatThreadId) ||
    !idOrNull(ExecutionRunIdSchema, value.execution.executionRunId) ||
    !idOrNull(
      WorktreeOwnershipIdSchema,
      value.execution.worktreeOwnershipId,
    )
  ) {
    return false;
  }
  return value.execution.success
    ? value.execution.failureCode === null &&
        value.execution.chatThreadId !== null &&
        value.execution.executionRunId !== null &&
        value.execution.worktreeOwnershipId !== null
    : typeof value.execution.failureCode === "string" &&
        OWNED_WORKTREE_FAILURE_CODES.has(value.execution.failureCode);
};

const isErrorResponse = (value: Readonly<Record<string, unknown>>): boolean =>
  hasExactKeys(value, ["error"]) &&
  isRecord(value.error) &&
  hasExactKeys(value.error, ["code"]) &&
  typeof value.error.code === "string" &&
  value.error.code.length <= 128 &&
  /^[A-Z][A-Z0-9_]*$/u.test(value.error.code);

// These are client wire-shape checks, not workflow eligibility decisions.
// Typed field maps keep every field of the existing storage contracts explicit.
type WireCheck = (value: unknown) => boolean;
type WireFields<T> = { readonly [K in keyof T]-?: WireCheck };
const matchesFields = (
  value: unknown, fields: Readonly<Record<string, WireCheck>>,
): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && hasExactKeys(value, Object.keys(fields)) &&
  Object.entries(fields).every(([key, check]) => check(value[key]));
const wireText: WireCheck = value => typeof value === "string" && value.length > 0 &&
  value.trim() === value && !/[\ud800-\udfff]/u.test(value) && Array.from(value).every(character => {
    const code = character.codePointAt(0)!;
    return (code >= 32 || code === 9 || code === 10 || code === 13) && (code < 127 || code > 159);
  });
const wireBoolean: WireCheck = value => typeof value === "boolean";
const wireCount: WireCheck = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const wirePositive: WireCheck = value => wireCount(value) && value !== 0;
const oneOf = (...values: readonly unknown[]): WireCheck => value => values.includes(value);
const nullable = (check: WireCheck): WireCheck => value => value === null || check(value);
const arrayOf = (check: WireCheck): WireCheck => value => Array.isArray(value) && value.every(check);
const canonical = (schema: Parameters<typeof schemaMatchesExactly>[0]): WireCheck =>
  value => schemaMatchesExactly(schema, value);
const wireRole = oneOf(...GOVERNED_SUBTASK_ROLES);
const wireStage = oneOf("PLAN", "REVIEW", "MATERIALIZE", ...GOVERNED_SUBTASK_ROLES, "COMPLETE");
const wireProfile = oneOf("LOW", "STANDARD", "HIGH_RISK_FOUNDATION");
const ownerFields = {
  projectId: canonical(ProjectIdSchema), bigTaskId: canonical(BigTaskIdSchema),
  planRevision: wirePositive, candidateBinding: wireText, subtaskId: canonical(SubtaskIdSchema),
};
const manualAuthorityFields = {
  ...ownerFields, authorityId: wireText, workflowSequence: wireCount, authorizedAt: isCanonicalTimestamp,
} satisfies WireFields<GovernedManualStartAuthority>;
const extensionAuthorityFields = {
  ...ownerFields, authorityId: wireText, grantedTokens: oneOf(40_000), authorizedAt: isCanonicalTimestamp,
} satisfies WireFields<GovernedBudgetExtensionAuthority>;
const budgetFields = {
  status: oneOf("AVAILABLE", "AVAILABLE_WARNING", "HARD_PAUSE", "ABSOLUTE_CEILING", "UNKNOWN_USAGE"),
  allowed: wireBoolean, totalTokens: nullable(wireCount), warning: wireBoolean,
  extensionApplied: wireBoolean, effectiveLimitTokens: oneOf(120_000, 160_000),
} satisfies WireFields<Omit<AggregateSubtaskUsageBudget, "scope" | "subtaskKnownTokens" | "totalBudgetMode">>;
const isGovernedBudget: WireCheck = value => {
  if (isRecord(value) && value.scope === "BIG_TASK") {
    if (!matchesFields(value, { ...budgetFields, scope: oneOf("BIG_TASK"), effectiveLimitTokens: wireCount,
      ...("subtaskKnownTokens" in value ? { subtaskKnownTokens: wireCount } : {}),
      ...("totalBudgetMode" in value ? { totalBudgetMode: oneOf("WARNING_ONLY") } : {}) }) ||
      typeof value.effectiveLimitTokens !== "number" || value.effectiveLimitTokens < 1 || value.effectiveLimitTokens > 2_880_000 ||
      typeof value.totalTokens !== "number" || value.extensionApplied !== false) return false;
    const warningTokens = value.subtaskKnownTokens ?? value.totalTokens;
    if (typeof warningTokens !== "number" || warningTokens > value.totalTokens) return false;
    const allowed = value.totalBudgetMode === "WARNING_ONLY" || value.totalTokens < value.effectiveLimitTokens;
    const warning = warningTokens >= 120_000 || value.totalBudgetMode === "WARNING_ONLY" && value.totalTokens >= value.effectiveLimitTokens;
    return value.allowed === allowed && value.warning === warning &&
      value.status === (!allowed ? "ABSOLUTE_CEILING" : warning ? "AVAILABLE_WARNING" : "AVAILABLE");
  }
  if (!matchesFields(value, budgetFields)) return false;
  const policy = DEFAULT_V1_BUDGET_POLICY.subtask;
  if (value.status === "UNKNOWN_USAGE") {
    return value.allowed === false && value.totalTokens === null && value.warning === false &&
      value.extensionApplied === false && value.effectiveLimitTokens === policy.hardPauseTokens;
  }
  if (typeof value.totalTokens !== "number") return false;
  const limit = value.extensionApplied ? policy.absoluteContinuationCeilingTokens : policy.hardPauseTokens;
  const allowed = value.totalTokens < limit;
  const warning = value.totalTokens >= policy.warningTokens;
  const status = value.totalTokens >= policy.absoluteContinuationCeilingTokens ? "ABSOLUTE_CEILING"
    : !allowed ? "HARD_PAUSE" : warning ? "AVAILABLE_WARNING" : "AVAILABLE";
  return value.effectiveLimitTokens === limit && value.allowed === allowed &&
    value.warning === warning && value.status === status;
};
const receiptFields = {
  ...ownerFields, receiptId: wireText, operationId: wireText, workflowSequence: wireCount,
  profile: wireProfile, writeEnabled: wireBoolean, startPolicy: oneOf("MANUAL", "WHEN_READY"),
  manualStartAuthorityId: nullable(wireText), worktreeOwnershipId: canonical(WorktreeOwnershipIdSchema),
  gateEvidenceReferences: arrayOf(wireText), status: oneOf("RESERVED", "ACTIVE", "COMPLETED", "HUMAN_REQUIRED"),
  reservedAt: isCanonicalTimestamp, updatedAt: isCanonicalTimestamp, terminalAt: nullable(isCanonicalTimestamp),
} satisfies WireFields<GovernedDispatchReceipt>;
const authorizationFields = {
  ...ownerFields, authorizationId: wireText, dispatchReceiptId: wireText, workflowSequence: wireCount,
  workflowStage: wireRole, repairCyclesUsed: oneOf(0, 1, 2), role: wireRole,
  contextProfile: oneOf("STANDARD_SUBTASK_EXECUTION", "FRESH_INDEPENDENT_QA", "FOCUSED_RE_QA"),
  writeEnabled: wireBoolean, worktreeOwnershipId: canonical(WorktreeOwnershipIdSchema),
  candidateSha: canonical(RepositoryCommitShaSchema), authorizedAt: isCanonicalTimestamp,
} satisfies WireFields<GovernedRoleAuthorization>;
const wireEvidenceReference: WireCheck = value => matchesFields(value, {
  sourceType: oneOf("WORKFLOW_EVIDENCE", "IMPLEMENTATION_CHECKPOINT", "CANONICAL_MATERIALIZATION", "PERSISTED_DEPENDENCY_READINESS"),
  sourceReference: wireText,
});
const transitionFields = {
  ...ownerFields, operationId: wireText, sequence: wirePositive,
  priorStage: wireStage, resultingStage: wireStage,
  priorRepairCyclesUsed: oneOf(0, 1, 2), resultingRepairCyclesUsed: oneOf(0, 1, 2),
  evidenceReferences: arrayOf(wireEvidenceReference), occurredAt: isCanonicalTimestamp,
} satisfies WireFields<DurableWorkflowTransition>;
const humanFields = {
  ...ownerFields, subtaskId: nullable(canonical(SubtaskIdSchema)), operationId: wireText,
  scope: oneOf("BIG_TASK", "SUBTASK"), sequence: nullable(wireCount),
  currentStage: nullable(wireStage), requestedNextStage: nullable(wireStage), repairCyclesUsed: oneOf(null, 0, 1, 2),
  reason: oneOf("REPLAN_REQUIRED", "REPAIR_REQA_EXHAUSTED", "AUTHORITY_BLOCKED"),
  evidenceReferences: arrayOf(wireEvidenceReference), sourceReference: wireText, createdAt: isCanonicalTimestamp,
} satisfies WireFields<DurableWorkflowHumanRequirement>;
const workflowFields = {
  ...ownerFields, profile: wireProfile, writeEnabled: wireBoolean,
  initialStage: oneOf("MATERIALIZE", "EXECUTE"), initializedAt: isCanonicalTimestamp,
  currentStage: wireStage, initialRepairCyclesUsed: oneOf(0), repairCyclesUsed: oneOf(0, 1, 2),
  boardStatus: canonical(SubtaskStatusSchema), deliveryMaturity: canonical(SubtaskMaturitySchema),
  transitionCount: wireCount, transitions: arrayOf(value => matchesFields(value, transitionFields)),
  unresolvedHumanRequired: nullable(value => matchesFields(value, humanFields)),
} satisfies WireFields<DurableWorkflowControlView>;
const sameFields = (
  left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>, keys: readonly string[],
): boolean => keys.every(key => left[key] === right[key]);
const sameOwner = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean =>
  sameFields(left, right, Object.keys(ownerFields));

const isGovernedInspection = (value: Readonly<Record<string, unknown>>, bigTaskId: BigTaskId): boolean => {
  if (!matchesFields(value, {
    bigTaskId: canonical(BigTaskIdSchema), status: oneOf("IN_PROGRESS", "DONE"),
    candidateBinding: nullable(wireText), workflows: arrayOf(item => matchesFields(item, workflowFields)),
    budgets: arrayOf(isGovernedBudget),
    dispatchReceipts: arrayOf(item => matchesFields(item, receiptFields)),
  }) || value.bigTaskId !== bigTaskId || !Array.isArray(value.workflows) ||
    !Array.isArray(value.budgets) || !Array.isArray(value.dispatchReceipts)) return false;
  const workflows = value.workflows as readonly Readonly<Record<string, unknown>>[];
  const receipts = value.dispatchReceipts as readonly Readonly<Record<string, unknown>>[];
  if (value.budgets.length !== workflows.length || new Set(workflows.map(item => item.subtaskId)).size !== workflows.length) return false;
  if (["receiptId", "subtaskId"].some(key => new Set(receipts.map(item => item[key])).size !== receipts.length)) return false;
  if (value.status === "DONE" && (value.candidateBinding === null || workflows.length === 0 ||
    !workflows.every(workflow => workflow.currentStage === "COMPLETE" && workflow.boardStatus === "DONE" &&
      workflow.unresolvedHumanRequired === null && receipts.some(receipt =>
        sameOwner(receipt, workflow) && receipt.status === "COMPLETED")))) return false;
  return workflows.every(workflow =>
    workflow.bigTaskId === bigTaskId && workflow.candidateBinding === value.candidateBinding &&
    sameFields(workflow, workflows[0]!, ["projectId", "planRevision"]) &&
    Array.isArray(workflow.transitions) && workflow.transitionCount === workflow.transitions.length &&
    workflow.transitions.every((transition: unknown) => isRecord(transition) && sameOwner(transition, workflow)) &&
    (workflow.unresolvedHumanRequired === null || (isRecord(workflow.unresolvedHumanRequired) &&
      sameFields(workflow.unresolvedHumanRequired, workflow, ["projectId", "bigTaskId", "planRevision", "candidateBinding"]) &&
      (workflow.unresolvedHumanRequired.scope === "BIG_TASK"
        ? workflow.unresolvedHumanRequired.subtaskId === null
        : workflow.unresolvedHumanRequired.subtaskId === workflow.subtaskId)))) &&
    receipts.every(receipt =>
      workflows.some(workflow => sameOwner(receipt, workflow)));
};

const isGovernedAdvance = (value: Readonly<Record<string, unknown>>, bigTaskId: BigTaskId): boolean => {
  if (!hasExactKeys(value, ["prepared", "execution"]) || !isRecord(value.prepared)) return false;
  const prepared = value.prepared;
  if (prepared.kind === "BLOCKED" || prepared.kind === "HUMAN_REQUIRED") {
    return value.execution === null && matchesFields(prepared, {
      kind: oneOf("BLOCKED", "HUMAN_REQUIRED"), subtaskId: nullable(canonical(SubtaskIdSchema)),
      reason: prepared.kind === "BLOCKED"
        ? oneOf("PLANNING_AUTHORITY_NOT_READY", "DEPENDENCY_BLOCKED", "REPOSITORY_PREFLIGHT_BLOCKED", "CONTEXT_PREFLIGHT_BLOCKED",
          "BUDGET_BLOCKED", "CONCURRENCY_BLOCKED", "WORKTREE_BLOCKED", "PROVIDER_ROLE_FAILED", "ROLE_RESULT_BLOCKED", "NO_ELIGIBLE_ACTION")
        : oneOf("MANUAL_START_REQUIRED", "BUDGET_EXTENSION_REQUIRED", "REPAIR_REQA_EXHAUSTED", "AUTHORITY_BLOCKED", "REPLAN_REQUIRED"),
    });
  }
  if (prepared.kind === "BIG_TASK_COMPLETE") {
    return value.execution === null && matchesFields(prepared, {
      kind: oneOf("BIG_TASK_COMPLETE"), bigTaskId: canonical(BigTaskIdSchema), completionReceiptId: wireText,
    }) && prepared.bigTaskId === bigTaskId;
  }
  if (prepared.kind !== "ROLE_AUTHORIZED" && prepared.kind !== "ROLE_IN_PROGRESS") return false;
  const fields = {
    kind: oneOf("ROLE_AUTHORIZED", "ROLE_IN_PROGRESS"),
    authorization: (item: unknown) => matchesFields(item, authorizationFields),
    receipt: (item: unknown) => matchesFields(item, receiptFields),
  };
  if (!matchesFields(prepared, prepared.kind === "ROLE_AUTHORIZED" ? {
    ...fields, budget: isGovernedBudget,
  } : {
    ...fields, executionRunId: canonical(ExecutionRunIdSchema), runStatus: oneOf("CREATED", "RUNNING"),
  }) || !isRecord(prepared.authorization) || !isRecord(prepared.receipt)) return false;
  const authorization = prepared.authorization;
  const writes = ["EXECUTE", "HARDEN", "REPAIR"].includes(String(authorization.role));
  const contextProfile = authorization.role === "FRESH_QA" ? "FRESH_INDEPENDENT_QA"
    : authorization.role === "FOCUSED_RE_QA" ? "FOCUSED_RE_QA" : "STANDARD_SUBTASK_EXECUTION";
  if (authorization.bigTaskId !== bigTaskId || !sameOwner(authorization, prepared.receipt) ||
    authorization.dispatchReceiptId !== prepared.receipt.receiptId || authorization.role !== authorization.workflowStage ||
    authorization.writeEnabled !== (writes && prepared.receipt.writeEnabled === true) ||
    authorization.contextProfile !== contextProfile ||
    authorization.worktreeOwnershipId !== prepared.receipt.worktreeOwnershipId) return false;
  if (prepared.kind === "ROLE_IN_PROGRESS") return value.execution === null;
  const execution = value.execution;
  if (!matchesFields(execution, {
    success: wireBoolean, failureCode: nullable(oneOf(...GOVERNED_ROLE_CODEX_EXECUTION_FAILURE_CODES)),
    authorizationId: nullable(wireText), role: nullable(wireRole), executionRunId: nullable(canonical(ExecutionRunIdSchema)),
    outcome: oneOf(null, "READY", "BLOCKED", "PASS", "BLOCKING_FAIL"),
    reconciliationKind: oneOf(null, "TRANSITION_RECORDED", "HUMAN_REQUIRED", "ROLE_RESULT_BLOCKED"),
  })) return false;
  if ((execution.authorizationId !== null && execution.authorizationId !== authorization.authorizationId) ||
    (execution.role !== null && execution.role !== authorization.role)) return false;
  const hasIdentity = execution.authorizationId !== null;
  if ((execution.role !== null) !== hasIdentity || (execution.executionRunId !== null) !== hasIdentity ||
    (execution.outcome !== null && !hasIdentity) ||
    (execution.reconciliationKind !== null && execution.outcome === null)) return false;
  const producesImplementation = authorization.role === "EXECUTE" || authorization.role === "REPAIR";
  if (execution.outcome !== null && !(producesImplementation ? ["READY", "BLOCKED"] : ["PASS", "BLOCKING_FAIL"])
    .includes(String(execution.outcome))) return false;
  return execution.success
    ? execution.failureCode === null && execution.authorizationId !== null && execution.role !== null &&
      execution.executionRunId !== null && execution.outcome !== null && execution.reconciliationKind !== null
    : execution.failureCode !== null;
};

const governedAdvanceSucceeded = (value: Readonly<Record<string, unknown>>): boolean =>
  isRecord(value.prepared) && (value.prepared.kind === "BIG_TASK_COMPLETE" ||
    (value.prepared.kind === "ROLE_AUTHORIZED" && isRecord(value.execution) && value.execution.success === true &&
      value.execution.reconciliationKind === "TRANSITION_RECORDED" &&
      (value.execution.outcome === "READY" || value.execution.outcome === "PASS")));

const isExecutionReview = (value: Readonly<Record<string, unknown>>, id: BigTaskId): boolean => {
  if (!hasExactKeys(value, ["bigTaskId", "planDigest", "repositoryHeadSha", "candidate", "taskContracts", "executionIssues", "confirmation"]) ||
    !Array.isArray(value.executionIssues) || value.executionIssues.length > 24 || value.executionIssues.some(issue =>
      !isRecord(issue) || !hasExactKeys(issue, ["code", "subtaskId"]) || issue.code !== "DEPENDENCY_PROFILE_CONFLICT" || !schemaMatchesExactly(SubtaskIdSchema, issue.subtaskId)) ||
    value.bigTaskId !== id || value.confirmation !== "HANLIN_EXECUTION_APPROVAL_REQUIRED" ||
    typeof value.planDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.planDigest) ||
    !RepositoryCommitShaSchema.safeParse(value.repositoryHeadSha).success || !isRecord(value.candidate) || !Array.isArray(value.taskContracts)) return false;
  const plan = value.candidate;
  if (!hasExactKeys(plan, ["kind", "projectId", "bigTaskId", "revision", "subtasks", "dependencies"]) || plan.kind !== "PLAN_CANDIDATE" || plan.bigTaskId !== id ||
    !schemaMatchesExactly(ProjectIdSchema, plan.projectId) || !Number.isSafeInteger(plan.revision) || Number(plan.revision) < 1 ||
    !Array.isArray(plan.subtasks) || plan.subtasks.length < 1 || plan.subtasks.length > 24 ||
    !Array.isArray(plan.dependencies) || plan.dependencies.length > 64 || value.taskContracts.length !== plan.subtasks.length) return false;
  const ids = new Set<string>();
  for (const [index, task] of plan.subtasks.entries()) {
    if (!isRecord(task) || !hasExactKeys(task, ["id", "bigTaskId", "profile", "taskContractRef", "writeEnabled"]) || task.bigTaskId !== id ||
      !schemaMatchesExactly(SubtaskIdSchema, task.id) || !["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"].includes(String(task.profile)) ||
      typeof task.taskContractRef !== "string" || typeof task.writeEnabled !== "boolean" || ids.has(String(task.id))) return false;
    ids.add(String(task.id));
    const parsed = TaskContractV0Schema.safeParse(value.taskContracts[index]);
    if (!parsed.success || parsed.data.subtaskId !== task.id || parsed.data.bigTaskId !== id || parsed.data.projectId !== plan.projectId || parsed.data.taskContractRef !== task.taskContractRef) return false;
  }
  return plan.dependencies.every(edge => isRecord(edge) && hasExactKeys(edge, ["upstreamSubtaskId", "downstreamSubtaskId", "dependencyType", "requiredGate", "reason"]) &&
    ids.has(String(edge.upstreamSubtaskId)) && ids.has(String(edge.downstreamSubtaskId)) && edge.upstreamSubtaskId !== edge.downstreamSubtaskId &&
    ["BLOCKING", "INFORMATIONAL"].includes(String(edge.dependencyType)) && ["NONE", "HARDENED", "ACCEPTED"].includes(String(edge.requiredGate)) && wireText(edge.reason));
};

const validateResponseShape = (
  command: OperatorCommand,
  status: number,
  value: Readonly<Record<string, unknown>>,
): boolean => {
  if (status < 200 || status >= 300) {
    return isErrorResponse(value);
  }
  if (status !== 200) {
    return false;
  }
  switch (command.name) {
    case "execution-qa-recovery-review": return BigTaskQaRecoveryReviewSchema.safeParse(value).success && BigTaskQaRecoveryReviewSchema.parse(value).request.bigTaskId === command.bigTaskId;
    case "execution-recover-qa": {
      const parsed = BigTaskExecutionStatusSchema.safeParse(value);
      if (!parsed.success || parsed.data.qaRecovery === undefined) return false;
      const request = Object.fromEntries(Object.entries(parsed.data.qaRecovery).filter(([key]) => !["authorizationId", "authorizedAt"].includes(key)));
      return JSON.stringify(BigTaskQaRecoverySchema.parse(request)) === JSON.stringify(command.recovery);
    }
    case "execution-recovery-review": return BigTaskExecutionRecoveryReviewSchema.safeParse(value).success &&
      BigTaskExecutionRecoveryReviewSchema.parse(value).request.bigTaskId === command.bigTaskId;
    case "execution-renew-window": {
      const parsed = BigTaskExecutionStatusSchema.safeParse(value);
      return parsed.success && parsed.data.bigTaskId === command.renewal.bigTaskId && parsed.data.planDigest === command.renewal.planDigest &&
        parsed.data.windowRenewal?.previousExpiresAt === command.renewal.previousExpiresAt &&
        parsed.data.windowRenewal.durationMilliseconds === command.renewal.durationMilliseconds;
    }
    case "execution-recover": {
      const parsed = BigTaskExecutionStatusSchema.safeParse(value);
      if (!parsed.success || parsed.data.recovery === undefined) return false;
      const recorded = [parsed.data.recovery, ...(parsed.data.additionalRecoveries ?? [])].find(r => r.failedAuthorizationId === command.recovery.failedAuthorizationId);
      if (recorded === undefined) return false;
      const request = Object.fromEntries(Object.entries(recorded).filter(([key]) => key !== "authorizationId"));
      return JSON.stringify(BigTaskExecutionRecoverySchema.parse(request)) === JSON.stringify(command.recovery);
    }
    case "execution-review": return isExecutionReview(value, command.bigTaskId);
    case "execution-status":
    case "execution-start":
    case "execution-pause": return BigTaskExecutionStatusSchema.safeParse(value).success && value.bigTaskId === command.bigTaskId;
    case "execution-approve": return BigTaskExecutionStatusSchema.safeParse(value).success && value.bigTaskId === command.approval.bigTaskId &&
      value.planDigest === command.approval.planDigest && JSON.stringify(BigTaskExecutionStatusSchema.parse(value).limits) === JSON.stringify(command.approval.limits);
    case "execution-accept": return BigTaskExecutionStatusSchema.safeParse(value).success && value.bigTaskId === command.acceptance.bigTaskId &&
      value.resultHeadSha === command.acceptance.headSha && value.phase === "ACCEPTED";
    case "planning-intake":
      return isPlanningStatus(value, command.intake.bigTask.id);
    case "planning-status":
    case "planning-run":
      return isPlanningStatus(value, command.bigTaskId);
    case "ping":
      return (
        hasExactKeys(value, ["ok", "schemaVersion"]) &&
        value.ok === true &&
        value.schemaVersion === 1
      );
    case "status":
      return isInspectionResponse(value, command.subtaskId);
    case "provision":
      return isWorktreeResponse(value, "ACTIVE");
    case "run":
      return isExecutionResponse(value);
    case "release":
      return isWorktreeResponse(value, "RELEASED");
    case "governed-status":
      return isGovernedInspection(value, command.bigTaskId);
    case "governed-advance":
      return isGovernedAdvance(value, command.bigTaskId);
    case "governed-manual-start":
      return matchesFields(value, manualAuthorityFields) && value.subtaskId === command.subtaskId;
    case "governed-budget-extension":
      return matchesFields(value, extensionAuthorityFields) && value.subtaskId === command.subtaskId;
  }
};

const parseSubtaskId = (value: string): SubtaskId => {
  const parsed = SubtaskIdSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    throw new LocalOperatorError("INVALID_COMMAND");
  }
  return parsed.data;
};

export const parseOperatorCommand = (
  arguments_: readonly string[],
): OperatorCommand => {
  const [command, subtaskId, ...extra] = arguments_;
  if (extra.length !== 0) {
    throw new LocalOperatorError("INVALID_COMMAND");
  }
  if (command === "planning-intake" && subtaskId !== undefined) {
    try { return { name: "planning-intake", intake: BigTaskPlanningIntakeSchema.parse(readOperatorJson(subtaskId)) }; }
    catch { throw new LocalOperatorError("INVALID_COMMAND"); }
  }
  if (command === "execution-recover" && subtaskId !== undefined) {
    try { return { name: command, recovery: BigTaskExecutionRecoverySchema.parse(readOperatorJson(subtaskId)) }; }
    catch { throw new LocalOperatorError("INVALID_COMMAND"); }
  }
  if (command === "execution-recover-qa" && subtaskId !== undefined) {
    try { return { name: command, recovery: BigTaskQaRecoverySchema.parse(readOperatorJson(subtaskId)) }; }
    catch { throw new LocalOperatorError("INVALID_COMMAND"); }
  }
  if (command === "execution-renew-window" && subtaskId !== undefined) {
    try { return { name: command, renewal: BigTaskExecutionWindowRenewalSchema.parse(readOperatorJson(subtaskId)) }; }
    catch { throw new LocalOperatorError("INVALID_COMMAND"); }
  }
  if ((command === "execution-approve" || command === "execution-accept") && subtaskId !== undefined) {
    try {
      const value = readOperatorJson(subtaskId);
      return command === "execution-approve" ? { name: command, approval: BigTaskExecutionApprovalSchema.parse(value) }
        : { name: command, acceptance: BigTaskExecutionAcceptanceSchema.parse(value) };
    } catch { throw new LocalOperatorError("INVALID_COMMAND"); }
  }
  if ((command === "execution-qa-recovery-review" || command === "execution-recovery-review" || command === "execution-review" || command === "execution-status" || command === "execution-start" || command === "execution-pause") && subtaskId !== undefined) {
    if (!schemaMatchesExactly(BigTaskIdSchema, subtaskId)) throw new LocalOperatorError("INVALID_COMMAND");
    return { name: command, bigTaskId: BigTaskIdSchema.parse(subtaskId) };
  }
  if (command === "ping" && subtaskId === undefined) {
    return Object.freeze({ name: "ping" });
  }
  if ((command === "planning-status" || command === "planning-run" || command === "governed-status" || command === "governed-advance") && subtaskId !== undefined) {
    if (!schemaMatchesExactly(BigTaskIdSchema, subtaskId)) {
      throw new LocalOperatorError("INVALID_COMMAND");
    }
    return Object.freeze({ name: command, bigTaskId: BigTaskIdSchema.parse(subtaskId) });
  }
  if (
    (command === "status" ||
      command === "provision" ||
      command === "run" ||
      command === "release" ||
      command === "governed-manual-start" ||
      command === "governed-budget-extension") &&
    subtaskId !== undefined
  ) {
    return Object.freeze({ name: command, subtaskId: parseSubtaskId(subtaskId) });
  }
  throw new LocalOperatorError("INVALID_COMMAND");
};

const commandRequest = (
  command: OperatorCommand,
): {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: Buffer | undefined;
} => {
  switch (command.name) {
    case "execution-qa-recovery-review":
    case "execution-recovery-review":
    case "execution-review":
    case "execution-status":
    case "execution-start":
    case "execution-pause":
      return { method: "POST", path: `/v0/execution/${command.name.slice(10)}`, body: Buffer.from(JSON.stringify({ bigTaskId: command.bigTaskId }), "utf8") };
    case "execution-recover":
      return { method: "POST", path: "/v0/execution/recover", body: Buffer.from(JSON.stringify(command.recovery), "utf8") };
    case "execution-recover-qa":
      return { method: "POST", path: "/v0/execution/recover-qa", body: Buffer.from(JSON.stringify(command.recovery), "utf8") };
    case "execution-renew-window":
      return { method: "POST", path: "/v0/execution/renew-window", body: Buffer.from(JSON.stringify(command.renewal), "utf8") };
    case "execution-approve":
      return { method: "POST", path: "/v0/execution/approve", body: Buffer.from(JSON.stringify(command.approval), "utf8") };
    case "execution-accept":
      return { method: "POST", path: "/v0/execution/accept", body: Buffer.from(JSON.stringify(command.acceptance), "utf8") };
    case "planning-intake":
      return { method: "POST", path: "/v0/planning/intake", body: Buffer.from(JSON.stringify(command.intake), "utf8") };
    case "planning-status":
    case "planning-run":
      return { method: "POST", path: command.name === "planning-status" ? "/v0/planning/status" : "/v0/planning/run", body: Buffer.from(JSON.stringify({ bigTaskId: command.bigTaskId }), "utf8") };
    case "governed-status":
      return {
        method: "GET",
        path: `/v0/governed/big-tasks/${encodeURIComponent(command.bigTaskId)}`,
        body: undefined,
      };
    case "governed-advance":
      return {
        method: "POST",
        path: "/v0/governed/advance",
        body: Buffer.from(JSON.stringify({ bigTaskId: command.bigTaskId }), "utf-8"),
      };
    case "governed-manual-start":
    case "governed-budget-extension":
      return {
        method: "POST",
        path: command.name === "governed-manual-start"
          ? "/v0/governed/manual-start" : "/v0/governed/budget-extension",
        body: Buffer.from(JSON.stringify({ subtaskId: command.subtaskId }), "utf-8"),
      };
    case "ping":
      return { method: "GET", path: "/v0/ping", body: undefined };
    case "status":
      return {
        method: "GET",
        path: `/v0/subtasks/${encodeURIComponent(command.subtaskId)}`,
        body: undefined,
      };
    case "provision":
      return {
        method: "POST",
        path: "/v0/worktrees/provision",
        body: Buffer.from(JSON.stringify({ subtaskId: command.subtaskId }), "utf-8"),
      };
    case "run":
      return {
        method: "POST",
        path: "/v0/executions/run",
        body: Buffer.from(JSON.stringify({ subtaskId: command.subtaskId }), "utf-8"),
      };
    case "release":
      return {
        method: "POST",
        path: "/v0/worktrees/release",
        body: Buffer.from(JSON.stringify({ subtaskId: command.subtaskId }), "utf-8"),
      };
  }
};

const requestDaemon = async (
  descriptor: LocalSessionDescriptor,
  command: OperatorCommand,
  timeoutMilliseconds: number,
): Promise<OperatorResult> => {
  const outbound = commandRequest(command);
  const responseLimitBytes = localControlResponseLimitBytes(outbound.path);
  const authority = `${LOCAL_CONTROL_HOST}:${descriptor.port}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timing: {
      clientRequest?: ClientRequest;
      deadline?: NodeJS.Timeout;
    } = {};
    const fail = (error: LocalOperatorError): void => {
      if (!settled) {
        settled = true;
        if (timing.deadline !== undefined) {
          clearTimeout(timing.deadline);
        }
        timing.clientRequest?.destroy();
        reject(error);
      }
    };
    timing.deadline = setTimeout(() => {
      fail(new LocalOperatorError("OPERATOR_TIMEOUT"));
    }, timeoutMilliseconds);
    timing.deadline.unref();
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${descriptor.sessionToken}`,
      connection: "close",
      host: authority,
    };
    if (outbound.body !== undefined) {
      headers["content-length"] = String(outbound.body.byteLength);
      headers["content-type"] = "application/json";
      headers["x-ctc-request"] = "1";
    }
    const outboundRequest = request(
      {
        agent: false,
        family: 4,
        headers,
        host: LOCAL_CONTROL_HOST,
        method: outbound.method,
        path: outbound.path,
        port: descriptor.port,
      },
      (response) => {
        const contentTypes = response.headersDistinct["content-type"];
        if (
          contentTypes?.length !== 1 ||
          !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
            contentTypes[0] ?? "",
          )
        ) {
          fail(new LocalOperatorError("RESPONSE_MALFORMED"));
          return;
        }
        const contentLength = response.headers["content-length"];
        if (
          contentLength !== undefined &&
          (/^(?:0|[1-9][0-9]*)$/u.test(contentLength) === false ||
            Number(contentLength) > responseLimitBytes)
        ) {
          fail(
            new LocalOperatorError(
              Number(contentLength) > responseLimitBytes
                ? "RESPONSE_TOO_LARGE"
                : "RESPONSE_MALFORMED",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > responseLimitBytes) {
            fail(new LocalOperatorError("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          if (settled) {
            return;
          }
          const responseBytes = Buffer.concat(chunks, bytes);
          if (!isUtf8(responseBytes)) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          const text = responseBytes.toString("utf-8");
          if (text.includes(descriptor.sessionToken)) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          if (!hasUnambiguousJsonStructure(text)) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          const status = response.statusCode;
          if (status === undefined || !isRecord(parsed)) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          let serialized: string;
          try {
            serialized = JSON.stringify(parsed);
          } catch {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          if (
            serialized.includes(descriptor.sessionToken) ||
            !validateResponseShape(command, status, parsed)
          ) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          const execution = parsed.execution;
          const executionFailed =
            isRecord(execution) && execution.success === false;
          settled = true;
          if (timing.deadline !== undefined) {
            clearTimeout(timing.deadline);
          }
          resolve(
            Object.freeze({
              httpStatus: status,
              body: parsed,
              succeeded: status >= 200 && status < 300 && !executionFailed &&
                (command.name !== "governed-advance" || governedAdvanceSucceeded(parsed)),
            }),
          );
        });
        response.once("aborted", () => {
          fail(new LocalOperatorError("OPERATOR_UNAVAILABLE"));
        });
        response.once("error", () => {
          fail(new LocalOperatorError("OPERATOR_UNAVAILABLE"));
        });
      },
    );
    timing.clientRequest = outboundRequest;
    outboundRequest.once("error", (error) => {
      fail(
        new LocalOperatorError(
          (error as NodeJS.ErrnoException).code?.startsWith("HPE_") === true
            ? "RESPONSE_MALFORMED"
            : "OPERATOR_UNAVAILABLE",
        ),
      );
    });
    if (outbound.body !== undefined) {
      outboundRequest.write(outbound.body);
    }
    outboundRequest.end();
  });
};

const runWithPaths = async (
  command: OperatorCommand,
  paths: LocalControlPaths,
  timeoutMilliseconds: number,
): Promise<OperatorResult> => {
  let descriptor: LocalSessionDescriptor;
  try {
    descriptor = readSessionDescriptor(paths);
  } catch (error) {
    if (error instanceof LocalStateError) {
      throw new LocalOperatorError("SESSION_UNAVAILABLE");
    }
    throw new LocalOperatorError("SESSION_UNAVAILABLE");
  }
  return requestDaemon(descriptor, command, timeoutMilliseconds);
};

export const runOperatorCommand = async (
  command: OperatorCommand,
): Promise<OperatorResult> =>
  runWithPaths(
    command,
    productionLocalControlPaths(),
    DEFAULT_OPERATOR_TIMEOUT_MILLISECONDS,
  );

/** Package-private deterministic-test seam; not exported from the package root. */
export const runOperatorCommandForTesting = async (
  command: OperatorCommand,
  paths: LocalControlPaths,
  timeoutMilliseconds: number,
): Promise<OperatorResult> =>
  runWithPaths(command, paths, timeoutMilliseconds);
