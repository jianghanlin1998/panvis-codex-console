import { describe, expect, expectTypeOf, it } from "vitest";

import {
  auditEventsTable,
  bigTasksTable,
  contextDigestsTable,
  contextItemsTable,
  openTaskDatabase,
  projectsTable,
  STORAGE_ERROR_CODES,
  subtaskImplementationCheckpointsTable,
  subtasksTable,
  taskDependenciesTable,
  TaskStorage,
  TaskStorageError,
} from "@codex-task-console/storage";
import type {
  ActiveContextItemBucket,
  ActiveContextItemSnapshot,
  AllowedRawContextItemBucket,
  AllowedRawContextItemSnapshot,
  JitContextStorageSourceSnapshot,
} from "@codex-task-console/storage";

describe("storage package public exports", () => {
  it("exposes only the deliberate storage contract surface", () => {
    expect(openTaskDatabase).toBeTypeOf("function");
    expect(TaskStorage).toBeTypeOf("function");
    expect(TaskStorageError).toBeTypeOf("function");
    expect(STORAGE_ERROR_CODES).toContain("MIGRATION_FAILED");
    expect(projectsTable).toBeDefined();
    expect(bigTasksTable).toBeDefined();
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
    expectTypeOf<JitContextStorageSourceSnapshot>().toBeObject();
  });
});
