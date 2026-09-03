import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type {
  SubtaskDependency,
  TaskContractV0,
} from "@codex-task-console/domain";
import type {
  PlanCandidate,
  PlanReviewState,
} from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage, TaskStorageError } from "../src/index.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeImplementationCheckpoint,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_b2b_hardening");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_b2b_hardening");
const MATERIALIZED_AT = "2026-08-09T00:00:00.000Z";

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  index: number,
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: index % 2 === 0 ? "BLOCKING" : "INFORMATIONAL",
    requiredGate: index % 2 === 0
      ? (index % 4 === 0 ? "HARDENED" : "ACCEPTED")
      : "NONE",
    reason: `Hardening dependency ${index}.`,
  });

const makePlan = (
  ids: readonly string[] = ["st_b2b_z", "st_b2b_a", "st_b2b_m"],
  dependencies?: readonly SubtaskDependency[],
): PlanCandidate => {
  const subtasks = ids.map((id, index) => ({
    id: SubtaskIdSchema.parse(id),
    bigTaskId: BIG_TASK_ID,
    profile: index % 3 === 0
      ? "HIGH_RISK_FOUNDATION" as const
      : index % 3 === 1
        ? "LOW" as const
        : "STANDARD" as const,
    taskContractRef: `contract/hardening-${id}`,
    writeEnabled: index % 2 === 0,
  }));
  return {
    kind: "PLAN_CANDIDATE",
    projectId: PROJECT_ID,
    bigTaskId: BIG_TASK_ID,
    revision: 1,
    subtasks,
    dependencies: dependencies ?? [
      dependency(ids[0]!, ids[1]!, 0),
      dependency(ids[0]!, ids[2]!, 1),
    ],
  };
};

const contractsFor = (plan: PlanCandidate): readonly TaskContractV0[] =>
  plan.subtasks.map((subtask, index) => TaskContractV0Schema.parse({
    taskContractRef: subtask.taskContractRef,
    projectId: plan.projectId,
    bigTaskId: plan.bigTaskId,
    subtaskId: subtask.id,
    title: `Hardening title ${index}`,
    goal: `Hardening goal ${index}`,
    scopeIn: [`Hardening scope ${index}`],
    scopeOut: [`Deferred scope ${index}`],
    acceptanceCriteria: [`Hardening acceptance ${index}`],
    untouchedAreas: [`Unrelated area ${index}`],
    promptSeed: `Execute exact hardening intent ${index}.`,
    startPolicy: index % 2 === 0 ? "MANUAL" : "WHEN_READY",
    delegationPolicy: index % 2 === 0 ? "NONE" : "REVIEW_ONLY",
    recommendedReasoningLevel: index % 2 === 0 ? "XHIGH" : "MEDIUM",
  }));

const approval = (state: PlanReviewState) => ({
  outcome: "APPROVE" as const,
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const seedApprovedSource = (
  storage: TaskStorage,
  plan = makePlan(),
): readonly TaskContractV0[] => {
  storage.createProject(makeProject(PROJECT_ID, "b2b-hardening"));
  storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
  const contracts = contractsFor(plan);
  const bundle = storage.beginDurablePlanningBundle(plan, contracts);
  storage.recordDurableReviewerDecision(BIG_TASK_ID, approval(bundle.reviewState));
  storage.materializeDurablePlan(BIG_TASK_ID);
  return contracts;
};

const expectStorageError = (
  operation: () => unknown,
  expectedCode: TaskStorageError["code"],
): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe(expectedCode);
  expect(error.message).not.toMatch(
    /SQLite|SQL|constraint|trigger|locked|busy|\/Users\/|task_contracts/i,
  );
  return error;
};

const corrupt = (databasePath: string, statements: string): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
    sqlite.exec(statements);
  } finally {
    sqlite.close();
  }
};

const rawCounts = (databasePath: string): Readonly<Record<string, number>> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: string): number =>
      (sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        readonly count: number;
      }).count;
    return Object.freeze({
      evidence: count("canonical_task_materializations"),
      subtasks: count("subtasks"),
      dependencies: count("task_dependencies"),
    });
  } finally {
    sqlite.close();
  }
};

describe("Step 8B2b four-layer authority and corruption hardening", () => {
  it("keeps first-call missing/not-ready semantics distinct from owned-source corruption", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject(PROJECT_ID, "b2b-hardening"));
      storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "PARENT_NOT_FOUND",
      );

      const plan = makePlan(["st_b2b_not_ready"], []);
      storage.beginDurablePlanningBundle(plan, contractsFor(plan));
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "CONFLICT",
      );
      storage.close();
    });
  });

  it("classifies every tested loss or downgrade beneath owned evidence as corruption", () => {
    const cases = [
      {
        name: "planning track missing",
        sql: "DELETE FROM orchestration_planning_tracks WHERE big_task_id = 'bt_b2b_hardening'",
      },
      {
        name: "all planning authority missing",
        sql: `DROP TRIGGER task_contracts_immutable_delete;
          DROP TRIGGER candidate_task_contract_bindings_immutable_delete;
          DELETE FROM candidate_task_contract_bindings WHERE big_task_id = 'bt_b2b_hardening';
          DELETE FROM task_contracts WHERE big_task_id = 'bt_b2b_hardening';
          DELETE FROM orchestration_review_decisions WHERE big_task_id = 'bt_b2b_hardening';
          DELETE FROM orchestration_materializations WHERE big_task_id = 'bt_b2b_hardening';
          DELETE FROM orchestration_plan_candidates WHERE big_task_id = 'bt_b2b_hardening';
          DELETE FROM orchestration_planning_tracks WHERE big_task_id = 'bt_b2b_hardening'`,
      },
      {
        name: "graph materialization missing",
        sql: "DELETE FROM orchestration_materializations WHERE big_task_id = 'bt_b2b_hardening'",
      },
      {
        name: "Task Contract artifact missing",
        sql: `DROP TRIGGER task_contracts_immutable_delete;
          DELETE FROM task_contracts WHERE rowid = (
            SELECT rowid FROM task_contracts
            WHERE big_task_id = 'bt_b2b_hardening' ORDER BY rowid LIMIT 1
          )`,
      },
      {
        name: "Task Contract bundle downgraded",
        sql: `DROP TRIGGER candidate_task_contract_bindings_immutable_delete;
          DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable;
          DELETE FROM candidate_task_contract_bindings WHERE big_task_id = 'bt_b2b_hardening';
          UPDATE orchestration_plan_candidates SET task_contract_count = NULL
            WHERE big_task_id = 'bt_b2b_hardening'`,
      },
      {
        name: "Reviewer approval broken",
        sql: `UPDATE orchestration_review_decisions SET outcome = 'REJECT',
          revision_requirements = '["changed"]'
          WHERE big_task_id = 'bt_b2b_hardening'`,
      },
      {
        name: "source candidate malformed",
        sql: "UPDATE orchestration_plan_candidates SET candidate_payload = '{}' WHERE big_task_id = 'bt_b2b_hardening'",
      },
      {
        name: "source binding damaged",
        sql: "UPDATE orchestration_materializations SET candidate_binding = 'damaged' WHERE big_task_id = 'bt_b2b_hardening'",
      },
      {
        name: "source project damaged",
        sql: "UPDATE orchestration_materializations SET project_id = 'prj_damaged' WHERE big_task_id = 'bt_b2b_hardening'",
      },
      {
        name: "source revision damaged",
        sql: "UPDATE orchestration_materializations SET plan_revision = 9 WHERE big_task_id = 'bt_b2b_hardening'",
      },
      {
        name: "exact candidate revision missing",
        sql: "DELETE FROM orchestration_plan_candidates WHERE big_task_id = 'bt_b2b_hardening'",
      },
    ] as const;

    for (const scenario of cases) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage);
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        corrupt(databasePath, scenario.sql);
        expectStorageError(
          () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        expectStorageError(
          () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("detects coordinate substitutions across evidence, graph, and contract association", () => {
    const cases = [
      "UPDATE canonical_task_materializations SET project_id = 'prj_substitute' WHERE big_task_id = 'bt_b2b_hardening'",
      "UPDATE canonical_task_materializations SET plan_revision = 2 WHERE big_task_id = 'bt_b2b_hardening'",
      "UPDATE canonical_task_materializations SET candidate_binding = 'substitute' WHERE big_task_id = 'bt_b2b_hardening'",
      "UPDATE canonical_task_materializations SET subtask_count = 4 WHERE big_task_id = 'bt_b2b_hardening'",
      "UPDATE canonical_task_materializations SET dependency_count = 1 WHERE big_task_id = 'bt_b2b_hardening'",
      `DROP TRIGGER candidate_task_contract_bindings_immutable_update;
        UPDATE candidate_task_contract_bindings SET task_contract_ref = 'contract/substitute'
        WHERE big_task_id = 'bt_b2b_hardening' AND subtask_id = 'st_b2b_z'`,
      `DROP TRIGGER canonical_materialized_subtask_stable_update_guard;
        DROP TRIGGER canonical_materialized_dependency_update_guard;
        UPDATE subtasks SET id = 'st_b2b_substitute' WHERE id = 'st_b2b_z'`,
    ] as const;

    for (const mutation of cases) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage);
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        corrupt(
          databasePath,
          `DROP TRIGGER canonical_task_materializations_immutable_update; ${mutation}`,
        );
        expectStorageError(
          () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("detects every mutable evidence value while preserving the missing-evidence V0 boundary", () => {
    const mutations = [
      "project_id = 'prj_wrong'",
      "plan_revision = 7",
      "candidate_binding = 'wrong-binding'",
      "subtask_count = 99",
      "dependency_count = 0",
      "materialized_at = '2030-01-01T00:00:00.000Z'",
      "materialized_at = 'not-a-timestamp'",
    ] as const;
    for (const mutation of mutations) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage);
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        corrupt(
          databasePath,
          `DROP TRIGGER canonical_task_materializations_immutable_update;
           UPDATE canonical_task_materializations SET ${mutation}
           WHERE big_task_id = 'bt_b2b_hardening'`,
        );
        expectStorageError(
          () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }

    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage, makePlan(["st_b2b_provenance"], []));
      storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      corrupt(
        databasePath,
        `DROP TRIGGER canonical_task_materializations_immutable_delete;
         DELETE FROM canonical_task_materializations
         WHERE big_task_id = 'bt_b2b_hardening'`,
      );
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "CONFLICT",
      );
      storage.close();
    });

    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage, makePlan(["st_b2b_key_provenance"], []));
      storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      corrupt(
        databasePath,
        `DROP TRIGGER canonical_task_materializations_immutable_update;
         UPDATE canonical_task_materializations SET big_task_id = 'bt_b2b_moved_key'
         WHERE big_task_id = 'bt_b2b_hardening'`,
      );
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "CONFLICT",
      );
      expectStorageError(
        () => storage.getCanonicalTaskMaterialization(
          BigTaskIdSchema.parse("bt_b2b_moved_key"),
        ),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("supplements replay with structural evidence constraints", () => {
    const invalidRows = [
      ["bt_missing", PROJECT_ID, 1, "binding", 1, 0],
      [BIG_TASK_ID, "prj_missing", 1, "binding", 1, 0],
      [BIG_TASK_ID, PROJECT_ID, 0, "binding", 1, 0],
      [BIG_TASK_ID, PROJECT_ID, -1, "binding", 1, 0],
      [BIG_TASK_ID, PROJECT_ID, 1.5, "binding", 1, 0],
      [BIG_TASK_ID, PROJECT_ID, 2, "binding", 1, 0],
      [BIG_TASK_ID, PROJECT_ID, 1, "", 1, 0],
      [BIG_TASK_ID, PROJECT_ID, 1, "binding", 0, 0],
      [BIG_TASK_ID, PROJECT_ID, 1, "binding", 1.5, 0],
      [BIG_TASK_ID, PROJECT_ID, 1, "binding", 1, -1],
      [BIG_TASK_ID, PROJECT_ID, 1, "binding", 1, 0.5],
    ] as const;
    for (const row of invalidRows) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage, makePlan(["st_b2b_constraint"], []));
        const sqlite = new DatabaseSync(databasePath);
        expect(() => sqlite.prepare(`INSERT INTO canonical_task_materializations
          (big_task_id, project_id, plan_revision, candidate_binding,
           subtask_count, dependency_count, materialized_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(...row, MATERIALIZED_AT)).toThrow();
        expect(sqlite.prepare(
          "SELECT count(*) AS count FROM canonical_task_materializations",
        ).get()).toEqual({ count: 0 });
        sqlite.close();
        storage.close();
      });
    }
  });

  it("fails semantic replay for completion evidence copied between approved Big Tasks", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage, makePlan(["st_b2b_copy_source"], []));
      storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);

      const otherBigTaskId = BigTaskIdSchema.parse("bt_b2b_copy_target");
      storage.createBigTask(makeBigTask(otherBigTaskId, PROJECT_ID));
      const otherPlan: PlanCandidate = {
        ...makePlan(["st_b2b_copy_target"], []),
        bigTaskId: otherBigTaskId,
        subtasks: [{
          id: SubtaskIdSchema.parse("st_b2b_copy_target"),
          bigTaskId: otherBigTaskId,
          profile: "LOW",
          taskContractRef: "contract/b2b-copy-target",
          writeEnabled: false,
        }],
      };
      const otherBundle = storage.beginDurablePlanningBundle(
        otherPlan,
        contractsFor(otherPlan),
      );
      storage.recordDurableReviewerDecision(
        otherBigTaskId,
        approval(otherBundle.reviewState),
      );
      storage.materializeDurablePlan(otherBigTaskId);

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(`INSERT INTO canonical_task_materializations
        SELECT ?, project_id, plan_revision, candidate_binding,
               subtask_count, dependency_count, materialized_at
          FROM canonical_task_materializations WHERE big_task_id = ?`)
        .run(otherBigTaskId, BIG_TASK_ID);
      sqlite.close();
      expectStorageError(
        () => storage.getCanonicalTaskMaterialization(otherBigTaskId),
        "MALFORMED_STORED_DATA",
      );
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(otherBigTaskId),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });
});

describe("Step 8B2b lifecycle and idempotent historical replay hardening", () => {
  it("composes with accepted implementation completion and later parent progression", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = new Date(MATERIALIZED_AT);
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      const lifecycleIds = ["st_b2b_lifecycle_a", "st_b2b_lifecycle_b"];
      const plan = makePlan(lifecycleIds, [
        dependency(lifecycleIds[0]!, lifecycleIds[1]!, 1),
      ]);
      seedApprovedSource(storage, plan);
      const original = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(
        "UPDATE subtasks SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?",
      ).run(MATERIALIZED_AT, plan.subtasks[0]!.id);
      sqlite.close();

      currentTime = new Date("2026-08-09T00:00:01.000Z");
      const completion = storage.completeSubtaskImplementation({
        subtaskId: plan.subtasks[0]!.id,
        checkpoint: makeImplementationCheckpoint(
          "icp_b2b_hardening_completion",
          plan.subtasks[0]!.id,
          { occurredAt: currentTime.toISOString() },
        ),
      });
      expect(completion.subtask).toMatchObject({
        status: "QA_DEBUG",
        maturity: "IMPLEMENTED",
      });
      expect(storage.listSubtaskImplementationCheckpoints(plan.subtasks[0]!.id))
        .toEqual([completion.checkpoint]);

      const progression = new DatabaseSync(databasePath);
      progression.prepare("UPDATE big_tasks SET status = 'DONE', updated_at = ? WHERE id = ?")
        .run("2026-08-09T00:00:02.000Z", BIG_TASK_ID);
      progression.prepare(
        "UPDATE subtasks SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?",
      ).run("2026-08-09T00:00:02.000Z", plan.subtasks[1]!.id);
      progression.close();

      const historical = storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!;
      expect(historical.materializedAt).toBe(original.materializedAt);
      expect(historical.dependencies).toEqual(plan.dependencies);
      expect(historical.subtasks.map(({ subtask }) => [subtask.status, subtask.maturity]))
        .toEqual([
          ["QA_DEBUG", "IMPLEMENTED"],
          ["IN_PROGRESS", "NOT_STARTED"],
        ]);
      currentTime = new Date("2040-01-01T00:00:00.000Z");
      expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(historical);
      storage.close();
    });
  });

  it("allows equal and later lifecycle timestamps but rejects regressing or malformed ones", () => {
    for (const updatedAt of [
      MATERIALIZED_AT,
      "2026-08-09T00:00:00.001Z",
      "2035-12-31T23:59:59.999Z",
    ]) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage, makePlan(["st_b2b_time"], []));
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        corrupt(
          databasePath,
          `UPDATE subtasks SET status = 'IN_PROGRESS', updated_at = '${updatedAt}'
           WHERE id = 'st_b2b_time'`,
        );
        expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).not.toBeNull();
        storage.close();
      });
    }

    for (const updatedAt of ["2026-08-08T23:59:59.999Z", "invalid"]) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage, makePlan(["st_b2b_time"], []));
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        corrupt(
          databasePath,
          `UPDATE subtasks SET updated_at = '${updatedAt}' WHERE id = 'st_b2b_time'`,
        );
        expectStorageError(
          () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("performs repeated owned retries without durable writes or timestamp replacement", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = new Date(MATERIALIZED_AT);
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      seedApprovedSource(storage);
      const first = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const observer = new DatabaseSync(databasePath, { readOnly: true });
      const snapshotRows = (): unknown => ({
        evidence: observer.prepare(
          "SELECT * FROM canonical_task_materializations ORDER BY big_task_id",
        ).all(),
        subtasks: observer.prepare(
          "SELECT * FROM subtasks WHERE big_task_id = ? ORDER BY id",
        ).all(BIG_TASK_ID),
        dependencies: observer.prepare(
          "SELECT * FROM task_dependencies ORDER BY upstream_subtask_id, downstream_subtask_id",
        ).all(),
      });
      const before = snapshotRows();
      const beforeVersion = observer.prepare("PRAGMA data_version").get();
      currentTime = new Date("2045-01-01T00:00:00.000Z");
      for (let attempt = 0; attempt < 8; attempt += 1) {
        expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(first);
      }
      expect(snapshotRows()).toEqual(before);
      expect(observer.prepare("PRAGMA data_version").get()).toEqual(beforeVersion);
      observer.close();
      storage.close();
    });
  });
});

describe("Step 8B2b SQLite conflict and graph-freeze hardening", () => {
  it("blocks every ordinary evidence conflict algorithm with recursive triggers disabled", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage);
      const expected = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      expect(sqlite.prepare("PRAGMA recursive_triggers").get())
        .toEqual({ recursive_triggers: 0 });
      const operations = [
        "INSERT INTO canonical_task_materializations SELECT * FROM canonical_task_materializations WHERE big_task_id = 'bt_b2b_hardening'",
        "INSERT OR REPLACE INTO canonical_task_materializations SELECT * FROM canonical_task_materializations WHERE big_task_id = 'bt_b2b_hardening'",
        "REPLACE INTO canonical_task_materializations SELECT * FROM canonical_task_materializations WHERE big_task_id = 'bt_b2b_hardening'",
        `INSERT INTO canonical_task_materializations
           SELECT * FROM canonical_task_materializations
           WHERE big_task_id = 'bt_b2b_hardening'
           ON CONFLICT(big_task_id) DO UPDATE SET dependency_count = excluded.dependency_count`,
        `INSERT INTO canonical_task_materializations
           SELECT * FROM canonical_task_materializations
           WHERE big_task_id = 'bt_b2b_hardening'
           ON CONFLICT(big_task_id) DO NOTHING`,
        "UPDATE canonical_task_materializations SET project_id = project_id WHERE big_task_id = 'bt_b2b_hardening'",
        "DELETE FROM canonical_task_materializations WHERE big_task_id = 'bt_b2b_hardening'",
      ] as const;
      for (const statement of operations) {
        expect(() => sqlite.exec(statement)).toThrow();
      }
      sqlite.close();
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toEqual(expected);
      storage.close();
    });
  });

  it("blocks every stable Subtask column, set mutation, replacement move, and multi-row partial insert", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage, makePlan(["st_b2b_guard_a", "st_b2b_guard_b"], []));
      const otherBigTaskId = BigTaskIdSchema.parse("bt_b2b_unowned");
      storage.createBigTask(makeBigTask(otherBigTaskId, PROJECT_ID));
      storage.createSubtask(makeSubtask("st_b2b_unowned_a", otherBigTaskId));
      storage.createSubtask(makeSubtask("st_b2b_unowned_b", otherBigTaskId));
      const expected = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      expect(sqlite.prepare("PRAGMA recursive_triggers").get())
        .toEqual({ recursive_triggers: 0 });

      const stableUpdates = [
        "id = 'st_b2b_guard_changed'",
        "big_task_id = 'bt_b2b_unowned'",
        "title = 'changed'",
        "goal = 'changed'",
        "scope_in = '[\"changed\"]'",
        "scope_out = '[\"changed\"]'",
        "acceptance_criteria = '[\"changed\"]'",
        "untouched_areas = '[\"changed\"]'",
        "start_policy = 'WHEN_READY'",
        "delegation_policy = 'REVIEW_ONLY'",
        "recommended_reasoning_level = 'LOW'",
        "prompt_seed = 'changed'",
        "created_at = '2026-08-09T00:00:00.001Z'",
      ] as const;
      for (const assignment of stableUpdates) {
        expect(() => sqlite.exec(
          `UPDATE subtasks SET ${assignment} WHERE id = 'st_b2b_guard_a'`,
        )).toThrow();
      }

      const setMutations = [
        `INSERT INTO subtasks SELECT 'st_b2b_extra', big_task_id, title, goal,
           scope_in, scope_out, acceptance_criteria, untouched_areas, status,
           maturity, start_policy, delegation_policy, recommended_reasoning_level,
           prompt_seed, created_at, updated_at
           FROM subtasks WHERE id = 'st_b2b_guard_a'`,
        "DELETE FROM subtasks WHERE id = 'st_b2b_guard_a'",
        `INSERT OR REPLACE INTO subtasks
           SELECT id, 'bt_b2b_unowned', title, goal, scope_in, scope_out,
           acceptance_criteria, untouched_areas, status, maturity, start_policy,
           delegation_policy, recommended_reasoning_level, prompt_seed,
           created_at, updated_at FROM subtasks WHERE id = 'st_b2b_guard_a'`,
        `REPLACE INTO subtasks
           SELECT id, 'bt_b2b_unowned', title, goal, scope_in, scope_out,
           acceptance_criteria, untouched_areas, status, maturity, start_policy,
           delegation_policy, recommended_reasoning_level, prompt_seed,
           created_at, updated_at FROM subtasks WHERE id = 'st_b2b_guard_a'`,
        `INSERT INTO subtasks SELECT * FROM subtasks WHERE id = 'st_b2b_guard_a'
           ON CONFLICT(id) DO UPDATE SET title = excluded.title`,
        `INSERT INTO subtasks SELECT * FROM subtasks WHERE id = 'st_b2b_guard_a'
           ON CONFLICT(id) DO NOTHING`,
      ] as const;
      for (const statement of setMutations) {
        expect(() => sqlite.exec(statement)).toThrow();
      }

      expect(() => sqlite.exec(`INSERT INTO subtasks
        SELECT 'st_b2b_unowned_first', big_task_id, title, goal, scope_in, scope_out,
          acceptance_criteria, untouched_areas, status, maturity, start_policy,
          delegation_policy, recommended_reasoning_level, prompt_seed, created_at, updated_at
          FROM subtasks WHERE id = 'st_b2b_unowned_a'
        UNION ALL
        SELECT 'st_b2b_owned_second', big_task_id, title, goal, scope_in, scope_out,
          acceptance_criteria, untouched_areas, status, maturity, start_policy,
          delegation_policy, recommended_reasoning_level, prompt_seed, created_at, updated_at
          FROM subtasks WHERE id = 'st_b2b_guard_a'`)).toThrow();
      expect(sqlite.prepare("SELECT id FROM subtasks WHERE id = 'st_b2b_unowned_first'").get())
        .toBeUndefined();

      sqlite.prepare(
        "UPDATE subtasks SET status = 'IN_PROGRESS', maturity = 'IMPLEMENTED', updated_at = ? WHERE id = ?",
      ).run("2026-08-09T00:00:01.000Z", "st_b2b_guard_a");
      sqlite.close();
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID))
        .toEqual({
          ...expected,
          subtasks: expected.subtasks.map((item) =>
            item.subtaskId === "st_b2b_guard_a"
              ? {
                  ...item,
                  subtask: {
                    ...item.subtask,
                    status: "IN_PROGRESS",
                    maturity: "IMPLEMENTED",
                  },
                }
              : item),
        });
      storage.close();
    });
  });

  it("freezes nonzero dependency graphs across public and direct conflict forms", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const plan = makePlan();
      seedApprovedSource(storage, plan);
      const otherBigTaskId = BigTaskIdSchema.parse("bt_b2b_dependency_other");
      storage.createBigTask(makeBigTask(otherBigTaskId, PROJECT_ID));
      storage.createSubtask(makeSubtask("st_b2b_other_dep_a", otherBigTaskId));
      storage.createSubtask(makeSubtask("st_b2b_other_dep_b", otherBigTaskId));
      const expected = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);

      for (const replacement of [
        plan.dependencies,
        [...plan.dependencies].reverse(),
        [],
      ]) {
        expectStorageError(
          () => storage.replaceDependenciesForBigTask(BIG_TASK_ID, replacement),
          "CONFLICT",
        );
      }

      const sqlite = new DatabaseSync(databasePath);
      const operations = [
        "UPDATE task_dependencies SET reason = 'changed' WHERE upstream_subtask_id = 'st_b2b_z'",
        "UPDATE task_dependencies SET required_gate = 'ACCEPTED' WHERE downstream_subtask_id = 'st_b2b_a'",
        "UPDATE task_dependencies SET dependency_type = 'INFORMATIONAL', required_gate = 'NONE' WHERE downstream_subtask_id = 'st_b2b_a'",
        "UPDATE task_dependencies SET upstream_subtask_id = 'st_b2b_m' WHERE downstream_subtask_id = 'st_b2b_a'",
        "UPDATE task_dependencies SET downstream_subtask_id = 'st_b2b_other_dep_a' WHERE downstream_subtask_id = 'st_b2b_a'",
        "DELETE FROM task_dependencies WHERE upstream_subtask_id = 'st_b2b_z' AND downstream_subtask_id = 'st_b2b_a'",
        "INSERT OR REPLACE INTO task_dependencies SELECT * FROM task_dependencies WHERE upstream_subtask_id = 'st_b2b_z' AND downstream_subtask_id = 'st_b2b_a'",
        "REPLACE INTO task_dependencies SELECT * FROM task_dependencies WHERE upstream_subtask_id = 'st_b2b_z' AND downstream_subtask_id = 'st_b2b_a'",
        `INSERT INTO task_dependencies SELECT * FROM task_dependencies
           WHERE upstream_subtask_id = 'st_b2b_z' AND downstream_subtask_id = 'st_b2b_a'
           ON CONFLICT(upstream_subtask_id, downstream_subtask_id)
           DO UPDATE SET reason = excluded.reason`,
        `INSERT INTO task_dependencies SELECT * FROM task_dependencies
           WHERE upstream_subtask_id = 'st_b2b_z' AND downstream_subtask_id = 'st_b2b_a'
           ON CONFLICT(upstream_subtask_id, downstream_subtask_id) DO NOTHING`,
        `INSERT INTO task_dependencies VALUES
          ('st_b2b_a', 'st_b2b_m', 'INFORMATIONAL', 'NONE', 'extra', '${MATERIALIZED_AT}')`,
        `INSERT INTO task_dependencies VALUES
          ('st_b2b_z', 'st_b2b_other_dep_a', 'INFORMATIONAL', 'NONE', 'cross', '${MATERIALIZED_AT}')`,
      ] as const;
      for (const statement of operations) {
        expect(() => sqlite.exec(statement)).toThrow();
      }

      expect(() => sqlite.exec(`INSERT INTO task_dependencies VALUES
        ('st_b2b_other_dep_a', 'st_b2b_other_dep_b', 'BLOCKING', 'HARDENED', 'ordinary', '${MATERIALIZED_AT}'),
        ('st_b2b_a', 'st_b2b_m', 'INFORMATIONAL', 'NONE', 'owned', '${MATERIALIZED_AT}')`))
        .toThrow();
      expect(sqlite.prepare(
        "SELECT * FROM task_dependencies WHERE upstream_subtask_id = 'st_b2b_other_dep_a'",
      ).get()).toBeUndefined();
      sqlite.close();

      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toEqual(expected);
      expect(storage.listDependenciesForBigTask(otherBigTaskId)).toEqual([]);
      storage.close();
    });
  });

  it("distinguishes an owned zero-edge graph from ordinary empty dependency state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const plan = makePlan(["st_b2b_zero_a", "st_b2b_zero_b"], []);
      seedApprovedSource(storage, plan);
      const result = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      expect(result).toMatchObject({ dependencyCount: 0, dependencies: [] });
      expectStorageError(
        () => storage.replaceDependenciesForBigTask(BIG_TASK_ID, []),
        "CONFLICT",
      );

      const sqlite = new DatabaseSync(databasePath);
      expect(() => sqlite.exec(`INSERT INTO task_dependencies VALUES
        ('st_b2b_zero_a', 'st_b2b_zero_b', 'BLOCKING', 'HARDENED', 'forbidden', '${MATERIALIZED_AT}')`))
        .toThrow();
      sqlite.exec("DROP TRIGGER canonical_materialized_dependency_insert_guard");
      sqlite.exec(`INSERT INTO task_dependencies VALUES
        ('st_b2b_zero_a', 'st_b2b_zero_b', 'BLOCKING', 'HARDENED', 'corrupt', '${MATERIALIZED_AT}')`);
      sqlite.close();
      expectStorageError(
        () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("keeps guards conditional for unrelated manually managed Big Tasks", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage, makePlan(["st_b2b_owned_only"], []));
      storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const otherBigTaskId = BigTaskIdSchema.parse("bt_b2b_manual_graph");
      storage.createBigTask(makeBigTask(otherBigTaskId, PROJECT_ID));
      storage.createSubtask(makeSubtask("st_b2b_manual_a", otherBigTaskId));
      storage.createSubtask(makeSubtask("st_b2b_manual_b", otherBigTaskId));
      const edge = dependency("st_b2b_manual_a", "st_b2b_manual_b", 0);
      expect(storage.replaceDependenciesForBigTask(otherBigTaskId, [edge])).toEqual([edge]);
      expect(storage.replaceDependenciesForBigTask(otherBigTaskId, [])).toEqual([]);
      expect(storage.createSubtask(makeSubtask("st_b2b_manual_c", otherBigTaskId)).id)
        .toBe("st_b2b_manual_c");
      storage.close();
    });
  });
});

describe("Step 8B2b no-adoption and atomicity hardening", () => {
  it("rejects every tested first-materialization collision without adopting or partially writing", () => {
    const cases = [
      "target under same Big Task",
      "target under another Big Task",
      "extra row under target Big Task",
      "all exact-looking rows",
      "partial exact-looking rows",
      "manual rows plus dependency state",
    ] as const;

    for (const scenario of cases) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        const plan = makePlan();
        const contracts = seedApprovedSource(storage, plan);
        const exactSubtask = (contract: TaskContractV0) => ({
          recordType: "SUBTASK" as const,
          id: contract.subtaskId,
          bigTaskId: contract.bigTaskId,
          title: contract.title,
          goal: contract.goal,
          scopeIn: [...contract.scopeIn],
          scopeOut: [...contract.scopeOut],
          acceptanceCriteria: [...contract.acceptanceCriteria],
          untouchedAreas: [...contract.untouchedAreas],
          status: "TODO" as const,
          maturity: "NOT_STARTED" as const,
          startPolicy: contract.startPolicy,
          delegationPolicy: contract.delegationPolicy,
          recommendedReasoningLevel: contract.recommendedReasoningLevel,
          promptSeed: contract.promptSeed,
        });

        if (scenario === "target under another Big Task") {
          const other = BigTaskIdSchema.parse("bt_b2b_collision_other");
          storage.createBigTask(makeBigTask(other, PROJECT_ID));
          storage.createSubtask(makeSubtask(plan.subtasks[0]!.id, other));
        } else if (scenario === "extra row under target Big Task") {
          storage.createSubtask(makeSubtask("st_b2b_collision_extra", BIG_TASK_ID));
        } else if (scenario === "all exact-looking rows") {
          for (const contract of contracts) {
            storage.createSubtask(exactSubtask(contract));
          }
        } else if (scenario === "partial exact-looking rows") {
          storage.createSubtask(exactSubtask(contracts[0]!));
        } else if (scenario === "manual rows plus dependency state") {
          for (const contract of contracts) {
            storage.createSubtask(exactSubtask(contract));
          }
          storage.replaceDependenciesForBigTask(BIG_TASK_ID, plan.dependencies);
        } else {
          storage.createSubtask(makeSubtask(plan.subtasks[0]!.id, BIG_TASK_ID));
        }

        const before = rawCounts(databasePath);
        const targetBefore = storage.listSubtasksByBigTask(BIG_TASK_ID);
        const dependenciesBefore = storage.listDependenciesForBigTask(BIG_TASK_ID);
        expectStorageError(
          () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "CONFLICT",
        );
        expect(rawCounts(databasePath)).toEqual(before);
        expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
        expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual(targetBefore);
        expect(storage.listDependenciesForBigTask(BIG_TASK_ID))
          .toEqual(dependenciesBefore);
        storage.close();
      });
    }
  });

  it("rolls back every meaningful injected first-materialization write boundary", () => {
    const ids = [
      "st_b2b_atomic_a",
      "st_b2b_atomic_b",
      "st_b2b_atomic_c",
      "st_b2b_atomic_d",
    ];
    const edges = [
      dependency(ids[0]!, ids[1]!, 0),
      dependency(ids[0]!, ids[2]!, 1),
      dependency(ids[1]!, ids[3]!, 2),
    ];
    const injections = [
      `CREATE TRIGGER test_b2b_fail_mid_subtasks BEFORE INSERT ON subtasks
       WHEN NEW.id = 'st_b2b_atomic_b'
       BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
      `CREATE TRIGGER test_b2b_fail_first_dependency BEFORE INSERT ON task_dependencies
       BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
      `CREATE TRIGGER test_b2b_fail_mid_dependencies BEFORE INSERT ON task_dependencies
       WHEN NEW.downstream_subtask_id = 'st_b2b_atomic_c'
       BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
      `CREATE TRIGGER test_b2b_fail_evidence BEFORE INSERT ON canonical_task_materializations
       BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
      `CREATE TRIGGER test_b2b_corrupt_after_evidence
       AFTER INSERT ON canonical_task_materializations
       BEGIN
         UPDATE orchestration_materializations SET candidate_binding = 'fixture-corrupt'
         WHERE big_task_id = NEW.big_task_id;
       END`,
    ] as const;

    for (const injection of injections) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage, makePlan(ids, edges));
        const unrelated = BigTaskIdSchema.parse("bt_b2b_atomic_unrelated");
        storage.createBigTask(makeBigTask(unrelated, PROJECT_ID));
        storage.createSubtask(makeSubtask("st_b2b_atomic_unrelated", unrelated));
        const before = rawCounts(databasePath);
        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec(injection);
        sqlite.close();

        const error = captureTaskStorageError(
          () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        );
        expect(["TRANSACTION_FAILED", "MALFORMED_STORED_DATA"])
          .toContain(error.code);
        expect(error.message).not.toMatch(/fixture|SQLite|SQL|trigger|\/Users\//i);
        expect(rawCounts(databasePath)).toEqual(before);
        expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
        expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual([]);
        expect(storage.getSubtaskById(
          SubtaskIdSchema.parse("st_b2b_atomic_unrelated"),
        )).not.toBeNull();
        expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.materializedGraph)
          .not.toBeNull();
        storage.close();
      });
    }
  });

  it("releases a failed inner savepoint for a second legal attempt in the same outer transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = new Date(Number.NaN);
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      currentTime = new Date(MATERIALIZED_AT);
      seedApprovedSource(storage, makePlan(["st_b2b_savepoint"], []));

      storage.runInTransaction((outer) => {
        currentTime = new Date(Number.NaN);
        expectStorageError(
          () => outer.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "STORAGE_OPERATION_FAILED",
        );
        currentTime = new Date(MATERIALIZED_AT);
        expect(outer.materializeApprovedCanonicalTasks(BIG_TASK_ID).subtaskCount)
          .toBe(1);
      });
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)?.subtaskCount)
        .toBe(1);
      storage.close();
    });
  });

  it("detects missing owned rows and dependency provenance corruption without reconstruction", () => {
    const corruptions = [
      `DROP TRIGGER canonical_materialized_dependency_delete_guard;
       DROP TRIGGER canonical_materialized_subtask_delete_guard;
       DELETE FROM task_dependencies WHERE downstream_subtask_id = 'st_b2b_a';
       DELETE FROM subtasks WHERE id = 'st_b2b_a'`,
      `DROP TRIGGER canonical_materialized_dependency_delete_guard;
       DROP TRIGGER canonical_materialized_subtask_delete_guard;
       DELETE FROM task_dependencies;
       DELETE FROM subtasks WHERE big_task_id = 'bt_b2b_hardening'`,
      `DROP TRIGGER canonical_materialized_dependency_delete_guard;
       DELETE FROM task_dependencies WHERE downstream_subtask_id = 'st_b2b_a'`,
      `DROP TRIGGER canonical_materialized_dependency_delete_guard;
       DELETE FROM task_dependencies`,
      `DROP TRIGGER canonical_materialized_dependency_update_guard;
       UPDATE task_dependencies SET created_at = '2026-08-09T00:00:00.001Z'
       WHERE downstream_subtask_id = 'st_b2b_a'`,
    ] as const;
    for (const mutation of corruptions) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage);
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        corrupt(databasePath, mutation);
        expectStorageError(
          () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        expectStorageError(
          () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });
});

const waitForFiles = async (paths: readonly string[]): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 5);
    });
  }
  throw new Error("Cross-process materialization barrier was not reached.");
};

const runMaterializationWorker = (
  databasePath: string,
  readyPath: string,
  goPath: string,
  outcomePath: string,
): Promise<Readonly<{ readonly status: number | null; readonly output: string }>> =>
  new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
        "run",
        "packages/storage/test/canonical-task-materialization-process-worker.test.ts",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CTC_B2B_PROCESS_DATABASE_PATH: databasePath,
          CTC_B2B_PROCESS_READY_PATH: readyPath,
          CTC_B2B_PROCESS_GO_PATH: goPath,
          CTC_B2B_PROCESS_OUTCOME_PATH: outcomePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (status) => {
      resolvePromise(Object.freeze({ status, output }));
    });
  });

describe("Step 8B2b concurrency and deterministic replay hardening", () => {
  it("shows no dirty owned read during an outer transaction and exact state after commit/rollback", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(first);
      const second = openTaskDatabase({ databasePath, clock: fixedClock });
      let expected = first.runInTransaction((outer) => {
        const materialized = outer.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        expect(second.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
        return materialized;
      });
      expect(second.getCanonicalTaskMaterialization(BIG_TASK_ID)).toEqual(expected);
      first.close();
      second.close();

      const rollbackDatabasePath = join(
        databasePath,
        "..",
        "rollback-materialization.sqlite",
      );
      const rollbackWriter = openTaskDatabase({
        databasePath: rollbackDatabasePath,
        clock: fixedClock,
      });
      seedApprovedSource(rollbackWriter);
      const rollbackReader = openTaskDatabase({
        databasePath: rollbackDatabasePath,
        clock: fixedClock,
      });
      expectStorageError(
        () => rollbackWriter.runInTransaction((outer) => {
          expected = outer.materializeApprovedCanonicalTasks(BIG_TASK_ID);
          expect(rollbackReader.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
          throw new Error("fixture rollback");
        }),
        "TRANSACTION_FAILED",
      );
      expect(rollbackReader.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      expect(rollbackReader.listSubtasksByBigTask(BIG_TASK_ID)).toEqual([]);
      rollbackWriter.close();
      rollbackReader.close();
    });
  });

  it("returns one exact owned result across 24 bounded alternating handle retries", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(first);
      const second = openTaskDatabase({
        databasePath,
        clock: () => new Date("2050-01-01T00:00:00.000Z"),
      });
      const expected = first.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const storage = attempt % 2 === 0 ? second : first;
        expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(expected);
      }
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare(
        "SELECT count(*) AS count FROM canonical_task_materializations",
      ).get()).toEqual({ count: 1 });
      sqlite.close();
      first.close();
      second.close();
    });
  });

  it("sanitizes write contention, leaves no partial authority, and recovers once", () => {
    withTemporaryDatabasePath((databasePath) => {
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(seed);
      seed.close();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      getTaskStorageWorktreeAccess(storage)!.sqlite.exec("PRAGMA busy_timeout = 0");
      const locker = new DatabaseSync(databasePath);
      locker.exec("BEGIN IMMEDIATE");
      const error = captureTaskStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
      );
      expect(error.code).toBe("TRANSACTION_FAILED");
      expect(error.message).not.toMatch(/SQLite|SQL|locked|busy|trigger|\/Users\//i);
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      locker.exec("ROLLBACK");
      locker.close();
      expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID).subtaskCount)
        .toBe(3);
      storage.close();
    });
  });

  it("returns the same owned result to two barrier-synchronized first materializers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctc-b2b-process-"));
    const databasePath = join(directory, "task-console.sqlite");
    const goPath = join(directory, "go.signal");
    const readyPaths = [join(directory, "first.ready"), join(directory, "second.ready")];
    const outcomePaths = [
      join(directory, "first.outcome"),
      join(directory, "second.outcome"),
    ];
    try {
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(seed);
      seed.close();
      const workers = readyPaths.map((readyPath, index) =>
        runMaterializationWorker(
          databasePath,
          readyPath,
          goPath,
          outcomePaths[index]!,
        ));
      await waitForFiles(readyPaths);
      writeFileSync(goPath, "go\n", { encoding: "utf-8" });
      const results = await Promise.all(workers);
      expect(
        results.map(({ status }) => status),
        results.map(({ output }) => output).join("\n"),
      ).toEqual([0, 0]);
      const outcomes = outcomePaths.map((path) =>
        JSON.parse(readFileSync(path, { encoding: "utf-8" })) as unknown);
      expect(outcomes[0]).toEqual(outcomes[1]);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(reopened.getCanonicalTaskMaterialization(BIG_TASK_ID))
        .toMatchObject(outcomes[0] as Record<string, unknown>);
      expect(rawCounts(databasePath)).toMatchObject({ evidence: 1, subtasks: 3 });
      reopened.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);
});

describe("Step 8B2b ordering, authority ownership, scale, and public boundary", () => {
  it("preserves nonlexical approved Subtask order and graph-owned profile/write authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      const ids = ["st_b2b_order_10", "st_b2b_order_2", "st_b2b_order_1"];
      const unsortedEdges = [
        dependency(ids[1]!, ids[2]!, 1),
        dependency(ids[0]!, ids[2]!, 0),
      ];
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const plan = makePlan(ids, unsortedEdges);
      seedApprovedSource(storage, plan);
      const result = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const graph = storage.getDurablePlanningSnapshot(BIG_TASK_ID)!.materializedGraph!;
      expect(result.subtasks.map(({ subtaskId }) => subtaskId)).toEqual(ids);
      expect(result.subtasks.map(({ profile, writeEnabled }) => ({ profile, writeEnabled })))
        .toEqual(graph.subtasks.map(({ profile, writeEnabled }) => ({ profile, writeEnabled })));
      expect(result.dependencies).toEqual(
        [...graph.dependencies].sort((left, right) =>
          compareCodeUnits(left.upstreamSubtaskId, right.upstreamSubtaskId) ||
          compareCodeUnits(left.downstreamSubtaskId, right.downstreamSubtaskId) ||
          compareCodeUnits(left.dependencyType, right.dependencyType)),
      );

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      const columns = (table: string): readonly string[] =>
        (sqlite.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly {
          readonly name: string;
        }[]).map(({ name }) => name);
      expect(columns("subtasks")).not.toEqual(expect.arrayContaining([
        "profile",
        "write_enabled",
      ]));
      expect(columns("canonical_task_materializations"))
        .not.toEqual(expect.arrayContaining(["profile", "write_enabled"]));
      sqlite.close();
      storage.close();
    });
  });

  it("materializes, retries, lifecycle-drifts, and reopens fresh 37- and 67-Subtask shapes", () => {
    for (const size of [37, 67]) {
      withTemporaryDatabasePath((databasePath) => {
        const ids = Array.from({ length: size }, (_, index) =>
          `st_b2b_scale_${String(size)}_${String(index).padStart(2, "0")}`);
        const edges = size === 37
          ? []
          : ids.slice(1).map((id, index) => dependency(ids[index]!, id, index));
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage, makePlan(ids, edges));
        const result = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        expect(result).toMatchObject({
          subtaskCount: size,
          dependencyCount: edges.length,
        });
        expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(result);
        const sqlite = new DatabaseSync(databasePath);
        sqlite.prepare(
          "UPDATE subtasks SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?",
        ).run("2026-08-09T00:00:01.000Z", ids[0]!);
        sqlite.close();
        expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)?.subtasks[0]?.subtask.status)
          .toBe("IN_PROGRESS");
        storage.close();
        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toMatchObject({
          subtaskCount: size,
          dependencyCount: edges.length,
        });
        storage.close();
      });
    }
  });

  it("keeps the public materialization claim narrow and exposes no authority-writer shortcuts", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(storage));
      expect(methods).toEqual(expect.arrayContaining([
        "materializeApprovedCanonicalTasks",
        "getCanonicalTaskMaterialization",
      ]));
      expect(methods).not.toEqual(expect.arrayContaining([
        "setCanonicalMaterialization",
        "markMaterialized",
        "adoptExistingTasks",
        "rewriteMaterializedTask",
        "replaceOwnedDependencyGraph",
      ]));
      seedApprovedSource(storage, makePlan(["st_b2b_public"], []));
      const result = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      expect(Object.keys(result).sort(compareCodeUnits)).toEqual([
        "bigTaskId",
        "candidateBinding",
        "dependencies",
        "dependencyCount",
        "materializedAt",
        "planRevision",
        "projectId",
        "subtaskCount",
        "subtasks",
      ].sort(compareCodeUnits));
      expect(JSON.stringify(result)).not.toMatch(
        /dispatch|ready|worktree|budget|concurrency|executionStarted/i,
      );
      storage.close();
    });
  });
});
