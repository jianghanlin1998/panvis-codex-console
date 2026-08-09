import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BigTaskSchema,
  ProjectSchema,
  SubtaskDependencySchema,
  SubtaskSchema,
} from "@codex-task-console/domain";
import type {
  BigTask,
  Project,
  Subtask,
  SubtaskDependency,
} from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";

export const FIXED_TIME = "2026-08-09T00:00:00.000Z";
export const fixedClock = (): Date => new Date(FIXED_TIME);

export const makeProject = (id = "prj_console", slug = "codex-task-console"): Project =>
  ProjectSchema.parse({
    recordType: "PROJECT",
    id,
    name: `Project ${id}`,
    slug,
    repository: { kind: "PATH", path: `/repositories/${slug}` },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });

export const makeBigTask = (
  id = "bt_v1",
  projectId = "prj_console",
  status: "IN_PROGRESS" | "DONE" = "IN_PROGRESS",
): BigTask =>
  BigTaskSchema.parse({
    recordType: "BIG_TASK",
    id,
    projectId,
    title: `Big Task ${id}`,
    goal: `Goal ${id}`,
    rationale: `Rationale ${id}`,
    scopeIn: ["Core task storage", id],
    scopeOut: ["Deferred capabilities"],
    acceptanceCriteria: ["Round-trips exactly"],
    status,
  });

export const makeSubtask = (
  id = "st_a",
  bigTaskId = "bt_v1",
  status: "TODO" | "IN_PROGRESS" | "QA_DEBUG" | "DONE" | "DROPPED" | "ARCHIVED" =
    "TODO",
): Subtask =>
  SubtaskSchema.parse({
    recordType: "SUBTASK",
    id,
    bigTaskId,
    title: `Subtask ${id}`,
    goal: `Goal ${id}`,
    scopeIn: ["Persist", id],
    scopeOut: ["Run Codex"],
    acceptanceCriteria: ["Data round-trips"],
    untouchedAreas: ["Panvis"],
    status,
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
    promptSeed: `Stable intent for ${id}`,
  });

export const makeDependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  dependencyType: "BLOCKING" | "INFORMATIONAL" = "BLOCKING",
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType,
  });

export const withMemoryStorage = <T>(operation: (storage: TaskStorage) => T): T => {
  const storage = openTaskDatabase({ databasePath: ":memory:", clock: fixedClock });
  try {
    return operation(storage);
  } finally {
    storage.close();
  }
};

export const withTemporaryDatabasePath = <T>(operation: (databasePath: string) => T): T => {
  const directory = mkdtempSync(join(tmpdir(), "codex-task-console-storage-"));
  const databasePath = join(directory, "task-console.sqlite");
  try {
    return operation(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

export const createHierarchy = (storage: TaskStorage): void => {
  storage.createProject(makeProject());
  storage.createBigTask(makeBigTask());
  storage.createSubtask(makeSubtask("st_a"));
  storage.createSubtask(makeSubtask("st_b"));
  storage.createSubtask(makeSubtask("st_c"));
};

export const captureTaskStorageError = (operation: () => unknown): TaskStorageError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof TaskStorageError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a TaskStorageError.");
};
