import {
  executeGovernedRoleCodex,
  executeSingleSubtaskOwnedWorktreeCodex,
} from "@codex-task-console/codex-adapter";
import type {
  GovernedRoleCodexExecutionResult,
  OwnedWorktreeCodexExecutionResult,
} from "@codex-task-console/codex-adapter";
import type {
  BigTaskId,
  ChatThread,
  ExecutionRun,
  SubtaskId,
  WorktreeOwnership,
} from "@codex-task-console/domain";
import {
  TaskStorageError,
  WorktreeOwnershipError,
  createGovernedExecutionStore,
  createWorktreeOwnershipManager,
} from "@codex-task-console/storage";
import type {
  GovernedExecutionStore,
  TaskStorage,
  WorktreeOwnershipManager,
} from "@codex-task-console/storage";

const MAX_RECENT_THREADS = 8;
const MAX_RECENT_RUNS_PER_THREAD = 8;

export type LocalControlServiceErrorCode =
  | "INVALID_REQUEST"
  | "SUBTASK_NOT_FOUND"
  | "OPERATION_CONFLICT"
  | "LOCAL_OPERATION_FAILED";

export class LocalControlServiceError extends Error {
  readonly code: LocalControlServiceErrorCode;
  readonly httpStatus: 400 | 404 | 409 | 500;

  constructor(
    code: LocalControlServiceErrorCode,
    httpStatus: 400 | 404 | 409 | 500,
  ) {
    super(code);
    this.name = "LocalControlServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface ThreadSummary {
  readonly id: string;
  readonly status: ChatThread["status"];
  readonly providerId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runs: readonly RunSummary[];
}

interface RunSummary {
  readonly id: string;
  readonly status: ExecutionRun["status"];
  readonly providerRunId: string | null;
  readonly providerModelId: string | null;
  readonly normalizedUsage: ExecutionRun["normalizedUsage"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubtaskInspection {
  readonly subtask: {
    readonly id: string;
    readonly status: string;
    readonly maturity: string;
  };
  readonly dependencyReadiness: {
    readonly valid: boolean;
    readonly ready: boolean;
    readonly blockerCount: number;
    readonly errorCodes: readonly string[];
  };
  readonly worktree: {
    readonly id: string;
    readonly status: string;
    readonly activeAuthorityVerified: boolean;
  } | null;
  readonly durableExecution: {
    readonly chatThreadCount: number;
    readonly returnedChatThreadCount: number;
    readonly recentChatThreads: readonly ThreadSummary[];
  };
}

export interface WorktreeOperationResult {
  readonly worktree: {
    readonly id: string;
    readonly status: WorktreeOwnership["status"];
    readonly startingCommitSha: string;
    readonly releaseHeadSha: string | null;
  };
}

export interface ExecutionOperationResult {
  readonly execution: {
    readonly success: boolean;
    readonly failureCode: string | null;
    readonly chatThreadId: string | null;
    readonly executionRunId: string | null;
    readonly worktreeOwnershipId: string | null;
    readonly providerId: string;
    readonly providerThreadId: string | null;
    readonly providerRunId: string | null;
    readonly providerModelId: string | null;
    readonly normalizedUsage: OwnedWorktreeCodexExecutionResult["normalizedUsage"];
    readonly terminalTurnStatus: OwnedWorktreeCodexExecutionResult["terminalTurnStatus"];
    readonly appServerChildCleaned: boolean;
    readonly transientRuntimeCleaned: boolean;
  };
}

export interface LocalControlService {
  inspectSubtask(subtaskId: SubtaskId): Promise<SubtaskInspection>;
  provisionOwnedWorktree(subtaskId: SubtaskId): Promise<WorktreeOperationResult>;
  runOwnedWorktreeExecution(subtaskId: SubtaskId): Promise<ExecutionOperationResult>;
  releaseOwnedWorktree(subtaskId: SubtaskId): Promise<WorktreeOperationResult>;
  inspectGovernedBigTask?(bigTaskId: BigTaskId): Promise<object>;
  advanceGovernedBigTask?(bigTaskId: BigTaskId): Promise<object>;
  authorizeGovernedManualStart?(subtaskId: SubtaskId): Promise<object>;
  authorizeGovernedBudgetExtension?(subtaskId: SubtaskId): Promise<object>;
}

const sanitizeStorageError = (error: unknown): LocalControlServiceError => {
  if (error instanceof LocalControlServiceError) {
    return error;
  }
  if (error instanceof TaskStorageError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return new LocalControlServiceError("INVALID_REQUEST", 400);
      case "PARENT_NOT_FOUND":
        return new LocalControlServiceError("SUBTASK_NOT_FOUND", 404);
      case "CONFLICT":
        return new LocalControlServiceError("OPERATION_CONFLICT", 409);
      default:
        return new LocalControlServiceError("LOCAL_OPERATION_FAILED", 500);
    }
  }
  if (error instanceof WorktreeOwnershipError) {
    switch (error.code) {
      case "INVALID_SUBTASK_ID":
        return new LocalControlServiceError("INVALID_REQUEST", 400);
      case "TASK_HIERARCHY_UNAVAILABLE":
        return new LocalControlServiceError("SUBTASK_NOT_FOUND", 404);
      case "STORAGE_UNAVAILABLE":
      case "MALFORMED_STORED_OWNERSHIP":
        return new LocalControlServiceError("LOCAL_OPERATION_FAILED", 500);
      default:
        return new LocalControlServiceError("OPERATION_CONFLICT", 409);
    }
  }
  return new LocalControlServiceError("LOCAL_OPERATION_FAILED", 500);
};

const summarizeRun = (run: ExecutionRun): RunSummary =>
  Object.freeze({
    id: run.id,
    status: run.status,
    providerRunId: run.providerRun?.providerRunId ?? null,
    providerModelId: run.providerModel?.providerModelId ?? null,
    normalizedUsage: run.normalizedUsage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });

const summarizeThread = (
  thread: ChatThread,
  runs: readonly ExecutionRun[],
): ThreadSummary => {
  return Object.freeze({
    id: thread.id,
    status: thread.status,
    providerId: thread.providerId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    runs: Object.freeze(
      runs.map(summarizeRun),
    ),
  });
};

const summarizeWorktree = (
  ownership: WorktreeOwnership,
): WorktreeOperationResult =>
  Object.freeze({
    worktree: Object.freeze({
      id: ownership.id,
      status: ownership.status,
      startingCommitSha: ownership.startingCommitSha,
      releaseHeadSha: ownership.releaseHeadSha,
    }),
  });

const summarizeExecution = (
  result: OwnedWorktreeCodexExecutionResult,
): ExecutionOperationResult =>
  Object.freeze({
    execution: Object.freeze({
      success: result.success,
      failureCode: result.failureCode,
      chatThreadId: result.chatThreadId,
      executionRunId: result.executionRunId,
      worktreeOwnershipId: result.worktreeOwnershipId,
      providerId: result.providerId,
      providerThreadId: result.providerThread?.providerThreadId ?? null,
      providerRunId: result.providerRun?.providerRunId ?? null,
      providerModelId: result.model?.providerModelId ?? null,
      normalizedUsage: result.normalizedUsage,
      terminalTurnStatus: result.terminalTurnStatus,
      appServerChildCleaned: result.appServerChildCleaned,
      transientRuntimeCleaned: result.transientRuntimeCleaned,
    }),
  });

class ProductionLocalControlService implements LocalControlService {
  readonly #storage: TaskStorage;
  readonly #worktrees: WorktreeOwnershipManager;
  readonly #governed: GovernedExecutionStore;
  readonly #execute: (
    storage: TaskStorage,
    subtaskId: SubtaskId,
  ) => Promise<OwnedWorktreeCodexExecutionResult>;
  readonly #executeGoverned: (
    governed: GovernedExecutionStore,
    authorizationId: string,
  ) => Promise<GovernedRoleCodexExecutionResult>;

  constructor(
    storage: TaskStorage,
    worktrees: WorktreeOwnershipManager,
    execute: (
      storage: TaskStorage,
      subtaskId: SubtaskId,
    ) => Promise<OwnedWorktreeCodexExecutionResult>,
    executeGoverned: (
      governed: GovernedExecutionStore,
      authorizationId: string,
    ) => Promise<GovernedRoleCodexExecutionResult>,
  ) {
    this.#storage = storage;
    this.#worktrees = worktrees;
    this.#execute = execute;
    this.#governed = createGovernedExecutionStore(storage, worktrees);
    this.#executeGoverned = executeGoverned;
  }

  async inspectSubtask(subtaskId: SubtaskId): Promise<SubtaskInspection> {
    try {
      const subtask = this.#storage.getSubtaskById(subtaskId);
      if (subtask === null) {
        throw new LocalControlServiceError("SUBTASK_NOT_FOUND", 404);
      }
      const readiness = this.#storage.evaluateStoredSubtaskDependencyReadiness(
        subtask.id,
      );
      const history = this.#worktrees.listWorktreeOwnershipHistoryForSubtask(
        subtask.id,
      );
      const latestWorktree = history.at(-1) ?? null;
      let activeAuthorityVerified = false;
      if (latestWorktree?.status === "ACTIVE") {
        try {
          activeAuthorityVerified =
            this.#worktrees.resolveActiveOwnedWorktreeForSubtask(subtask.id)
              .ownership.id === latestWorktree.id;
        } catch {
          activeAuthorityVerified = false;
        }
      }
      const executionHistory =
        this.#storage.readBoundedDurableExecutionHistoryForSubtask(subtask.id, {
          maxChatThreads: MAX_RECENT_THREADS,
          maxExecutionRunsPerThread: MAX_RECENT_RUNS_PER_THREAD,
        });
      return Object.freeze({
        subtask: Object.freeze({
          id: subtask.id,
          status: subtask.status,
          maturity: subtask.maturity,
        }),
        dependencyReadiness: Object.freeze({
          valid: readiness.valid,
          ready: readiness.ready,
          blockerCount: readiness.blockers.length,
          errorCodes: Object.freeze([...readiness.errorCodes]),
        }),
        worktree:
          latestWorktree === null
            ? null
            : Object.freeze({
                id: latestWorktree.id,
                status: latestWorktree.status,
                activeAuthorityVerified,
              }),
        durableExecution: Object.freeze({
          chatThreadCount: executionHistory.chatThreadCount,
          returnedChatThreadCount: executionHistory.recentChatThreads.length,
          recentChatThreads: Object.freeze(
            executionHistory.recentChatThreads.map(({ chatThread, executionRuns }) =>
              summarizeThread(chatThread, executionRuns),
            ),
          ),
        }),
      });
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  async provisionOwnedWorktree(
    subtaskId: SubtaskId,
  ): Promise<WorktreeOperationResult> {
    try {
      return summarizeWorktree(
        this.#worktrees.provisionOwnedWorktreeForSubtask(subtaskId),
      );
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  async runOwnedWorktreeExecution(
    subtaskId: SubtaskId,
  ): Promise<ExecutionOperationResult> {
    try {
      return summarizeExecution(
        await this.#execute(this.#storage, subtaskId),
      );
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  async releaseOwnedWorktree(
    subtaskId: SubtaskId,
  ): Promise<WorktreeOperationResult> {
    try {
      return summarizeWorktree(
        this.#worktrees.releaseOwnedWorktreeForSubtask(subtaskId),
      );
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  async inspectGovernedBigTask(bigTaskId: BigTaskId): Promise<object> {
    try {
      return this.#governed.inspectBigTask(bigTaskId);
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  async advanceGovernedBigTask(bigTaskId: BigTaskId): Promise<object> {
    try {
      const prepared = this.#governed.prepareNextRole(bigTaskId);
      if (prepared.kind !== "ROLE_AUTHORIZED") {
        return Object.freeze({ prepared, execution: null });
      }
      const execution = await this.#executeGoverned(
        this.#governed,
        prepared.authorization.authorizationId,
      );
      return Object.freeze({
        prepared,
        execution: summarizeGovernedExecution(execution),
      });
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  async authorizeGovernedManualStart(subtaskId: SubtaskId): Promise<object> {
    try {
      return this.#governed.authorizeManualStart(subtaskId);
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  async authorizeGovernedBudgetExtension(
    subtaskId: SubtaskId,
  ): Promise<object> {
    try {
      return this.#governed.authorizeOneTimeBudgetExtension(subtaskId);
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }
}

const summarizeGovernedExecution = (
  result: GovernedRoleCodexExecutionResult,
): Readonly<{
  success: boolean;
  failureCode: string | null;
  authorizationId: string | null;
  role: string | null;
  executionRunId: string | null;
  outcome: string | null;
  reconciliationKind: GovernedRoleReconciliationResultKind | null;
}> =>
  Object.freeze({
    success: result.success,
    failureCode: result.failureCode,
    authorizationId: result.authorization?.authorizationId ?? null,
    role: result.authorization?.role ?? null,
    executionRunId: result.executionRunId,
    outcome: result.roleResult?.outcome ?? null,
    reconciliationKind: result.reconciliation?.kind ?? null,
  });

type GovernedRoleReconciliationResultKind =
  NonNullable<GovernedRoleCodexExecutionResult["reconciliation"]>["kind"];

export const createProductionLocalControlService = (
  storage: TaskStorage,
): LocalControlService =>
  new ProductionLocalControlService(
    storage,
    createWorktreeOwnershipManager(storage),
    executeSingleSubtaskOwnedWorktreeCodex,
    executeGovernedRoleCodex,
  );

/** Package-private deterministic-test seam; not exported from the package root. */
export const createLocalControlServiceForTesting = (
  storage: TaskStorage,
  worktrees: WorktreeOwnershipManager,
  execute: (
    storage: TaskStorage,
    subtaskId: SubtaskId,
  ) => Promise<OwnedWorktreeCodexExecutionResult>,
  executeGoverned: (
    governed: GovernedExecutionStore,
    authorizationId: string,
  ) => Promise<GovernedRoleCodexExecutionResult> = executeGovernedRoleCodex,
): LocalControlService =>
  new ProductionLocalControlService(
    storage,
    worktrees,
    execute,
    executeGoverned,
  );
