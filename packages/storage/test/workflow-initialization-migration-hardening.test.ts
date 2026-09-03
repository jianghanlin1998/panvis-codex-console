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
  makeBigTask,
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

const hasColumn = (sqlite: DatabaseSync, table: string, column: string): boolean =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly {
    readonly name: string;
  }[]).some(({ name }) => name === column);

const seedGenerationData = (sqlite: DatabaseSync, suffix: string): void => {
  const projectId = `prj_b3a_generation_${suffix}`;
  const bigTaskId = `bt_b3a_generation_${suffix}`;
  sqlite.prepare(`INSERT INTO projects
    (id, name, slug, repository_kind, repository_value, default_branch,
     max_active_coding_subtasks, created_at, updated_at)
    VALUES (?, ?, ?, 'PATH', ?, 'main', 2, ?, ?)`)
    .run(
      projectId,
      `B3a generation ${suffix}`,
      `b3a-generation-${suffix}`,
      `/repositories/b3a-generation-${suffix}`,
      "2026-09-03T09:00:00.000Z",
      "2026-09-03T09:00:00.000Z",
    );
  sqlite.prepare(`INSERT INTO big_tasks
    (id, project_id, title, goal, rationale, scope_in, scope_out,
     acceptance_criteria, status, created_at, updated_at)
    VALUES (?, ?, 'Generation Big Task', 'Preserve data', 'Migration hardening',
      '["Storage"]', '[]', '["Exact"]', 'IN_PROGRESS', ?, ?)`)
    .run(
      bigTaskId,
      projectId,
      "2026-09-03T09:00:00.000Z",
      "2026-09-03T09:00:00.000Z",
    );
  const maturityColumn = hasColumn(sqlite, "subtasks", "maturity")
    ? ", maturity"
    : "";
  const maturityValue = maturityColumn.length > 0 ? ", 'NOT_STARTED'" : "";
  const insertSubtask = sqlite.prepare(`INSERT INTO subtasks
    (id, big_task_id, title, goal, scope_in, scope_out, acceptance_criteria,
     untouched_areas, status, start_policy, delegation_policy,
     recommended_reasoning_level, prompt_seed, created_at, updated_at${maturityColumn})
    VALUES (?, ?, ?, ?, '["Persist"]', '[]', '["Exact"]', '[]', 'TODO',
      'MANUAL', 'NONE', 'HIGH', ?, ?, ?${maturityValue})`);
  for (const item of ["z", "a"] as const) {
    insertSubtask.run(
      `st_b3a_generation_${suffix}_${item}`,
      bigTaskId,
      `Generation ${item}`,
      `Preserve ${item}`,
      `Generation prompt ${item}`,
      "2026-09-03T09:00:00.000Z",
      "2026-09-03T09:00:00.000Z",
    );
  }
  if (hasColumn(sqlite, "task_dependencies", "required_gate")) {
    sqlite.prepare(`INSERT INTO task_dependencies
      (upstream_subtask_id, downstream_subtask_id, dependency_type,
       required_gate, reason, created_at)
      VALUES (?, ?, 'BLOCKING', 'ACCEPTED', 'Generation dependency.', ?)`)
      .run(
        `st_b3a_generation_${suffix}_z`,
        `st_b3a_generation_${suffix}_a`,
        "2026-09-03T09:00:00.000Z",
      );
  } else {
    sqlite.prepare(`INSERT INTO task_dependencies
      (upstream_subtask_id, downstream_subtask_id, dependency_type, created_at)
      VALUES (?, ?, 'BLOCKING', ?)`)
      .run(
        `st_b3a_generation_${suffix}_z`,
        `st_b3a_generation_${suffix}_a`,
        "2026-09-03T09:00:00.000Z",
      );
  }
};

const approval = (state: PlanReviewState) => ({
  outcome: "APPROVE" as const,
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const seedCurrentWorkflowSource = (
  storage: TaskStorage,
  projectId: ReturnType<typeof ProjectIdSchema.parse>,
  suffix: string,
) => {
  const bigTaskId = BigTaskIdSchema.parse(`bt_b3a_fresh_${suffix}`);
  storage.createBigTask(makeBigTask(bigTaskId, projectId));
  const plan: PlanCandidate = {
    kind: "PLAN_CANDIDATE",
    projectId,
    bigTaskId,
    revision: 1,
    subtasks: ["10", "2", "1"].map((item, index) => ({
      id: SubtaskIdSchema.parse(`st_b3a_fresh_${suffix}_${item}`),
      bigTaskId,
      profile: (["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"] as const)[index]!,
      taskContractRef: `contract/b3a-fresh-${suffix}-${item}`,
      writeEnabled: index !== 1,
    })),
    dependencies: [],
  };
  const contracts = plan.subtasks.map((subtask, index) => TaskContractV0Schema.parse({
    taskContractRef: subtask.taskContractRef,
    projectId,
    bigTaskId,
    subtaskId: subtask.id,
    title: `Fresh workflow ${index}`,
    goal: "Initialize only after explicit authority.",
    scopeIn: ["Migration"],
    scopeOut: [],
    acceptanceCriteria: ["Exact reopen"],
    untouchedAreas: [],
    promptSeed: `Fresh workflow prompt ${index}`,
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
  }));
  const bundle = storage.beginDurablePlanningBundle(plan, contracts);
  storage.recordDurableReviewerDecision(bigTaskId, approval(bundle.reviewState));
  storage.materializeDurablePlan(bigTaskId);
  storage.materializeApprovedCanonicalTasks(bigTaskId);
  return storage.initializeDurableSubtaskWorkflows(bigTaskId);
};

const injectFailureAfter = (migration: string, marker: string): string => {
  const markerIndex = migration.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing B3a migration marker: ${marker}`);
  const separator = "--> statement-breakpoint";
  const separatorIndex = migration.indexOf(separator, markerIndex);
  const insertAt = separatorIndex < 0
    ? migration.length
    : separatorIndex + separator.length;
  return `${migration.slice(0, insertAt)}\nCREATE TABLE projects (id text);\n${separator}\n${migration.slice(insertAt)}`;
};

describe("Step 8B3a migration generation hardening", () => {
  it("migrates every reconstructable predecessor with data and fabricates no workflow ownership", () => {
    for (let index = 0; index < predecessorMigrationNames.length; index += 1) {
      withTemporaryDatabasePath((databasePath) => {
        const suffix = String(index).padStart(2, "0");
        const priorFolder = join(databasePath, "..", `b3a-generation-${suffix}`);
        copyMigrations(priorFolder, predecessorMigrationNames.slice(0, index + 1));
        openTaskDatabase({
          databasePath,
          migrationsFolder: priorFolder,
          clock: () => new Date("2026-09-03T09:00:00.000Z"),
        }).close();
        let sqlite = new DatabaseSync(databasePath);
        sqlite.exec("PRAGMA foreign_keys = ON");
        seedGenerationData(sqlite, suffix);
        sqlite.close();

        let storage = openTaskDatabase({
          databasePath,
          clock: () => new Date("2026-09-03T10:00:00.000Z"),
        });
        const projectId = ProjectIdSchema.parse(`prj_b3a_generation_${suffix}`);
        const legacyBigTaskId = BigTaskIdSchema.parse(`bt_b3a_generation_${suffix}`);
        expect(storage.getProjectById(projectId)).toMatchObject({
          name: `B3a generation ${suffix}`,
        });
        expect(storage.listSubtasksByBigTask(legacyBigTaskId).map(({ id }) => id))
          .toEqual([
            `st_b3a_generation_${suffix}_a`,
            `st_b3a_generation_${suffix}_z`,
          ]);
        expect(storage.getDurableSubtaskWorkflowInitialization(legacyBigTaskId)).toBeNull();

        sqlite = new DatabaseSync(databasePath, { readOnly: true });
        expect(sqlite.prepare("SELECT count(*) AS count FROM subtask_workflow_instances").get())
          .toEqual({ count: 0 });
        expect(sqlite.prepare("SELECT count(*) AS count FROM workflow_initialization_receipts").get())
          .toEqual({ count: 0 });
        expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
          .toEqual({ count: predecessorMigrationNames.length + 4 });
        expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        sqlite.close();

        const initialized = seedCurrentWorkflowSource(storage, projectId, suffix);
        expect(initialized.workflowInstanceCount).toBe(3);
        storage.close();
        storage = openTaskDatabase({
          databasePath,
          clock: () => new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(storage.getDurableSubtaskWorkflowInitialization(initialized.bigTaskId))
          .toEqual(initialized);
        storage.close();

        sqlite = new DatabaseSync(databasePath);
        expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(() => sqlite.exec(
          "UPDATE subtask_workflow_instances SET initial_stage = initial_stage",
        )).toThrow();
        expect(() => sqlite.exec("DELETE FROM subtask_workflow_instances")).toThrow();
        expect(() => sqlite.exec(
          "UPDATE workflow_initialization_receipts SET initialized_at = initialized_at",
        )).toThrow();
        expect(() => sqlite.exec("DELETE FROM workflow_initialization_receipts")).toThrow();
        sqlite.close();
      });
    }
  });
});

describe("Step 8B3a migration rollback and guard-family hardening", () => {
  const markers = [
    "CREATE TABLE `subtask_workflow_instances`",
    "CREATE TABLE `workflow_initialization_receipts`",
    "CREATE UNIQUE INDEX `canonical_task_materializations_authority_unique`",
    "CREATE INDEX `subtask_workflow_instances_big_task_index`",
    "CREATE UNIQUE INDEX `subtasks_id_big_task_id_unique`",
    "CREATE TRIGGER `subtask_workflow_instances_owned_insert_guard`",
    "CREATE TRIGGER `subtask_workflow_instances_immutable_insert_conflict`",
    "CREATE TRIGGER `subtask_workflow_instances_immutable_update`",
    "CREATE TRIGGER `subtask_workflow_instances_immutable_delete`",
    "CREATE TRIGGER `workflow_initialization_receipts_complete_insert_guard`",
    "CREATE TRIGGER `workflow_initialization_receipts_immutable_insert_conflict`",
    "CREATE TRIGGER `workflow_initialization_receipts_immutable_update`",
    "CREATE TRIGGER `workflow_initialization_receipts_immutable_delete`",
  ] as const;

  it.each(markers)("rolls back a migration failure after %s", (marker) => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "b3a-failure-prior");
      copyMigrations(priorFolder, predecessorMigrationNames);
      const prior = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: () => new Date("2026-09-03T09:00:00.000Z"),
      });
      prior.createProject({
        recordType: "PROJECT",
        id: ProjectIdSchema.parse("prj_b3a_failure"),
        name: "B3a failure sentinel",
        slug: "b3a-failure-sentinel",
        repository: { kind: "PATH", path: "/repositories/b3a-failure" },
        defaultBranch: "main",
        maxActiveCodingSubtasks: 2,
      });
      prior.close();

      const failingFolder = join(databasePath, "..", "b3a-failing-migrations");
      copyMigrations(failingFolder, predecessorMigrationNames);
      cpSync(
        join(migrationsRoot, latestMigrationName),
        join(failingFolder, latestMigrationName),
        { recursive: true },
      );
      const migrationPath = join(failingFolder, latestMigrationName, "migration.sql");
      const migration = readFileSync(migrationPath, { encoding: "utf-8" });
      writeFileSync(migrationPath, injectFailureAfter(migration, marker), {
        encoding: "utf-8",
      });

      expect(captureTaskStorageError(() => openTaskDatabase({
        databasePath,
        migrationsFolder: failingFolder,
        clock: () => new Date("2026-09-03T10:00:00.000Z"),
      }))).toMatchObject({
        code: "MIGRATION_FAILED",
        message: "Task database migration failed.",
      });
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
        .toEqual({ count: predecessorMigrationNames.length });
      expect(sqlite.prepare("SELECT name FROM projects").all())
        .toEqual([{ name: "B3a failure sentinel" }]);
      for (const table of ["subtask_workflow_instances", "workflow_initialization_receipts"]) {
        expect(sqlite.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
        ).get(table)).toBeUndefined();
      }
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      sqlite.close();
    });
  });
});
