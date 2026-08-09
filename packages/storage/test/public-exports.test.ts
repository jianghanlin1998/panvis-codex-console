import { describe, expect, it } from "vitest";

import {
  bigTasksTable,
  openTaskDatabase,
  projectsTable,
  STORAGE_ERROR_CODES,
  subtasksTable,
  taskDependenciesTable,
  TaskStorage,
  TaskStorageError,
} from "@codex-task-console/storage";

describe("storage package public exports", () => {
  it("exposes only the deliberate storage contract surface", () => {
    expect(openTaskDatabase).toBeTypeOf("function");
    expect(TaskStorage).toBeTypeOf("function");
    expect(TaskStorageError).toBeTypeOf("function");
    expect(STORAGE_ERROR_CODES).toContain("MIGRATION_FAILED");
    expect(projectsTable).toBeDefined();
    expect(bigTasksTable).toBeDefined();
    expect(subtasksTable).toBeDefined();
    expect(taskDependenciesTable).toBeDefined();
  });
});
