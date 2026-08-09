import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { BigTask, Subtask } from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import {
  fixedClock,
  makeBigTask,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

describe("Big Task storage", () => {
  it("creates and round-trips a valid Big Task with status and arrays", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      const bigTask = makeBigTask("bt_done", "prj_console", "DONE");
      expect(storage.createBigTask(bigTask)).toEqual(bigTask);
      expect(storage.getBigTaskById(bigTask.id)).toEqual(bigTask);
    });
  });

  it("limits deterministic Big Task lists to the requested Project", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_b", "prj_a"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      storage.createBigTask(makeBigTask("bt_other", "prj_b"));

      expect(storage.listBigTasksByProject(makeProject("prj_a", "project-a").id).map(({ id }) => id)).toEqual([
        "bt_a",
        "bt_b",
      ]);
    });
  });

  it("rejects a missing parent Project", () => {
    withMemoryStorage((storage) => {
      let thrown: unknown;
      try {
        storage.createBigTask(makeBigTask());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "PARENT_NOT_FOUND" });
      expect(storage.listBigTasksByProject(makeProject().id)).toEqual([]);
    });
  });

  it("rejects invalid Big Task input before writing", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      const invalid = { ...makeBigTask(), status: "TODO" } as unknown as BigTask;
      let thrown: unknown;
      try {
        storage.createBigTask(invalid);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.listBigTasksByProject(makeProject().id)).toEqual([]);
    });
  });
});

describe("Subtask storage", () => {
  it("creates and round-trips status, policies, prompt seed, and arrays", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      const subtask = {
        ...makeSubtask("st_done", "bt_v1", "DONE"),
        startPolicy: "WHEN_READY" as const,
        delegationPolicy: "REVIEW_ONLY" as const,
        recommendedReasoningLevel: "XHIGH" as const,
      };
      expect(storage.createSubtask(subtask)).toEqual(subtask);
      expect(storage.getSubtaskById(subtask.id)).toEqual(subtask);
    });
  });

  it("limits deterministic Subtask lists to the requested Big Task", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask("bt_a"));
      storage.createBigTask(makeBigTask("bt_b"));
      storage.createSubtask(makeSubtask("st_b", "bt_a"));
      storage.createSubtask(makeSubtask("st_a", "bt_a"));
      storage.createSubtask(makeSubtask("st_other", "bt_b"));

      expect(storage.listSubtasksByBigTask(makeBigTask("bt_a").id).map(({ id }) => id)).toEqual([
        "st_a",
        "st_b",
      ]);
    });
  });

  it("rejects a missing parent Big Task", () => {
    withMemoryStorage((storage) => {
      let thrown: unknown;
      try {
        storage.createSubtask(makeSubtask());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "PARENT_NOT_FOUND" });
      expect(storage.getSubtaskById(makeSubtask().id)).toBeNull();
    });
  });

  it("rejects invalid Subtask input before writing", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      const invalid = { ...makeSubtask(), startPolicy: "AUTOMATIC" } as unknown as Subtask;
      let thrown: unknown;
      try {
        storage.createSubtask(invalid);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.listSubtasksByBigTask(makeBigTask().id)).toEqual([]);
    });
  });

  it("returns a sanitized typed error for malformed stored structured data", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      storage.createSubtask(makeSubtask());
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare("UPDATE subtasks SET scope_in = ? WHERE id = ?").run("not-json", "st_a");
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        let thrown: unknown;
        try {
          reopened.getSubtaskById(makeSubtask().id);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(TaskStorageError);
        expect(thrown).toMatchObject({ code: "MALFORMED_STORED_DATA" });
        expect((thrown as Error).message).not.toMatch(/JSON|Unexpected token|not-json/i);
      } finally {
        reopened.close();
      }
    });
  });

  it("does not mutate caller-owned structured arrays", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      const scopeIn = ["Persist", "st_frozen"];
      Object.freeze(scopeIn);
      const subtask = Object.freeze({ ...makeSubtask("st_frozen"), scopeIn });
      const snapshot = JSON.stringify(subtask);
      storage.createSubtask(subtask);
      expect(JSON.stringify(subtask)).toBe(snapshot);
      expect(subtask.scopeIn).toBe(scopeIn);
    });
  });
});
