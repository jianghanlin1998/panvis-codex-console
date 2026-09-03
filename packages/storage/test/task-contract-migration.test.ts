import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type {
  PlanCandidate,
} from "@codex-task-console/orchestration";
import { beginPlanReview } from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeProject,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const MIGRATIONS_ROOT = fileURLToPath(new URL("../drizzle", import.meta.url));
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
  "20260902135340_material_master_chief",
  "20260902152406_simple_exodus",
] as const;
const ALL_MIGRATIONS = [
  ...PREDECESSOR_MIGRATIONS,
  "20260902171242_grey_toad",
  "20260903034830_stormy_marvel_apes",
  "20260903063931_big_reavers",
  "20260903095250_old_gressill",
  "20260903130845_equal_proteus",
] as const;
const REQUIRED_TASK_CONTRACT_TRIGGERS = [
  "candidate_task_contract_bindings_immutable_delete",
  "candidate_task_contract_bindings_immutable_insert_conflict",
  "candidate_task_contract_bindings_immutable_update",
  "orchestration_plan_candidate_task_contract_count_immutable",
  "orchestration_plan_candidate_task_contract_count_insert_check",
  "orchestration_plan_candidate_task_contract_count_insert_conflict",
  "task_contracts_immutable_delete",
  "task_contracts_immutable_insert_conflict",
  "task_contracts_immutable_update",
] as const;

const copyPredecessor = (databasePath: string, folderName: string): string => {
  const folder = join(dirname(databasePath), folderName);
  mkdirSync(folder);
  for (const migration of PREDECESSOR_MIGRATIONS) {
    cpSync(join(MIGRATIONS_ROOT, migration), join(folder, basename(migration)), {
      recursive: true,
    });
  }
  return folder;
};

const plan = (projectId: string, bigTaskId: string, subtaskId: string): PlanCandidate => ({
  kind: "PLAN_CANDIDATE",
  projectId: ProjectIdSchema.parse(projectId),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
  revision: 1,
  subtasks: [
    {
      id: SubtaskIdSchema.parse(subtaskId),
      bigTaskId: BigTaskIdSchema.parse(bigTaskId),
      profile: "STANDARD",
      taskContractRef: `legacy-ref-${subtaskId}`,
      writeEnabled: true,
    },
  ],
  dependencies: [],
});

describe("Immutable Task Contract authority migration", () => {
  it.each(
    ALL_MIGRATIONS.map((migration, index) => [migration, index] as const),
  )("migrates generation %s through current authority", (_migration, index) => {
    withTemporaryDatabasePath((databasePath) => {
      const generationFolder = join(dirname(databasePath), `generation-${index}`);
      mkdirSync(generationFolder);
      for (const migration of ALL_MIGRATIONS.slice(0, index + 1)) {
        cpSync(
          join(MIGRATIONS_ROOT, migration),
          join(generationFolder, basename(migration)),
          { recursive: true },
        );
      }

      const projectId = ProjectIdSchema.parse(`prj_contract_gen_${index}`);
      const historicalBigTaskId = BigTaskIdSchema.parse(
        `bt_contract_gen_history_${index}`,
      );
      let storage = openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: generationFolder,
      });
      storage.createProject(
        makeProject(projectId, `contract-generation-${index}`),
      );
      storage.createBigTask(makeBigTask(historicalBigTaskId, projectId));
      let historicalPlan: PlanCandidate | null = null;
      if (index >= 9) {
        historicalPlan = plan(
          projectId,
          historicalBigTaskId,
          `st_contract_gen_history_${index}`,
        );
        storage.beginDurablePlanning(historicalPlan);
      }
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getProjectById(projectId)).toEqual(
        makeProject(projectId, `contract-generation-${index}`),
      );
      if (historicalPlan === null) {
        expect(
          storage.getDurablePlanningSnapshot(historicalBigTaskId),
        ).toBeNull();
      } else {
        expect(
          storage.getDurablePlanningReviewBundle(historicalBigTaskId),
        ).toMatchObject({
          reviewState: { candidate: historicalPlan },
          taskContractAuthorityReadiness:
            "TASK_CONTRACT_AUTHORITY_NOT_READY",
          taskContracts: [],
        });
      }

      const currentBigTaskId = BigTaskIdSchema.parse(
        `bt_contract_gen_current_${index}`,
      );
      storage.createBigTask(makeBigTask(currentBigTaskId, projectId));
      const currentPlan = plan(
        projectId,
        currentBigTaskId,
        `st_contract_gen_current_${index}`,
      );
      const subtask = currentPlan.subtasks[0]!;
      const contract = TaskContractV0Schema.parse({
        taskContractRef: subtask.taskContractRef,
        projectId,
        bigTaskId: currentBigTaskId,
        subtaskId: subtask.id,
        title: `Generation ${index} contract`,
        goal: "Prove latest immutable authority after migration.",
        scopeIn: ["Migration generation"],
        scopeOut: [],
        acceptanceCriteria: ["Authority reopens exactly."],
        untouchedAreas: [],
        promptSeed: "Exercise only deterministic storage.",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "HIGH",
      });
      const bundle = storage.beginDurablePlanningBundle(currentPlan, [contract]);
      storage.recordDurableReviewerDecision(currentBigTaskId, {
        outcome: "APPROVE",
        planRevision: 1,
        candidateBinding: bundle.candidateBinding,
      });
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(
        storage.getApprovedTaskContractAuthority(currentBigTaskId),
      ).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        taskContracts: [contract],
      });
      expect(storage.isForeignKeyEnforcementEnabled()).toBe(true);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: ALL_MIGRATIONS.length });
      sqlite.close();
    });
  });

  it("retains every structural immutability trigger after the full migration chain", () => {
    withTemporaryDatabasePath((databasePath) => {
      openTaskDatabase({ databasePath, clock: fixedClock }).close();
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      const triggers = sqlite
        .prepare(
          `SELECT name, sql
             FROM sqlite_schema
            WHERE type = 'trigger'
              AND (name LIKE 'task_contracts_%'
                OR name LIKE 'candidate_task_contract_bindings_%'
                OR name LIKE 'orchestration_plan_candidate_task_contract_count_%')
            ORDER BY name`,
        )
        .all() as unknown as readonly {
        readonly name: string;
        readonly sql: string;
      }[];
      expect(triggers.map(({ name }) => name)).toEqual(
        REQUIRED_TASK_CONTRACT_TRIGGERS,
      );
      for (const trigger of triggers) {
        expect(trigger.sql).toMatch(/RAISE\s*\(\s*ABORT/i);
      }
      sqlite.close();
    });
  });

  it("enforces the Task Contract PK, unique, FK, and CHECK matrix", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const projectId = ProjectIdSchema.parse("prj_contract_constraints");
      const bigTaskId = BigTaskIdSchema.parse("bt_contract_constraints");
      storage.createProject(makeProject(projectId, "contract-constraints"));
      storage.createBigTask(makeBigTask(bigTaskId, projectId));
      const currentPlan = plan(
        projectId,
        bigTaskId,
        "st_contract_constraints",
      );
      const subtask = currentPlan.subtasks[0]!;
      const contract = TaskContractV0Schema.parse({
        taskContractRef: subtask.taskContractRef,
        projectId,
        bigTaskId,
        subtaskId: subtask.id,
        title: "Constraint contract",
        goal: "Exercise structural invariants.",
        scopeIn: ["Schema"],
        scopeOut: [],
        acceptanceCriteria: ["Invalid writes fail."],
        untouchedAreas: [],
        promptSeed: "Use the exact schema.",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "HIGH",
      });
      const bundle = storage.beginDurablePlanningBundle(currentPlan, [contract]);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      const insertContract = sqlite.prepare(
        `INSERT INTO task_contracts
           (project_id, task_contract_ref, big_task_id, subtask_id, contract_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const contractValues = [
        contract.projectId,
        contract.taskContractRef,
        contract.bigTaskId,
        contract.subtaskId,
        JSON.stringify(contract),
        "2026-08-09T00:00:00.000Z",
      ] as const;
      expect(() => insertContract.run(...contractValues)).toThrow();
      expect(() =>
        insertContract.run(
          "prj_missing",
          "missing-project-ref",
          contract.bigTaskId,
          contract.subtaskId,
          JSON.stringify({ ...contract, projectId: "prj_missing" }),
          contractValues[5],
        ),
      ).toThrow();
      expect(() =>
        insertContract.run(
          contract.projectId,
          "missing-big-task-ref",
          "bt_missing",
          contract.subtaskId,
          JSON.stringify({ ...contract, bigTaskId: "bt_missing" }),
          contractValues[5],
        ),
      ).toThrow();
      for (const invalidRef of ["", "x".repeat(1_001)]) {
        expect(() =>
          insertContract.run(
            contract.projectId,
            invalidRef,
            contract.bigTaskId,
            contract.subtaskId,
            JSON.stringify({ ...contract, taskContractRef: invalidRef }),
            contractValues[5],
          ),
        ).toThrow();
      }

      const insertBinding = sqlite.prepare(
        `INSERT INTO candidate_task_contract_bindings
           (project_id, big_task_id, plan_revision, candidate_binding, subtask_id, task_contract_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const bindingValues = [
        contract.projectId,
        contract.bigTaskId,
        1,
        bundle.candidateBinding,
        contract.subtaskId,
        contract.taskContractRef,
        "2026-08-09T00:00:00.000Z",
      ] as const;
      expect(() => insertBinding.run(...bindingValues)).toThrow();
      expect(() =>
        insertBinding.run(
          contract.projectId,
          contract.bigTaskId,
          99,
          bundle.candidateBinding,
          "st_absent_revision",
          contract.taskContractRef,
          bindingValues[6],
        ),
      ).toThrow();
      expect(() =>
        insertBinding.run(
          contract.projectId,
          contract.bigTaskId,
          1,
          bundle.candidateBinding,
          "st_missing_contract",
          "missing-contract-ref",
          bindingValues[6],
        ),
      ).toThrow();
      expect(() =>
        insertBinding.run(
          contract.projectId,
          contract.bigTaskId,
          1,
          bundle.candidateBinding,
          "st_duplicate_ref",
          contract.taskContractRef,
          bindingValues[6],
        ),
      ).toThrow();
      for (const invalidRevision of [0, -1]) {
        expect(() =>
          insertBinding.run(
            contract.projectId,
            contract.bigTaskId,
            invalidRevision,
            bundle.candidateBinding,
            "st_invalid_revision",
            contract.taskContractRef,
            bindingValues[6],
          ),
        ).toThrow();
      }
      expect(() =>
        insertBinding.run(
          contract.projectId,
          contract.bigTaskId,
          1,
          "",
          "st_empty_binding",
          contract.taskContractRef,
          bindingValues[6],
        ),
      ).toThrow();
      for (const invalidRef of ["", "x".repeat(1_001)]) {
        expect(() =>
          insertBinding.run(
            contract.projectId,
            contract.bigTaskId,
            1,
            bundle.candidateBinding,
            "st_invalid_ref",
            invalidRef,
            bindingValues[6],
          ),
        ).toThrow();
      }
      sqlite.close();
    });
  });

  it("adds empty authority tables without fabricating contracts for accepted Step 8B1 histories", () => {
    withTemporaryDatabasePath((databasePath) => {
      const predecessor = copyPredecessor(databasePath, "task-contract-predecessor");
      let storage = openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: predecessor,
      });
      const projectId = ProjectIdSchema.parse("prj_contract_migration");
      storage.createProject(makeProject(projectId, "contract-migration"));

      const histories = [
        ["bt_contract_rejected", "st_contract_rejected", "REJECT"],
        ["bt_contract_approved", "st_contract_approved", "APPROVE"],
        ["bt_contract_materialized", "st_contract_materialized", "MATERIALIZE"],
      ] as const;
      const seededPlans = new Map<string, PlanCandidate>();
      for (const [bigTaskIdValue, subtaskId] of histories) {
        const bigTaskId = BigTaskIdSchema.parse(bigTaskIdValue);
        storage.createBigTask(makeBigTask(bigTaskId, projectId));
        seededPlans.set(bigTaskId, plan(projectId, bigTaskId, subtaskId));
      }
      storage.close();

      const predecessorSqlite = new DatabaseSync(databasePath);
      predecessorSqlite.exec("PRAGMA foreign_keys = ON");
      for (const [bigTaskIdValue, , outcome] of histories) {
        const seededPlan = seededPlans.get(bigTaskIdValue)!;
        const started = beginPlanReview(seededPlan);
        if (started.kind !== "REVIEW_STATE") {
          throw new Error("Test fixture Plan Candidate is invalid.");
        }
        const binding = started.state.candidateBinding;
        predecessorSqlite
          .prepare(
            "INSERT INTO orchestration_planning_tracks (big_task_id, project_id, created_at) VALUES (?, ?, ?)",
          )
          .run(bigTaskIdValue, projectId, "2026-08-09T00:00:00.000Z");
        predecessorSqlite
          .prepare(
            "INSERT INTO orchestration_plan_candidates (big_task_id, project_id, revision, candidate_payload, candidate_binding, created_at) VALUES (?, ?, 1, ?, ?, ?)",
          )
          .run(
            bigTaskIdValue,
            projectId,
            JSON.stringify(seededPlan),
            binding,
            "2026-08-09T00:00:00.000Z",
          );
        predecessorSqlite
          .prepare(
            "INSERT INTO orchestration_review_decisions (big_task_id, plan_revision, outcome, candidate_binding, revision_requirements, created_at) VALUES (?, 1, ?, ?, ?, ?)",
          )
          .run(
            bigTaskIdValue,
            outcome === "REJECT" ? "REJECT" : "APPROVE",
            binding,
            outcome === "REJECT"
              ? JSON.stringify(["Preserve immutable history."])
              : null,
            "2026-08-09T00:00:00.000Z",
          );
        if (outcome === "MATERIALIZE") {
          predecessorSqlite
            .prepare(
              "INSERT INTO orchestration_materializations (big_task_id, project_id, plan_revision, candidate_binding, materialized_at) VALUES (?, ?, 1, ?, ?)",
            )
            .run(
              bigTaskIdValue,
              projectId,
              binding,
              "2026-08-09T00:00:00.000Z",
            );
        }
      }
      predecessorSqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      for (const [bigTaskIdValue, , outcome] of histories) {
        const bigTaskId = BigTaskIdSchema.parse(bigTaskIdValue);
        const snapshot = storage.getDurablePlanningSnapshot(bigTaskId);
        expect(snapshot?.candidateHistory[0]?.candidate).toEqual(
          seededPlans.get(bigTaskId),
        );
        expect(snapshot?.reviewState.phase).toBe(
          outcome === "REJECT" ? "AWAITING_REVISION" : "APPROVED",
        );
        expect(snapshot?.materializedGraph === null).toBe(
          outcome !== "MATERIALIZE",
        );
        expect(storage.getDurablePlanningReviewBundle(bigTaskId)).toMatchObject({
          taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
          taskContracts: [],
        });
        expect(storage.getApprovedTaskContractAuthority(bigTaskId)).toMatchObject({
          taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        });
      }
      expect(storage.isForeignKeyEnforcementEnabled()).toBe(true);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 16 });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM task_contracts").get(),
      ).toEqual({ count: 0 });
      expect(
        sqlite
          .prepare("SELECT count(*) AS count FROM candidate_task_contract_bindings")
          .get(),
      ).toEqual({ count: 0 });
      sqlite.close();
    });
  });

  it.each([
    [
      "binding table",
      "CREATE TABLE candidate_task_contract_bindings (sentinel TEXT NOT NULL)",
    ],
    ["artifact table", "CREATE TABLE task_contracts (sentinel TEXT NOT NULL)"],
    [
      "bundle marker column",
      "ALTER TABLE orchestration_plan_candidates ADD task_contract_count integer",
    ],
    [
      "final index",
      "CREATE TABLE contract_index_sentinel (id TEXT); CREATE UNIQUE INDEX candidate_task_contract_bindings_ref_unique ON contract_index_sentinel(id)",
    ],
    [
      "immutability trigger",
      "CREATE TRIGGER task_contracts_immutable_update BEFORE INSERT ON projects BEGIN SELECT 1; END",
    ],
    [
      "artifact insert-conflict trigger",
      "CREATE TRIGGER task_contracts_immutable_insert_conflict BEFORE INSERT ON projects BEGIN SELECT 1; END",
    ],
    [
      "association insert-conflict trigger",
      "CREATE TRIGGER candidate_task_contract_bindings_immutable_insert_conflict BEFORE INSERT ON projects BEGIN SELECT 1; END",
    ],
    [
      "bundle-marker conflict trigger",
      "CREATE TRIGGER orchestration_plan_candidate_task_contract_count_insert_conflict BEFORE INSERT ON projects BEGIN SELECT 1; END",
    ],
    [
      "final trigger",
      "CREATE TRIGGER orchestration_plan_candidate_task_contract_count_insert_check BEFORE INSERT ON projects BEGIN SELECT 1; END",
    ],
  ] as const)("rolls back the whole migration on a %s collision", (_label, collisionSql) => {
    withTemporaryDatabasePath((databasePath) => {
      const predecessor = copyPredecessor(databasePath, "collision-predecessor");
      const projectId = ProjectIdSchema.parse("prj_contract_collision");
      const prior = openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: predecessor,
      });
      prior.createProject(makeProject(projectId, "contract-collision"));
      prior.close();

      const collision = new DatabaseSync(databasePath);
      collision.exec(collisionSql);
      collision.close();

      const error = captureTaskStorageError(() =>
        openTaskDatabase({ databasePath, clock: fixedClock }),
      );
      expect(error.code).toBe("MIGRATION_FAILED");
      expect(error.message).not.toMatch(/SQLite|SQL|constraint|task_contract|\/Users\//i);

      const verified = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        verified.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 11 });
      expect(
        verified
          .prepare("SELECT id FROM projects WHERE id = 'prj_contract_collision'")
          .get(),
      ).toEqual({ id: "prj_contract_collision" });
      const candidateTable = verified
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'candidate_task_contract_bindings'",
        )
        .get() as { readonly sql: string } | undefined;
      const artifactTable = verified
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'task_contracts'",
        )
        .get() as { readonly sql: string } | undefined;
      if (candidateTable !== undefined) {
        expect(candidateTable.sql).toContain("sentinel");
      }
      if (artifactTable !== undefined) {
        expect(artifactTable.sql).toContain("sentinel");
      }
      verified.close();
    });
  });
});
