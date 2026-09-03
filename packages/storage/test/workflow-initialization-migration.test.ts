import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type { PlanCandidate, PlanReviewState } from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeProject,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const migrationsRoot = fileURLToPath(new URL("../drizzle", import.meta.url));
const latestMigrationName = "20260903063931_big_reavers";
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
  "20260903034830_stormy_marvel_apes",
] as const;

const copyMigrations = (target: string, names: readonly string[]): void => {
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    cpSync(join(migrationsRoot, name), join(target, name), { recursive: true });
  }
};

const injectFailureAfter = (migration: string, marker: string): string => {
  const markerIndex = migration.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Missing workflow migration fixture marker: ${marker}`);
  }
  const separator = "--> statement-breakpoint";
  const separatorIndex = migration.indexOf(separator, markerIndex);
  if (separatorIndex < 0) {
    return `${migration}\n${separator}\nCREATE TABLE projects (id text);\n`;
  }
  const insertAt = separatorIndex + separator.length;
  return `${migration.slice(0, insertAt)}\nCREATE TABLE projects (id text);\n${separator}\n${migration.slice(insertAt)}`;
};

const approval = (state: PlanReviewState) => ({
  outcome: "APPROVE" as const,
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const seedCanonicalSource = (storage: TaskStorage) => {
  const projectId = ProjectIdSchema.parse("prj_workflow_migration");
  const bigTaskId = BigTaskIdSchema.parse("bt_workflow_migration");
  storage.createProject(makeProject(projectId, "workflow-migration"));
  storage.createBigTask(makeBigTask(bigTaskId, projectId));
  const plan: PlanCandidate = {
    kind: "PLAN_CANDIDATE",
    projectId,
    bigTaskId,
    revision: 1,
    subtasks: ["LOW", "HIGH_RISK_FOUNDATION"].map((profile, index) => ({
      id: SubtaskIdSchema.parse(`st_workflow_migration_${index}`),
      bigTaskId,
      profile: profile as "LOW" | "HIGH_RISK_FOUNDATION",
      taskContractRef: `contract/workflow-migration-${index}`,
      writeEnabled: index === 0,
    })),
    dependencies: [],
  };
  const contracts = plan.subtasks.map((subtask, index) => TaskContractV0Schema.parse({
    taskContractRef: subtask.taskContractRef,
    projectId,
    bigTaskId,
    subtaskId: subtask.id,
    title: `Migration workflow ${index}`,
    goal: "Preserve accepted canonical source.",
    scopeIn: ["Migration"],
    scopeOut: [],
    acceptanceCriteria: ["Exact replay"],
    untouchedAreas: [],
    promptSeed: `Migration workflow prompt ${index}`,
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
  }));
  const bundle = storage.beginDurablePlanningBundle(plan, contracts);
  storage.recordDurableReviewerDecision(bigTaskId, approval(bundle.reviewState));
  storage.materializeDurablePlan(bigTaskId);
  return storage.materializeApprovedCanonicalTasks(bigTaskId);
};

describe("workflow initialization migration", () => {
  it("preserves historical Step 8B2b authority and fabricates no workflow ownership", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "workflow-prior-migrations");
      copyMigrations(priorFolder, predecessorMigrationNames);
      let storage = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: fixedClock,
      });
      const source = seedCanonicalSource(storage);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getCanonicalTaskMaterialization(source.bigTaskId)).toEqual(source);
      expect(storage.getDurableSubtaskWorkflowInitialization(source.bigTaskId)).toBeNull();
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("SELECT count(*) AS count FROM subtask_workflow_instances").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT count(*) AS count FROM workflow_initialization_receipts").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
        .toEqual({ count: predecessorMigrationNames.length + 4 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.initializeDurableSubtaskWorkflows(source.bigTaskId))
        .toMatchObject({ workflowInstanceCount: 2 });
      storage.close();
    });
  });

  it.each([
    "CREATE TABLE `subtask_workflow_instances`",
    "CREATE TABLE `workflow_initialization_receipts`",
    "CREATE UNIQUE INDEX `canonical_task_materializations_authority_unique`",
    "CREATE TRIGGER `subtask_workflow_instances_owned_insert_guard`",
    "CREATE TRIGGER `workflow_initialization_receipts_immutable_delete`",
  ])("rolls back failure after %s without ledger advance or partial authority", (marker) => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "workflow-failure-prior");
      copyMigrations(priorFolder, predecessorMigrationNames);
      const project = makeProject("prj_workflow_failure", "workflow-failure");
      const prior = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: fixedClock,
      });
      prior.createProject(project);
      prior.close();

      const failingFolder = join(databasePath, "..", "workflow-failing-migrations");
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
      for (const table of [
        "subtask_workflow_instances",
        "workflow_initialization_receipts",
      ]) {
        expect(sqlite.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
        ).get(table)).toBeUndefined();
      }
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      sqlite.close();

      openTaskDatabase({ databasePath, clock: fixedClock }).close();
      const reopened = new DatabaseSync(databasePath, { readOnly: true });
      expect(reopened.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
        .toEqual({ count: predecessorMigrationNames.length + 4 });
      expect(reopened.prepare("SELECT count(*) AS count FROM subtask_workflow_instances").get())
        .toEqual({ count: 0 });
      expect(reopened.prepare("SELECT count(*) AS count FROM workflow_initialization_receipts").get())
        .toEqual({ count: 0 });
      reopened.close();
    });
  });
});
