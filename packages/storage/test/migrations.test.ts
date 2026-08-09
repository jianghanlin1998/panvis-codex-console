import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeBigTask,
  makeDependency,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const acceptedS0B1Migration = fileURLToPath(
  new URL("../drizzle/20260809002701_public_mephisto", import.meta.url),
);

describe("database lifecycle and migrations", () => {
  it("migrates a fresh in-memory database", () => {
    withMemoryStorage((storage) => {
      expect(storage.isOpen).toBe(true);
      expect(storage.listProjects()).toEqual([]);
      storage.createProject(makeProject());
      expect(
        storage.listContextItemsByScope({
          scopeType: "PROJECT",
          projectId: makeProject().id,
        }),
      ).toEqual([]);
    });
  });

  it("creates only the accepted durable tables on a fresh database", () => {
    withTemporaryDatabasePath((databasePath) => {
      openTaskDatabase({ databasePath, clock: fixedClock }).close();
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const tables = sqlite
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => (row as { readonly name: string }).name);
        expect(tables).toEqual([
          "__drizzle_migrations",
          "big_tasks",
          "context_items",
          "projects",
          "subtasks",
          "task_dependencies",
        ]);
      } finally {
        sqlite.close();
      }
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
        expect(row.count).toBe(2);
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
        expect(row.count).toBe(2);
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

  it("migrates an existing S0B1 database without losing task data", () => {
    withTemporaryDatabasePath((databasePath) => {
      const s0b1Migrations = join(dirname(databasePath), "s0b1-migrations");
      mkdirSync(s0b1Migrations);
      cpSync(
        acceptedS0B1Migration,
        join(s0b1Migrations, basename(acceptedS0B1Migration)),
        { recursive: true },
      );

      const before = openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: s0b1Migrations,
      });
      createHierarchy(before);
      const dependency = makeDependency("st_a", "st_b");
      before.replaceDependenciesForBigTask(makeBigTask().id, [dependency]);
      before.close();

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(migrated.getProjectById(makeProject().id)).toEqual(makeProject());
        expect(migrated.getBigTaskById(makeBigTask().id)).toEqual(makeBigTask());
        expect(migrated.getSubtaskById(makeSubtask("st_a").id)).toEqual(
          makeSubtask("st_a"),
        );
        expect(migrated.listDependenciesForBigTask(makeBigTask().id)).toEqual([
          dependency,
        ]);
        expect(
          migrated.listContextItemsByScope({
            scopeType: "PROJECT",
            projectId: makeProject().id,
          }),
        ).toEqual([]);
      } finally {
        migrated.close();
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
