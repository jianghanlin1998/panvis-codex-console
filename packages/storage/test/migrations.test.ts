import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeProject,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

describe("database lifecycle and migrations", () => {
  it("migrates a fresh in-memory database", () => {
    withMemoryStorage((storage) => {
      expect(storage.isOpen).toBe(true);
      expect(storage.listProjects()).toEqual([]);
    });
  });

  it("records applied migration state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get() as {
          readonly count: number;
        };
        expect(row.count).toBe(1);
      } finally {
        sqlite.close();
      }
    });
  });

  it("runs migration setup twice without duplicating migration state", () => {
    withTemporaryDatabasePath((databasePath) => {
      openTaskDatabase({ databasePath, clock: fixedClock }).close();
      openTaskDatabase({ databasePath, clock: fixedClock }).close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get() as {
          readonly count: number;
        };
        expect(row.count).toBe(1);
      } finally {
        sqlite.close();
      }
    });
  });

  it("persists file-backed records after close and reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: fixedClock });
      first.createProject(makeProject());
      first.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getProjectById(makeProject().id)).toEqual(makeProject());
      } finally {
        reopened.close();
      }
    });
  });

  it("stores injected timestamps as deterministic UTC values", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = sqlite
          .prepare("SELECT created_at, updated_at FROM projects WHERE id = ?")
          .get("prj_console") as { readonly created_at: string; readonly updated_at: string };
        expect(row).toEqual({
          created_at: "2026-08-09T00:00:00.000Z",
          updated_at: "2026-08-09T00:00:00.000Z",
        });
      } finally {
        sqlite.close();
      }
    });
  });

  it("enables foreign-key enforcement", () => {
    withMemoryStorage((storage) => {
      expect(storage.isForeignKeyEnforcementEnabled()).toBe(true);
    });
  });

  it("returns a sanitized typed migration failure", () => {
    withTemporaryDatabasePath((databasePath) => {
      const missingMigrations = join(dirname(databasePath), "missing-migrations");
      let thrown: unknown;
      try {
        openTaskDatabase({ databasePath, clock: fixedClock, migrationsFolder: missingMigrations });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TaskStorageError);
      expect((thrown as TaskStorageError).code).toBe("MIGRATION_FAILED");
      expect((thrown as Error).message).toBe("Task database migration failed.");
      expect((thrown as Error).message).not.toContain(missingMigrations);
      expect((thrown as Error).message).not.toMatch(/ENOENT|no such file/i);
    });
  });

  it("closes explicitly and rejects later operations", () => {
    const storage = openTaskDatabase({ databasePath: ":memory:", clock: fixedClock });
    storage.close();
    storage.close();

    expect(storage.isOpen).toBe(false);
    expect(captureTaskStorageError(() => storage.listProjects()).code).toBe("DATABASE_CLOSED");
  });
});
