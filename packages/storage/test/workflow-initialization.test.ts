import { DatabaseSync } from "node:sqlite";

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
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeProject,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_workflow_initialization");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_workflow_initialization");
const FIXED_TIME = "2026-08-09T00:00:00.000Z";

const makePlan = (
  profiles: readonly WorkflowProfile[] = [
    "LOW",
    "STANDARD",
    "HIGH_RISK_FOUNDATION",
  ],
): PlanCandidate => ({
  kind: "PLAN_CANDIDATE",
  projectId: PROJECT_ID,
  bigTaskId: BIG_TASK_ID,
  revision: 1,
  subtasks: profiles.map((profile, index) => ({
    id: SubtaskIdSchema.parse(
      `st_workflow_${String(profiles.length - index).padStart(3, "0")}`,
    ),
    bigTaskId: BIG_TASK_ID,
    profile,
    taskContractRef: `contract/workflow-${index}`,
    writeEnabled: index % 2 === 0,
  })),
  dependencies: [],
});

const contractsFor = (plan: PlanCandidate): readonly TaskContractV0[] =>
  plan.subtasks.map((subtask, index) => TaskContractV0Schema.parse({
    taskContractRef: subtask.taskContractRef,
    projectId: plan.projectId,
    bigTaskId: plan.bigTaskId,
    subtaskId: subtask.id,
    title: `Workflow title ${index}`,
    goal: `Workflow goal ${index}`,
    scopeIn: [`Workflow scope ${index}`],
    scopeOut: [],
    acceptanceCriteria: [`Workflow acceptance ${index}`],
    untouchedAreas: ["Board lifecycle"],
    promptSeed: `Workflow prompt ${index}`,
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
): ReturnType<TaskStorage["materializeApprovedCanonicalTasks"]> => {
  storage.createProject(makeProject(PROJECT_ID, "workflow-initialization"));
  storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
  const bundle = storage.beginDurablePlanningBundle(plan, contractsFor(plan));
  storage.recordDurableReviewerDecision(BIG_TASK_ID, approval(bundle.reviewState));
  storage.materializeDurablePlan(BIG_TASK_ID);
  return storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
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

const counts = (databasePath: string): {
  readonly instances: number;
  readonly receipts: number;
} => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      instances: (sqlite.prepare(
        "SELECT count(*) AS count FROM subtask_workflow_instances",
      ).get() as { readonly count: number }).count,
      receipts: (sqlite.prepare(
        "SELECT count(*) AS count FROM workflow_initialization_receipts",
      ).get() as { readonly count: number }).count,
    };
  } finally {
    sqlite.close();
  }
};

describe("durable per-Subtask workflow initialization", () => {
  it.each([
    ["LOW", "EXECUTE"],
    ["STANDARD", "MATERIALIZE"],
    ["HIGH_RISK_FOUNDATION", "MATERIALIZE"],
  ] as const)("initializes a single %s Subtask at %s with zero repairs", (profile, stage) => {
    withMemoryStorage((storage) => {
      const source = seedCanonicalSource(storage, makePlan([profile]));
      const result = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      expect(result).toMatchObject({
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        planRevision: source.planRevision,
        candidateBinding: source.candidateBinding,
        workflowInstanceCount: 1,
        initializedAt: FIXED_TIME,
      });
      expect(result.workflowInstances).toEqual([{
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        planRevision: source.planRevision,
        candidateBinding: source.candidateBinding,
        subtaskId: source.subtasks[0]!.subtaskId,
        initialStage: stage,
        initialRepairCyclesUsed: 0,
        initializedAt: FIXED_TIME,
        profile,
        writeEnabled: true,
      }]);
    });
  });

  it("initializes every mixed-profile and write-disabled Subtask in source order without board mutation", () => {
    withMemoryStorage((storage) => {
      const plan = makePlan();
      const source = seedCanonicalSource(storage, plan);
      const before = storage.listSubtasksByBigTask(BIG_TASK_ID);
      const result = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      expect(result.workflowInstances.map((instance) => ({
        subtaskId: instance.subtaskId,
        profile: instance.profile,
        writeEnabled: instance.writeEnabled,
        initialStage: instance.initialStage,
        initialRepairCyclesUsed: instance.initialRepairCyclesUsed,
      }))).toEqual([
        {
          subtaskId: source.subtasks[0]!.subtaskId,
          profile: "LOW",
          writeEnabled: true,
          initialStage: "EXECUTE",
          initialRepairCyclesUsed: 0,
        },
        {
          subtaskId: source.subtasks[1]!.subtaskId,
          profile: "STANDARD",
          writeEnabled: false,
          initialStage: "MATERIALIZE",
          initialRepairCyclesUsed: 0,
        },
        {
          subtaskId: source.subtasks[2]!.subtaskId,
          profile: "HIGH_RISK_FOUNDATION",
          writeEnabled: true,
          initialStage: "MATERIALIZE",
          initialRepairCyclesUsed: 0,
        },
      ]);
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual(before);
      expect(before.every(({ status, maturity }) =>
        status === "TODO" && maturity === "NOT_STARTED")).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.workflowInstances)).toBe(true);
      expect(Object.isFrozen(result.workflowInstances[0])).toBe(true);
      expect(storage.getDurableSubtaskWorkflowInstance(
        source.subtasks[1]!.subtaskId,
      )).toEqual(result.workflowInstances[1]);
    });
  });

  it("retries and reopens exactly without acquiring or rewriting initialization time", () => {
    withTemporaryDatabasePath((databasePath) => {
      let current = new Date(FIXED_TIME);
      let trackedCalls = 0;
      let track = false;
      let storage = openTaskDatabase({
        databasePath,
        clock: () => {
          if (track) {
            trackedCalls += 1;
          }
          return current;
        },
      });
      seedCanonicalSource(storage);
      current = new Date("2026-08-09T00:00:01.000Z");
      track = true;
      const first = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const retry = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      expect(retry).toEqual(first);
      expect(trackedCalls).toBe(1);
      storage.close();

      storage = openTaskDatabase({
        databasePath,
        clock: () => {
          throw new Error("idempotent replay must not acquire time");
        },
      });
      expect(storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(first);
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toEqual(first);
      storage.close();
      expect(counts(databasePath)).toEqual({ instances: 3, receipts: 1 });
    });
  });

  it("returns bounded missing-source semantics before ownership and fails regressing clocks atomically", () => {
    withMemoryStorage((storage) => {
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        "CONFLICT",
      );
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toBeNull();
    });
    withTemporaryDatabasePath((databasePath) => {
      let current = new Date(FIXED_TIME);
      const storage = openTaskDatabase({ databasePath, clock: () => current });
      seedCanonicalSource(storage);
      current = new Date("2026-08-08T23:59:59.999Z");
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        "STORAGE_OPERATION_FAILED",
      );
      expect(counts(databasePath)).toEqual({ instances: 0, receipts: 0 });
      storage.close();
    });
  });

  it("writes the receipt last and rolls back every instance when receipt persistence fails", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedCanonicalSource(storage);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(`CREATE TRIGGER test_workflow_receipt_failure
        BEFORE INSERT ON workflow_initialization_receipts
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      sqlite.close();
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        "TRANSACTION_FAILED",
      );
      expect(counts(databasePath)).toEqual({ instances: 0, receipts: 0 });
      storage.close();
    });
  });

  it("isolates caught inner failure and rolls successful initialization back with its outer transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedCanonicalSource(storage);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(`CREATE TRIGGER test_workflow_instance_failure
        BEFORE INSERT ON subtask_workflow_instances
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      sqlite.close();

      storage.runInTransaction((transaction) => {
        expectStorageError(
          () => transaction.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
          "TRANSACTION_FAILED",
        );
        transaction.createBigTask(makeBigTask("bt_after_workflow_failure", PROJECT_ID));
      });
      expect(counts(databasePath)).toEqual({ instances: 0, receipts: 0 });
      expect(storage.getBigTaskById(BigTaskIdSchema.parse("bt_after_workflow_failure")))
        .not.toBeNull();

      const cleanup = new DatabaseSync(databasePath);
      cleanup.exec("DROP TRIGGER test_workflow_instance_failure");
      cleanup.close();
      expect(() => storage.runInTransaction((transaction) => {
        transaction.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
        throw new Error("outer rollback fixture");
      })).toThrow();
      expect(counts(databasePath)).toEqual({ instances: 0, receipts: 0 });
      storage.close();
    });
  });

  it("never adopts a matching preexisting workflow row", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const source = seedCanonicalSource(storage, makePlan(["LOW"]));
      const target = source.subtasks[0]!;
      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(`INSERT INTO subtask_workflow_instances
        (subtask_id, project_id, big_task_id, plan_revision, candidate_binding,
         initial_stage, initial_repair_cycles_used, initialized_at)
        VALUES (?, ?, ?, ?, ?, 'EXECUTE', 0, ?)`)
        .run(
          target.subtaskId,
          source.projectId,
          source.bigTaskId,
          source.planRevision,
          source.candidateBinding,
          source.materializedAt,
        );
      sqlite.close();
      expectStorageError(
        () => storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        "CONFLICT",
      );
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      expect(counts(databasePath)).toEqual({ instances: 1, receipts: 0 });
      storage.close();
    });
  });

  it("converges two handles and exposes no dirty initialization read", { timeout: 12_000 }, () => {
    withTemporaryDatabasePath((databasePath) => {
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedCanonicalSource(seed);
      seed.close();
      const first = openTaskDatabase({ databasePath, clock: fixedClock });
      const second = openTaskDatabase({
        databasePath,
        clock: () => new Date("2030-01-01T00:00:00.000Z"),
      });
      let owned: ReturnType<TaskStorage["initializeDurableSubtaskWorkflows"]> | null = null;
      first.runInTransaction((transaction) => {
        owned = transaction.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
        expect(second.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID)).toBeNull();
        const loser = captureTaskStorageError(
          () => second.initializeDurableSubtaskWorkflows(BIG_TASK_ID),
        );
        expect(["TRANSACTION_FAILED", "STORAGE_OPERATION_FAILED"]).toContain(loser.code);
        expect(loser.message).not.toMatch(/SQLite|SQL|locked|busy|\/Users\//i);
      });
      expect(second.initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(owned);
      expect(counts(databasePath)).toEqual({ instances: 3, receipts: 1 });
      second.close();
      first.close();
    });
  });

  it.each([31, 64])("initializes and exactly replays a bounded %i-Subtask mixed graph", (count) => {
    withMemoryStorage((storage) => {
      const profiles = Array.from({ length: count }, (_, index) =>
        (["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"] as const)[index % 3]!,
      );
      const source = seedCanonicalSource(storage, makePlan(profiles));
      const result = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      expect(result.workflowInstanceCount).toBe(count);
      expect(result.workflowInstances.map(({ subtaskId }) => subtaskId))
        .toEqual(source.subtasks.map(({ subtaskId }) => subtaskId));
      expect(result.workflowInstances.filter(({ writeEnabled }) => !writeEnabled))
        .toHaveLength(Math.floor(count / 2));
      expect(storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(result);
    });
  });
});

describe("workflow bootstrap immutability and corruption replay", () => {
  it("blocks replacement, upsert, update, delete, and post-receipt set growth with recursive triggers disabled", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedCanonicalSource(storage);
      const expected = storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      expect(sqlite.prepare("PRAGMA recursive_triggers").get())
        .toEqual({ recursive_triggers: 0 });
      const operations = [
        "INSERT INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances LIMIT 1",
        "INSERT OR REPLACE INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances LIMIT 1",
        "REPLACE INTO subtask_workflow_instances SELECT * FROM subtask_workflow_instances LIMIT 1",
        `INSERT INTO subtask_workflow_instances
           SELECT * FROM subtask_workflow_instances WHERE true LIMIT 1
           ON CONFLICT(subtask_id) DO UPDATE SET initial_stage = excluded.initial_stage`,
        `INSERT INTO subtask_workflow_instances
           SELECT * FROM subtask_workflow_instances WHERE true LIMIT 1
           ON CONFLICT(subtask_id) DO NOTHING`,
        "UPDATE subtask_workflow_instances SET initial_stage = initial_stage",
        "DELETE FROM subtask_workflow_instances",
        "INSERT INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts",
        "INSERT OR REPLACE INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts",
        "REPLACE INTO workflow_initialization_receipts SELECT * FROM workflow_initialization_receipts",
        `INSERT INTO workflow_initialization_receipts
           SELECT * FROM workflow_initialization_receipts WHERE true
           ON CONFLICT(big_task_id) DO UPDATE SET initialized_at = excluded.initialized_at`,
        `INSERT INTO workflow_initialization_receipts
           SELECT * FROM workflow_initialization_receipts WHERE true
           ON CONFLICT(big_task_id) DO NOTHING`,
        "UPDATE workflow_initialization_receipts SET initialized_at = initialized_at",
        "DELETE FROM workflow_initialization_receipts",
        `INSERT INTO subtask_workflow_instances
           SELECT 'st_forbidden_extra', project_id, big_task_id, plan_revision,
             candidate_binding, initial_stage, initial_repair_cycles_used, initialized_at
           FROM subtask_workflow_instances LIMIT 1`,
      ] as const;
      for (const statement of operations) {
        expect(() => sqlite.exec(statement), statement).toThrow();
      }
      sqlite.close();
      expect(storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID))
        .toEqual(expected);
      storage.close();
    });
  });

  it.each([
    ["receipt project", "workflow_initialization_receipts_immutable_update", "UPDATE workflow_initialization_receipts SET project_id = 'prj_wrong'"],
    ["receipt Big Task", "workflow_initialization_receipts_immutable_update", "UPDATE workflow_initialization_receipts SET big_task_id = 'bt_wrong'"],
    ["receipt revision", "workflow_initialization_receipts_immutable_update", "UPDATE workflow_initialization_receipts SET plan_revision = 2"],
    ["receipt binding", "workflow_initialization_receipts_immutable_update", "UPDATE workflow_initialization_receipts SET candidate_binding = 'wrong'"],
    ["receipt count", "workflow_initialization_receipts_immutable_update", "UPDATE workflow_initialization_receipts SET workflow_instance_count = 2"],
    ["receipt timestamp", "workflow_initialization_receipts_immutable_update", "UPDATE workflow_initialization_receipts SET initialized_at = 'wrong'"],
    ["instance project", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET project_id = 'prj_wrong' WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)"],
    ["instance Big Task", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET big_task_id = 'bt_wrong' WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)"],
    ["instance revision", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET plan_revision = 2 WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)"],
    ["instance binding", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET candidate_binding = 'wrong' WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)"],
    ["instance Subtask", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET subtask_id = 'st_wrong' WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)"],
    ["instance stage", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET initial_stage = 'EXECUTE' WHERE initial_stage = 'MATERIALIZE' AND rowid = (SELECT min(rowid) FROM subtask_workflow_instances WHERE initial_stage = 'MATERIALIZE')"],
    ["instance repair count", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET initial_repair_cycles_used = 1 WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)"],
    ["instance timestamp", "subtask_workflow_instances_immutable_update", "UPDATE subtask_workflow_instances SET initialized_at = '2030-01-01T00:00:00.000Z' WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)"],
  ] as const)("fails closed for corrupt %s", (_kind, trigger, mutation) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedCanonicalSource(storage);
      storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.exec(`DROP TRIGGER ${trigger}`);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.exec(mutation);
      sqlite.close();
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it.each([
    [
      "missing instance",
      "DROP TRIGGER subtask_workflow_instances_immutable_delete",
      "DELETE FROM subtask_workflow_instances WHERE rowid = (SELECT min(rowid) FROM subtask_workflow_instances)",
    ],
    [
      "extra instance",
      "DROP TRIGGER subtask_workflow_instances_owned_insert_guard",
      `INSERT INTO subtask_workflow_instances
         SELECT 'st_extra', project_id, big_task_id, plan_revision, candidate_binding,
           initial_stage, initial_repair_cycles_used, initialized_at
         FROM subtask_workflow_instances LIMIT 1`,
    ],
    [
      "missing receipt",
      "DROP TRIGGER workflow_initialization_receipts_immutable_delete",
      "DELETE FROM workflow_initialization_receipts",
    ],
    [
      "missing Step 8B2b source",
      "DROP TRIGGER canonical_task_materializations_immutable_delete",
      "DELETE FROM canonical_task_materializations",
    ],
    [
      "malformed Step 8B2b source",
      "SELECT 1",
      "UPDATE orchestration_materializations SET candidate_binding = 'corrupt'",
    ],
  ] as const)("fails closed for owned history with %s", (_kind, preparation, mutation) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedCanonicalSource(storage);
      storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.exec(preparation);
      sqlite.exec(mutation);
      sqlite.close();
      expectStorageError(
        () => storage.getDurableSubtaskWorkflowInitialization(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });
});
