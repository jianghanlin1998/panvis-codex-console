import { assertGovernedSchemaIntegrity } from "./governed-schema-integrity.js";
import { BigTaskControlFailureSchema, type BigTaskControlFailure } from "@codex-task-console/domain";
import { executionPlanIssues } from "./execution-plan-readiness.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { devNull, tmpdir } from "node:os";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { BigTaskQaRecoverySchema, BigTaskRoleFailureSchema, executionUsageSettled, executionTokenLimitReached, hasUnacknowledgedExecutionUsage, BigTaskExecutionWindowRenewalSchema, BigTaskExecutionRecoverySchema, BigTaskExecutionApprovalSchema, BigTaskExecutionStatusSchema, BigTaskIdSchema, ExecutionRunIdSchema, RepositoryCommitShaSchema } from "@codex-task-console/domain";
import type { BigTaskQaRecovery, BigTaskRoleFailure, BigTaskExecutionWindowRenewal, BigTaskExecutionRecovery, BigTaskExecutionApproval, BigTaskId, SubtaskId, WorktreeOwnership } from "@codex-task-console/domain";
import { TaskStorageError } from "./errors.js";
import type { TaskStorage } from "./task-storage.js";
import { getTaskStorageWorktreeAccess } from "./task-storage-internals.js";
import { TrustedRepositorySourceReader } from "./trusted-repository-source.js";
import { executionGitTimeout, withExecutionGitBoundary } from "./execution-git-boundary.js";

export const executionCanonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const executionDigest = (value: unknown): string => createHash("sha256").update(executionCanonical(value), "utf8").digest("hex");
function fail(code: "CONFLICT" | "INVALID_INPUT" | "MALFORMED_STORED_DATA" = "CONFLICT"): never {
  throw new TaskStorageError(code, "The approved Big Task execution boundary is unavailable.");
}
const access = (storage: TaskStorage) => {
  const value = getTaskStorageWorktreeAccess(storage);
  if (value === null || !value.isOpen()) fail();
  return value;
};
const timestamp = (storage: TaskStorage): string => access(storage).clock().toISOString();
const idOf = (input: BigTaskId): BigTaskId => {
  const parsed = BigTaskIdSchema.safeParse(input);
  if (!parsed.success || parsed.data !== input) fail("INVALID_INPUT");
  return parsed.data;
};

/** Fixed Git operations use argument arrays, bounded output, no user hooks or ambient Git configuration. */
export function executionGit(repository: string, args: readonly string[], input?: Buffer,
  privateIndex?: string, commitDate?: string, remainingMilliseconds?: () => number): string {
  const timeout = (): number => {
    const remaining = Math.min(remainingMilliseconds?.() ?? 15_000, executionGitTimeout(15_000));
    if (!Number.isFinite(remaining) || remaining <= 0) fail();
    return Math.max(1, Math.min(15_000, Math.floor(remaining)));
  };
  const prefix = ["-C", repository, "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false"];
  const env = { PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C",
    ...(privateIndex === undefined ? {} : { GIT_INDEX_FILE: privateIndex }),
    ...(commitDate === undefined ? {} : { GIT_AUTHOR_NAME: "Codex Task Console", GIT_AUTHOR_EMAIL: "console@example.invalid",
      GIT_COMMITTER_NAME: "Codex Task Console", GIT_COMMITTER_EMAIL: "console@example.invalid", GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate }),
  };
  // Reading names cannot run a filter or disclose its command/configuration value.
  // Effective local, included and worktree configuration is covered. Filtered
  // repositories are unsupported; fail before any content-sensitive Git command.
  const filters = spawnSync("git", [...prefix, "config", "--name-only", "--get-regexp", "^filter\\."], {
    encoding: "utf8", env, shell: false, timeout: timeout(), maxBuffer: 16_384, windowsHide: true,
  });
  if (filters.status !== 1 || filters.stdout !== "") fail();
  const result = spawnSync("git", [...prefix, ...args], {
    encoding: "utf8", input, env, shell: false, timeout: timeout(), maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0) fail();
  timeout();
  return result.stdout.trimEnd();
}

interface ApprovalRecord {
  readonly request: BigTaskExecutionApproval;
  readonly approvedAt: string;
  readonly projectBinding: string;
  readonly repositoryBinding: string;
  readonly resultRef: string;
}
export type ExecutionPhase = "APPROVED" | "RUNNING" | "PAUSED" | "HUMAN_REQUIRED" | "AWAITING_ACCEPTANCE" | "ACCEPTED";
export type ExecutionStopReason = "USER_PAUSED" | "DAEMON_STOPPING" | "CHECKPOINT_RECOVERED" | "INTERRUPTED" | "TIME_LIMIT_REACHED" | "TOKEN_LIMIT_REACHED" | "ROLE_LIMIT_REACHED" | "USAGE_UNKNOWN" | "GOVERNED_BLOCKED" | "LOCAL_OPERATION_FAILED";
type IntegrationIntent = { readonly subtaskId: string | null; readonly fromSha: string; readonly toSha: string };
const integrationWriters = new WeakMap<TaskStorage, (bigTaskId: BigTaskId, intent: IntegrationIntent) => void>();
type ExecutionEvent =
  | { readonly kind: "START"; readonly at: string }
  | { readonly kind: "RECOVERY"; readonly at: string; readonly request: BigTaskExecutionRecovery; readonly authorizationId: string }
  | { readonly kind: "WINDOW_RENEWED"; readonly at: string; readonly request: BigTaskExecutionWindowRenewal }
  | { readonly kind: "QA_RECOVERY"; readonly at: string; readonly request: BigTaskQaRecovery; readonly authorizationId: string }
  | { readonly kind: "ROLE_FAILURE"; readonly at: string; readonly failure: BigTaskRoleFailure }
  | { readonly kind: "CONTROL_FAILURE"; readonly at: string; readonly failure: BigTaskControlFailure }
  | { readonly kind: "ROLE"; readonly at: string; readonly authorizationId: string }
  | ({ readonly kind: "INTEGRATION_PREPARED" | "INTEGRATE"; readonly at: string } & IntegrationIntent)
  | { readonly kind: "STOP"; readonly at: string; readonly reason: ExecutionStopReason }
  | { readonly kind: "DELIVER" | "ACCEPT"; readonly at: string; readonly headSha: string };
export interface BigTaskExecutionStatus {
  readonly bigTaskId: BigTaskId;
  readonly planDigest: string;
  readonly phase: ExecutionPhase;
  readonly stopReason: ExecutionStopReason | null;
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly limits: BigTaskExecutionApproval["limits"];
  readonly roleCalls: number;
  readonly knownTokens: number;
  readonly usageComplete: boolean;
  readonly activeRoleCount: number;
  readonly unknownCompletedUsage: boolean;
  readonly recovery?: BigTaskExecutionRecovery & { readonly authorizationId: string };
  readonly totalBudgetMode?: "WARNING_ONLY";
  readonly additionalRecoveries?: readonly NonNullable<BigTaskExecutionStatus["recovery"]>[];
  readonly windowRenewal?: Pick<BigTaskExecutionWindowRenewal, "previousExpiresAt" | "durationMilliseconds"> & { readonly renewedAt: string };
  readonly additionalWindowRenewals?: readonly NonNullable<BigTaskExecutionStatus["windowRenewal"]>[];
  readonly qaRecovery?: BigTaskQaRecovery & { readonly authorizationId: string; readonly authorizedAt: string };
  readonly unacknowledgedUnknownUsage?: boolean;
  readonly lastRoleFailure?: BigTaskRoleFailure & { readonly at: string };
  readonly lastControlFailure?: BigTaskControlFailure & { readonly at: string };
  readonly resultRef: string;
  readonly resultHeadSha: string;
  readonly integratedSubtaskIds: readonly string[];
  readonly pendingIntegration: IntegrationIntent | null;
  readonly resultRefCreated: boolean;
}

export const executionRecoveries = (state: Pick<BigTaskExecutionStatus, "recovery" | "additionalRecoveries">): readonly NonNullable<BigTaskExecutionStatus["recovery"]>[] =>
  state.recovery === undefined ? [] : [state.recovery, ...(state.additionalRecoveries ?? [])];

/** Applies only to live-planned Big Tasks. Existing accepted standalone task contracts remain compatible. */
export function isLivePlannedTask(storage: TaskStorage, bigTaskId: BigTaskId): boolean {
  const sqlite = access(storage).sqlite;
  return sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'live_planning_intakes'").get() !== undefined &&
    sqlite.prepare("SELECT 1 FROM live_planning_intakes WHERE big_task_id = ?").get(idOf(bigTaskId)) !== undefined;
}

export class BigTaskExecutionStore {
  constructor(readonly storage: TaskStorage) {
    assertGovernedSchemaIntegrity(access(storage).sqlite);
    integrationWriters.set(storage, (id, intent) => this.#integrate(id, intent));
  }

  repairCycleLimit(id: BigTaskId): 1 | 2 { return this.#approval(id).request.limits.repairCycleLimit; }

  assertStandaloneSubtask(subtaskId: SubtaskId): void { assertStandaloneExecution(this.storage, subtaskId); }

  review(bigTaskId: BigTaskId) {
    idOf(bigTaskId);
    const hasApproval = access(this.storage).sqlite.prepare("SELECT 1 FROM big_task_execution_approvals WHERE big_task_id = ?").get(bigTaskId) !== undefined;
    const running = hasApproval && this.inspect(bigTaskId).phase === "RUNNING";
    return withExecutionGitBoundary(running ? () => this.remainingMilliseconds(bigTaskId) : () => 15_000,
      () => this.#review(bigTaskId));
  }

  #review(bigTaskId: BigTaskId) {
    idOf(bigTaskId);
    const bundle = this.storage.getApprovedTaskContractAuthority(bigTaskId);
    const planning = this.storage.getDurablePlanningSnapshot(bigTaskId);
    const bigTask = this.storage.getBigTaskById(bigTaskId);
    if (!isLivePlannedTask(this.storage, bigTaskId) || bundle?.taskContractAuthorityReadiness !== "TASK_CONTRACT_AUTHORITY_READY" || planning === null || bigTask === null) fail();
    const project = this.storage.getProjectById(bigTask.projectId);
    if (project?.repository.kind !== "PATH") fail();
    const planDigest = executionDigest({ candidate: planning.reviewState.candidate, candidateBinding: bundle.candidateBinding,
      taskContracts: bundle.taskContracts, intent: { ...bigTask, status: "IN_PROGRESS" } });
    const repositoryHeadSha = RepositoryCommitShaSchema.parse(executionGit(project.repository.path, ["rev-parse", "--verify", "HEAD^{commit}"]));
    const repository = new TrustedRepositorySourceReader(this.storage).readTrustedRepositorySourceSnapshotForBigTask(bigTaskId);
    return { bigTaskId, planDigest, repositoryHeadSha, candidate: planning.reviewState.candidate,
      taskContracts: bundle.taskContracts, project, repository, executionIssues: executionPlanIssues(planning.reviewState.candidate) };
  }

  approve(input: unknown): BigTaskExecutionStatus {
    const parsed = BigTaskExecutionApprovalSchema.safeParse(input);
    if (!parsed.success || executionCanonical(input) !== executionCanonical(parsed.data)) fail("INVALID_INPUT");
    const request = parsed.data;
    return this.storage.runInTransaction(() => {
      const existing = access(this.storage).sqlite.prepare("SELECT payload FROM big_task_execution_approvals WHERE big_task_id = ?").get(request.bigTaskId);
      if (existing !== undefined) {
        if (executionCanonical(this.#approval(request.bigTaskId).request) !== executionCanonical(request)) fail();
        return this.inspect(request.bigTaskId);
      }
      const review = this.review(request.bigTaskId);
      if (review.executionIssues.length !== 0 ||
        request.limits.repairCycleLimit === 2 && review.candidate.subtasks.some(task => task.profile !== "HIGH_RISK_FOUNDATION" || !task.writeEnabled) ||
        review.planDigest !== request.planDigest || review.repositoryHeadSha !== request.repositoryHeadSha ||
        this.storage.getCanonicalTaskMaterialization(request.bigTaskId) !== null) fail();
      const value: ApprovalRecord = { request, approvedAt: timestamp(this.storage), projectBinding: executionDigest(review.project),
        repositoryBinding: executionDigest(review.repository), resultRef: `refs/heads/codex/execution/${executionDigest(request).slice(0, 32)}` };
      access(this.storage).sqlite.prepare("INSERT INTO big_task_execution_approvals (big_task_id, payload) VALUES (?, ?)")
        .run(request.bigTaskId, executionCanonical(value));
      return this.inspect(request.bigTaskId);
    });
  }

  inspect(bigTaskId: BigTaskId): BigTaskExecutionStatus {
    const approval = this.#approval(bigTaskId);
    let phase: ExecutionPhase = "APPROVED";
    let stopReason: ExecutionStopReason | null = null;
    let startedAt: string | null = null;
    let expiresAt: string | null = null;
    let lastAt = approval.approvedAt;
    let roleCalls = 0;
    let head: string = approval.request.repositoryHeadSha;
    const integrated: string[] = [];
    let pendingIntegration: IntegrationIntent | null = null;
    let resultRefCreated = false;
    const roles = new Set<string>();
    let recovery: BigTaskExecutionStatus["recovery"];
    const additionalRecoveries: NonNullable<BigTaskExecutionStatus["recovery"]>[] = [];
    let windowRenewal: BigTaskExecutionStatus["windowRenewal"];
    const additionalWindowRenewals: NonNullable<BigTaskExecutionStatus["windowRenewal"]>[] = [];
    let qaRecovery: BigTaskExecutionStatus["qaRecovery"];
    let lastRoleFailure: BigTaskExecutionStatus["lastRoleFailure"];
    let lastControlFailure: BigTaskExecutionStatus["lastControlFailure"];
    const failedRoles = new Set<string>();
    const rows = access(this.storage).sqlite.prepare("SELECT sequence, payload FROM big_task_execution_events WHERE big_task_id = ? ORDER BY sequence").all(bigTaskId);
    if (rows.length > 1024) fail("MALFORMED_STORED_DATA");
    for (const [index, row] of rows.entries()) {
      let event: ExecutionEvent;
      try { event = JSON.parse(String(row.payload)) as ExecutionEvent; } catch { fail("MALFORMED_STORED_DATA"); }
      if (event === null || typeof event !== "object" || Array.isArray(event) || row.sequence !== index + 1 || executionCanonical(event) !== row.payload || typeof event.at !== "string" ||
        !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at || event.at < lastAt) fail("MALFORMED_STORED_DATA");
      lastAt = event.at;
      switch (event.kind) {
        case "START":
          if (Object.keys(event).length !== 2 || (phase !== "APPROVED" && phase !== "PAUSED" &&
            !(phase === "HUMAN_REQUIRED" && stopReason === "TIME_LIMIT_REACHED" && expiresAt !== null && event.at < expiresAt))) fail("MALFORMED_STORED_DATA");
          if (startedAt === null) { startedAt = event.at; expiresAt = new Date(Date.parse(event.at) + approval.request.limits.durationMilliseconds).toISOString(); }
          phase = "RUNNING"; stopReason = null; break;
        case "RECOVERY": {
          const request = BigTaskExecutionRecoverySchema.safeParse(event.request);
          if (Object.keys(event).length !== 4 || !request.success || additionalRecoveries.length >= 23 ||
            [recovery, ...additionalRecoveries].some(r => r?.failedAuthorizationId === request.data.failedAuthorizationId) || phase !== "HUMAN_REQUIRED" ||
            !["GOVERNED_BLOCKED", "TOKEN_LIMIT_REACHED", "TIME_LIMIT_REACHED"].includes(stopReason ?? "") ||
            (stopReason === "TOKEN_LIMIT_REACHED" && request.data.totalBudgetMode !== "WARNING_ONLY") || startedAt === null || pendingIntegration !== null ||
            expiresAt === null || event.at >= expiresAt ||
            request.data.bigTaskId !== bigTaskId || request.data.planDigest !== approval.request.planDigest ||
            request.data.repositoryHeadSha !== approval.request.repositoryHeadSha || !roles.has(request.data.failedAuthorizationId) ||
            executionCanonical(request.data) !== executionCanonical(event.request) ||
            event.authorizationId !== recoveryAuthorizationId(request.data.failedAuthorizationId)) fail("MALFORMED_STORED_DATA");
          const failed = this.storage.getExecutionRunById(request.data.failedExecutionRunId);
          const old = access(this.storage).sqlite.prepare(`SELECT a.*, l.execution_run_id FROM governed_role_authorizations a
            JOIN governed_role_execution_links l ON l.authorization_id=a.authorization_id WHERE a.authorization_id=?`).get(request.data.failedAuthorizationId);
          const next = access(this.storage).sqlite.prepare("SELECT * FROM governed_role_authorizations WHERE authorization_id=?").get(event.authorizationId);
          if (old === undefined || next === undefined || old.big_task_id !== bigTaskId || old.recovery_attempt !== 0 ||
            old.execution_run_id !== request.data.failedExecutionRunId || failed === null || !["FAILED", "INTERRUPTED"].includes(failed.status) ||
            failed.normalizedUsage?.totalTokens === undefined || next.recovery_attempt !== 1 || next.authorized_at !== event.at ||
            Object.keys(next).some(key => !["authorization_id", "authorized_at", "recovery_attempt"].includes(key) && next[key] !== old[key]) ||
            access(this.storage).sqlite.prepare("SELECT 1 FROM governed_role_results WHERE authorization_id=?").get(request.data.failedAuthorizationId)) fail("MALFORMED_STORED_DATA");
          const recorded = { ...request.data, authorizationId: event.authorizationId };
          if (recovery === undefined) recovery = recorded; else additionalRecoveries.push(recorded);
          phase = "PAUSED"; stopReason = "CHECKPOINT_RECOVERED"; break;
        }
        case "WINDOW_RENEWED": {
          const request = BigTaskExecutionWindowRenewalSchema.safeParse(event.request);
          if (Object.keys(event).length !== 3 || !request.success ||
            !["PAUSED", "HUMAN_REQUIRED"].includes(phase) || startedAt === null || pendingIntegration !== null ||
            request.data.bigTaskId !== bigTaskId || request.data.planDigest !== approval.request.planDigest ||
            request.data.previousExpiresAt !== expiresAt ||
            event.at < request.data.previousExpiresAt || executionCanonical(request.data) !== executionCanonical(event.request)) fail("MALFORMED_STORED_DATA");
          const renewal = { previousExpiresAt: request.data.previousExpiresAt, durationMilliseconds: request.data.durationMilliseconds, renewedAt: event.at };
          if (windowRenewal === undefined) windowRenewal = renewal; else additionalWindowRenewals.push(renewal);
          expiresAt = new Date(Date.parse(event.at) + request.data.durationMilliseconds).toISOString();
          break;
        }
        case "QA_RECOVERY": {
          const request = BigTaskQaRecoverySchema.safeParse(event.request);
          if (Object.keys(event).length !== 4 || !request.success || qaRecovery !== undefined || recovery === undefined || startedAt === null ||
            phase !== "HUMAN_REQUIRED" || stopReason !== "USAGE_UNKNOWN" || pendingIntegration !== null ||
            request.data.bigTaskId !== bigTaskId || request.data.planDigest !== approval.request.planDigest ||
            request.data.repositoryHeadSha !== approval.request.repositoryHeadSha || !roles.has(request.data.failedAuthorizationId) ||
            event.authorizationId !== recoveryAuthorizationId(request.data.failedAuthorizationId) ||
            request.data.previousExpiresAt !== expiresAt ||
            executionCanonical(request.data) !== executionCanonical(event.request)) fail("MALFORMED_STORED_DATA");
          const old = this.#qaFailureAuthority(request.data);
          const next = access(this.storage).sqlite.prepare("SELECT * FROM governed_role_authorizations WHERE authorization_id=?").get(event.authorizationId);
          if (next === undefined || next.recovery_attempt !== 1 || next.authorized_at !== event.at ||
            Object.keys(next).some(key => !["authorization_id", "authorized_at", "recovery_attempt"].includes(key) && next[key] !== old[key])) fail("MALFORMED_STORED_DATA");
          let priorKnown = 0, priorUnknown = 0;
          for (const id of roles) {
            const row = access(this.storage).sqlite.prepare("SELECT execution_run_id FROM governed_role_execution_links WHERE authorization_id=?").get(id);
            const run = row === undefined ? null : this.storage.getExecutionRunById(ExecutionRunIdSchema.parse(row.execution_run_id));
            if (run === null || !["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(run.status)) fail("MALFORMED_STORED_DATA");
            if (run.normalizedUsage?.totalTokens === undefined) priorUnknown += 1; else priorKnown += run.normalizedUsage.totalTokens;
          }
          if (priorUnknown !== 1 || priorKnown !== request.data.acknowledgedKnownTokens || priorKnown >= request.data.knownTokenLimit) fail("MALFORMED_STORED_DATA");
          qaRecovery = { ...request.data, authorizationId: event.authorizationId, authorizedAt: event.at };
          expiresAt = new Date(Date.parse(event.at) + request.data.durationMilliseconds).toISOString();
          phase = "PAUSED"; stopReason = "CHECKPOINT_RECOVERED"; break;
        }
        case "CONTROL_FAILURE": {
          const parsed = BigTaskControlFailureSchema.safeParse(event.failure);
          if (Object.keys(event).length !== 3 || !parsed.success || phase !== "RUNNING" ||
            executionCanonical(parsed.data) !== executionCanonical(event.failure)) fail("MALFORMED_STORED_DATA");
          lastControlFailure = { ...parsed.data, at: event.at }; break;
        }
        case "ROLE_FAILURE": {
          const parsed = BigTaskRoleFailureSchema.safeParse(event.failure);
          if (Object.keys(event).length !== 3 || !parsed.success || failedRoles.has(parsed.data.authorizationId) ||
            !["RUNNING", "PAUSED", "HUMAN_REQUIRED"].includes(phase) || executionCanonical(parsed.data) !== executionCanonical(event.failure)) fail("MALFORMED_STORED_DATA");
          if (access(this.storage).sqlite.prepare("SELECT big_task_id FROM governed_role_authorizations WHERE authorization_id=?").get(parsed.data.authorizationId)?.big_task_id !== bigTaskId) fail("MALFORMED_STORED_DATA");
          failedRoles.add(parsed.data.authorizationId);
          lastRoleFailure = { ...parsed.data, at: event.at }; break;
        }
        case "ROLE":
          if (Object.keys(event).length !== 3 || phase !== "RUNNING" || !/^gra_[a-f0-9]{48}$/u.test(event.authorizationId) || roles.has(event.authorizationId)) fail("MALFORMED_STORED_DATA");
          roles.add(event.authorizationId); roleCalls += 1; break;
        case "INTEGRATION_PREPARED":
          if (Object.keys(event).length !== 5 || phase !== "RUNNING" || pendingIntegration !== null || event.fromSha !== head ||
            (event.subtaskId === null ? resultRefCreated || event.toSha !== head : !resultRefCreated || integrated.includes(event.subtaskId)) ||
            !RepositoryCommitShaSchema.safeParse(event.toSha).success) fail("MALFORMED_STORED_DATA");
          pendingIntegration = { subtaskId: event.subtaskId, fromSha: event.fromSha, toSha: event.toSha }; break;
        case "INTEGRATE":
          if (Object.keys(event).length !== 5 || phase !== "RUNNING" || pendingIntegration === null ||
            executionCanonical(pendingIntegration) !== executionCanonical({ subtaskId: event.subtaskId, fromSha: event.fromSha, toSha: event.toSha })) fail("MALFORMED_STORED_DATA");
          head = event.toSha;
          if (event.subtaskId === null) resultRefCreated = true; else integrated.push(event.subtaskId);
          pendingIntegration = null; break;
        case "STOP":
          if (Object.keys(event).length !== 3 || phase !== "RUNNING" || !["USER_PAUSED", "DAEMON_STOPPING", "CHECKPOINT_RECOVERED", "INTERRUPTED", "TIME_LIMIT_REACHED", "TOKEN_LIMIT_REACHED", "ROLE_LIMIT_REACHED", "USAGE_UNKNOWN", "GOVERNED_BLOCKED", "LOCAL_OPERATION_FAILED"].includes(event.reason)) fail("MALFORMED_STORED_DATA");
          stopReason = event.reason; phase = event.reason === "USER_PAUSED" || event.reason === "DAEMON_STOPPING" || event.reason === "CHECKPOINT_RECOVERED" ? "PAUSED" : "HUMAN_REQUIRED"; break;
        case "DELIVER":
        case "ACCEPT":
          if (Object.keys(event).length !== 3 || event.headSha !== head || phase !== (event.kind === "DELIVER" ? "RUNNING" : "AWAITING_ACCEPTANCE")) fail("MALFORMED_STORED_DATA");
          phase = event.kind === "DELIVER" ? "AWAITING_ACCEPTANCE" : "ACCEPTED"; break;
        default: fail("MALFORMED_STORED_DATA");
      }
    }
    const linked = access(this.storage).sqlite.prepare(`SELECT link.authorization_id FROM governed_role_execution_links link
      JOIN governed_role_authorizations auth ON auth.authorization_id = link.authorization_id WHERE auth.big_task_id = ?`).all(bigTaskId);
    if (linked.length !== roles.size || linked.some(row => !roles.has(String(row.authorization_id)))) fail("MALFORMED_STORED_DATA");
    const usage = this.#usage(bigTaskId, qaRecovery?.failedExecutionRunId);
    const status = Object.freeze({ bigTaskId, planDigest: approval.request.planDigest, phase, stopReason, startedAt,
      expiresAt,
      limits: qaRecovery === undefined ? approval.request.limits : { ...approval.request.limits, totalTokenLimit: qaRecovery.knownTokenLimit },
      roleCalls, ...usage, ...(recovery === undefined ? {} : { recovery }), ...(qaRecovery === undefined ? {} : { qaRecovery }),
      ...(lastRoleFailure === undefined ? {} : { lastRoleFailure }),
      ...(lastControlFailure === undefined ? {} : { lastControlFailure }),
      ...(additionalRecoveries.length === 0 ? {} : { additionalRecoveries }),
      ...([recovery, ...additionalRecoveries].some(r => r?.totalBudgetMode === "WARNING_ONLY") ? { totalBudgetMode: "WARNING_ONLY" as const } : {}),
      ...(windowRenewal === undefined ? {} : { windowRenewal }),
      ...(additionalWindowRenewals.length === 0 ? {} : { additionalWindowRenewals }), resultRef: approval.resultRef, resultHeadSha: head,
      integratedSubtaskIds: Object.freeze(integrated), pendingIntegration, resultRefCreated });
    if (!BigTaskExecutionStatusSchema.safeParse(status).success) fail("MALFORMED_STORED_DATA");
    return status;
  }

  /** Records a human-approved replacement authorization atomically; no provider or target writes. */
  recover(input: unknown): BigTaskExecutionStatus {
    const request = BigTaskExecutionRecoverySchema.parse(input);
    if (executionCanonical(request) !== executionCanonical(input)) fail("INVALID_INPUT");
    const record = (): BigTaskExecutionStatus => {
      const state = this.inspect(request.bigTaskId);
      const prior = executionRecoveries(state).find(r => r.failedAuthorizationId === request.failedAuthorizationId);
      if (prior !== undefined) {
        const original = BigTaskExecutionRecoverySchema.parse(Object.fromEntries(Object.entries(prior).filter(([key]) => key !== "authorizationId")));
        if (executionCanonical(original) !== executionCanonical(request)) fail();
        return state;
      }
      if (state.phase !== "HUMAN_REQUIRED" || !["GOVERNED_BLOCKED", "TOKEN_LIMIT_REACHED", "TIME_LIMIT_REACHED"].includes(state.stopReason ?? "") || !executionUsageSettled(state) ||
        state.expiresAt === null || Date.parse(state.expiresAt) <= Date.parse(timestamp(this.storage)) || state.pendingIntegration !== null ||
        (request.totalBudgetMode !== "WARNING_ONLY" && executionTokenLimitReached(state)) || state.roleCalls >= state.limits.roleCallLimit ||
        request.planDigest !== state.planDigest || request.repositoryHeadSha !== this.#approval(request.bigTaskId).request.repositoryHeadSha) fail();
      this.assertCurrent(request.bigTaskId);
      const sql = access(this.storage).sqlite;
      const failed = sql.prepare(`SELECT a.*, l.execution_run_id FROM governed_role_authorizations a
        JOIN governed_role_execution_links l ON l.authorization_id=a.authorization_id WHERE a.authorization_id=?`).get(request.failedAuthorizationId);
      const run = this.storage.getExecutionRunById(request.failedExecutionRunId);
      if (failed === undefined || failed.big_task_id !== request.bigTaskId || failed.recovery_attempt !== 0 ||
        failed.execution_run_id !== request.failedExecutionRunId || run === null || !["FAILED", "INTERRUPTED"].includes(run.status) ||
        run.normalizedUsage?.totalTokens === undefined || sql.prepare("SELECT 1 FROM governed_role_results WHERE authorization_id=?").get(request.failedAuthorizationId)) fail();
      const view = this.storage.getDurableWorkflowControlView(failed.subtask_id as SubtaskId);
      if (view === null || view.currentStage !== failed.role || view.transitionCount + 1 !== failed.workflow_sequence || view.unresolvedHumanRequired !== null) fail();
      const at = timestamp(this.storage), authorizationId = recoveryAuthorizationId(request.failedAuthorizationId);
      sql.prepare(`INSERT INTO governed_role_authorizations
        (authorization_id, dispatch_receipt_id, project_id, big_task_id, plan_revision, candidate_binding, subtask_id, workflow_sequence,
         workflow_stage, repair_cycles_used, role, context_profile, write_enabled, worktree_ownership_id, candidate_sha, authorized_at, recovery_attempt)
        SELECT ?, dispatch_receipt_id, project_id, big_task_id, plan_revision, candidate_binding, subtask_id, workflow_sequence,
          workflow_stage, repair_cycles_used, role, context_profile, write_enabled, worktree_ownership_id, candidate_sha, ?, 1
        FROM governed_role_authorizations WHERE authorization_id=?`).run(authorizationId, at, request.failedAuthorizationId);
      this.#append(request.bigTaskId, { kind: "RECOVERY", at, request, authorizationId });
      return this.inspect(request.bigTaskId);
    };
    return access(this.storage).sqlite.isTransaction ? record() : this.storage.runInTransaction(record);
  }

  /** Explicit time-only amendments form an immutable chain; no calls, budgets or prior usage are reset. */
  renewWindow(input: unknown): BigTaskExecutionStatus {
    const parsed = BigTaskExecutionWindowRenewalSchema.safeParse(input);
    if (!parsed.success || executionCanonical(parsed.data) !== executionCanonical(input)) fail("INVALID_INPUT");
    const request = parsed.data;
    return this.storage.runInTransaction(() => {
      const state = this.inspect(request.bigTaskId);
      if (request.planDigest !== state.planDigest) fail();
      const prior = [state.windowRenewal, ...(state.additionalWindowRenewals ?? [])].find(window => window?.previousExpiresAt === request.previousExpiresAt);
      if (prior !== undefined) {
        if (request.durationMilliseconds !== prior.durationMilliseconds) fail();
        return state;
      }
      const at = timestamp(this.storage);
      if (!["PAUSED", "HUMAN_REQUIRED"].includes(state.phase) ||
        state.expiresAt !== request.previousExpiresAt || at < request.previousExpiresAt || state.pendingIntegration !== null ||
        !executionUsageSettled(state) || executionTokenLimitReached(state) || state.roleCalls >= state.limits.roleCallLimit) fail();
      this.assertCurrent(request.bigTaskId);
      this.#append(request.bigTaskId, { kind: "WINDOW_RENEWED", at, request });
      return this.inspect(request.bigTaskId);
    });
  }

  #qaFailureAuthority(request: BigTaskQaRecovery) {
    const old = access(this.storage).sqlite.prepare(`SELECT a.*, l.execution_run_id FROM governed_role_authorizations a
      JOIN governed_role_execution_links l ON l.authorization_id=a.authorization_id WHERE a.authorization_id=?`).get(request.failedAuthorizationId);
    const run = this.storage.getExecutionRunById(request.failedExecutionRunId);
    if (old === undefined || old.big_task_id !== request.bigTaskId || old.role !== "FRESH_QA" || old.write_enabled !== 0 || old.recovery_attempt !== 0 ||
      old.repair_cycles_used !== 0 || old.execution_run_id !== request.failedExecutionRunId || old.candidate_sha !== request.candidateSha ||
      run === null || !["FAILED", "INTERRUPTED"].includes(run.status) || run.normalizedUsage?.totalTokens !== undefined ||
      access(this.storage).sqlite.prepare("SELECT 1 FROM governed_role_results WHERE authorization_id=?").get(request.failedAuthorizationId)) fail();
    return old;
  }

  /** Explicitly acknowledges one unknown failed QA; its original usage remains unknown forever. */
  recoverQa(input: unknown): BigTaskExecutionStatus {
    const request = BigTaskQaRecoverySchema.parse(input);
    if (executionCanonical(request) !== executionCanonical(input)) fail("INVALID_INPUT");
    const record = () => {
      const state = this.inspect(request.bigTaskId);
      if (state.qaRecovery !== undefined) {
        const original = Object.fromEntries(Object.entries(state.qaRecovery).filter(([key]) => !["authorizationId", "authorizedAt"].includes(key)));
        if (executionCanonical(original) !== executionCanonical(request)) fail();
        return state;
      }
      if (state.phase !== "HUMAN_REQUIRED" || state.stopReason !== "USAGE_UNKNOWN" || state.recovery === undefined ||
        state.activeRoleCount !== 0 || !state.unknownCompletedUsage || state.pendingIntegration !== null || state.expiresAt !== request.previousExpiresAt ||
        state.knownTokens !== request.acknowledgedKnownTokens || state.knownTokens >= request.knownTokenLimit || state.roleCalls >= state.limits.roleCallLimit ||
        state.planDigest !== request.planDigest || request.repositoryHeadSha !== this.#approval(request.bigTaskId).request.repositoryHeadSha) fail();
      this.assertCurrent(request.bigTaskId);
      const old = this.#qaFailureAuthority(request);
      const view = this.storage.getDurableWorkflowControlView(old.subtask_id as SubtaskId);
      if (view?.currentStage !== "FRESH_QA" || view.deliveryMaturity !== "HARDENED" || view.transitionCount + 1 !== old.workflow_sequence || view.unresolvedHumanRequired !== null) fail();
      const at = timestamp(this.storage), authorizationId = recoveryAuthorizationId(request.failedAuthorizationId);
      access(this.storage).sqlite.prepare(`INSERT INTO governed_role_authorizations
        (authorization_id, dispatch_receipt_id, project_id, big_task_id, plan_revision, candidate_binding, subtask_id, workflow_sequence,
         workflow_stage, repair_cycles_used, role, context_profile, write_enabled, worktree_ownership_id, candidate_sha, authorized_at, recovery_attempt)
        SELECT ?, dispatch_receipt_id, project_id, big_task_id, plan_revision, candidate_binding, subtask_id, workflow_sequence,
          workflow_stage, repair_cycles_used, role, context_profile, write_enabled, worktree_ownership_id, candidate_sha, ?, 1
        FROM governed_role_authorizations WHERE authorization_id=?`).run(authorizationId, at, request.failedAuthorizationId);
      this.#append(request.bigTaskId, { kind: "QA_RECOVERY", at, request, authorizationId });
      return this.inspect(request.bigTaskId);
    };
    return access(this.storage).sqlite.isTransaction ? record() : this.storage.runInTransaction(record);
  }

  recordControlFailure(bigTaskId: BigTaskId, input: unknown): BigTaskExecutionStatus {
    const failure = BigTaskControlFailureSchema.parse(input);
    if (executionCanonical(input) !== executionCanonical(failure)) fail("INVALID_INPUT");
    return this.storage.runInTransaction(() => {
      if (this.inspect(bigTaskId).phase !== "RUNNING") fail();
      this.#append(bigTaskId, { kind: "CONTROL_FAILURE", at: timestamp(this.storage), failure });
      return this.inspect(bigTaskId);
    });
  }

  recordRoleFailure(bigTaskId: BigTaskId, input: unknown): BigTaskExecutionStatus {
    const failure = BigTaskRoleFailureSchema.parse(input);
    if (executionCanonical(input) !== executionCanonical(failure)) fail("INVALID_INPUT");
    return this.storage.runInTransaction(() => {
      const state = this.inspect(bigTaskId);
      if (state.lastRoleFailure?.authorizationId === failure.authorizationId) {
        const original = Object.fromEntries(Object.entries(state.lastRoleFailure).filter(([key]) => key !== "at"));
        if (executionCanonical(original) !== executionCanonical(failure)) fail();
        return state;
      }
      this.#append(bigTaskId, { kind: "ROLE_FAILURE", at: timestamp(this.storage), failure });
      return this.inspect(bigTaskId);
    });
  }

  start(bigTaskId: BigTaskId): { claimed: boolean; status: BigTaskExecutionStatus } {
    return this.storage.runInTransaction(() => {
      const state = this.inspect(bigTaskId);
      if (state.phase === "RUNNING" || state.phase === "AWAITING_ACCEPTANCE" || state.phase === "ACCEPTED") return { claimed: false, status: state };
      if (state.phase !== "APPROVED" && state.phase !== "PAUSED" && !(state.phase === "HUMAN_REQUIRED" && state.stopReason === "TIME_LIMIT_REACHED")) fail();
      this.assertCurrent(bigTaskId);
      if (state.expiresAt !== null && Date.parse(state.expiresAt) <= Date.parse(timestamp(this.storage))) fail();
      if (!this.#safeCheckpoint(bigTaskId) || !executionUsageSettled(state) || executionTokenLimitReached(state) || state.roleCalls >= state.limits.roleCallLimit) fail();
      this.#append(bigTaskId, { kind: "START", at: timestamp(this.storage) });
      this.storage.materializeDurablePlan(bigTaskId);
      return { claimed: true, status: this.inspect(bigTaskId) };
    });
  }

  stop(bigTaskId: BigTaskId, reason: ExecutionStopReason): BigTaskExecutionStatus {
    return this.storage.runInTransaction(() => {
      if (this.inspect(bigTaskId).phase === "RUNNING") this.#append(bigTaskId, { kind: "STOP", reason, at: timestamp(this.storage) });
      return this.inspect(bigTaskId);
    });
  }

  assertCurrent(bigTaskId: BigTaskId): void {
    const approval = this.#approval(bigTaskId);
    const current = this.review(bigTaskId);
    if (current.planDigest !== approval.request.planDigest || executionDigest(current.project) !== approval.projectBinding ||
      executionDigest(current.repository) !== approval.repositoryBinding || current.repositoryHeadSha !== approval.request.repositoryHeadSha) fail();
  }

  remainingMilliseconds(bigTaskId: BigTaskId): number {
    const state = this.inspect(bigTaskId);
    if (state.phase !== "RUNNING" || state.expiresAt === null) return 0;
    return Math.max(0, Date.parse(state.expiresAt) - Date.parse(timestamp(this.storage)));
  }

  assertRunning(bigTaskId: BigTaskId): BigTaskExecutionStatus {
    const state = this.inspect(bigTaskId);
    if (state.phase !== "RUNNING" || this.remainingMilliseconds(bigTaskId) <= 0 || hasUnacknowledgedExecutionUsage(state) || executionTokenLimitReached(state)) fail();
    this.assertCurrent(bigTaskId);
    if (this.remainingMilliseconds(bigTaskId) <= 0) fail();
    return state;
  }

  recordRole(bigTaskId: BigTaskId, authorizationId: string): void {
    const record = (): void => {
      const state = this.assertRunning(bigTaskId);
      if (state.roleCalls >= state.limits.roleCallLimit) fail();
      const row = access(this.storage).sqlite.prepare("SELECT big_task_id FROM governed_role_authorizations WHERE authorization_id = ?").get(authorizationId);
      if (row?.big_task_id !== bigTaskId) fail();
      this.#append(bigTaskId, { kind: "ROLE", authorizationId, at: timestamp(this.storage) });
    };
    // The governed role reservation already owns the SQLite writer transaction.
    if (access(this.storage).sqlite.isTransaction) record();
    else this.storage.runInTransaction(record);
  }

  deliver(bigTaskId: BigTaskId): BigTaskExecutionStatus {
    return this.storage.runInTransaction(() => {
      const state = this.assertRunning(bigTaskId);
      const task = this.storage.getBigTaskById(bigTaskId);
      const materialized = this.storage.getCanonicalTaskMaterialization(bigTaskId);
      if (!executionUsageSettled(state) || state.pendingIntegration !== null || task?.status !== "DONE" || materialized === null || state.integratedSubtaskIds.length !== materialized.subtaskCount) fail();
      this.#append(bigTaskId, { kind: "DELIVER", headSha: state.resultHeadSha, at: timestamp(this.storage) });
      return this.inspect(bigTaskId);
    });
  }

  accept(bigTaskId: BigTaskId, headSha: string): BigTaskExecutionStatus {
    return this.storage.runInTransaction(() => {
      const state = this.inspect(bigTaskId);
      const approval = this.#approval(bigTaskId);
      const task = this.storage.getBigTaskById(bigTaskId);
      const project = task === null ? null : this.storage.getProjectById(task.projectId);
      if (project?.repository.kind !== "PATH" || executionDigest(project) !== approval.projectBinding ||
        executionGit(project.repository.path, ["rev-parse", "--verify", `${state.resultRef}^{commit}`]) !== headSha ||
        state.resultHeadSha !== headSha) fail();
      if (state.phase === "ACCEPTED") return state;
      if (state.phase !== "AWAITING_ACCEPTANCE") fail();
      this.#append(bigTaskId, { kind: "ACCEPT", headSha, at: timestamp(this.storage) });
      return this.inspect(bigTaskId);
    });
  }

  recoverInterrupted(): void {
    const rows = access(this.storage).sqlite.prepare("SELECT big_task_id FROM big_task_execution_approvals").all();
    for (const row of rows) {
      const id = BigTaskIdSchema.parse(row.big_task_id);
      if (this.inspect(id).phase === "RUNNING") this.stop(id, this.#safeCheckpoint(id) ? "CHECKPOINT_RECOVERED" : "INTERRUPTED");
    }
  }

  #integrate(bigTaskId: BigTaskId, intent: IntegrationIntent): void {
    const remaining = (): number => this.remainingMilliseconds(bigTaskId);
    const git = (path: string, args: readonly string[]): string => executionGit(path, args, undefined, undefined, undefined, remaining);
    const prepared = this.storage.runInTransaction(() => {
      const state = this.assertRunning(bigTaskId);
      if (intent.subtaskId !== null && state.integratedSubtaskIds.includes(intent.subtaskId)) return null;
      if (intent.subtaskId === null && state.resultRefCreated) return null;
      const project = this.review(bigTaskId).project;
      if (project.repository.kind !== "PATH" || intent.fromSha !== state.resultHeadSha) fail();
      if (intent.subtaskId !== null) {
        const view = this.storage.getDurableWorkflowControlView(intent.subtaskId as SubtaskId);
        const proof = access(this.storage).sqlite.prepare(`SELECT h.candidate_sha, a.big_task_id FROM governed_handoffs h
          JOIN governed_role_results r ON r.result_id = h.role_result_id
          JOIN governed_role_authorizations a ON a.authorization_id = r.authorization_id WHERE h.subtask_id = ?`).get(intent.subtaskId);
        if (view?.currentStage !== "COMPLETE" || view.unresolvedHumanRequired !== null || proof?.big_task_id !== bigTaskId || proof.candidate_sha !== intent.toSha) fail();
        git(project.repository.path, ["merge-base", "--is-ancestor", intent.fromSha, intent.toSha]);
      }
      const refLine = git(project.repository.path, ["for-each-ref", "--format=%(refname) %(objectname)", state.resultRef]);
      if (state.pendingIntegration === null) {
        if (refLine !== (state.resultRefCreated ? `${state.resultRef} ${state.resultHeadSha}` : "")) fail();
        this.#append(bigTaskId, { kind: "INTEGRATION_PREPARED", ...intent, at: timestamp(this.storage) });
      } else if (executionCanonical(state.pendingIntegration) !== executionCanonical(intent)) fail();
      return { state, path: project.repository.path };
    });
    if (prepared === null) return;
    // Intent is committed before Git. A crash can resume only this exact CAS.
    const { state, path } = prepared;
    const current = git(path, ["for-each-ref", "--format=%(refname) %(objectname)", state.resultRef]);
    if (current !== `${state.resultRef} ${intent.toSha}`) {
      git(path, ["update-ref", state.resultRef, intent.toSha,
        state.resultRefCreated ? intent.fromSha : "0".repeat(intent.fromSha.length)]);
    }
    if (git(path, ["rev-parse", "--verify", `${state.resultRef}^{commit}`]) !== intent.toSha) fail();
    this.storage.runInTransaction(() => {
      const now = this.inspect(bigTaskId);
      if (now.pendingIntegration === null && (intent.subtaskId === null ? now.resultRefCreated : now.integratedSubtaskIds.includes(intent.subtaskId))) return;
      if (now.phase !== "RUNNING" || executionCanonical(now.pendingIntegration) !== executionCanonical(intent)) fail();
      this.#append(bigTaskId, { kind: "INTEGRATE", ...intent, at: timestamp(this.storage) });
    });
  }

  #approval(bigTaskId: BigTaskId): ApprovalRecord {
    const row = access(this.storage).sqlite.prepare("SELECT payload FROM big_task_execution_approvals WHERE big_task_id = ?").get(idOf(bigTaskId));
    if (row === undefined) fail();
    try {
      const value = JSON.parse(String(row.payload)) as ApprovalRecord;
      const request = BigTaskExecutionApprovalSchema.parse(value.request);
      if (Object.keys(value).length !== 5 || request.bigTaskId !== bigTaskId || executionCanonical(value) !== row.payload ||
        executionCanonical(request) !== executionCanonical(value.request) || !/^[a-f0-9]{64}$/u.test(value.projectBinding) || !/^[a-f0-9]{64}$/u.test(value.repositoryBinding) ||
        value.resultRef !== `refs/heads/codex/execution/${executionDigest(request).slice(0, 32)}` || new Date(value.approvedAt).toISOString() !== value.approvedAt) fail("MALFORMED_STORED_DATA");
      return value;
    } catch { return fail("MALFORMED_STORED_DATA"); }
  }

  #safeCheckpoint(bigTaskId: BigTaskId): boolean {
    const state = this.inspect(bigTaskId);
    const recovered = new Set([...executionRecoveries(state).map(r => r.failedAuthorizationId), state.qaRecovery?.failedAuthorizationId]);
    return access(this.storage).sqlite.prepare(`SELECT auth.authorization_id FROM governed_role_execution_links link
      JOIN governed_role_authorizations auth ON auth.authorization_id = link.authorization_id
      LEFT JOIN execution_runs run ON run.id = link.execution_run_id
      WHERE auth.big_task_id = ? AND (run.status IS NULL OR run.status != 'SUCCEEDED')`).all(bigTaskId).every(row => recovered.has(String(row.authorization_id)));
  }

  #usage(bigTaskId: BigTaskId, acknowledgedRunId?: string): { knownTokens: number; usageComplete: boolean; activeRoleCount: number; unknownCompletedUsage: boolean; unacknowledgedUnknownUsage?: boolean } {
    const rows = access(this.storage).sqlite.prepare(`SELECT link.execution_run_id FROM governed_role_execution_links link
      JOIN governed_role_authorizations auth ON auth.authorization_id = link.authorization_id WHERE auth.big_task_id = ?`).all(bigTaskId);
    let knownTokens = 0;
    let activeRoleCount = 0;
    let unknownCompletedUsage = false;
    let unacknowledgedUnknownUsage = false;
    for (const row of rows) {
      const run = this.storage.getExecutionRunById(ExecutionRunIdSchema.parse(row.execution_run_id));
      if (run === null) fail("MALFORMED_STORED_DATA");
      knownTokens += run.normalizedUsage?.totalTokens ?? 0;
      if (["CREATED", "RUNNING"].includes(run.status)) activeRoleCount += 1;
      else if (run.normalizedUsage?.totalTokens === undefined) { unknownCompletedUsage = true; if (run.id !== acknowledgedRunId) unacknowledgedUnknownUsage = true; }
    }
    if (activeRoleCount > 1 || !Number.isSafeInteger(knownTokens)) fail("MALFORMED_STORED_DATA");
    return { knownTokens, usageComplete: activeRoleCount === 0 && !unknownCompletedUsage, activeRoleCount, unknownCompletedUsage,
      ...(acknowledgedRunId === undefined ? {} : { unacknowledgedUnknownUsage }) };
  }

  #append(bigTaskId: BigTaskId, event: ExecutionEvent): void {
    const sqlite = access(this.storage).sqlite;
    const row = sqlite.prepare("SELECT count(*) AS count FROM big_task_execution_events WHERE big_task_id = ?").get(bigTaskId)!;
    sqlite.prepare("INSERT INTO big_task_execution_events (big_task_id, sequence, payload) VALUES (?, ?, ?)").run(bigTaskId, Number(row.count) + 1, executionCanonical(event));
  }
}

export function assertLivePlanApproved(storage: TaskStorage, bigTaskId: BigTaskId, running = false): void {
  if (!isLivePlannedTask(storage, bigTaskId)) return;
  const execution = new BigTaskExecutionStore(storage);
  if (running) execution.assertRunning(bigTaskId);
  else execution.assertCurrent(bigTaskId);
}
export function assertStandaloneExecution(storage: TaskStorage, subtaskId: SubtaskId): void {
  const subtask = storage.getSubtaskById(subtaskId);
  if (subtask !== null && isLivePlannedTask(storage, subtask.bigTaskId)) fail();
}

/** Package-private integration entry points: governed completion is re-derived from durable sources. */
export function ensureExecutionResultRef(storage: TaskStorage, id: BigTaskId): void {
  if (!isLivePlannedTask(storage, id)) return;
  const state = new BigTaskExecutionStore(storage).assertRunning(id);
  integrationWriters.get(storage)!(id, { subtaskId: null, fromSha: state.resultHeadSha, toSha: state.resultHeadSha });
}
export function integrateCompletedExecutionCandidate(storage: TaskStorage, id: BigTaskId, subtaskId: SubtaskId, candidateSha: string): void {
  if (!isLivePlannedTask(storage, id)) return;
  const state = new BigTaskExecutionStore(storage).assertRunning(id);
  integrationWriters.get(storage)!(id, { subtaskId, fromSha: state.resultHeadSha, toSha: candidateSha });
}
export function approvedExecutionBase(storage: TaskStorage, subtaskId: SubtaskId): string | null {
  const subtask = storage.getSubtaskById(subtaskId);
  if (subtask === null || !isLivePlannedTask(storage, subtask.bigTaskId)) return null;
  const execution = new BigTaskExecutionStore(storage);
  const state = execution.assertRunning(subtask.bigTaskId);
  const review = execution.review(subtask.bigTaskId);
  const project = review.project;
  if (!review.candidate.subtasks.some(task => task.id === subtaskId)) fail();
  if (!state.resultRefCreated || state.pendingIntegration !== null || project.repository.kind !== "PATH" ||
    executionGit(project.repository.path, ["rev-parse", "--verify", `${state.resultRef}^{commit}`]) !== state.resultHeadSha) fail();
  return state.resultHeadSha;
}

export function executionDeadlineForSubtask(storage: TaskStorage, subtaskId: SubtaskId, revalidateSource = true): (() => number) | null {
  const subtask = storage.getSubtaskById(subtaskId);
  if (subtask === null || !isLivePlannedTask(storage, subtask.bigTaskId)) return null;
  const execution = new BigTaskExecutionStore(storage);
  if (revalidateSource) execution.assertRunning(subtask.bigTaskId);
  // These scopes are synchronous. Freeze the original deadline and latest
  // durable event, then cheaply invalidate on any intervening execution change.
  // This retains pause/stop behavior without replaying the whole history before
  // and after every Git command. Creation/release also revalidate source above.
  const state = execution.inspect(subtask.bigTaskId);
  const latest = access(storage).sqlite.prepare("SELECT sequence, payload FROM big_task_execution_events WHERE big_task_id = ? ORDER BY sequence DESC LIMIT 1");
  const event = latest.get(subtask.bigTaskId);
  if (event === undefined || state.expiresAt === null) fail();
  let kind: unknown;
  try { kind = (JSON.parse(String(event.payload)) as { kind?: unknown }).kind; } catch { fail(); }
  if (typeof kind !== "string" || !["START", "ROLE", "INTEGRATION_PREPARED", "INTEGRATE"].includes(kind)) fail();
  const expiresAt = Date.parse(state.expiresAt);
  const remaining = (): number => {
    access(storage);
    const current = latest.get(subtask.bigTaskId);
    if (current?.sequence !== event.sequence || current?.payload !== event.payload) return 0;
    return Math.max(0, expiresAt - Date.parse(timestamp(storage)));
  };
  if (state.phase !== "RUNNING" || hasUnacknowledgedExecutionUsage(state) ||
    executionTokenLimitReached(state) || remaining() <= 0) fail();
  return remaining;
}

/** Package-private coordinator commit. No model tool receives Git common-directory write authority. */
export function commitApprovedExecutionCandidate(storage: TaskStorage, input: {
  bigTaskId: BigTaskId; authorizationId: string; parentSha: string; authorizedAt: string; ownership: WorktreeOwnership;
}): void {
  if (!isLivePlannedTask(storage, input.bigTaskId)) return;
  const execution = new BigTaskExecutionStore(storage);
  execution.assertRunning(input.bigTaskId);
  const path = input.ownership.worktreePath;
  const remaining = (): number => execution.remainingMilliseconds(input.bigTaskId);
  const git = (args: readonly string[], body?: Buffer, index?: string, date?: string): string =>
    executionGit(path, args, body, index, date, remaining);
  if (git(["rev-parse", "--verify", "HEAD^{commit}"]) !== input.parentSha ||
    git(["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${input.ownership.branchName}`) fail();
  if (git(["status", "--porcelain=v2", "--untracked-files=all", "-z"]) === "") return;
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), "ctc-candidate-index-"));
  const index = join(temporary, "index");
  try {
    git(["read-tree", input.parentSha], undefined, index);
    const names = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    if (names.length > 10_000 || new Set(names).size !== names.length) fail();
    let bytes = 0;
    for (const name of names) {
      if (remaining() <= 0) fail();
      if (name.startsWith("/") || name.includes("\\") || name.split("/").some(part => ["", ".", "..", ".git"].includes(part))) fail();
      const absolute = join(path, name);
      if (!absolute.startsWith(path + sep)) fail();
      if (!existsSync(absolute)) {
        git(["update-index", "--force-remove", "--", name], undefined, index); continue;
      }
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync.native(absolute) !== absolute || (bytes += stat.size) > 64 * 1024 * 1024) fail();
      const body = readFileSync(absolute);
      if (body.length !== stat.size) fail();
      const hash = git(["hash-object", "--no-filters", "-w", "--stdin"], body);
      git(["update-index", "--add", "--cacheinfo", stat.mode & 0o111 ? "100755" : "100644", hash, name], undefined, index);
    }
    const tree = git(["write-tree"], undefined, index);
    const priorTree = git(["rev-parse", `${input.parentSha}^{tree}`]);
    if (tree === priorTree) fail();
    const commit = git(["commit-tree", tree, "-p", input.parentSha],
      Buffer.from(`Console candidate ${input.authorizationId}\n`, "utf8"), index, input.authorizedAt);
    RepositoryCommitShaSchema.parse(commit);
    execution.assertRunning(input.bigTaskId);
    git(["update-ref", `refs/heads/${input.ownership.branchName}`, commit, input.parentSha]);
    // Update only this owned index; never reset or rewrite working files.
    git(["read-tree", commit]);
    if (git(["status", "--porcelain=v2", "--untracked-files=all", "-z"]) !== "") fail();
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Historical workflow replay uses the immutable approval limit, without requiring a running lease. */
export function approvedRepairCycleLimit(storage: TaskStorage, id: BigTaskId): 1 | 2 {
  if (!isLivePlannedTask(storage, id)) return 1;
  const row = access(storage).sqlite.prepare("SELECT payload FROM big_task_execution_approvals WHERE big_task_id = ?").get(id);
  if (row === undefined) return 1;
  return new BigTaskExecutionStore(storage).repairCycleLimit(id);
}

export const recoveryAuthorizationId = (failedAuthorizationId: string): string =>
  `gra_${executionDigest(["RECOVERY", failedAuthorizationId]).slice(0, 48)}`;

/** Read-only content binding for the exact retained candidate; no hooks, index or working-file writes. */
export function executionCandidateDigest(ownership: WorktreeOwnership, remainingMilliseconds?: () => number): string {
  const path = ownership.worktreePath;
  const git = (args: readonly string[]) => executionGit(path, args, undefined, undefined, undefined, remainingMilliseconds);
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (git(["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${ownership.branchName}`) fail();
  const names = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  if (names.length > 10_000 || new Set(names).size !== names.length) fail();
  let bytes = 0;
  const files = names.map(name => {
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some(part => ["", ".", "..", ".git"].includes(part))) fail();
    const absolute = join(path, name);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, null]; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync.native(absolute) !== absolute || (bytes += stat.size) > 64 * 1024 * 1024) fail();
    const body = readFileSync(absolute);
    if (body.length !== stat.size || remainingMilliseconds !== undefined && remainingMilliseconds() <= 0) fail();
    return [name, stat.mode & 0o111 ? "100755" : "100644", createHash("sha256").update(body).digest("hex")];
  });
  return executionDigest({ ownershipId: ownership.id, head, files });
}
