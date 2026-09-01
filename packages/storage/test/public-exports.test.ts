import { describe, expect, expectTypeOf, it } from "vitest";

import {
  auditEventsTable,
  bigTasksTable,
  chatThreadsTable,
  contextDigestsTable,
  contextItemsTable,
  ExecutionInputPreflight,
  ExecutionInputPreflightError,
  executionRunsTable,
  openTaskDatabase,
  OperationalJitContextAssembler,
  OperationalJitContextAssemblyError,
  projectsTable,
  STORAGE_ERROR_CODES,
  subtaskImplementationCheckpointsTable,
  subtasksTable,
  taskDependenciesTable,
  TaskStorage,
  TaskStorageError,
  TrustedRepositorySourceError,
  TrustedRepositorySourceReader,
} from "@codex-task-console/storage";
import type {
  ActiveContextItemBucket,
  ActiveContextItemSnapshot,
  AllowedRawContextItemBucket,
  AllowedRawContextItemSnapshot,
  BoundedDurableExecutionHistory,
  BoundedDurableExecutionHistoryOptions,
  BoundedDurableExecutionHistoryThread,
  BindChatThreadProviderReferenceInput,
  CreateChatThreadInput,
  CreateExecutionRunInput,
  ExecutionInputPreflightErrorCode,
  ExecutionInputPreflightResult,
  FinishExecutionRunInput,
  JitContextStorageSourceSnapshot,
  OperationalJitContextAssemblyErrorCode,
  OperationalJitContextProfile,
  StartExecutionRunInput,
  TrustedRepositorySourceErrorCode,
  TrustedRepositorySourceSnapshot,
  TrustedRepositorySourceTextBlock,
} from "@codex-task-console/storage";

describe("storage package public exports", () => {
  it("exposes only the deliberate storage contract surface", () => {
    expect(openTaskDatabase).toBeTypeOf("function");
    expect(TaskStorage).toBeTypeOf("function");
    expect(TaskStorageError).toBeTypeOf("function");
    expect(OperationalJitContextAssembler).toBeTypeOf("function");
    expect(OperationalJitContextAssemblyError).toBeTypeOf("function");
    expect(ExecutionInputPreflight).toBeTypeOf("function");
    expect(ExecutionInputPreflightError).toBeTypeOf("function");
    expect(TrustedRepositorySourceReader).toBeTypeOf("function");
    expect(TrustedRepositorySourceError).toBeTypeOf("function");
    expect(STORAGE_ERROR_CODES).toContain("MIGRATION_FAILED");
    expect(projectsTable).toBeDefined();
    expect(bigTasksTable).toBeDefined();
    expect(chatThreadsTable).toBeDefined();
    expect(executionRunsTable).toBeDefined();
    expect(contextDigestsTable).toBeDefined();
    expect(auditEventsTable).toBeDefined();
    expect(contextItemsTable).toBeDefined();
    expect(subtasksTable).toBeDefined();
    expect(taskDependenciesTable).toBeDefined();
    expect(subtaskImplementationCheckpointsTable).toBeDefined();
    expectTypeOf<ActiveContextItemBucket>().toBeObject();
    expectTypeOf<ActiveContextItemSnapshot>().toBeObject();
    expectTypeOf<AllowedRawContextItemBucket>().toBeObject();
    expectTypeOf<AllowedRawContextItemSnapshot>().toBeObject();
    expectTypeOf<BoundedDurableExecutionHistory>().toBeObject();
    expectTypeOf<BoundedDurableExecutionHistoryOptions>().toBeObject();
    expectTypeOf<BoundedDurableExecutionHistoryThread>().toBeObject();
    expectTypeOf<BindChatThreadProviderReferenceInput>().toBeObject();
    expectTypeOf<CreateChatThreadInput>().toBeObject();
    expectTypeOf<CreateExecutionRunInput>().toBeObject();
    expectTypeOf<StartExecutionRunInput>().toBeObject();
    expectTypeOf<FinishExecutionRunInput>().toBeObject();
    expectTypeOf<JitContextStorageSourceSnapshot>().toBeObject();
    expectTypeOf<OperationalJitContextAssemblyErrorCode>().toBeString();
    expectTypeOf<OperationalJitContextProfile>().toBeString();
    expectTypeOf<ExecutionInputPreflightErrorCode>().toBeString();
    expectTypeOf<ExecutionInputPreflightResult>().toBeObject();
    expectTypeOf<TrustedRepositorySourceSnapshot>().toBeObject();
    expectTypeOf<TrustedRepositorySourceTextBlock>().toBeObject();
    expectTypeOf<TrustedRepositorySourceErrorCode>().toBeString();
  });
});
