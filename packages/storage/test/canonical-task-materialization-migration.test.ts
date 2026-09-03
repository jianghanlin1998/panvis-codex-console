import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type { PlanCandidate, PlanReviewState } from "@codex-task-console/orchestration";
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
import { TaskContractV0Schema } from "@codex-task-console/domain";

const migrationsRoot = fileURLToPath(new URL("../drizzle", import.meta.url));
const latestMigrationName = "20260903034830_stormy_marvel_apes";
const predecessorMigrationNames = [
  "20260809002701_public_mephisto",
  "20260809150746_groovy_iron_monger",
  "20260810133952_messy_shatterstar",
  "20260810161248_crazy_lightspeed",
  "20260811143107_spicy_apocalypse",
  "20260830145904_tough_puma",
  "20260830155716_spicy_dust",
  "20260830175200_acoustic_scream",
  "20260831044031_tired_riptide",
  "20260902135340_material_master_chief",
  "20260902152406_simple_exodus",
  "20260902171242_grey_toad",
] as const;

const copyMigrations = (target: string, names: readonly string[]): void => {
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    cpSync(join(migrationsRoot, name), join(target, name), { recursive: true });
  }
};

const approval = (state: PlanReviewState) => ({
  outcome: "APPROVE" as const,
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const hasColumn = (
  sqlite: DatabaseSync,
  table: string,
  column: string,
): boolean =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly {
    readonly name: string;
  }[]).some(({ name }) => name === column);

const seedGenerationCommonData = (sqlite: DatabaseSync): void => {
  sqlite.prepare(`INSERT INTO projects
    (id, name, slug, repository_kind, repository_value, default_branch,
     max_active_coding_subtasks, created_at, updated_at)
    VALUES (?, ?, ?, 'PATH', ?, 'main', 2, ?, ?)`)
    .run(
      "prj_generation_data",
      "Generation data",
      "generation-data",
      "/repositories/generation-data",
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
    );
  sqlite.prepare(`INSERT INTO big_tasks
    (id, project_id, title, goal, rationale, scope_in, scope_out,
     acceptance_criteria, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?)`)
    .run(
      "bt_generation_data",
      "prj_generation_data",
      "Generation Big Task",
      "Preserve generation data",
      "Migration hardening",
      '["Storage"]',
      "[]",
      '["Preserved"]',
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
    );
  const insertSubtask = hasColumn(sqlite, "subtasks", "maturity")
    ? sqlite.prepare(`INSERT INTO subtasks
        (id, big_task_id, title, goal, scope_in, scope_out,
         acceptance_criteria, untouched_areas, status, start_policy,
         delegation_policy, recommended_reasoning_level, prompt_seed,
         created_at, updated_at, maturity)
        VALUES (?, 'bt_generation_data', ?, ?, '["Persist"]', '[]',
          '["Round-trip"]', '[]', 'TODO', 'MANUAL', 'NONE', 'HIGH', ?, ?, ?,
          'NOT_STARTED')`)
    : sqlite.prepare(`INSERT INTO subtasks
        (id, big_task_id, title, goal, scope_in, scope_out,
         acceptance_criteria, untouched_areas, status, start_policy,
         delegation_policy, recommended_reasoning_level, prompt_seed,
         created_at, updated_at)
        VALUES (?, 'bt_generation_data', ?, ?, '["Persist"]', '[]',
          '["Round-trip"]', '[]', 'TODO', 'MANUAL', 'NONE', 'HIGH', ?, ?, ?)`);
  for (const suffix of ["a", "b"]) {
    insertSubtask.run(
      `st_generation_${suffix}`,
      `Generation Subtask ${suffix}`,
      `Preserve ${suffix}`,
      `Generation prompt ${suffix}`,
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
    );
  }
  if (hasColumn(sqlite, "task_dependencies", "required_gate")) {
    sqlite.prepare(`INSERT INTO task_dependencies
      (upstream_subtask_id, downstream_subtask_id, dependency_type,
       required_gate, reason, created_at)
      VALUES ('st_generation_a', 'st_generation_b', 'BLOCKING', 'ACCEPTED',
        'Generation dependency.', '2026-08-09T00:00:00.000Z')`).run();
  } else {
    sqlite.prepare(`INSERT INTO task_dependencies
      (upstream_subtask_id, downstream_subtask_id, dependency_type, created_at)
      VALUES ('st_generation_a', 'st_generation_b', 'BLOCKING',
        '2026-08-09T00:00:00.000Z')`).run();
  }
};

const injectFailureAfter = (migration: string, marker: string): string => {
  const markerIndex = migration.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Missing migration fixture marker: ${marker}`);
  }
  const separator = "--> statement-breakpoint";
  const separatorIndex = migration.indexOf(separator, markerIndex);
  if (separatorIndex < 0) {
    return `${migration}\n${separator}\nCREATE TABLE projects (id text);\n`;
  }
  const insertAt = separatorIndex + separator.length;
  return `${migration.slice(0, insertAt)}\nCREATE TABLE projects (id text);\n${separator}\n${migration.slice(insertAt)}`;
};

describe("canonical task materialization migration", () => {
  it("preserves legacy canonical and planning authority without fabricating completion evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "prior-migrations");
      copyMigrations(priorFolder, predecessorMigrationNames);
      const projectId = ProjectIdSchema.parse("prj_canonical_migration");
      const plannedBigTaskId = BigTaskIdSchema.parse("bt_planned_legacy");
      const manualBigTaskId = BigTaskIdSchema.parse("bt_manual_legacy");
      let storage = openTaskDatabase({ databasePath, migrationsFolder: priorFolder, clock: fixedClock });
      storage.createProject(makeProject(projectId, "canonical-migration"));
      storage.createBigTask(makeBigTask(plannedBigTaskId, projectId));
      storage.createBigTask(makeBigTask(manualBigTaskId, projectId));
      storage.createSubtask(makeSubtask("st_manual_legacy_a", manualBigTaskId));
      storage.createSubtask(makeSubtask("st_manual_legacy_b", manualBigTaskId));
      const manualDependency = makeDependency("st_manual_legacy_a", "st_manual_legacy_b");
      storage.replaceDependenciesForBigTask(manualBigTaskId, [manualDependency]);

      const plan: PlanCandidate = {
        kind: "PLAN_CANDIDATE",
        projectId,
        bigTaskId: plannedBigTaskId,
        revision: 1,
        subtasks: [{
          id: SubtaskIdSchema.parse("st_planned_legacy"),
          bigTaskId: plannedBigTaskId,
          profile: "STANDARD",
          taskContractRef: "contract/planned-legacy",
          writeEnabled: true,
        }],
        dependencies: [],
      };
      const contract = TaskContractV0Schema.parse({
        taskContractRef: plan.subtasks[0]!.taskContractRef,
        projectId,
        bigTaskId: plannedBigTaskId,
        subtaskId: plan.subtasks[0]!.id,
        title: "Planned legacy",
        goal: "Preserve the exact approved authority.",
        scopeIn: ["Planning"],
        scopeOut: [],
        acceptanceCriteria: ["Exact replay"],
        untouchedAreas: [],
        promptSeed: "Use the approved authority.",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "HIGH",
      });
      const bundle = storage.beginDurablePlanningBundle(plan, [contract]);
      storage.recordDurableReviewerDecision(plannedBigTaskId, approval(bundle.reviewState));
      storage.materializeDurablePlan(plannedBigTaskId);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getCanonicalTaskMaterialization(plannedBigTaskId)).toBeNull();
      expect(storage.getDurablePlanningSnapshot(plannedBigTaskId)!.materializedGraph)
        .toMatchObject({ bigTaskId: plannedBigTaskId, subtasks: plan.subtasks });
      expect(storage.listSubtasksByBigTask(manualBigTaskId).map(({ id }) => id))
        .toEqual(["st_manual_legacy_a", "st_manual_legacy_b"]);
      expect(storage.listDependenciesForBigTask(manualBigTaskId)).toEqual([manualDependency]);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("SELECT count(*) AS count FROM canonical_task_materializations").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      sqlite.close();
    });
  });

  it("rolls back a late migration failure without ledger advance or partial authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "failure-prior-migrations");
      copyMigrations(priorFolder, predecessorMigrationNames);
      const storage = openTaskDatabase({ databasePath, migrationsFolder: priorFolder, clock: fixedClock });
      const project = makeProject("prj_failed_canonical_migration", "failed-canonical-migration");
      storage.createProject(project);
      storage.close();

      const failingFolder = join(databasePath, "..", "failing-migrations");
      copyMigrations(failingFolder, predecessorMigrationNames);
      cpSync(
        join(migrationsRoot, latestMigrationName),
        join(failingFolder, latestMigrationName),
        { recursive: true },
      );
      const migrationPath = join(failingFolder, latestMigrationName, "migration.sql");
      const migration = readFileSync(migrationPath, { encoding: "utf-8" });
      writeFileSync(
        migrationPath,
        `${migration}\n--> statement-breakpoint\nCREATE TABLE projects (id text);\n`,
        { encoding: "utf-8" },
      );

      const error = captureTaskStorageError(() =>
        openTaskDatabase({ databasePath, migrationsFolder: failingFolder, clock: fixedClock }),
      );
      expect(error).toMatchObject({ code: "MIGRATION_FAILED", message: "Task database migration failed." });

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
        .toEqual({ count: predecessorMigrationNames.length });
      expect(sqlite.prepare("SELECT name FROM projects").all()).toEqual([{ name: project.name }]);
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'canonical_task_materializations'",
      ).get()).toBeUndefined();
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      sqlite.close();
    });
  });

  it("migrates every reconstructable predecessor with data and durable guards", () => {
    for (let index = 0; index < predecessorMigrationNames.length; index += 1) {
      withTemporaryDatabasePath((databasePath) => {
        const priorFolder = join(databasePath, "..", `generation-${index}`);
        const generationNames = predecessorMigrationNames.slice(0, index + 1);
        copyMigrations(priorFolder, generationNames);
        const prior = openTaskDatabase({
          databasePath,
          migrationsFolder: priorFolder,
          clock: fixedClock,
        });
        prior.close();

        let sqlite = new DatabaseSync(databasePath);
        sqlite.exec("PRAGMA foreign_keys = ON");
        seedGenerationCommonData(sqlite);
        sqlite.close();

        let migrated = openTaskDatabase({ databasePath, clock: fixedClock });
        const generationProjectId = ProjectIdSchema.parse("prj_generation_data");
        const generationBigTaskId = BigTaskIdSchema.parse("bt_generation_data");
        expect(migrated.getProjectById(generationProjectId)).toMatchObject({
          name: "Generation data",
        });
        expect(migrated.getBigTaskById(generationBigTaskId)).toMatchObject({
          goal: "Preserve generation data",
        });
        expect(migrated.listSubtasksByBigTask(generationBigTaskId).map(({ id }) => id))
          .toEqual(["st_generation_a", "st_generation_b"]);
        expect(migrated.listDependenciesForBigTask(generationBigTaskId))
          .toMatchObject([{
            upstreamSubtaskId: "st_generation_a",
            downstreamSubtaskId: "st_generation_b",
            dependencyType: "BLOCKING",
            requiredGate: "ACCEPTED",
          }]);
        expect(migrated.getCanonicalTaskMaterialization(generationBigTaskId))
          .toBeNull();

        const projectId = generationProjectId;
        const bigTaskId = BigTaskIdSchema.parse("bt_generation_fresh");
        migrated.createBigTask(makeBigTask(bigTaskId, projectId));
        const plan: PlanCandidate = {
          kind: "PLAN_CANDIDATE",
          projectId,
          bigTaskId,
          revision: 1,
          subtasks: ["z", "a"].map((suffix) => ({
            id: SubtaskIdSchema.parse(`st_generation_fresh_${suffix}`),
            bigTaskId,
            profile: "STANDARD" as const,
            taskContractRef: `contract/generation-fresh-${suffix}`,
            writeEnabled: suffix === "z",
          })),
          dependencies: [],
        };
        const contracts = plan.subtasks.map((subtask) => TaskContractV0Schema.parse({
          taskContractRef: subtask.taskContractRef,
          projectId,
          bigTaskId,
          subtaskId: subtask.id,
          title: `Fresh ${subtask.id}`,
          goal: "Prove current materialization after migration.",
          scopeIn: ["Migration"],
          scopeOut: [],
          acceptanceCriteria: ["Exact reopen"],
          untouchedAreas: [],
          promptSeed: "Use current authority.",
          startPolicy: "MANUAL",
          delegationPolicy: "NONE",
          recommendedReasoningLevel: "HIGH",
        }));
        const bundle = migrated.beginDurablePlanningBundle(plan, contracts);
        migrated.recordDurableReviewerDecision(bigTaskId, approval(bundle.reviewState));
        migrated.materializeDurablePlan(bigTaskId);
        const materialized = migrated.materializeApprovedCanonicalTasks(bigTaskId);
        expect(materialized).toMatchObject({ subtaskCount: 2, dependencyCount: 0 });
        migrated.close();

        sqlite = new DatabaseSync(databasePath);
        expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
          .toEqual({ count: predecessorMigrationNames.length + 3 });
        expect(() => sqlite.exec(
          "UPDATE canonical_task_materializations SET subtask_count = 9",
        )).toThrow();
        expect(() => sqlite.exec(
          "UPDATE subtasks SET title = 'changed' WHERE id = 'st_generation_fresh_z'",
        )).toThrow();
        expect(() => sqlite.exec(`INSERT INTO task_dependencies VALUES
          ('st_generation_fresh_z', 'st_generation_fresh_a', 'BLOCKING',
           'HARDENED', 'forbidden', '2026-08-09T00:00:00.000Z')`)).toThrow();
        sqlite.close();

        migrated = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(migrated.getCanonicalTaskMaterialization(bigTaskId)).toEqual(materialized);
        migrated.close();
      });
    }
  });

  it("never fabricates ownership for identical-looking legacy rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "matching-prior-migrations");
      copyMigrations(priorFolder, predecessorMigrationNames);
      const projectId = ProjectIdSchema.parse("prj_matching_legacy");
      const bigTaskId = BigTaskIdSchema.parse("bt_matching_legacy");
      let storage = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: fixedClock,
      });
      storage.createProject(makeProject(projectId, "matching-legacy"));
      storage.createBigTask(makeBigTask(bigTaskId, projectId));
      const plan: PlanCandidate = {
        kind: "PLAN_CANDIDATE",
        projectId,
        bigTaskId,
        revision: 1,
        subtasks: [{
          id: SubtaskIdSchema.parse("st_matching_legacy"),
          bigTaskId,
          profile: "HIGH_RISK_FOUNDATION",
          taskContractRef: "contract/matching-legacy",
          writeEnabled: true,
        }],
        dependencies: [],
      };
      const contract = TaskContractV0Schema.parse({
        taskContractRef: plan.subtasks[0]!.taskContractRef,
        projectId,
        bigTaskId,
        subtaskId: plan.subtasks[0]!.id,
        title: "Matching legacy",
        goal: "Remain unowned after migration.",
        scopeIn: ["Legacy"],
        scopeOut: [],
        acceptanceCriteria: ["No adoption"],
        untouchedAreas: [],
        promptSeed: "Do not adopt.",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "XHIGH",
      });
      const bundle = storage.beginDurablePlanningBundle(plan, [contract]);
      storage.recordDurableReviewerDecision(bigTaskId, approval(bundle.reviewState));
      storage.materializeDurablePlan(bigTaskId);
      storage.createSubtask({
        recordType: "SUBTASK",
        id: contract.subtaskId,
        bigTaskId,
        title: contract.title,
        goal: contract.goal,
        scopeIn: [...contract.scopeIn],
        scopeOut: [...contract.scopeOut],
        acceptanceCriteria: [...contract.acceptanceCriteria],
        untouchedAreas: [...contract.untouchedAreas],
        status: "TODO",
        maturity: "NOT_STARTED",
        startPolicy: contract.startPolicy,
        delegationPolicy: contract.delegationPolicy,
        recommendedReasoningLevel: contract.recommendedReasoningLevel,
        promptSeed: contract.promptSeed,
      });
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getCanonicalTaskMaterialization(bigTaskId)).toBeNull();
      expect(captureTaskStorageError(
        () => storage.materializeApprovedCanonicalTasks(bigTaskId),
      ).code).toBe("CONFLICT");
      storage.close();
    });
  });

  it("rolls back failures after each materialization guard family", () => {
    const markers = [
      "CREATE TABLE `canonical_task_materializations`",
      "CREATE TRIGGER `canonical_task_materializations_immutable_insert_conflict`",
      "CREATE TRIGGER `canonical_materialized_subtask_set_insert_guard`",
      "CREATE TRIGGER `canonical_materialized_subtask_stable_update_guard`",
      "CREATE TRIGGER `canonical_materialized_dependency_insert_guard`",
      "CREATE TRIGGER `canonical_materialized_dependency_update_guard`",
    ] as const;
    for (const [index, marker] of markers.entries()) {
      withTemporaryDatabasePath((databasePath) => {
        const priorFolder = join(databasePath, "..", `guard-failure-prior-${index}`);
        copyMigrations(priorFolder, predecessorMigrationNames);
        const storage = openTaskDatabase({
          databasePath,
          migrationsFolder: priorFolder,
          clock: fixedClock,
        });
        const project = makeProject(
          `prj_guard_failure_${index}`,
          `guard-failure-${index}`,
        );
        storage.createProject(project);
        storage.close();

        const failingFolder = join(databasePath, "..", `guard-failure-${index}`);
        copyMigrations(failingFolder, predecessorMigrationNames);
        cpSync(
          join(migrationsRoot, latestMigrationName),
          join(failingFolder, latestMigrationName),
          { recursive: true },
        );
        const migrationPath = join(failingFolder, latestMigrationName, "migration.sql");
        const migration = readFileSync(migrationPath, { encoding: "utf-8" });
        writeFileSync(
          migrationPath,
          injectFailureAfter(migration, marker),
          { encoding: "utf-8" },
        );

        expect(captureTaskStorageError(() => openTaskDatabase({
          databasePath,
          migrationsFolder: failingFolder,
          clock: fixedClock,
        }))).toMatchObject({
          code: "MIGRATION_FAILED",
          message: "Task database migration failed.",
        });
        const sqlite = new DatabaseSync(databasePath, { readOnly: true });
        expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
          .toEqual({ count: predecessorMigrationNames.length });
        expect(sqlite.prepare("SELECT name FROM projects").all())
          .toEqual([{ name: project.name }]);
        expect(sqlite.prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'canonical_task_materializations'",
        ).get()).toBeUndefined();
        expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        sqlite.close();
      });
    }
  });
});
