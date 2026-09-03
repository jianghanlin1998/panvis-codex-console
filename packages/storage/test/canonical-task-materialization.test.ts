import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type { SubtaskDependency, TaskContractV0 } from "@codex-task-console/domain";
import type { PlanCandidate, PlanReviewState } from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage, TaskStorageError } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_canonical_materialization");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_canonical_materialization");

const makePlan = (
  count = 3,
  dependencies: readonly SubtaskDependency[] | null = null,
): PlanCandidate => {
  const subtasks = Array.from({ length: count }, (_, index) => ({
    id: SubtaskIdSchema.parse(`st_canonical_${index}`),
    bigTaskId: BIG_TASK_ID,
    profile: index % 2 === 0 ? "STANDARD" as const : "HIGH_RISK_FOUNDATION" as const,
    taskContractRef: `contract/canonical-${index}`,
    writeEnabled: index % 2 === 0,
  }));
  return {
    kind: "PLAN_CANDIDATE",
    projectId: PROJECT_ID,
    bigTaskId: BIG_TASK_ID,
    revision: 1,
    subtasks,
    dependencies: dependencies ?? (count < 3 ? [] : [
      SubtaskDependencySchema.parse({
        upstreamSubtaskId: subtasks[0]!.id,
        downstreamSubtaskId: subtasks[1]!.id,
        dependencyType: "BLOCKING",
        requiredGate: "ACCEPTED",
        reason: "The reviewed implementation must be accepted first.",
      }),
      SubtaskDependencySchema.parse({
        upstreamSubtaskId: subtasks[0]!.id,
        downstreamSubtaskId: subtasks[2]!.id,
        dependencyType: "INFORMATIONAL",
        requiredGate: "NONE",
        reason: "Share the reviewed implementation context.",
      }),
    ]),
  };
};

const contractsFor = (plan: PlanCandidate): readonly TaskContractV0[] =>
  plan.subtasks.map((subtask, index) => TaskContractV0Schema.parse({
    taskContractRef: subtask.taskContractRef,
    projectId: plan.projectId,
    bigTaskId: plan.bigTaskId,
    subtaskId: subtask.id,
    title: `Canonical title ${index}`,
    goal: `Canonical goal ${index}`,
    scopeIn: [`Scope in ${index}`],
    scopeOut: [`Scope out ${index}`],
    acceptanceCriteria: [`Acceptance ${index}`],
    untouchedAreas: [`Untouched ${index}`],
    promptSeed: `Prompt seed ${index}`,
    startPolicy: index % 2 === 0 ? "MANUAL" : "WHEN_READY",
    delegationPolicy: index % 2 === 0 ? "NONE" : "REVIEW_ONLY",
    recommendedReasoningLevel: index % 2 === 0 ? "HIGH" : "XHIGH",
  }));

const approve = (state: PlanReviewState) => ({
  outcome: "APPROVE" as const,
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const seedApprovedSource = (
  storage: TaskStorage,
  plan = makePlan(),
): readonly TaskContractV0[] => {
  storage.createProject(makeProject(PROJECT_ID, "canonical-materialization"));
  storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
  const contracts = contractsFor(plan);
  const bundle = storage.beginDurablePlanningBundle(plan, contracts);
  storage.recordDurableReviewerDecision(BIG_TASK_ID, approve(bundle.reviewState));
  storage.materializeDurablePlan(BIG_TASK_ID);
  return contracts;
};

const expectStorageError = (
  operation: () => unknown,
  code: TaskStorageError["code"],
): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe(code);
  expect(error.message).not.toMatch(/SQLite|SQL|constraint|trigger|\/Users\//i);
  return error;
};

describe("atomic canonical task materialization", () => {
  it("projects exact Task Contracts, preserves graph metadata and dependencies, and retries without writes", () => {
    withMemoryStorage((storage) => {
      const plan = makePlan();
      const contracts = seedApprovedSource(storage, plan);
      const first = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const retry = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);

      expect(first).toEqual(retry);
      expect(first).toMatchObject({
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        planRevision: 1,
        candidateBinding: storage.getDurablePlanningSnapshot(BIG_TASK_ID)!
          .materializedGraph!.candidateBinding,
        subtaskCount: 3,
        dependencyCount: 2,
        materializedAt: "2026-08-09T00:00:00.000Z",
        dependencies: plan.dependencies,
      });
      expect(first.subtasks.map(({ subtaskId, taskContractRef, profile, writeEnabled }) => ({
        subtaskId, taskContractRef, profile, writeEnabled,
      }))).toEqual(plan.subtasks.map(({ id, taskContractRef, profile, writeEnabled }) => ({
        subtaskId: id, taskContractRef, profile, writeEnabled,
      })));
      expect(first.subtasks.map(({ subtask }) => subtask)).toEqual(
        contracts.map((contract) => ({
          recordType: "SUBTASK",
          id: contract.subtaskId,
          bigTaskId: contract.bigTaskId,
          title: contract.title,
          goal: contract.goal,
          scopeIn: contract.scopeIn,
          scopeOut: contract.scopeOut,
          acceptanceCriteria: contract.acceptanceCriteria,
          untouchedAreas: contract.untouchedAreas,
          status: "TODO",
          maturity: "NOT_STARTED",
          startPolicy: contract.startPolicy,
          delegationPolicy: contract.delegationPolicy,
          recommendedReasoningLevel: contract.recommendedReasoningLevel,
          promptSeed: contract.promptSeed,
        })),
      );
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.subtasks)).toBe(true);
      expect(Object.isFrozen(first.subtasks[0]!.subtask.scopeIn)).toBe(true);
      expect(Object.isFrozen(first.dependencies)).toBe(true);
    });
  });

  it("accepts a single Subtask and a zero-edge approved graph", () => {
    withMemoryStorage((storage) => {
      seedApprovedSource(storage, makePlan(1));
      expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toMatchObject({
        subtaskCount: 1,
        dependencyCount: 0,
        dependencies: [],
      });
    });
  });

  it("requires materialized approved Task Contract authority", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject(PROJECT_ID, "canonical-materialization"));
      storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "PARENT_NOT_FOUND",
      );
      const plan = makePlan();
      storage.beginDurablePlanningBundle(plan, contractsFor(plan));
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "CONFLICT",
      );
    });
  });

  it("never adopts target, extra, or matching unowned canonical rows", () => {
    for (const kind of ["target", "extra", "matching"] as const) {
      withMemoryStorage((storage) => {
        const plan = makePlan(1);
        const [contract] = seedApprovedSource(storage, plan);
        if (kind === "extra") {
          storage.createSubtask(makeSubtask("st_unowned_extra", BIG_TASK_ID));
        } else if (kind === "matching") {
          storage.createSubtask({
            recordType: "SUBTASK",
            id: contract!.subtaskId,
            bigTaskId: contract!.bigTaskId,
            title: contract!.title,
            goal: contract!.goal,
            scopeIn: [...contract!.scopeIn],
            scopeOut: [...contract!.scopeOut],
            acceptanceCriteria: [...contract!.acceptanceCriteria],
            untouchedAreas: [...contract!.untouchedAreas],
            status: "TODO",
            maturity: "NOT_STARTED",
            startPolicy: contract!.startPolicy,
            delegationPolicy: contract!.delegationPolicy,
            recommendedReasoningLevel: contract!.recommendedReasoningLevel,
            promptSeed: contract!.promptSeed,
          });
        } else {
          storage.createSubtask(makeSubtask(plan.subtasks[0]!.id, BIG_TASK_ID));
        }
        expectStorageError(
          () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "CONFLICT",
        );
        expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      });
    }
  });

  it("permits legal lifecycle drift while retaining exact historical retry", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage);
      const original = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(
        "UPDATE subtasks SET status = 'IN_PROGRESS', maturity = 'IMPLEMENTED', updated_at = ? WHERE id = ?",
      ).run("2026-08-09T00:00:01.000Z", original.subtasks[0]!.subtaskId);
      sqlite.prepare("UPDATE big_tasks SET status = 'DONE', updated_at = ? WHERE id = ?")
        .run("2026-08-09T00:00:02.000Z", BIG_TASK_ID);
      sqlite.close();

      const read = storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!;
      expect(read.subtasks[0]!.subtask).toMatchObject({
        status: "IN_PROGRESS",
        maturity: "IMPLEMENTED",
      });
      expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(read);
      expect(read.materializedAt).toBe(original.materializedAt);
      storage.close();
    });
  });

  it("blocks a first materialization beneath an ineligible completed parent", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage, makePlan(1));
      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare("UPDATE big_tasks SET status = 'DONE' WHERE id = ?").run(BIG_TASK_ID);
      sqlite.close();
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "PARENT_NOT_FOUND",
      );
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual([]);
      storage.close();
    });
  });

  it("fails atomically for invalid or regressing materialization clocks", () => {
    for (const nextClock of [
      () => new Date("2026-08-08T23:59:59.999Z"),
      () => new Date(Number.NaN),
    ]) {
      withTemporaryDatabasePath((databasePath) => {
        let currentClock = fixedClock;
        const storage = openTaskDatabase({ databasePath, clock: () => currentClock() });
        seedApprovedSource(storage);
        currentClock = nextClock;
        expectStorageError(
          () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "STORAGE_OPERATION_FAILED",
        );
        expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual([]);
        expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
        storage.close();
      });
    }
  });

  it("isolates a caught nested failure and rolls back successful inner work with its outer transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage);
      const blocker = new DatabaseSync(databasePath);
      blocker.exec(`CREATE TRIGGER test_dependency_failure BEFORE INSERT ON task_dependencies
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      blocker.close();

      storage.runInTransaction((transaction) => {
        expectStorageError(
          () => transaction.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "TRANSACTION_FAILED",
        );
        transaction.createBigTask(makeBigTask("bt_unrelated_after_failure", PROJECT_ID));
      });
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual([]);
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      expect(storage.getBigTaskById(BigTaskIdSchema.parse("bt_unrelated_after_failure")))
        .not.toBeNull();

      const cleanup = new DatabaseSync(databasePath);
      cleanup.exec("DROP TRIGGER test_dependency_failure");
      cleanup.close();
      expect(() => storage.runInTransaction((transaction) => {
        transaction.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        throw new Error("roll back outer fixture");
      })).toThrow();
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual([]);
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      storage.close();
    });
  });

  it("reopens exact and returns one owned result across multiple handles", () => {
    withTemporaryDatabasePath((databasePath) => {
      let first = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(first);
      const expected = first.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const second = openTaskDatabase({ databasePath, clock: () => new Date("2030-01-01T00:00:00Z") });
      expect(second.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(expected);
      const evidenceCount = new DatabaseSync(databasePath)
        .prepare("SELECT count(*) AS count FROM canonical_task_materializations")
        .get() as { readonly count: number };
      expect(evidenceCount.count).toBe(1);
      second.close();
      first.close();
      first = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(first.getCanonicalTaskMaterialization(BIG_TASK_ID)).toEqual(expected);
      first.close();
    });
  });

  it("materializes and verifies a bounded 64-Subtask graph", () => {
    withMemoryStorage((storage) => {
      seedApprovedSource(storage, makePlan(64, []));
      const result = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      expect(result.subtaskCount).toBe(64);
      expect(result.subtasks).toHaveLength(64);
      expect(storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(result);
    });
  });
});

describe("canonical materialization immutability and corruption replay", () => {
  it("blocks public graph mutation for owned Big Tasks and preserves ordinary APIs elsewhere", () => {
    withMemoryStorage((storage) => {
      seedApprovedSource(storage);
      const result = storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      expectStorageError(
        () => storage.createSubtask(makeSubtask("st_forbidden_extra", BIG_TASK_ID)),
        "CONFLICT",
      );
      expectStorageError(
        () => storage.replaceDependenciesForBigTask(BIG_TASK_ID, []),
        "CONFLICT",
      );

      const other = BigTaskIdSchema.parse("bt_ordinary_graph");
      storage.createBigTask(makeBigTask(other, PROJECT_ID));
      storage.createSubtask(makeSubtask("st_ordinary_a", other));
      storage.createSubtask(makeSubtask("st_ordinary_b", other));
      const dependency = SubtaskDependencySchema.parse({
        upstreamSubtaskId: "st_ordinary_a",
        downstreamSubtaskId: "st_ordinary_b",
        dependencyType: "BLOCKING",
        requiredGate: "HARDENED",
        reason: "Ordinary behavior remains available.",
      });
      expect(storage.replaceDependenciesForBigTask(other, [dependency])).toEqual([dependency]);
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toHaveLength(result.subtaskCount);
    });
  });

  it("guards evidence, stable intent, Subtask set, and dependency graph against SQLite conflict forms", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage);
      storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      expect((sqlite.prepare("PRAGMA recursive_triggers").get() as { recursive_triggers: number }).recursive_triggers).toBe(0);

      const forbidden = [
        () => sqlite.prepare("INSERT INTO canonical_task_materializations SELECT * FROM canonical_task_materializations WHERE big_task_id = ?").run(BIG_TASK_ID),
        () => sqlite.prepare("UPDATE canonical_task_materializations SET dependency_count = 9 WHERE big_task_id = ?").run(BIG_TASK_ID),
        () => sqlite.prepare("DELETE FROM canonical_task_materializations WHERE big_task_id = ?").run(BIG_TASK_ID),
        () => sqlite.prepare("INSERT OR REPLACE INTO canonical_task_materializations SELECT * FROM canonical_task_materializations WHERE big_task_id = ?").run(BIG_TASK_ID),
        () => sqlite.prepare(`INSERT INTO canonical_task_materializations SELECT * FROM canonical_task_materializations WHERE big_task_id = ?
          ON CONFLICT(big_task_id) DO UPDATE SET dependency_count = excluded.dependency_count`).run(BIG_TASK_ID),
        () => sqlite.prepare("UPDATE subtasks SET title = 'drift' WHERE id = 'st_canonical_0'").run(),
        () => sqlite.prepare("DELETE FROM subtasks WHERE id = 'st_canonical_0'").run(),
        () => sqlite.prepare("INSERT OR REPLACE INTO subtasks SELECT * FROM subtasks WHERE id = 'st_canonical_0'").run(),
        () => sqlite.prepare(`INSERT INTO subtasks SELECT * FROM subtasks WHERE id = 'st_canonical_0'
          ON CONFLICT(id) DO UPDATE SET title = 'drift'`).run(),
        () => sqlite.prepare(`INSERT INTO subtasks
          SELECT 'st_forbidden_extra', big_task_id, title, goal, scope_in, scope_out,
                 acceptance_criteria, untouched_areas, status, maturity, start_policy,
                 delegation_policy, recommended_reasoning_level, prompt_seed, created_at, updated_at
          FROM subtasks WHERE id = 'st_canonical_0'`).run(),
        () => sqlite.prepare("UPDATE task_dependencies SET reason = 'drift' WHERE upstream_subtask_id = 'st_canonical_0' AND downstream_subtask_id = 'st_canonical_1'").run(),
        () => sqlite.prepare("DELETE FROM task_dependencies WHERE upstream_subtask_id = 'st_canonical_0' AND downstream_subtask_id = 'st_canonical_1'").run(),
        () => sqlite.prepare("INSERT OR REPLACE INTO task_dependencies SELECT * FROM task_dependencies WHERE upstream_subtask_id = 'st_canonical_0' AND downstream_subtask_id = 'st_canonical_1'").run(),
        () => sqlite.prepare(`INSERT INTO task_dependencies SELECT * FROM task_dependencies
          WHERE upstream_subtask_id = 'st_canonical_0' AND downstream_subtask_id = 'st_canonical_1'
          ON CONFLICT(upstream_subtask_id, downstream_subtask_id) DO UPDATE SET reason = 'drift'`).run(),
        () => sqlite.prepare(`INSERT INTO task_dependencies
          SELECT 'st_canonical_1', 'st_canonical_2', 'INFORMATIONAL', 'NONE', reason, created_at
          FROM task_dependencies LIMIT 1`).run(),
      ];
      for (const operation of forbidden) {
        expect(operation).toThrow();
      }
      sqlite.prepare("UPDATE subtasks SET status = 'IN_PROGRESS', maturity = 'IMPLEMENTED', updated_at = ? WHERE id = 'st_canonical_0'")
        .run("2026-08-09T00:00:01.000Z");
      sqlite.close();
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!.subtasks[0]!.subtask)
        .toMatchObject({ status: "IN_PROGRESS", maturity: "IMPLEMENTED" });
      storage.close();
    });
  });

  it("fails closed for representative stable Subtask, dependency, evidence, and source drift", () => {
    const corruptions = [
      {
        drop: "DROP TRIGGER canonical_materialized_subtask_stable_update_guard",
        mutate: "UPDATE subtasks SET prompt_seed = 'corrupt' WHERE id = 'st_canonical_0'",
      },
      {
        drop: `DROP TRIGGER canonical_materialized_dependency_delete_guard;
          DROP TRIGGER canonical_materialized_subtask_delete_guard`,
        mutate: `DELETE FROM task_dependencies WHERE upstream_subtask_id = 'st_canonical_0' OR downstream_subtask_id = 'st_canonical_2';
          DELETE FROM subtasks WHERE id = 'st_canonical_2'`,
      },
      {
        drop: "DROP TRIGGER canonical_materialized_dependency_update_guard",
        mutate: "UPDATE task_dependencies SET required_gate = 'HARDENED' WHERE upstream_subtask_id = 'st_canonical_0' AND downstream_subtask_id = 'st_canonical_1'",
      },
      {
        drop: "DROP TRIGGER canonical_materialized_dependency_delete_guard",
        mutate: "DELETE FROM task_dependencies WHERE upstream_subtask_id = 'st_canonical_0' AND downstream_subtask_id = 'st_canonical_1'",
      },
      {
        drop: "DROP TRIGGER canonical_task_materializations_immutable_update",
        mutate: "UPDATE canonical_task_materializations SET dependency_count = 0 WHERE big_task_id = 'bt_canonical_materialization'",
      },
    ];
    for (const corruption of corruptions) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage);
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec(corruption.drop);
        sqlite.exec(corruption.mutate);
        sqlite.close();
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

  it("detects drift across every stable canonical Subtask field", () => {
    const mutations = [
      "UPDATE subtasks SET id = 'st_canonical_changed' WHERE id = 'st_canonical_0'",
      "UPDATE subtasks SET big_task_id = 'bt_changed_owner' WHERE id = 'st_canonical_0'",
      "UPDATE subtasks SET title = 'changed' WHERE id = 'st_canonical_0'",
      "UPDATE subtasks SET goal = 'changed' WHERE id = 'st_canonical_0'",
      `UPDATE subtasks SET scope_in = '["changed"]' WHERE id = 'st_canonical_0'`,
      `UPDATE subtasks SET scope_out = '["changed"]' WHERE id = 'st_canonical_0'`,
      `UPDATE subtasks SET acceptance_criteria = '["changed"]' WHERE id = 'st_canonical_0'`,
      `UPDATE subtasks SET untouched_areas = '["changed"]' WHERE id = 'st_canonical_0'`,
      "UPDATE subtasks SET start_policy = 'WHEN_READY' WHERE id = 'st_canonical_0'",
      "UPDATE subtasks SET delegation_policy = 'REVIEW_ONLY' WHERE id = 'st_canonical_0'",
      "UPDATE subtasks SET recommended_reasoning_level = 'LOW' WHERE id = 'st_canonical_0'",
      "UPDATE subtasks SET prompt_seed = 'changed' WHERE id = 'st_canonical_0'",
      "UPDATE subtasks SET created_at = '2026-08-09T00:00:01.000Z' WHERE id = 'st_canonical_0'",
    ];
    for (const mutation of mutations) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage);
        storage.createBigTask(makeBigTask("bt_changed_owner", PROJECT_ID));
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("DROP TRIGGER canonical_materialized_subtask_stable_update_guard");
        sqlite.exec("DROP TRIGGER canonical_materialized_dependency_update_guard");
        sqlite.exec(mutation);
        sqlite.close();
        expectStorageError(
          () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("detects deleted, extra, changed, swapped, and cross-Big-Task dependency drift", () => {
    const mutations = [
      "DELETE FROM task_dependencies WHERE upstream_subtask_id = 'st_canonical_0' AND downstream_subtask_id = 'st_canonical_1'",
      `INSERT INTO task_dependencies VALUES ('st_canonical_1', 'st_canonical_2', 'INFORMATIONAL', 'NONE', 'extra', '2026-08-09T00:00:00.000Z')`,
      "UPDATE task_dependencies SET reason = 'changed' WHERE downstream_subtask_id = 'st_canonical_1'",
      "UPDATE task_dependencies SET required_gate = 'HARDENED' WHERE downstream_subtask_id = 'st_canonical_1'",
      "UPDATE task_dependencies SET dependency_type = 'INFORMATIONAL', required_gate = 'NONE' WHERE downstream_subtask_id = 'st_canonical_1'",
      "UPDATE task_dependencies SET upstream_subtask_id = 'st_canonical_2' WHERE downstream_subtask_id = 'st_canonical_1'",
      "UPDATE task_dependencies SET downstream_subtask_id = 'st_other_graph' WHERE downstream_subtask_id = 'st_canonical_1'",
    ];
    for (const mutation of mutations) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedApprovedSource(storage);
        const other = BigTaskIdSchema.parse("bt_other_graph");
        storage.createBigTask(makeBigTask(other, PROJECT_ID));
        storage.createSubtask(makeSubtask("st_other_graph", other));
        storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("DROP TRIGGER canonical_materialized_dependency_insert_guard");
        sqlite.exec("DROP TRIGGER canonical_materialized_dependency_update_guard");
        sqlite.exec("DROP TRIGGER canonical_materialized_dependency_delete_guard");
        sqlite.exec(mutation);
        sqlite.close();
        expectStorageError(
          () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("fails closed when the immutable Step 8B1 source binding drifts", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage);
      storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare("UPDATE orchestration_materializations SET candidate_binding = 'corrupt' WHERE big_task_id = ?")
        .run(BIG_TASK_ID);
      sqlite.close();
      expectStorageError(
        () => storage.getCanonicalTaskMaterialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("does not fabricate ownership when completion evidence is missing", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedApprovedSource(storage, makePlan(1));
      storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("DROP TRIGGER canonical_task_materializations_immutable_delete");
      sqlite.prepare("DELETE FROM canonical_task_materializations WHERE big_task_id = ?").run(BIG_TASK_ID);
      sqlite.close();
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toBeNull();
      expectStorageError(
        () => storage.materializeApprovedCanonicalTasks(BIG_TASK_ID),
        "CONFLICT",
      );
      storage.close();
    });
  });
});
