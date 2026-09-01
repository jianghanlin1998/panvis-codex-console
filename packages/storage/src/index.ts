export { TaskStorageError, STORAGE_ERROR_CODES } from "./errors.js";
export type { StorageErrorCode } from "./errors.js";

export {
  auditEventsTable,
  bigTasksTable,
  chatThreadsTable,
  contextDigestsTable,
  contextItemsTable,
  executionRunsTable,
  projectsTable,
  subtaskImplementationCheckpointsTable,
  subtasksTable,
  taskDependenciesTable,
} from "./schema.js";

export { openTaskDatabase, TaskStorage } from "./task-storage.js";
export type {
  ActiveContextItemBucket,
  ActiveContextItemSnapshot,
  AllowedRawContextItemBucket,
  AllowedRawContextItemSnapshot,
  BoundedDurableExecutionHistory,
  BoundedDurableExecutionHistoryOptions,
  BoundedDurableExecutionHistoryThread,
  BindChatThreadProviderReferenceInput,
  CompleteSubtaskImplementationInput,
  CompleteSubtaskImplementationResult,
  CreateChatThreadInput,
  CreateExecutionRunInput,
  FinishExecutionRunInput,
  FinalizePrimaryExecutionAttemptInput,
  FinalizedPrimaryExecutionAttempt,
  JitContextStorageSourceSnapshot,
  OpenTaskDatabaseOptions,
  ReservePrimaryExecutionAttemptInput,
  ReservedPrimaryExecutionAttempt,
  StartExecutionRunInput,
} from "./task-storage.js";

export {
  TrustedRepositorySourceError,
  TrustedRepositorySourceReader,
} from "./trusted-repository-source.js";
export type {
  TrustedRepositorySourceErrorCode,
  TrustedRepositorySourceSnapshot,
  TrustedRepositorySourceTextBlock,
} from "./trusted-repository-source.js";

export {
  OperationalJitContextAssembler,
  OperationalJitContextAssemblyError,
} from "./operational-context-assembly.js";
export type {
  OperationalJitContextAssemblyErrorCode,
  OperationalJitContextProfile,
} from "./operational-context-assembly.js";

export {
  ExecutionInputPreflight,
  ExecutionInputPreflightError,
} from "./execution-input-preflight.js";

export {
  createWorktreeOwnershipManager,
  WorktreeOwnershipError,
} from "./worktree-ownership.js";
export type {
  ResolvedActiveOwnedWorktree,
  WorktreeOwnershipErrorCode,
  WorktreeOwnershipManager,
} from "./worktree-ownership.js";
export type {
  ExecutionInputPreflightErrorCode,
  ExecutionInputPreflightResult,
} from "./execution-input-preflight.js";
