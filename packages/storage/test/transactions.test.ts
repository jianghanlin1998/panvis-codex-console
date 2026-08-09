import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import {
  fixedClock,
  makeBigTask,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

describe("transactions and relational integrity", () => {
  it("commits a successful transaction", () => {
    withMemoryStorage((storage) => {
      storage.runInTransaction((transaction) => {
        transaction.createProject(makeProject());
        transaction.createBigTask(makeBigTask());
      });

      expect(storage.getProjectById(makeProject().id)).toEqual(makeProject());
      expect(storage.getBigTaskById(makeBigTask().id)).toEqual(makeBigTask());
    });
  });

  it("rolls back a thrown transaction with a sanitized error", () => {
    withMemoryStorage((storage) => {
      let thrown: unknown;
      try {
        storage.runInTransaction((transaction) => {
          transaction.createProject(makeProject());
          throw new Error("private raw callback detail");
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TaskStorageError);
      expect(thrown).toMatchObject({ code: "TRANSACTION_FAILED" });
      expect((thrown as Error).message).not.toContain("private raw callback detail");
      expect(storage.getProjectById(makeProject().id)).toBeNull();
    });
  });

  it("rejects asynchronous transaction callbacks and rolls back", () => {
    withMemoryStorage((storage) => {
      let thrown: unknown;
      try {
        storage.runInTransaction((transaction) => {
          transaction.createProject(makeProject());
          return Promise.resolve();
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "TRANSACTION_FAILED" });
      expect(storage.getProjectById(makeProject().id)).toBeNull();
    });
  });

  it("enforces documented RESTRICT parent delete behavior", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      storage.createSubtask(makeSubtask());
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        sqlite.exec("PRAGMA foreign_keys = ON");
        expect(() => sqlite.prepare("DELETE FROM projects WHERE id = ?").run("prj_console")).toThrow();
      } finally {
        sqlite.close();
      }

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getProjectById(makeProject().id)).toEqual(makeProject());
        expect(reopened.getBigTaskById(makeBigTask().id)).toEqual(makeBigTask());
        expect(reopened.getSubtaskById(makeSubtask().id)).toEqual(makeSubtask());
      } finally {
        reopened.close();
      }
    });
  });

  it("produces no orphan record after missing-parent writes", () => {
    withMemoryStorage((storage) => {
      expect(() => storage.createBigTask(makeBigTask())).toThrow(TaskStorageError);
      expect(storage.getBigTaskById(makeBigTask().id)).toBeNull();
      expect(() => storage.createSubtask(makeSubtask())).toThrow(TaskStorageError);
      expect(storage.getSubtaskById(makeSubtask().id)).toBeNull();
    });
  });
});
