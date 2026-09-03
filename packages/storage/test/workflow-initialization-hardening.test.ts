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
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type { TaskContractV0 } from "@codex-task-console/domain";
import type {
  PlanCandidate,
  PlanReviewState,
  WorkflowProfile,
} from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage, TaskStorageError } from "../src/index.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
import {
  captureTaskStorageError,
  makeBigTask,
  makeImplementationCheckpoint,
  makeProject,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_b3a_hardening");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_b3a_hardening");
const SOURCE_AT = "2026-09-03T10:00:00.000Z";
const INITIALIZED_AT = "2026-09-03T10:00:01.000Z";

const makePlan = (
  options: Readonly<{
    projectId?: string;
    bigTaskId?: string;
    profiles?: readonly WorkflowProfile[];
    prefix?: string;
  }> = {},
): PlanCandidate => {
  const projectId = ProjectIdSchema.parse(options.projectId ?? PROJECT_ID);
  const bigTaskId = BigTaskIdSchema.parse(options.bigTaskId ?? BIG_TASK_ID);
  const profiles = options.profiles ?? [
    "LOW",
    "STANDARD",
    "HIGH_RISK_FOUNDATION",
    "LOW",
  ];
  const prefix = options.prefix ?? "st_b3a_nonlexical";
  const order = profiles.map((_, index) =>
    ["10", "2", "1", "20"][index] ?? String(index).padStart(3, "0"));
  return {
    kind: "PLAN_CANDIDATE",
    projectId,
    bigTaskId,
    revision: 1,
    subtasks: profiles.map((profile, index) => ({
      id: SubtaskIdSchema.parse(`${prefix}_${order[index]}`),
      bigTaskId,
      profile,
      taskContractRef: `contract/${prefix}-${index}`,
      writeEnabled: index % 2 === 0,
    })),
    dependencies: [],
  };
};

const contractsFor = (plan: PlanCandidate): readonly TaskContractV0[] =>
  plan.subtasks.map((subtask, index) => TaskContractV0Schema.parse({
    taskContractRef: subtask.taskContractRef,
    projectId: plan.projectId,
    bigTaskId: plan.bigTaskId,
    subtaskId: subtask.id,
    title: `B3a hardening title ${index}`,
    goal: `B3a hardening goal ${index}`,
    scopeIn: [`B3a hardening scope ${index}`],
    scopeOut: [`Deferred B3b scope ${index}`],
    acceptanceCriteria: [`Exact workflow bootstrap ${index}`],
    untouchedAreas: ["Board lifecycle"],
    promptSeed: `Initialize exact workflow ${index}.`,
    startPolicy: index % 2 === 0 ? "MANUAL" : "WHEN_READY",
    delegationPolicy: index % 2 === 0 ? "NONE" : "REVIEW_ONLY",
    recommendedReasoningLevel: index % 2 === 0 ? "HIGH" : "XHIGH",
  }));

const approval = (state: PlanReviewState) => ({
  outcome: "APPROVE" as const,
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const seedCanonicalSource = (
  storage: TaskStorage,
  plan = makePlan(),
  createProject = true,
): ReturnType<TaskStorage["materializeApprovedCanonicalTasks"]> => {
  if (createProject) {
    storage.createProject(makeProject(plan.projectId, "b3a-hardening"));
  }
  storage.createBigTask(makeBigTask(plan.bigTaskId, plan.projectId));
  const bundle = storage.beginDurablePlanningBundle(plan, contractsFor(plan));
  storage.recordDurableReviewerDecision(plan.bigTaskId, approval(bundle.reviewState));
  storage.materializeDurablePlan(plan.bigTaskId);
  return storage.materializeApprovedCanonicalTasks(plan.bigTaskId);
};

const expectStorageError = (
  operation: () => unknown,
  code: TaskStorageError["code"],
): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe(code);
  expect(error.message).not.toMatch(
    /SQLite|SQL|constraint|trigger|locked|busy|fixture|\/Users\/|task_contracts/i,
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

const workflowRows = (databasePath: string): Readonly<{
  instances: readonly unknown[];
  receipts: readonly unknown[];
}> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.freeze({
      instances: sqlite.prepare(
        "SELECT * FROM subtask_workflow_instances ORDER BY big_task_id, subtask_id",
      ).all(),
      receipts: sqlite.prepare(
        "SELECT * FROM workflow_initialization_receipts ORDER BY big_task_id",
      ).all(),
    });
  } finally {
    sqlite.close();
  }
};

describe("Step 8B3a exact source, lifecycle, and public-boundary hardening", () => {
  it("binds every nonlexical mixed-profile instance to the exact Step 8B2b source", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(INITIALIZED_AT),
      });
      const plan = makePlan();
      const source = seedCanonicalSource(storage, plan);
      const before = storage.listSubtasksByBigTask(BIG_TASK_ID);
      const beforeRows = new DatabaseSync(databasePath, { readOnly: true });
      const beforeLifecycle = beforeRows.prepare(
        "SELECT id, status, maturity, updated_at FROM subtasks WHERE big_task_id = ? ORDER BY id",
      ).all(BIG_TASK_ID);
      beforeRows.close();
      const result = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);

      expect(result).toMatchObject({
        projectId: source.projectId,
        bigTaskId: source.bigTaskId,
        planRevision: source.planRevision,
        candidateBinding: source.candidateBinding,
        workflowInstanceCount: source.subtaskCount,
        initializedAt: INITIALIZED_AT,
      });
      expect(result.workflowInstances.map((instance) => ({
        projectId: instance.projectId,
        bigTaskId: instance.bigTaskId,
        planRevision: instance.planRevision,
        candidateBinding: instance.candidateBinding,
        subtaskId: instance.subtaskId,
        profile: instance.profile,
        writeEnabled: instance.writeEnabled,
        initialStage: instance.initialStage,
        initialRepairCyclesUsed: instance.initialRepairCyclesUsed,
      }))).toEqual(plan.subtasks.map((subtask) => ({
        projectId: plan.projectId,
        bigTaskId: plan.bigTaskId,
        planRevision: plan.revision,
        candidateBinding: source.candidateBinding,
        subtaskId: subtask.id,
        profile: subtask.profile,
        writeEnabled: subtask.writeEnabled,
        initialStage: subtask.profile === "LOW" ? "EXECUTE" : "MATERIALIZE",
        initialRepairCyclesUsed: 0,
      })));
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual(before);
      const afterRows = new DatabaseSync(databasePath, { readOnly: true });
      expect(afterRows.prepare(
        "SELECT id, status, maturity, updated_at FROM subtasks WHERE big_task_id = ? ORDER BY id",
      ).all(BIG_TASK_ID)).toEqual(beforeLifecycle);
      const instanceColumns = (afterRows.prepare(
        "PRAGMA table_info(subtask_workflow_instances)",
      ).all() as unknown as readonly { readonly name: string }[]).map(({ name }) => name);
      expect(instanceColumns).not.toEqual(expect.arrayContaining([
        "profile",
        "write_enabled",
        "current_stage",
        "current_repair_cycles_used",
      ]));
      afterRows.close();
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.workflowInstances)).toBe(true);
      expect(result.workflowInstances.every(Object.isFrozen)).toBe(true);

      const first = result.workflowInstances[0]!;
      expect(() => {
        (result.workflowInstances as unknown as unknown[]).push(first);
      }).toThrow();
      expect(() => {
        (first as unknown as { initialStage: string }).initialStage = "MATERIALIZE";
      }).toThrow();
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toEqual(result);
      storage.close();
    });
  });

  it("keeps legal Subtask and parent lifecycle drift orthogonal to immutable bootstrap", () => {
    withTemporaryDatabasePath((databasePath) => {
      let current = new Date(SOURCE_AT);
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(current) });
      const source = seedCanonicalSource(storage);
      current = new Date(INITIALIZED_AT);
      const initialized = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const target = source.subtasks[0]!.subtaskId;
      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(
        "UPDATE subtasks SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?",
      ).run("2026-09-03T10:00:02.000Z", target);
      sqlite.prepare(
        "UPDATE big_tasks SET status = 'DONE', updated_at = ? WHERE id = ?",
      ).run("2026-09-03T10:00:02.000Z", BIG_TASK_ID);
      sqlite.close();

      current = new Date("2026-09-03T10:00:03.000Z");
      const completion = storage.completeSubtaskImplementation({
        subtaskId: target,
        checkpoint: makeImplementationCheckpoint("icp_b3a_completion", target, {
          occurredAt: current.toISOString(),
        }),
      });
      expect(completion.subtask).toMatchObject({ status: "QA_DEBUG", maturity: "IMPLEMENTED" });
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toEqual(initialized);
      expect(storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(initialized);
      storage.close();
    });
  });

  it("exposes only initialization/read authority and no mutable-stage or readiness claim", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(storage));
      expect(methods).toEqual(expect.arrayContaining([
        "initializeDurableSubtaskWorkflows",
        "getDurableSubtaskWorkflowInitialization",
        "getDurableSubtaskWorkflowInstance",
      ]));
      expect(methods).not.toEqual(expect.arrayContaining([
        "setStage",
        "setCurrentStage",
        "advanceStage",
        "setRepairCyclesUsed",
        "markInitialized",
        "adoptWorkflow",
        "saveWorkflowRow",
      ]));
      seedCanonicalSource(storage);
      const result = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      expect(Object.keys(result).sort()).toEqual([
        "bigTaskId",
        "candidateBinding",
        "initializedAt",
        "planRevision",
        "projectId",
        "workflowInstanceCount",
        "workflowInstances",
      ]);
      expect(JSON.stringify(result)).not.toMatch(
        /currentStage|ready|dispatch|executionStarted|worktree|budget|evidence/i,
      );
      storage.close();
    });
  });
});

describe("Step 8B3a owned source-loss and corruption hardening", () => {
  const sourceCorruptions = [
    ["planning track missing", "DELETE FROM orchestration_planning_tracks WHERE big_task_id = 'bt_b3a_hardening'"],
    ["Step 8B1 materialization missing", "DELETE FROM orchestration_materializations WHERE big_task_id = 'bt_b3a_hardening'"],
    ["candidate missing", "DELETE FROM orchestration_plan_candidates WHERE big_task_id = 'bt_b3a_hardening'"],
    ["approval downgraded", "UPDATE orchestration_review_decisions SET outcome = 'REJECT', revision_requirements = '[\"changed\"]' WHERE big_task_id = 'bt_b3a_hardening'"],
    ["source project substituted", "UPDATE orchestration_materializations SET project_id = 'prj_substituted' WHERE big_task_id = 'bt_b3a_hardening'"],
    ["source revision substituted", "UPDATE orchestration_materializations SET plan_revision = 7 WHERE big_task_id = 'bt_b3a_hardening'"],
    ["source binding substituted", "UPDATE orchestration_materializations SET candidate_binding = 'substituted' WHERE big_task_id = 'bt_b3a_hardening'"],
    ["candidate profile drift", "UPDATE orchestration_plan_candidates SET candidate_payload = replace(candidate_payload, '\"profile\":\"LOW\"', '\"profile\":\"STANDARD\"') WHERE big_task_id = 'bt_b3a_hardening'"],
    ["Task Contract missing", "DROP TRIGGER task_contracts_immutable_delete; DELETE FROM task_contracts WHERE rowid = (SELECT min(rowid) FROM task_contracts WHERE big_task_id = 'bt_b3a_hardening')"],
    ["Task Contract binding missing", "DROP TRIGGER candidate_task_contract_bindings_immutable_delete; DELETE FROM candidate_task_contract_bindings WHERE rowid = (SELECT min(rowid) FROM candidate_task_contract_bindings WHERE big_task_id = 'bt_b3a_hardening')"],
    ["Step 8B2b evidence missing", "DROP TRIGGER canonical_task_materializations_immutable_delete; DELETE FROM canonical_task_materializations WHERE big_task_id = 'bt_b3a_hardening'"],
    ["canonical Subtask missing", "DROP TRIGGER canonical_materialized_subtask_delete_guard; DELETE FROM subtasks WHERE id = 'st_b3a_nonlexical_10'"],
  ] as const;

  it.each(sourceCorruptions)("fails closed after ownership when %s", (_name, mutation) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      corrupt(databasePath, mutation);
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  const receiptCorruptions = [
    "project_id = 'prj_wrong'",
    "big_task_id = 'bt_wrong'",
    "plan_revision = 2",
    "candidate_binding = 'wrong'",
    "workflow_instance_count = 1",
    "workflow_instance_count = 99",
    "initialized_at = 'invalid'",
    "initialized_at = '2026-09-03T10:00:00Z'",
    "initialized_at = '2026-09-03T09:59:59.999Z'",
    "initialized_at = '2030-01-01T00:00:00.000Z'",
  ] as const;

  it.each(receiptCorruptions)("rejects corrupted receipt %s", (assignment) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      corrupt(
        databasePath,
        `DROP TRIGGER workflow_initialization_receipts_immutable_update;
         UPDATE workflow_initialization_receipts SET ${assignment}
         WHERE big_task_id = 'bt_b3a_hardening'`,
      );
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  const instanceCorruptions = [
    "project_id = 'prj_wrong'",
    "big_task_id = 'bt_wrong'",
    "plan_revision = 2",
    "candidate_binding = 'wrong'",
    "subtask_id = 'st_wrong'",
    "initial_stage = 'MATERIALIZE'",
    "initial_repair_cycles_used = 1",
    "initial_repair_cycles_used = -1",
    "initial_repair_cycles_used = 1.5",
    "initial_repair_cycles_used = 'zero'",
    "initialized_at = 'invalid'",
    "initialized_at = '2026-09-03T10:00:01Z'",
    "initialized_at = '2026-09-03T10:00:00.000Z'",
    "initialized_at = '2030-01-01T00:00:00.000Z'",
  ] as const;

  it.each(instanceCorruptions)("rejects corrupted instance %s", (assignment) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      corrupt(
        databasePath,
        `DROP TRIGGER subtask_workflow_instances_immutable_update;
         UPDATE subtask_workflow_instances SET ${assignment}
         WHERE subtask_id = 'st_b3a_nonlexical_10'`,
      );
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  const setCorruptions = [
    ["one missing", "DROP TRIGGER subtask_workflow_instances_immutable_delete; DELETE FROM subtask_workflow_instances WHERE subtask_id = 'st_b3a_nonlexical_10'"],
    ["multiple missing", "DROP TRIGGER subtask_workflow_instances_immutable_delete; DELETE FROM subtask_workflow_instances WHERE subtask_id IN ('st_b3a_nonlexical_10', 'st_b3a_nonlexical_2')"],
    ["all missing", "DROP TRIGGER subtask_workflow_instances_immutable_delete; DELETE FROM subtask_workflow_instances"],
    ["one extra", "DROP TRIGGER subtask_workflow_instances_owned_insert_guard; INSERT INTO subtask_workflow_instances SELECT 'st_b3a_extra', project_id, big_task_id, plan_revision, candidate_binding, initial_stage, initial_repair_cycles_used, initialized_at FROM subtask_workflow_instances LIMIT 1"],
    ["sibling substituted", "DROP TRIGGER subtask_workflow_instances_immutable_update; UPDATE subtask_workflow_instances SET subtask_id = 'st_b3a_sibling' WHERE subtask_id = 'st_b3a_nonlexical_10'"],
    ["cross-Big-Task substituted", "DROP TRIGGER subtask_workflow_instances_immutable_update; UPDATE subtask_workflow_instances SET big_task_id = 'bt_cross' WHERE subtask_id = 'st_b3a_nonlexical_10'"],
    ["receipt removed", "DROP TRIGGER workflow_initialization_receipts_immutable_delete; DELETE FROM workflow_initialization_receipts"],
  ] as const;

  it.each(setCorruptions)("rejects owned set corruption with %s", (_name, mutation) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      corrupt(databasePath, mutation);
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInstance(
          SubtaskIdSchema.parse("st_b3a_nonlexical_10"),
        ),
        "MALFORMED_STORED_DATA",
      );
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        _name === "receipt removed" ? "CONFLICT" : "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });
});

describe("Step 8B3a no-adoption, chronology, and idempotence hardening", () => {
  it.each([1, 2, 4])("never adopts %i exact-looking preexisting workflow rows", (rowCount) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      const source = seedCanonicalSource(storage);
      const sqlite = new DatabaseSync(databasePath);
      const insert = sqlite.prepare(`INSERT INTO subtask_workflow_instances
        (subtask_id, project_id, big_task_id, plan_revision, candidate_binding,
         initial_stage, initial_repair_cycles_used, initialized_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`);
      for (const subtask of source.subtasks.slice(0, rowCount)) {
        insert.run(
          subtask.subtaskId,
          source.projectId,
          source.bigTaskId,
          source.planRevision,
          source.candidateBinding,
          subtask.profile === "LOW" ? "EXECUTE" : "MATERIALIZE",
          INITIALIZED_AT,
        );
      }
      sqlite.close();
      const before = workflowRows(databasePath);
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        "CONFLICT",
      );
      expect(workflowRows(databasePath)).toEqual(before);
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("never adopts wrong-binding or cross-Big-Task rows and documents receipt-loss behavior", () => {
    for (const mutation of [
      "UPDATE subtask_workflow_instances SET candidate_binding = 'wrong'",
      "UPDATE subtask_workflow_instances SET big_task_id = 'bt_wrong'",
    ]) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
        const source = seedCanonicalSource(storage, makePlan({ profiles: ["LOW"] }));
        const target = source.subtasks[0]!;
        const sqlite = new DatabaseSync(databasePath);
        sqlite.prepare(`INSERT INTO subtask_workflow_instances
          VALUES (?, ?, ?, ?, ?, 'EXECUTE', 0, ?)`)
          .run(
            target.subtaskId,
            source.projectId,
            source.bigTaskId,
            source.planRevision,
            source.candidateBinding,
            INITIALIZED_AT,
          );
        sqlite.exec("PRAGMA foreign_keys = OFF; DROP TRIGGER subtask_workflow_instances_immutable_update");
        sqlite.exec(mutation);
        sqlite.close();
        expectStorageError(
          () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
          "CONFLICT",
        );
        storage.close();
      });
    }
  });

  it.each([
    [SOURCE_AT, true],
    [INITIALIZED_AT, true],
    ["2026-09-03T09:59:59.999Z", false],
  ] as const)("applies the initialization chronology for clock %s", (clock, valid) => {
    withTemporaryDatabasePath((databasePath) => {
      let current = new Date(SOURCE_AT);
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(current) });
      seedCanonicalSource(storage, makePlan({ profiles: ["STANDARD"] }));
      current = new Date(clock);
      if (valid) {
        expect(storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID).initializedAt).toBe(clock);
      } else {
        expectStorageError(
          () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
          "STORAGE_OPERATION_FAILED",
        );
        expect(workflowRows(databasePath)).toEqual({ instances: [], receipts: [] });
      }
      storage.close();
    });
  });

  it("rejects an invalid Date atomically and releases the inner savepoint for a legal retry", () => {
    withTemporaryDatabasePath((databasePath) => {
      let current = new Date(SOURCE_AT);
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(current) });
      seedCanonicalSource(storage, makePlan({ profiles: ["HIGH_RISK_FOUNDATION"] }));
      storage.runInTransaction((outer) => {
        current = new Date(Number.NaN);
        expectStorageError(
          () => outer.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
          "STORAGE_OPERATION_FAILED",
        );
        current = new Date(INITIALIZED_AT);
        expect(outer.initializeDurableSubtaskWorkflows(BIG_TASK_ID).workflowInstanceCount)
          .toBe(1);
      });
      expect(workflowRows(databasePath)).toMatchObject({
        instances: [expect.any(Object)],
        receipts: [expect.any(Object)],
      });
      storage.close();
    });
  });

  it("retries by read/verify/return without clock acquisition or database writes", () => {
    withTemporaryDatabasePath((databasePath) => {
      let current = new Date(SOURCE_AT);
      let trackedCalls = 0;
      let track = false;
      const storage = openTaskDatabase({
        databasePath,
        clock: () => {
          if (track) trackedCalls += 1;
          return new Date(current);
        },
      });
      seedCanonicalSource(storage);
      current = new Date(INITIALIZED_AT);
      const first = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const observer = new DatabaseSync(databasePath, { readOnly: true });
      const beforeRows = workflowRows(databasePath);
      const beforeVersion = observer.prepare("PRAGMA data_version").get();
      current = new Date("2099-12-31T23:59:59.999Z");
      track = true;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        expect(storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(first);
      }
      expect(trackedCalls).toBe(0);
      expect(workflowRows(databasePath)).toEqual(beforeRows);
      expect(observer.prepare("PRAGMA data_version").get()).toEqual(beforeVersion);
      observer.close();
      storage.close();
    });
  });
});

describe("Step 8B3a receipt-last, nested atomicity, and SQLite guard hardening", () => {
  const failureInjections = [
    `CREATE TRIGGER test_b3a_fail_before_first BEFORE INSERT ON subtask_workflow_instances
     BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
    `CREATE TRIGGER test_b3a_fail_after_first BEFORE INSERT ON subtask_workflow_instances
     WHEN NEW.subtask_id = 'st_b3a_nonlexical_2'
     BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
    `CREATE TRIGGER test_b3a_fail_mid_set BEFORE INSERT ON subtask_workflow_instances
     WHEN NEW.subtask_id = 'st_b3a_nonlexical_1'
     BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
    `CREATE TRIGGER test_b3a_fail_receipt BEFORE INSERT ON workflow_initialization_receipts
     BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
    `CREATE TRIGGER test_b3a_corrupt_after_receipt AFTER INSERT ON workflow_initialization_receipts
     BEGIN UPDATE orchestration_materializations SET candidate_binding = 'fixture-corrupt'
       WHERE big_task_id = NEW.big_task_id; END`,
  ] as const;

  it.each(failureInjections)("rolls back the full initialization for injection %#", (injection) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(injection);
      sqlite.close();
      const error = captureTaskStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
      );
      expect(["TRANSACTION_FAILED", "MALFORMED_STORED_DATA"]).toContain(error.code);
      expect(error.message).not.toMatch(/fixture|SQLite|SQL|trigger|\/Users\//i);
      expect(workflowRows(databasePath)).toEqual({ instances: [], receipts: [] });
      expect(storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).not.toBeNull();
      storage.close();
    });
  });

  it("isolates caught inner failure and rolls a successful inner initialization back with its outer transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(`CREATE TRIGGER test_b3a_inner_failure BEFORE INSERT ON subtask_workflow_instances
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      sqlite.close();
      storage.runInTransaction((outer) => {
        expectStorageError(
          () => outer.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
          "TRANSACTION_FAILED",
        );
        outer.createBigTask(makeBigTask("bt_b3a_unrelated_after_failure", PROJECT_ID));
      });
      expect(workflowRows(databasePath)).toEqual({ instances: [], receipts: [] });
      expect(storage.getBigTaskById(BigTaskIdSchema.parse("bt_b3a_unrelated_after_failure")))
        .not.toBeNull();

      const cleanup = new DatabaseSync(databasePath);
      cleanup.exec("DROP TRIGGER test_b3a_inner_failure");
      cleanup.close();
      expectStorageError(
        () => storage.runInTransaction((outer) => {
          outer.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
          throw new Error("outer failure");
        }),
        "TRANSACTION_FAILED",
      );
      expect(workflowRows(databasePath)).toEqual({ instances: [], receipts: [] });
      storage.close();
    });
  });

  it("blocks all supported conflict forms for both immutable tables with recursive triggers disabled", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      const expected = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      expect(sqlite.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 0 });
      const operations = [
        "INSERT INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances LIMIT 1",
        "INSERT OR REPLACE INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances LIMIT 1",
        "REPLACE INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances LIMIT 1",
        "INSERT INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances WHERE true LIMIT 1 ON CONFLICT(subtask_id) DO UPDATE SET initial_stage = excluded.initial_stage",
        "INSERT INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances WHERE true LIMIT 1 ON CONFLICT(subtask_id) DO NOTHING",
        "UPDATE subtask_workflow_instances SET initial_stage = initial_stage",
        "DELETE FROM subtask_workflow_instances",
        "INSERT INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts",
        "INSERT OR REPLACE INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts",
        "REPLACE INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts",
        "INSERT INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts WHERE true ON CONFLICT(big_task_id) DO UPDATE SET initialized_at = excluded.initialized_at",
        "INSERT INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts WHERE true ON CONFLICT(big_task_id) DO NOTHING",
        "UPDATE workflow_initialization_receipts SET initialized_at = initialized_at",
        "DELETE FROM workflow_initialization_receipts",
      ] as const;
      for (const operation of operations) {
        expect(() => sqlite.exec(operation), operation).toThrow();
      }
      sqlite.close();
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toEqual(expected);
      storage.close();
    });
  });

  it("rolls back an earlier unowned row when a later row in one insert conflicts", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const secondBigTaskId = BigTaskIdSchema.parse("bt_b3a_unowned_insert");
      const secondPlan = makePlan({
        bigTaskId: secondBigTaskId,
        profiles: ["STANDARD"],
        prefix: "st_b3a_unowned_insert",
      });
      const secondSource = seedCanonicalSource(storage, secondPlan, false);
      const sqlite = new DatabaseSync(databasePath);
      expect(() => sqlite.prepare(`INSERT INTO subtask_workflow_instances
        (subtask_id, project_id, big_task_id, plan_revision, candidate_binding,
         initial_stage, initial_repair_cycles_used, initialized_at)
        VALUES (?, ?, ?, ?, ?, 'MATERIALIZE', 0, ?),
          ('st_b3a_nonlexical_10', ?, ?, 1,
           (SELECT candidate_binding FROM canonical_task_materializations WHERE big_task_id = ?),
           'EXECUTE', 0, ?)`)
        .run(
          secondSource.subtasks[0]!.subtaskId,
          secondSource.projectId,
          secondSource.bigTaskId,
          secondSource.planRevision,
          secondSource.candidateBinding,
          INITIALIZED_AT,
          PROJECT_ID,
          BIG_TASK_ID,
          BIG_TASK_ID,
          INITIALIZED_AT,
        )).toThrow();
      expect(sqlite.prepare(
        "SELECT * FROM subtask_workflow_instances WHERE big_task_id = ?",
      ).all(secondBigTaskId)).toEqual([]);
      sqlite.close();
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)?.workflowInstanceCount)
        .toBe(4);
      storage.close();
    });
  });

  it("supplements replay with exact structural FK/check/receipt-completeness constraints", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      const source = seedCanonicalSource(storage, makePlan({ profiles: ["LOW"] }));
      const target = source.subtasks[0]!;
      const sqlite = new DatabaseSync(databasePath);
      const invalidInstances = [
        ["st_missing", source.projectId, source.bigTaskId, 1, source.candidateBinding, "EXECUTE", 0, INITIALIZED_AT],
        [target.subtaskId, "prj_missing", source.bigTaskId, 1, source.candidateBinding, "EXECUTE", 0, INITIALIZED_AT],
        [target.subtaskId, source.projectId, "bt_missing", 1, source.candidateBinding, "EXECUTE", 0, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 0, source.candidateBinding, "EXECUTE", 0, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 1.5, source.candidateBinding, "EXECUTE", 0, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 1, "", "EXECUTE", 0, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 1, source.candidateBinding, "PLAN", 0, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 1, source.candidateBinding, "EXECUTE", 1, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 1, source.candidateBinding, "EXECUTE", -1, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 1, source.candidateBinding, "EXECUTE", 1.5, INITIALIZED_AT],
        [target.subtaskId, source.projectId, source.bigTaskId, 1, source.candidateBinding, "EXECUTE", null, INITIALIZED_AT],
      ] as const;
      const insertInstance = sqlite.prepare(`INSERT INTO subtask_workflow_instances
        (subtask_id, project_id, big_task_id, plan_revision, candidate_binding,
         initial_stage, initial_repair_cycles_used, initialized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of invalidInstances) {
        expect(() => insertInstance.run(...row), JSON.stringify(row)).toThrow();
      }

      insertInstance.run(
        target.subtaskId,
        source.projectId,
        source.bigTaskId,
        source.planRevision,
        source.candidateBinding,
        "EXECUTE",
        0,
        INITIALIZED_AT,
      );
      const insertReceipt = sqlite.prepare(`INSERT INTO workflow_initialization_receipts
        (big_task_id, project_id, plan_revision, candidate_binding,
         workflow_instance_count, initialized_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const row of [
        ["bt_missing", source.projectId, 1, source.candidateBinding, 1, INITIALIZED_AT],
        [source.bigTaskId, "prj_missing", 1, source.candidateBinding, 1, INITIALIZED_AT],
        [source.bigTaskId, source.projectId, 0, source.candidateBinding, 1, INITIALIZED_AT],
        [source.bigTaskId, source.projectId, 1, "", 1, INITIALIZED_AT],
        [source.bigTaskId, source.projectId, 1, source.candidateBinding, 0, INITIALIZED_AT],
        [source.bigTaskId, source.projectId, 1, source.candidateBinding, 2, INITIALIZED_AT],
        [source.bigTaskId, source.projectId, 1, source.candidateBinding, 1, "2030-01-01T00:00:00.000Z"],
      ] as const) {
        expect(() => insertReceipt.run(...row), JSON.stringify(row)).toThrow();
      }
      sqlite.close();
      storage.close();
    });
  });

  it.each([
    ["wrong membership", "subtask_id = 'st_b3a_wrong_member'"],
    ["wrong candidate binding", "candidate_binding = 'wrong-binding'"],
    ["inconsistent timestamp", "initialized_at = '2030-01-01T00:00:00.000Z'"],
  ] as const)("blocks a correct-count receipt with %s", (_name, assignment) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      const source = seedCanonicalSource(storage, makePlan({ profiles: ["LOW", "STANDARD"] }));
      const sqlite = new DatabaseSync(databasePath);
      const insert = sqlite.prepare(`INSERT INTO subtask_workflow_instances
        (subtask_id, project_id, big_task_id, plan_revision, candidate_binding,
         initial_stage, initial_repair_cycles_used, initialized_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`);
      for (const subtask of source.subtasks) {
        insert.run(
          subtask.subtaskId,
          source.projectId,
          source.bigTaskId,
          source.planRevision,
          source.candidateBinding,
          subtask.profile === "LOW" ? "EXECUTE" : "MATERIALIZE",
          INITIALIZED_AT,
        );
      }
      sqlite.exec("PRAGMA foreign_keys = OFF; DROP TRIGGER subtask_workflow_instances_immutable_update");
      sqlite.exec(`UPDATE subtask_workflow_instances SET ${assignment}
        WHERE subtask_id = 'st_b3a_nonlexical_10'`);
      sqlite.exec("PRAGMA foreign_keys = ON");
      expect(() => sqlite.prepare(`INSERT INTO workflow_initialization_receipts
        (big_task_id, project_id, plan_revision, candidate_binding,
         workflow_instance_count, initialized_at) VALUES (?, ?, ?, ?, 2, ?)`)
        .run(
          source.bigTaskId,
          source.projectId,
          source.planRevision,
          source.candidateBinding,
          INITIALIZED_AT,
        )).toThrow();
      expect(sqlite.prepare("SELECT * FROM workflow_initialization_receipts").all())
        .toEqual([]);
      sqlite.close();
      storage.close();
    });
  });
});

const waitForFiles = async (paths: readonly string[]): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (paths.every((path) => existsSync(path))) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Cross-process workflow initialization barrier was not reached.");
};

const runInitializationWorker = (
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
        "packages/storage/test/workflow-initialization-process-worker.test.ts",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CTC_B3A_PROCESS_DATABASE_PATH: databasePath,
          CTC_B3A_PROCESS_READY_PATH: readyPath,
          CTC_B3A_PROCESS_GO_PATH: goPath,
          CTC_B3A_PROCESS_OUTCOME_PATH: outcomePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("close", (status) => resolvePromise(Object.freeze({ status, output })));
  });

describe("Step 8B3a concurrency, ordering, and scale hardening", () => {
  it("shows no dirty owned read and exact commit/rollback state across two handles", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(first);
      const second = openTaskDatabase({ databasePath, clock: () => new Date("2050-01-01T00:00:00.000Z") });
      const expected = first.runInTransaction((outer) => {
        const result = outer.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
        expect(second.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toBeNull();
        return result;
      });
      expect(second.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toEqual(expected);
      for (let attempt = 0; attempt < 24; attempt += 1) {
        expect((attempt % 2 === 0 ? first : second)
          .initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(expected);
      }
      first.close();
      second.close();

      const rollbackPath = join(databasePath, "..", "workflow-rollback.sqlite");
      const writer = openTaskDatabase({ databasePath: rollbackPath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(writer);
      const reader = openTaskDatabase({ databasePath: rollbackPath, clock: () => new Date(INITIALIZED_AT) });
      expectStorageError(
        () => writer.runInTransaction((outer) => {
          outer.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
          expect(reader.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toBeNull();
          throw new Error("rollback");
        }),
        "TRANSACTION_FAILED",
      );
      expect(reader.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toBeNull();
      writer.close();
      reader.close();
    });
  });

  it("sanitizes contention, leaves zero partial authority, and succeeds once released", () => {
    withTemporaryDatabasePath((databasePath) => {
      const seed = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(seed);
      seed.close();
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      getTaskStorageWorktreeAccess(storage)!.sqlite.exec("PRAGMA busy_timeout = 0");
      const locker = new DatabaseSync(databasePath);
      locker.exec("BEGIN IMMEDIATE");
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        "TRANSACTION_FAILED",
      );
      expect(workflowRows(databasePath)).toEqual({ instances: [], receipts: [] });
      locker.exec("ROLLBACK");
      locker.close();
      expect(storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID).workflowInstanceCount)
        .toBe(4);
      storage.close();
    });
  });

  it("returns the same complete initialization to two barrier-synchronized processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctc-b3a-process-"));
    const databasePath = join(directory, "task-console.sqlite");
    const goPath = join(directory, "go.signal");
    const readyPaths = [join(directory, "first.ready"), join(directory, "second.ready")];
    const outcomePaths = [join(directory, "first.outcome"), join(directory, "second.outcome")];
    try {
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      seedCanonicalSource(storage);
      storage.close();
      const workers = readyPaths.map((readyPath, index) => runInitializationWorker(
        databasePath,
        readyPath,
        goPath,
        outcomePaths[index]!,
      ));
      await waitForFiles(readyPaths);
      writeFileSync(goPath, "go\n", { encoding: "utf-8" });
      const results = await Promise.all(workers);
      expect(results.map(({ status }) => status), results.map(({ output }) => output).join("\n"))
        .toEqual([0, 0]);
      const outcomes = outcomePaths.map((path) =>
        JSON.parse(readFileSync(path, { encoding: "utf-8" })) as unknown);
      expect(outcomes[0]).toEqual(outcomes[1]);
      const reopened = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      expect(reopened.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID))
        .toMatchObject(outcomes[0] as Record<string, unknown>);
      expect(workflowRows(databasePath)).toMatchObject({
        instances: expect.arrayContaining([expect.any(Object)]),
        receipts: [expect.any(Object)],
      });
      reopened.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it.each([37, 67])("initializes, retries, reopens, and preserves source order for %i Subtasks", (size) => {
    withTemporaryDatabasePath((databasePath) => {
      const profiles = Array.from({ length: size }, (_, index) =>
        (["HIGH_RISK_FOUNDATION", "LOW", "STANDARD"] as const)[index % 3]!);
      const plan = makePlan({ profiles, prefix: `st_b3a_scale_${size}` });
      let storage = openTaskDatabase({ databasePath, clock: () => new Date(INITIALIZED_AT) });
      const source = seedCanonicalSource(storage, plan);
      const result = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      expect(result.workflowInstanceCount).toBe(size);
      expect(result.workflowInstances.map(({ subtaskId }) => subtaskId))
        .toEqual(source.subtasks.map(({ subtaskId }) => subtaskId));
      expect(result.workflowInstances.filter(({ writeEnabled }) => !writeEnabled))
        .toHaveLength(Math.floor(size / 2));
      expect(storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(result);
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: () => new Date("2099-01-01T00:00:00.000Z") });
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toEqual(result);
      storage.close();
    });
  });
});
