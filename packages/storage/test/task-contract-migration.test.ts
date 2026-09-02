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
      ).toEqual({ count: 12 });
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
