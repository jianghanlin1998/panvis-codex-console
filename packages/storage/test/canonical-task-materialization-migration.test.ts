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
});
