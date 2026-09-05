import { cpSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
const b3aMigrationNames = [
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
  "20260903063931_big_reavers",
] as const;
const step8cImplementationMigrationNames = [
  ...b3aMigrationNames,
  "20260903095250_old_gressill",
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

const seedB3a = (storage: TaskStorage) => {
  const projectId = ProjectIdSchema.parse("prj_step8c_migration");
  const bigTaskId = BigTaskIdSchema.parse("bt_step8c_migration");
  const profiles = ["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"] as const;
  storage.createProject(makeProject(projectId, "step8c-migration"));
  storage.createBigTask(makeBigTask(bigTaskId, projectId));
  const plan: PlanCandidate = {
    kind: "PLAN_CANDIDATE",
    projectId,
    bigTaskId,
    revision: 1,
    subtasks: profiles.map((profile, index) => ({
      id: SubtaskIdSchema.parse(`st_step8c_migration_${index}`),
      bigTaskId,
      profile,
      taskContractRef: `contract/step8c-migration-${index}`,
      writeEnabled: index !== 1,
    })),
    dependencies: [],
  };
  const contracts = plan.subtasks.map((subtask, index) =>
    TaskContractV0Schema.parse({
      taskContractRef: subtask.taskContractRef,
      projectId,
      bigTaskId,
      subtaskId: subtask.id,
      title: `Step 8C migration ${index}`,
      goal: "Preserve B3a bootstrap authority.",
      scopeIn: ["Migration"],
      scopeOut: ["Fabricated history"],
      acceptanceCriteria: ["Exact derived state"],
      untouchedAreas: [],
      promptSeed: `Migrate workflow ${index}.`,
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
    }),
  );
  const bundle = storage.beginDurablePlanningBundle(plan, contracts);
  storage.recordDurableReviewerDecision(bigTaskId, approval(bundle.reviewState));
  storage.materializeDurablePlan(bigTaskId);
  storage.materializeApprovedCanonicalTasks(bigTaskId);
  const initialization = storage.initializeDurableSubtaskWorkflows(bigTaskId);
  return { plan, initialization };
};

const workflowRows = (databasePath: string) => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite.prepare(
      `SELECT subtask_id, project_id, big_task_id, plan_revision,
              candidate_binding, initial_stage, initial_repair_cycles_used,
              initialized_at
         FROM subtask_workflow_instances
        ORDER BY subtask_id`,
    ).all();
  } finally {
    sqlite.close();
  }
};

describe("Step 8C workflow control migration", () => {
  it("upgrades the exact B3a shape without fabricating history and reopens derived state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "step8c-b3a-migrations");
      copyMigrations(priorFolder, b3aMigrationNames);
      let storage = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: fixedClock,
      });
      const seeded = seedB3a(storage);
      const beforeRows = workflowRows(databasePath);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(workflowRows(databasePath)).toEqual(beforeRows);
      const expectedStages = ["EXECUTE", "MATERIALIZE", "MATERIALIZE"];
      for (let index = 0; index < seeded.plan.subtasks.length; index += 1) {
        expect(
          storage.getDurableWorkflowControlView(
            seeded.plan.subtasks[index]!.id,
          ),
        ).toMatchObject({
          initialStage: expectedStages[index],
          currentStage: expectedStages[index],
          initialRepairCyclesUsed: 0,
          repairCyclesUsed: 0,
          boardStatus: "TODO",
          deliveryMaturity: "NOT_STARTED",
          transitionCount: 0,
          transitions: [],
          unresolvedHumanRequired: null,
        });
      }
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      for (const table of [
        "durable_workflow_evidence_authorities",
        "durable_workflow_evidence",
        "durable_workflow_transitions",
        "durable_workflow_human_requirements",
      ]) {
        expect(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get())
          .toEqual({ count: 0 });
      }
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get())
        .toEqual({ count: b3aMigrationNames.length + 6 });
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(
        storage.getDurableWorkflowControlView(seeded.plan.subtasks[0]!.id),
      ).toMatchObject({ currentStage: "EXECUTE", transitionCount: 0 });
      storage.close();
    });
  });

  it("upgrades the b651 Step 8C implementation database without rewriting bootstrap or history", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "step8c-implementation-migrations");
      copyMigrations(priorFolder, step8cImplementationMigrationNames);
      let storage = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: fixedClock,
      });
      const seeded = seedB3a(storage);
      const beforeRows = workflowRows(databasePath);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(workflowRows(databasePath)).toEqual(beforeRows);
      expect(
        storage.getDurableWorkflowControlView(seeded.plan.subtasks[0]!.id),
      ).toMatchObject({
        initialStage: "EXECUTE",
        currentStage: "EXECUTE",
        transitionCount: 0,
      });
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        sqlite.prepare(
          "SELECT count(*) AS count FROM __drizzle_migrations",
        ).get(),
      ).toEqual({ count: step8cImplementationMigrationNames.length + 5 });
      expect(
        sqlite.prepare(
          "SELECT count(*) AS count FROM durable_workflow_evidence_authorities",
        ).get(),
      ).toEqual({ count: 0 });
      sqlite.close();
    });
  });

  it("preserves but refuses legacy caller-self-attested b651 evidence without source authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "step8c-legacy-evidence-migrations");
      copyMigrations(priorFolder, step8cImplementationMigrationNames);
      let storage = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: fixedClock,
      });
      const seeded = seedB3a(storage);
      const target = seeded.plan.subtasks[1]!;
      const source = storage.getCanonicalTaskMaterialization(target.bigTaskId)!;
      storage.close();

      const legacy = new DatabaseSync(databasePath);
      legacy.prepare(
        `INSERT INTO durable_workflow_evidence
          (evidence_id, project_id, big_task_id, plan_revision,
           candidate_binding, subtask_id, expected_sequence, observed_stage,
           observed_repair_cycles_used, evidence_kind, outcome, producer,
           source_reference, occurred_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'MATERIALIZE', 0,
                 'HUMAN_APPROVAL_SATISFIED', 'PASS', 'HUMAN_AUTHORITY',
                 'caller:self-attested', ?, ?)`,
      ).run(
        "wfe_legacy_self_attested",
        source.projectId,
        source.bigTaskId,
        source.planRevision,
        source.candidateBinding,
        target.id,
        seeded.initialization.initializedAt,
        seeded.initialization.initializedAt,
      );
      legacy.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const error = captureTaskStorageError(() =>
        storage.getDurableWorkflowEvidence("wfe_legacy_self_attested"),
      );
      expect(error.code).toBe("MALFORMED_STORED_DATA");
      expect(error.message).not.toMatch(/SQLite|SQL|constraint|trigger|\/Users\//i);
      storage.close();

      const hardened = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        hardened.prepare(
          `SELECT evidence_id, authority_id
             FROM durable_workflow_evidence`,
        ).get(),
      ).toEqual({
        evidence_id: "wfe_legacy_self_attested",
        authority_id: null,
      });
      expect(
        hardened.prepare(
          "SELECT count(*) AS count FROM durable_workflow_evidence_authorities",
        ).get(),
      ).toEqual({ count: 0 });
      hardened.close();
    });
  });

  it("creates an empty valid Step 8C schema for a fresh database", () => {
    withTemporaryDatabasePath((databasePath) => {
      openTaskDatabase({ databasePath, clock: fixedClock }).close();
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const table of [
        "durable_workflow_evidence_authorities",
        "durable_workflow_evidence",
        "durable_workflow_transitions",
        "durable_workflow_human_requirements",
      ]) {
        expect(
          sqlite.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
          ).get(table),
        ).toEqual({ name: table });
      }
      sqlite.close();
    });
  });
});
