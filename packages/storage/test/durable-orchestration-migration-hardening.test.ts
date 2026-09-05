import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeDependency,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";
import {
  insertLegacyBigTask,
  insertLegacyDependency,
  insertLegacyProject,
  insertLegacySubtask,
  migratedLegacyDependency,
} from "./legacy-fixtures.js";

const MIGRATIONS_ROOT = fileURLToPath(new URL("../drizzle", import.meta.url));
const MIGRATION_PROJECT_ID = ProjectIdSchema.parse("prj_migration_hardening");
const MIGRATION_BIG_TASK_ID = BigTaskIdSchema.parse("bt_migration_hardening");
const CONSTRAINT_PROJECT_ID = ProjectIdSchema.parse("prj_constraints");
const CONSTRAINT_BIG_TASK_ID = BigTaskIdSchema.parse("bt_constraints");
const CONSTRAINT_SUBTASK_ID = SubtaskIdSchema.parse("st_constraints");
const PREDECESSOR_MIGRATIONS = [
  "20260809002701_public_mephisto",
  "20260809150746_groovy_iron_monger",
  "20260810133952_messy_shatterstar",
  "20260810161248_crazy_lightspeed",
  "20260811143107_spicy_apocalypse",
  "20260830145904_tough_puma",
  "20260830155716_spicy_dust",
  "20260830175200_acoustic_scream",
  "20260831044031_tired_riptide",
] as const;
const IMPLEMENTATION_MIGRATIONS = [
  ...PREDECESSOR_MIGRATIONS,
  "20260902135340_material_master_chief",
] as const;

const copyMigrations = (
  databasePath: string,
  names: readonly string[],
  folderName: string,
): string => {
  const migrationsFolder = join(dirname(databasePath), folderName);
  mkdirSync(migrationsFolder);
  for (const name of names) {
    cpSync(
      join(MIGRATIONS_ROOT, name),
      join(migrationsFolder, basename(name)),
      { recursive: true },
    );
  }
  return migrationsFolder;
};

const createLatestPredecessor = (databasePath: string): void => {
  const predecessorFolder = copyMigrations(
    databasePath,
    PREDECESSOR_MIGRATIONS,
    "orchestration-predecessor",
  );
  const prior = openTaskDatabase({
    databasePath,
    clock: fixedClock,
    migrationsFolder: predecessorFolder,
  });
  prior.createProject(makeProject(MIGRATION_PROJECT_ID, "migration-hardening"));
  prior.createBigTask(
    makeBigTask(MIGRATION_BIG_TASK_ID, MIGRATION_PROJECT_ID),
  );
  prior.createSubtask(makeSubtask("st_migration_a", MIGRATION_BIG_TASK_ID));
  prior.createSubtask(makeSubtask("st_migration_b", MIGRATION_BIG_TASK_ID));
  prior.replaceDependenciesForBigTask(MIGRATION_BIG_TASK_ID, [
    makeDependency("st_migration_a", "st_migration_b"),
  ]);
  prior.close();
};

describe("Step 8B1 migration predecessor matrix", () => {
  it("migrates an empty latest predecessor and reopens with foreign keys enabled", () => {
    withTemporaryDatabasePath((databasePath) => {
      const predecessorFolder = copyMigrations(
        databasePath,
        PREDECESSOR_MIGRATIONS,
        "empty-predecessor",
      );
      openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: predecessorFolder,
      }).close();

      let migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(migrated.listProjects()).toEqual([]);
      expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      migrated.close();
      migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(migrated.listProjects()).toEqual([]);
      migrated.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 19 });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM orchestration_planning_tracks",
          )
          .get(),
      ).toEqual({ count: 0 });
      sqlite.close();
    });
  });

  it("preserves a data-rich latest predecessor exactly without fabricating authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      createLatestPredecessor(databasePath);
      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(migrated.getProjectById(MIGRATION_PROJECT_ID)).toEqual(
        makeProject(MIGRATION_PROJECT_ID, "migration-hardening"),
      );
      expect(migrated.getBigTaskById(MIGRATION_BIG_TASK_ID)).toEqual(
        makeBigTask(MIGRATION_BIG_TASK_ID, MIGRATION_PROJECT_ID),
      );
      expect(migrated.listSubtasksByBigTask(MIGRATION_BIG_TASK_ID)).toEqual([
        makeSubtask("st_migration_a", MIGRATION_BIG_TASK_ID),
        makeSubtask("st_migration_b", MIGRATION_BIG_TASK_ID),
      ]);
      expect(
        migrated.listDependenciesForBigTask(MIGRATION_BIG_TASK_ID),
      ).toEqual([makeDependency("st_migration_a", "st_migration_b")]);
      expect(
        migrated.getDurablePlanningSnapshot(MIGRATION_BIG_TASK_ID),
      ).toBeNull();
      expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      migrated.close();
    });
  });

  it("migrates a representative oldest database and preserves legacy graph data", () => {
    withTemporaryDatabasePath((databasePath) => {
      const oldestFolder = copyMigrations(
        databasePath,
        [PREDECESSOR_MIGRATIONS[0]],
        "oldest-predecessor",
      );
      openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: oldestFolder,
      }).close();

      const project = makeProject("prj_old_orchestration", "old-orchestration");
      const bigTask = makeBigTask("bt_old_orchestration", project.id);
      const firstSubtask = makeSubtask("st_old_a", bigTask.id);
      const secondSubtask = makeSubtask("st_old_b", bigTask.id);
      const edge = makeDependency(firstSubtask.id, secondSubtask.id);
      const legacy = new DatabaseSync(databasePath);
      legacy.exec("PRAGMA foreign_keys = ON");
      insertLegacyProject(legacy, project);
      insertLegacyBigTask(legacy, bigTask);
      insertLegacySubtask(legacy, firstSubtask);
      insertLegacySubtask(legacy, secondSubtask);
      insertLegacyDependency(legacy, edge);
      legacy.close();

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(migrated.getProjectById(project.id)).toEqual(project);
      expect(migrated.getBigTaskById(bigTask.id)).toEqual(bigTask);
      expect(migrated.getSubtaskById(firstSubtask.id)).toEqual(firstSubtask);
      expect(migrated.listDependenciesForBigTask(bigTask.id)).toEqual([
        migratedLegacyDependency(edge),
      ]);
      expect(migrated.getDurablePlanningSnapshot(bigTask.id)).toBeNull();
      migrated.close();
    });
  });

  it("upgrades the Step 8B1 implementation database with exact planning history", () => {
    withTemporaryDatabasePath((databasePath) => {
      const implementationFolder = copyMigrations(
        databasePath,
        IMPLEMENTATION_MIGRATIONS,
        "implementation-predecessor",
      );
      let storage = openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: implementationFolder,
      });
      storage.createProject(makeProject(CONSTRAINT_PROJECT_ID, "constraints"));
      storage.createBigTask(makeBigTask(CONSTRAINT_BIG_TASK_ID, CONSTRAINT_PROJECT_ID));
      let snapshot = storage.beginDurablePlanning({
        kind: "PLAN_CANDIDATE",
        projectId: CONSTRAINT_PROJECT_ID,
        bigTaskId: CONSTRAINT_BIG_TASK_ID,
        revision: 1,
        subtasks: [
          {
            id: CONSTRAINT_SUBTASK_ID,
            bigTaskId: CONSTRAINT_BIG_TASK_ID,
            profile: "STANDARD",
            taskContractRef: "contracts/constraints.md",
            writeEnabled: true,
          },
        ],
        dependencies: [],
      });
      snapshot = storage.recordDurableReviewerDecision(CONSTRAINT_BIG_TASK_ID, {
        outcome: "APPROVE",
        planRevision: snapshot.reviewState.candidate.revision,
        candidateBinding: snapshot.reviewState.candidateBinding,
      });
      snapshot = storage.materializeDurablePlan(CONSTRAINT_BIG_TASK_ID);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(CONSTRAINT_BIG_TASK_ID)).toEqual(
        snapshot,
      );
      expect(storage.isForeignKeyEnforcementEnabled()).toBe(true);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 19 });
      sqlite.close();
    });
  });
});

describe("Step 8B1 migration rollback hardening", () => {
  const collisionCases = [
    [
      "early table",
      "CREATE TABLE orchestration_materializations (collision_sentinel TEXT NOT NULL)",
      ["orchestration_materializations"],
    ],
    [
      "late table",
      "CREATE TABLE orchestration_review_decisions (collision_sentinel TEXT NOT NULL)",
      ["orchestration_review_decisions"],
    ],
    [
      "final index",
      "CREATE TABLE migration_collision_sentinel (id TEXT); CREATE INDEX orchestration_plan_candidates_binding_unique ON migration_collision_sentinel(id)",
      [],
    ],
  ] as const;

  it.each(collisionCases)(
    "rolls back every partial statement on a %s collision",
    (_label, collisionSql, expectedOrchestrationTables) => {
      withTemporaryDatabasePath((databasePath) => {
        createLatestPredecessor(databasePath);
        const collision = new DatabaseSync(databasePath);
        collision.exec(collisionSql);
        collision.close();

        const migrationError = captureTaskStorageError(() =>
          openTaskDatabase({ databasePath, clock: fixedClock }),
        );
        expect(migrationError.code).toBe("MIGRATION_FAILED");
        expect(migrationError.message).not.toMatch(
          /SQLite|SQL|constraint|orchestration_|\/Users\//i,
        );

        const verified = new DatabaseSync(databasePath, { readOnly: true });
        expect(
          verified.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
        ).toEqual({ count: 9 });
        expect(
          verified
            .prepare("SELECT id FROM projects WHERE id = 'prj_migration_hardening'")
            .get(),
        ).toEqual({ id: "prj_migration_hardening" });
        const orchestrationTables = verified
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'orchestration_%' ORDER BY name",
          )
          .all()
          .map((row) => (row as { readonly name: string }).name);
        expect(orchestrationTables).toEqual(expectedOrchestrationTables);
        verified.close();
      });
    },
  );

  it.each([
    ["early rebuild", "__new_orchestration_materializations"],
    ["late rebuild", "__new_orchestration_review_decisions"],
  ] as const)(
    "rolls back the referential-hardening migration on an %s collision",
    (_label, collisionTable) => {
      withTemporaryDatabasePath((databasePath) => {
        const implementationFolder = copyMigrations(
          databasePath,
          IMPLEMENTATION_MIGRATIONS,
          "referential-predecessor",
        );
        const prior = openTaskDatabase({
          databasePath,
          clock: fixedClock,
          migrationsFolder: implementationFolder,
        });
        prior.createProject(makeProject(CONSTRAINT_PROJECT_ID, "constraints"));
        prior.createBigTask(
          makeBigTask(CONSTRAINT_BIG_TASK_ID, CONSTRAINT_PROJECT_ID),
        );
        const snapshot = prior.beginDurablePlanning({
          kind: "PLAN_CANDIDATE",
          projectId: CONSTRAINT_PROJECT_ID,
          bigTaskId: CONSTRAINT_BIG_TASK_ID,
          revision: 1,
          subtasks: [
            {
              id: CONSTRAINT_SUBTASK_ID,
              bigTaskId: CONSTRAINT_BIG_TASK_ID,
              profile: "STANDARD",
              taskContractRef: "contracts/constraints.md",
              writeEnabled: true,
            },
          ],
          dependencies: [],
        });
        prior.close();

        const collision = new DatabaseSync(databasePath);
        collision.exec(
          `CREATE TABLE ${collisionTable} (collision_sentinel TEXT NOT NULL)`,
        );
        collision.close();

        const migrationError = captureTaskStorageError(() =>
          openTaskDatabase({ databasePath, clock: fixedClock }),
        );
        expect(migrationError.code).toBe("MIGRATION_FAILED");

        const verified = new DatabaseSync(databasePath, { readOnly: true });
        expect(
          verified.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
        ).toEqual({ count: 10 });
        expect(
          verified
            .prepare(
              "SELECT count(*) AS count FROM orchestration_plan_candidates WHERE big_task_id = 'bt_constraints'",
            )
            .get(),
        ).toEqual({ count: 1 });
        expect(
          verified.prepare(`PRAGMA table_info(${collisionTable})`).all(),
        ).toEqual([expect.objectContaining({ name: "collision_sentinel" })]);
        verified.close();

        const implementationOnly = openTaskDatabase({
          databasePath,
          clock: fixedClock,
          migrationsFolder: implementationFolder,
        });
        expect(
          implementationOnly.getDurablePlanningSnapshot(CONSTRAINT_BIG_TASK_ID),
        ).toEqual(snapshot);
        implementationOnly.close();
      });
    },
  );
});

describe("Step 8B1 SQLite structural constraints", () => {
  it("enforces cheap uniqueness, shape, revision, and foreign-key invariants", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject(CONSTRAINT_PROJECT_ID, "constraints"));
      storage.createBigTask(makeBigTask(CONSTRAINT_BIG_TASK_ID, CONSTRAINT_PROJECT_ID));
      storage.beginDurablePlanning({
        kind: "PLAN_CANDIDATE",
        projectId: CONSTRAINT_PROJECT_ID,
        bigTaskId: CONSTRAINT_BIG_TASK_ID,
        revision: 1,
        subtasks: [
          {
            id: CONSTRAINT_SUBTASK_ID,
            bigTaskId: CONSTRAINT_BIG_TASK_ID,
            profile: "STANDARD",
            taskContractRef: "contracts/constraints.md",
            writeEnabled: true,
          },
        ],
        dependencies: [],
      });
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      const candidateRow = sqlite
        .prepare(
          "SELECT candidate_payload, candidate_binding, created_at FROM orchestration_plan_candidates WHERE big_task_id = 'bt_constraints'",
        )
        .get() as {
          readonly candidate_payload: string;
          readonly candidate_binding: string;
          readonly created_at: string;
        };
      const insertCandidate = sqlite.prepare(
        "INSERT INTO orchestration_plan_candidates (big_task_id, project_id, revision, candidate_payload, candidate_binding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      expect(() =>
        insertCandidate.run(
          "bt_constraints",
          "prj_constraints",
          1,
          candidateRow.candidate_payload,
          `${candidateRow.candidate_binding}-duplicate-revision`,
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertCandidate.run(
          "bt_constraints",
          "prj_constraints",
          0,
          candidateRow.candidate_payload,
          "invalid-revision",
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertCandidate.run(
          "bt_constraints",
          "prj_constraints",
          2,
          candidateRow.candidate_payload,
          candidateRow.candidate_binding,
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertCandidate.run(
          "bt_missing",
          "prj_constraints",
          1,
          candidateRow.candidate_payload,
          "missing-track",
          candidateRow.created_at,
        ),
      ).toThrow();

      const insertDecision = sqlite.prepare(
        "INSERT INTO orchestration_review_decisions (big_task_id, plan_revision, outcome, candidate_binding, revision_requirements, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      expect(() =>
        insertDecision.run(
          "bt_constraints",
          0,
          "APPROVE",
          candidateRow.candidate_binding,
          null,
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertDecision.run(
          "bt_constraints",
          1,
          "APPROVE",
          candidateRow.candidate_binding,
          "[]",
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertDecision.run(
          "bt_missing",
          1,
          "APPROVE",
          candidateRow.candidate_binding,
          null,
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertDecision.run(
          "bt_constraints",
          2,
          "APPROVE",
          candidateRow.candidate_binding,
          null,
          candidateRow.created_at,
        ),
      ).toThrow();
      insertDecision.run(
        "bt_constraints",
        1,
        "APPROVE",
        candidateRow.candidate_binding,
        null,
        candidateRow.created_at,
      );
      expect(() =>
        insertDecision.run(
          "bt_constraints",
          1,
          "APPROVE",
          candidateRow.candidate_binding,
          null,
          candidateRow.created_at,
        ),
      ).toThrow();

      const insertMaterialization = sqlite.prepare(
        "INSERT INTO orchestration_materializations (big_task_id, project_id, plan_revision, candidate_binding, materialized_at) VALUES (?, ?, ?, ?, ?)",
      );
      expect(() =>
        insertMaterialization.run(
          "bt_constraints",
          "prj_constraints",
          0,
          candidateRow.candidate_binding,
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertMaterialization.run(
          "bt_missing",
          "prj_constraints",
          1,
          candidateRow.candidate_binding,
          candidateRow.created_at,
        ),
      ).toThrow();
      expect(() =>
        insertMaterialization.run(
          "bt_constraints",
          "prj_constraints",
          2,
          candidateRow.candidate_binding,
          candidateRow.created_at,
        ),
      ).toThrow();
      insertMaterialization.run(
        "bt_constraints",
        "prj_constraints",
        1,
        candidateRow.candidate_binding,
        candidateRow.created_at,
      );
      expect(() =>
        insertMaterialization.run(
          "bt_constraints",
          "prj_constraints",
          1,
          candidateRow.candidate_binding,
          candidateRow.created_at,
        ),
      ).toThrow();
      sqlite.close();
    });
  });
});
