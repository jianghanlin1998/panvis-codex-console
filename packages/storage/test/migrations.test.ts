import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { ContextScopeSchema } from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeContextItem,
  makeDependency,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";
import {
  insertLegacyBigTask,
  insertLegacyContextItem,
  insertLegacyDependency,
  insertLegacyProject,
  insertLegacySubtask,
  migratedLegacyDependency,
} from "./legacy-fixtures.js";

const acceptedS0B1Migration = fileURLToPath(
  new URL("../drizzle/20260809002701_public_mephisto", import.meta.url),
);
const acceptedS0B2aMigration = fileURLToPath(
  new URL("../drizzle/20260809150746_groovy_iron_monger", import.meta.url),
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
          "audit_events",
          "big_tasks",
          "context_digests",
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
        expect(row.count).toBe(4);
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
        expect(row.count).toBe(4);
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

      openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: s0b1Migrations,
      }).close();
      const dependency = makeDependency("st_a", "st_b");
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      insertLegacyProject(sqlite, makeProject());
      insertLegacyBigTask(sqlite, makeBigTask());
      for (const subtask of [
        makeSubtask("st_a"),
        makeSubtask("st_b"),
        makeSubtask("st_c"),
      ]) {
        insertLegacySubtask(sqlite, subtask);
      }
      insertLegacyDependency(sqlite, dependency);
      sqlite.close();

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(migrated.getProjectById(makeProject().id)).toEqual(makeProject());
        expect(migrated.getBigTaskById(makeBigTask().id)).toEqual(makeBigTask());
        expect(migrated.getSubtaskById(makeSubtask("st_a").id)).toEqual(
          makeSubtask("st_a"),
        );
        expect(migrated.listDependenciesForBigTask(makeBigTask().id)).toEqual([
          migratedLegacyDependency(dependency),
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

  it("preserves a non-trivial S0B1 graph and supports Context Items after migration", () => {
    withTemporaryDatabasePath((databasePath) => {
      const s0b1Migrations = join(dirname(databasePath), "s0b1-migrations-large");
      mkdirSync(s0b1Migrations);
      cpSync(
        acceptedS0B1Migration,
        join(s0b1Migrations, basename(acceptedS0B1Migration)),
        { recursive: true },
      );

      openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: s0b1Migrations,
      }).close();
      const projects = Array.from({ length: 4 }, (_, index) =>
        makeProject(`prj_migration_${index}`, `migration-${index}`),
      );
      const bigTasks = Array.from({ length: 10 }, (_, index) =>
        makeBigTask(`bt_migration_${index}`, projects[index % projects.length]!.id),
      );
      const subtaskCounts = [10, 2, 2, 2, 2, 2, 2, 1, 1, 1] as const;
      const subtasks = bigTasks.flatMap((bigTask, bigTaskIndex) =>
        Array.from({ length: subtaskCounts[bigTaskIndex]! }, (_, subtaskIndex) =>
          makeSubtask(
            `st_migration_${bigTaskIndex}_${subtaskIndex}`,
            bigTask.id,
          ),
        ),
      );
      const firstTaskSubtasks = subtasks.filter(
        ({ bigTaskId }) => bigTaskId === bigTasks[0]!.id,
      );
      const dependencies = firstTaskSubtasks
        .flatMap((upstream, upstreamIndex) =>
          firstTaskSubtasks.slice(upstreamIndex + 1).map((downstream, offset) =>
            makeDependency(
              upstream.id,
              downstream.id,
              (upstreamIndex + offset) % 2 === 0 ? "BLOCKING" : "INFORMATIONAL",
            ),
          ),
        )
        .slice(0, 32);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      projects.forEach((project) => insertLegacyProject(sqlite, project));
      bigTasks.forEach((bigTask) => insertLegacyBigTask(sqlite, bigTask));
      subtasks.forEach((subtask) => insertLegacySubtask(sqlite, subtask));
      dependencies.forEach((dependency) => insertLegacyDependency(sqlite, dependency));
      sqlite.close();

      const semanticState = {
        projects,
        bigTasks: projects.flatMap(({ id }) =>
          bigTasks.filter(({ projectId }) => projectId === id),
        ),
        subtasks,
        dependencies: dependencies.map(migratedLegacyDependency),
      };
      expect(semanticState.projects).toHaveLength(4);
      expect(semanticState.bigTasks).toHaveLength(10);
      expect(semanticState.subtasks).toHaveLength(25);
      expect(semanticState.dependencies).toHaveLength(32);
      expect(new Set(dependencies.map(({ dependencyType }) => dependencyType))).toEqual(
        new Set(["BLOCKING", "INFORMATIONAL"]),
      );
      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(migrated.listProjects()).toEqual(semanticState.projects);
      expect(
        projects.flatMap(({ id }) => migrated.listBigTasksByProject(id)),
      ).toEqual(semanticState.bigTasks);
      expect(
        bigTasks.flatMap(({ id }) => migrated.listSubtasksByBigTask(id)),
      ).toEqual(semanticState.subtasks);
      expect(
        bigTasks.flatMap(({ id }) => migrated.listDependenciesForBigTask(id)),
      ).toEqual(semanticState.dependencies);
      expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      const contextItem = makeContextItem("ctx_after_large_migration", {
        scopeType: "PROJECT",
        projectId: projects[0]!.id,
      });
      expect(migrated.createContextItem(contextItem)).toEqual(contextItem);
      migrated.close();

      const rerun = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(rerun.listProjects()).toEqual(semanticState.projects);
        expect(rerun.getContextItemById(contextItem.id)).toEqual(contextItem);
        expect(rerun.isForeignKeyEnforcementEnabled()).toBe(true);
      } finally {
        rerun.close();
      }
    });
  });

  it("preserves accepted S0B2a data and enables Digest and Audit writes after migration", () => {
    withTemporaryDatabasePath((databasePath) => {
      const s0b2aMigrations = join(dirname(databasePath), "s0b2a-migrations");
      mkdirSync(s0b2aMigrations);
      for (const migration of [acceptedS0B1Migration, acceptedS0B2aMigration]) {
        cpSync(migration, join(s0b2aMigrations, basename(migration)), {
          recursive: true,
        });
      }

      openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: s0b2aMigrations,
      }).close();
      const dependency = makeDependency("st_a", "st_b");
      const scope = ContextScopeSchema.parse({
        scopeType: "SUBTASK",
        projectId: "prj_console",
        bigTaskId: "bt_v1",
        subtaskId: "st_a",
      });
      const contextItem = makeContextItem("ctx_before_s0b2b", scope);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      insertLegacyProject(sqlite, makeProject());
      insertLegacyBigTask(sqlite, makeBigTask());
      for (const subtask of [
        makeSubtask("st_a"),
        makeSubtask("st_b"),
        makeSubtask("st_c"),
      ]) {
        insertLegacySubtask(sqlite, subtask);
      }
      insertLegacyDependency(sqlite, dependency);
      insertLegacyContextItem(sqlite, contextItem);
      sqlite.close();
      const acceptedState = {
        project: makeProject(),
        bigTask: makeBigTask(),
        subtasks: [makeSubtask("st_a"), makeSubtask("st_b"), makeSubtask("st_c")],
        dependencies: [migratedLegacyDependency(dependency)],
        contextItem,
      };

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(migrated.getProjectById(makeProject().id)).toEqual(acceptedState.project);
      expect(migrated.getBigTaskById(makeBigTask().id)).toEqual(acceptedState.bigTask);
      expect(migrated.listSubtasksByBigTask(makeBigTask().id)).toEqual(
        acceptedState.subtasks,
      );
      expect(migrated.listDependenciesForBigTask(makeBigTask().id)).toEqual(
        acceptedState.dependencies,
      );
      expect(migrated.getContextItemById(contextItem.id)).toEqual(
        acceptedState.contextItem,
      );
      const digest = makeContextDigest("dgt_after_s0b2a", scope);
      const auditEvent = makeAuditEvent("aud_after_s0b2a", scope);
      expect(migrated.createContextDigest(digest)).toEqual(digest);
      expect(migrated.appendAuditEvent(auditEvent)).toEqual(auditEvent);
      expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      migrated.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getContextItemById(contextItem.id)).toEqual(contextItem);
        expect(reopened.getContextDigestByScope(scope)).toEqual(digest);
        expect(reopened.listAuditEventsByScope(scope)).toEqual([auditEvent]);
        expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
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
