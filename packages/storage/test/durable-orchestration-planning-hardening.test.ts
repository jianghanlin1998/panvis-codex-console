import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import {
  applyReviewerDecision,
  beginPlanReview,
  materializeApprovedPlan,
} from "@codex-task-console/orchestration";
import type {
  PlanCandidate,
  PlanReviewState,
  ProposedSubtask,
  ReviewDecision,
} from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import type {
  DurableOrchestrationPlanningSnapshot,
  TaskStorage,
  TaskStorageError,
} from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_planning_hardening");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_planning_hardening");

const proposedSubtask = (
  id: string,
  revision: number,
  bigTaskId: string = BIG_TASK_ID,
): ProposedSubtask => ({
  id: SubtaskIdSchema.parse(id),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
  profile: revision % 2 === 0 ? "HIGH_RISK_FOUNDATION" : "STANDARD",
  taskContractRef: `contracts/${id}-r${revision}.md`,
  writeEnabled: true,
});

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  reason = `${upstreamSubtaskId} precedes ${downstreamSubtaskId}.`,
) =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "BLOCKING",
    requiredGate: "ACCEPTED",
    reason,
  });

const candidate = (revision = 1): PlanCandidate => ({
  kind: "PLAN_CANDIDATE",
  projectId: PROJECT_ID,
  bigTaskId: BIG_TASK_ID,
  revision,
  subtasks: [
    proposedSubtask("st_hardening_a", revision),
    proposedSubtask("st_hardening_b", revision),
    proposedSubtask("st_hardening_c", revision),
  ],
  dependencies: [
    dependency("st_hardening_a", "st_hardening_b"),
    dependency("st_hardening_b", "st_hardening_c"),
  ],
});

const seedHierarchy = (storage: TaskStorage): void => {
  storage.createProject(makeProject(PROJECT_ID, "planning-hardening"));
  storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
};

const approvalFor = (
  state: PlanReviewState,
): Extract<ReviewDecision, { readonly outcome: "APPROVE" }> => ({
  outcome: "APPROVE",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const rejectionFor = (
  state: PlanReviewState,
): Extract<ReviewDecision, { readonly outcome: "REJECT" }> => ({
  outcome: "REJECT",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
  revisionRequirements: ["Revise the bounded plan."],
});

const expectPlanningError = (
  operation: () => unknown,
  code: TaskStorageError["code"],
): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe(code);
  expect(error.message).not.toMatch(/SQLite|SQL|constraint|payload|\/Users\//i);
  return error;
};

const approve = (
  storage: TaskStorage,
  snapshot: DurableOrchestrationPlanningSnapshot,
): DurableOrchestrationPlanningSnapshot =>
  storage.recordDurableReviewerDecision(
    BIG_TASK_ID,
    approvalFor(snapshot.reviewState),
  );

const installTrigger = (databasePath: string, sql: string): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec(sql);
  } finally {
    sqlite.close();
  }
};

const createMaterializedHistory = (
  storage: TaskStorage,
): DurableOrchestrationPlanningSnapshot => {
  const snapshot = storage.beginDurablePlanning(candidate());
  approve(storage, snapshot);
  return storage.materializeDurablePlan(BIG_TASK_ID);
};

const corruptMaterializedHistory = (
  mutation: (sqlite: DatabaseSync) => void,
): TaskStorageError => {
  let observed!: TaskStorageError;
  withTemporaryDatabasePath((databasePath) => {
    const storage = openTaskDatabase({ databasePath, clock: fixedClock });
    seedHierarchy(storage);
    createMaterializedHistory(storage);
    storage.close();

    const sqlite = new DatabaseSync(databasePath);
    try {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      mutation(sqlite);
    } finally {
      sqlite.close();
    }

    const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
    try {
      observed = expectPlanningError(
        () => reopened.getDurablePlanningSnapshot(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
    } finally {
      reopened.close();
    }
  });
  return observed;
};

describe("CTC-ORCH-B1-HARD-001 Step 8A semantic parity", () => {
  const base = candidate();
  const invalidGraphs = [
    [
      "duplicate proposed ID",
      { ...base, subtasks: [base.subtasks[0]!, base.subtasks[0]!] },
      "DUPLICATE_SUBTASK_ID",
    ],
    [
      "duplicate edge",
      { ...base, dependencies: [base.dependencies[0]!, base.dependencies[0]!] },
      "DUPLICATE_DEPENDENCY",
    ],
    [
      "missing endpoint",
      {
        ...base,
        dependencies: [dependency("st_missing", "st_hardening_a")],
      },
      "MISSING_UPSTREAM_SUBTASK",
    ],
    [
      "self dependency",
      {
        ...base,
        dependencies: [dependency("st_hardening_a", "st_hardening_a")],
      },
      "SELF_DEPENDENCY",
    ],
    [
      "blocking cycle",
      {
        ...base,
        dependencies: [
          dependency("st_hardening_a", "st_hardening_b"),
          dependency("st_hardening_b", "st_hardening_a"),
        ],
      },
      "DEPENDENCY_CYCLE",
    ],
    [
      "mixed blocking and informational topology",
      {
        ...base,
        dependencies: [
          dependency("st_hardening_a", "st_hardening_b"),
          SubtaskDependencySchema.parse({
            upstreamSubtaskId: "st_hardening_b",
            downstreamSubtaskId: "st_hardening_c",
            dependencyType: "INFORMATIONAL",
            requiredGate: "NONE",
            reason: "Informational context.",
          }),
          dependency("st_hardening_b", "st_hardening_a"),
        ],
      },
      "DEPENDENCY_CYCLE",
    ],
    [
      "proposed ownership mismatch",
      {
        ...base,
        subtasks: [
          proposedSubtask("st_hardening_a", 1, "bt_other"),
          ...base.subtasks.slice(1),
        ],
      },
      "BIG_TASK_OWNERSHIP_MISMATCH",
    ],
  ] as const satisfies readonly [string, PlanCandidate, string][];

  it.each(invalidGraphs)(
    "durably reviews a structurally valid %s and defers graph rejection to materialization",
    (_label, graphInvalidCandidate, expectedCode) => {
      const pureStarted = beginPlanReview(graphInvalidCandidate);
      expect(pureStarted).toMatchObject({
        kind: "REVIEW_STATE",
        state: { phase: "AWAITING_REVIEW" },
      });
      if (pureStarted.kind !== "REVIEW_STATE") {
        throw new Error("The accepted pure kernel must begin review.");
      }
      const pureApproved = applyReviewerDecision(
        pureStarted.state,
        approvalFor(pureStarted.state),
      );
      expect(pureApproved).toMatchObject({
        kind: "REVIEW_STATE",
        state: { phase: "APPROVED" },
      });
      if (pureApproved.kind !== "REVIEW_STATE") {
        throw new Error("The accepted pure kernel must preserve approval.");
      }
      const pureMaterialized = materializeApprovedPlan(pureApproved.state);
      expect(pureMaterialized.kind).toBe("GRAPH_INVALID");
      if (pureMaterialized.kind !== "GRAPH_INVALID") {
        throw new Error("The accepted pure kernel must reject the invalid graph.");
      }
      expect(pureMaterialized.validation.errors.map(({ code }) => code)).toContain(
        expectedCode,
      );

      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        let snapshot = storage.beginDurablePlanning(graphInvalidCandidate);
        expect(snapshot.reviewState.phase).toBe("AWAITING_REVIEW");
        snapshot = approve(storage, snapshot);
        expect(snapshot.reviewState.phase).toBe("APPROVED");
        const error = expectPlanningError(
          () => storage.materializeDurablePlan(BIG_TASK_ID),
          "DEPENDENCY_VALIDATION_FAILED",
        );
        expect(error.validationCodes).toContain(expectedCode);
        expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
        storage.close();

        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
        storage.close();
      });
    },
  );

  it("uses the accepted revision kernel before deferring revised-graph validation", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(candidate());
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      const revised = candidate(2);
      snapshot = storage.submitDurablePlannerRevision({
        ...revised,
        dependencies: [
          dependency("st_hardening_a", "st_hardening_b"),
          dependency("st_hardening_b", "st_hardening_a"),
        ],
      });
      expect(snapshot.reviewState).toMatchObject({
        phase: "AWAITING_REVIEW",
        automaticRevisionsUsed: 1,
      });
      snapshot = approve(storage, snapshot);
      const error = expectPlanningError(
        () => storage.materializeDurablePlan(BIG_TASK_ID),
        "DEPENDENCY_VALIDATION_FAILED",
      );
      expect(error.validationCodes).toContain("DEPENDENCY_CYCLE");
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      storage.close();
    });
  });
});

describe("CTC-ORCH-B1-HARD-002 historical authority isolation", () => {
  it("keeps history readable after legal Big Task status drift and blocks a new mutation", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const persisted = storage.beginDurablePlanning(candidate());
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare("UPDATE big_tasks SET status = 'DONE' WHERE id = ?").run(BIG_TASK_ID);
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(persisted);
      expectPlanningError(
        () =>
          storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            approvalFor(persisted.reviewState),
          ),
        "PARENT_NOT_FOUND",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(persisted);
      storage.close();
    });
  });

  it("keeps history readable after a later cross-Big-Task proposed-ID collision", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      storage.createProject(makeProject("prj_planning_other", "planning-other"));
      storage.createBigTask(makeBigTask("bt_planning_other", "prj_planning_other"));
      const persisted = storage.beginDurablePlanning(candidate());
      storage.createSubtask(makeSubtask("st_hardening_a", "bt_planning_other"));

      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(persisted);
      expectPlanningError(
        () =>
          storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            approvalFor(persisted.reviewState),
          ),
        "CONFLICT",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(persisted);
      storage.close();
    });
  });

  it("allows a same-Big-Task canonical row without rewriting historical authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(candidate());
      storage.createSubtask(makeSubtask("st_hardening_a", BIG_TASK_ID));
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      snapshot = approve(storage, snapshot);
      const materialized = storage.materializeDurablePlan(BIG_TASK_ID);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(materialized);
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toEqual([
        makeSubtask("st_hardening_a", BIG_TASK_ID),
      ]);
      storage.close();
    });
  });

  it("blocks a cross-Big-Task collision between approval and materialization", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      storage.createProject(makeProject("prj_planning_other", "planning-other"));
      storage.createBigTask(makeBigTask("bt_planning_other", "prj_planning_other"));
      let snapshot = storage.beginDurablePlanning(candidate());
      snapshot = approve(storage, snapshot);
      storage.createSubtask(makeSubtask("st_hardening_a", "bt_planning_other"));

      expectPlanningError(
        () => storage.materializeDurablePlan(BIG_TASK_ID),
        "CONFLICT",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      storage.close();
    });
  });

  it("keeps completed materialization readable and idempotent after later mutable drift", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      storage.createProject(makeProject("prj_planning_other", "planning-other"));
      storage.createBigTask(makeBigTask("bt_planning_other", "prj_planning_other"));
      const materialized = createMaterializedHistory(storage);
      storage.createSubtask(makeSubtask("st_hardening_a", "bt_planning_other"));
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare("UPDATE big_tasks SET status = 'DONE' WHERE id = ?").run(BIG_TASK_ID);
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(materialized);
      expect(storage.materializeDurablePlan(BIG_TASK_ID)).toEqual(materialized);
      storage.close();
    });
  });
});

describe("CTC-ORCH-B1-HARD-003 nested operation atomicity", () => {
  it("rolls back a failed inner begin when the outer caller catches the error", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      storage.close();
      installTrigger(
        databasePath,
        `CREATE TRIGGER corrupt_candidate_after_begin AFTER INSERT ON orchestration_plan_candidates
         WHEN NEW.revision = 1
         BEGIN
           UPDATE orchestration_plan_candidates SET candidate_payload = '{}' WHERE big_task_id = NEW.big_task_id AND revision = NEW.revision;
         END`,
      );
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.runInTransaction((outer) => {
        expectPlanningError(
          () => outer.beginDurablePlanning(candidate()),
          "MALFORMED_STORED_DATA",
        );
      });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      storage.close();
    });
  });

  it("rolls back failed inner decision, revision, and materialization writes", () => {
    const cases = ["decision", "revision", "materialization"] as const;
    for (const failurePoint of cases) {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        let snapshot = storage.beginDurablePlanning(candidate());
        if (failurePoint === "revision") {
          snapshot = storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            rejectionFor(snapshot.reviewState),
          );
        } else if (failurePoint === "materialization") {
          snapshot = approve(storage, snapshot);
        }
        const before = snapshot;
        storage.close();

        const trigger =
          failurePoint === "decision"
            ? `CREATE TRIGGER corrupt_decision_after_insert AFTER INSERT ON orchestration_review_decisions
               BEGIN
                 UPDATE orchestration_review_decisions SET candidate_binding = candidate_binding || '-corrupt' WHERE big_task_id = NEW.big_task_id AND plan_revision = NEW.plan_revision;
               END`
            : failurePoint === "revision"
              ? `CREATE TRIGGER corrupt_revision_after_insert AFTER INSERT ON orchestration_plan_candidates
                 WHEN NEW.revision = 2
                 BEGIN
                   UPDATE orchestration_plan_candidates SET candidate_payload = '{}' WHERE big_task_id = NEW.big_task_id AND revision = NEW.revision;
                 END`
              : `CREATE TRIGGER corrupt_materialization_after_insert AFTER INSERT ON orchestration_materializations
                 BEGIN
                   UPDATE orchestration_materializations SET candidate_binding = candidate_binding || '-corrupt' WHERE big_task_id = NEW.big_task_id;
                 END`;
        installTrigger(databasePath, trigger);
        storage = openTaskDatabase({ databasePath, clock: fixedClock });

        storage.runInTransaction((outer) => {
          const operation =
            failurePoint === "decision"
              ? () =>
                  outer.recordDurableReviewerDecision(
                    BIG_TASK_ID,
                    approvalFor(before.reviewState),
                  )
              : failurePoint === "revision"
                ? () => outer.submitDurablePlannerRevision(candidate(2))
                : () => outer.materializeDurablePlan(BIG_TASK_ID);
          expectPlanningError(operation, "MALFORMED_STORED_DATA");
        });
        expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(before);
        storage.close();
      });
    }
  });
});

describe("CTC-ORCH-B1-HARD-004 durable audit chronology", () => {
  it("accepts equal and forward time but atomically rejects a regressing clock", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      storage.close();

      let currentTime = "2026-09-02T10:00:00.000Z";
      storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      let snapshot = storage.beginDurablePlanning(candidate());

      currentTime = "2026-09-02T09:59:59.999Z";
      expectPlanningError(
        () =>
          storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            rejectionFor(snapshot.reviewState),
          ),
        "STORAGE_OPERATION_FAILED",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);

      currentTime = "2026-09-02T10:00:01.000Z";
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      currentTime = "2026-09-02T10:00:01.000Z";
      snapshot = storage.submitDurablePlannerRevision(candidate(2));
      snapshot = approve(storage, snapshot);

      currentTime = "2026-09-02T10:00:00.000Z";
      expectPlanningError(
        () => storage.materializeDurablePlan(BIG_TASK_ID),
        "STORAGE_OPERATION_FAILED",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);

      currentTime = "2026-09-02T10:00:02.000Z";
      expect(storage.materializeDurablePlan(BIG_TASK_ID).materializedGraph).not.toBeNull();
      storage.close();
    });
  });

  it("fails closed when persisted artifact chronology is impossible", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = "2026-09-02T10:00:00.000Z";
      let storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      seedHierarchy(storage);
      const snapshot = storage.beginDurablePlanning(candidate());
      currentTime = "2026-09-02T10:00:01.000Z";
      approve(storage, snapshot);
      currentTime = "2026-09-02T10:00:02.000Z";
      storage.materializeDurablePlan(BIG_TASK_ID);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare(
          "UPDATE orchestration_review_decisions SET created_at = '2026-09-02T09:00:00.000Z' WHERE big_task_id = ?",
        )
        .run(BIG_TASK_ID);
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectPlanningError(
        () => storage.getDurablePlanningSnapshot(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("rejects invalid clocks without leaving a partial planning track", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      storage.close();

      storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(Number.NaN),
      });
      expectPlanningError(
        () => storage.beginDurablePlanning(candidate()),
        "STORAGE_OPERATION_FAILED",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      storage.close();
    });
  });

  const corruptChronology = [
    [
      "track after first candidate",
      "UPDATE orchestration_planning_tracks SET created_at = '2026-09-02T12:00:00.000Z'",
    ],
    [
      "materialization before approval",
      "UPDATE orchestration_materializations SET materialized_at = '2026-08-08T09:00:00.000Z'",
    ],
    [
      "noncanonical candidate timestamp",
      "UPDATE orchestration_plan_candidates SET created_at = '2026-09-02T10:00:00Z'",
    ],
    [
      "invalid decision timestamp",
      "UPDATE orchestration_review_decisions SET created_at = 'not-a-time'",
    ],
  ] as const;

  it.each(corruptChronology)("fails closed for %s", (_label, sql) => {
    corruptMaterializedHistory((sqlite) => sqlite.exec(sql));
  });

  it.each([
    [
      "revision candidate before its rejecting decision",
      "UPDATE orchestration_plan_candidates SET created_at = '2026-09-02T10:00:00.500Z' WHERE revision = 2",
    ],
    [
      "Reviewer decision before its revision candidate",
      "UPDATE orchestration_review_decisions SET created_at = '2026-09-02T10:00:01.500Z' WHERE plan_revision = 2",
    ],
  ] as const)("fails closed for %s", (_label, corruptionSql) => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = "2026-09-02T10:00:00.000Z";
      let storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(candidate());
      currentTime = "2026-09-02T10:00:01.000Z";
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      currentTime = "2026-09-02T10:00:02.000Z";
      snapshot = storage.submitDurablePlannerRevision(candidate(2));
      currentTime = "2026-09-02T10:00:03.000Z";
      approve(storage, snapshot);
      currentTime = "2026-09-02T10:00:04.000Z";
      storage.materializeDurablePlan(BIG_TASK_ID);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(corruptionSql);
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectPlanningError(
        () => storage.getDurablePlanningSnapshot(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });
});

describe("durable replay, binding, and revision hardening", () => {
  it("preserves the accepted MAX_SAFE_INTEGER revision boundaries", () => {
    for (const initialRevision of [
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        let snapshot = storage.beginDurablePlanning(candidate(initialRevision));
        snapshot = storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(snapshot.reviewState),
        );
        if (initialRevision === Number.MAX_SAFE_INTEGER - 1) {
          expect(snapshot.reviewState.phase).toBe("AWAITING_REVISION");
          snapshot = storage.submitDurablePlannerRevision(
            candidate(Number.MAX_SAFE_INTEGER),
          );
          snapshot = storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            rejectionFor(snapshot.reviewState),
          );
        }
        expect(snapshot.reviewState).toMatchObject({
          phase: "HUMAN_REQUIRED",
          humanReason: "PLAN_REVIEW_EXHAUSTED",
        });
        storage.close();

        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
        expectPlanningError(
          () =>
            storage.submitDurablePlannerRevision(
              candidate(Number.MAX_SAFE_INTEGER),
            ),
          "INVALID_INPUT",
        );
        storage.close();
      });
    }
  });

  const rowSubstitutions = [
    [
      "track Project identity",
      (sqlite: DatabaseSync) =>
        sqlite
          .prepare("UPDATE orchestration_planning_tracks SET project_id = 'prj_substituted'")
          .run(),
    ],
    [
      "candidate order with unchanged binding",
      (sqlite: DatabaseSync) => {
        const row = sqlite
          .prepare("SELECT candidate_payload FROM orchestration_plan_candidates")
          .get() as { readonly candidate_payload: string };
        const value = JSON.parse(row.candidate_payload) as {
          subtasks: unknown[];
        };
        value.subtasks.reverse();
        sqlite
          .prepare("UPDATE orchestration_plan_candidates SET candidate_payload = ?")
          .run(JSON.stringify(value));
      },
    ],
    [
      "decision revision",
      (sqlite: DatabaseSync) =>
        sqlite
          .prepare("UPDATE orchestration_review_decisions SET plan_revision = 2")
          .run(),
    ],
    [
      "decision outcome after approval",
      (sqlite: DatabaseSync) =>
        sqlite
          .prepare(
            "UPDATE orchestration_review_decisions SET outcome = 'ESCALATE', revision_requirements = NULL",
          )
          .run(),
    ],
    [
      "materialization Project identity",
      (sqlite: DatabaseSync) =>
        sqlite
          .prepare("UPDATE orchestration_materializations SET project_id = 'prj_substituted'")
          .run(),
    ],
    [
      "terminal artifact followed by an extra decision",
      (sqlite: DatabaseSync) => {
        const row = sqlite
          .prepare("SELECT * FROM orchestration_review_decisions")
          .get() as Record<string, unknown>;
        sqlite
          .prepare(
            "INSERT INTO orchestration_review_decisions (big_task_id, plan_revision, outcome, candidate_binding, revision_requirements, created_at) VALUES (?, 2, 'APPROVE', ?, NULL, ?)",
          )
          .run(
            String(row.big_task_id),
            String(row.candidate_binding),
            String(row.created_at),
          );
      },
    ],
  ] as const;

  it.each(rowSubstitutions)("fails closed for substituted %s", (_label, mutation) => {
    corruptMaterializedHistory(mutation);
  });

  it("fails closed when candidate payload and binding are coherently substituted after approval", () => {
    corruptMaterializedHistory((sqlite) => {
      const row = sqlite
        .prepare(
          "SELECT candidate_payload FROM orchestration_plan_candidates WHERE revision = 1",
        )
        .get() as { readonly candidate_payload: string };
      const value = JSON.parse(row.candidate_payload) as PlanCandidate;
      const changed = {
        ...value,
        subtasks: value.subtasks.map((subtask, index) =>
          index === 0 ? { ...subtask, profile: "LOW" as const } : subtask,
        ),
      };
      const rebound = beginPlanReview(changed);
      if (rebound.kind !== "REVIEW_STATE") {
        throw new Error("The substituted candidate must remain structurally valid.");
      }
      sqlite
        .prepare(
          "UPDATE orchestration_plan_candidates SET candidate_payload = ?, candidate_binding = ? WHERE revision = 1",
        )
        .run(JSON.stringify(rebound.state.candidate), rebound.state.candidateBinding);
    });
  });
});

describe("durable Unicode and canonical serialization hardening", () => {
  it("accepts exact boundary code points and valid astral text", () => {
    for (const text of ["x x", "x~x", "x\u00a0x", "x\ud83d\ude80x", "xe\u0301x", "xéx"]) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        const input = candidate();
        const exactCandidate: PlanCandidate = {
          ...input,
          subtasks: input.subtasks.map((subtask, index) =>
            index === 0 ? { ...subtask, taskContractRef: text } : subtask,
          ),
          dependencies: input.dependencies.map((edge, index) =>
            index === 0 ? { ...edge, reason: text } : edge,
          ),
        };
        let snapshot = storage.beginDurablePlanning(exactCandidate);
        snapshot = storage.recordDurableReviewerDecision(BIG_TASK_ID, {
          ...rejectionFor(snapshot.reviewState),
          revisionRequirements: [text],
        });
        expect(snapshot.reviewState).toMatchObject({
          revisionRequirements: [text],
        });
        storage.close();
      });
    }
  });

  it("rejects every C0/C1 control, DEL, and isolated surrogate without mutation", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const forbidden = [
        ...Array.from({ length: 0x20 }, (_, codePoint) =>
          String.fromCharCode(codePoint),
        ),
        ...Array.from({ length: 0x21 }, (_, offset) =>
          String.fromCharCode(0x7f + offset),
        ),
        "\ud800",
        "\udfff",
      ];
      for (const text of forbidden) {
        const input = candidate();
        expectPlanningError(
          () =>
            storage.beginDurablePlanning({
              ...input,
              subtasks: input.subtasks.map((subtask, index) =>
                index === 0
                  ? { ...subtask, taskContractRef: `x${text}x` }
                  : subtask,
              ),
            }),
          "INVALID_INPUT",
        );
      }
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      storage.close();
    });
  });

  const noncanonicalPayloadMutations = [
    ["escaped solidus", (payload: string) => payload.replace("contracts/", "contracts\\/" )],
    ["escaped ASCII", (payload: string) => payload.replace("contracts", "\\u0063ontracts")],
    [
      "duplicate object key",
      (payload: string) => payload.replace(
        '{"kind":"PLAN_CANDIDATE",',
        '{"kind":"PLAN_CANDIDATE","kind":"PLAN_CANDIDATE",',
      ),
    ],
  ] as const;

  it.each(noncanonicalPayloadMutations)(
    "fails closed for valid but noncanonical JSON: %s",
    (_label, mutate) => {
      corruptMaterializedHistory((sqlite) => {
        const row = sqlite
          .prepare("SELECT candidate_payload FROM orchestration_plan_candidates")
          .get() as { readonly candidate_payload: string };
        const mutated = mutate(row.candidate_payload);
        expect(JSON.parse(mutated)).toEqual(JSON.parse(row.candidate_payload));
        sqlite
          .prepare("UPDATE orchestration_plan_candidates SET candidate_payload = ?")
          .run(mutated);
      });
    },
  );
});

describe("multi-handle authority ordering", () => {
  it.each(["REJECT_FIRST", "APPROVE_FIRST"] as const)(
    "selects one deterministic Reviewer authority for %s",
    (order) => {
      withTemporaryDatabasePath((databasePath) => {
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        const initial = seed.beginDurablePlanning(candidate());
        seed.close();

        const first = openTaskDatabase({ databasePath, clock: fixedClock });
        const second = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const winningDecision =
            order === "REJECT_FIRST"
              ? rejectionFor(initial.reviewState)
              : approvalFor(initial.reviewState);
          const losingDecision =
            order === "REJECT_FIRST"
              ? approvalFor(initial.reviewState)
              : rejectionFor(initial.reviewState);
          const winner = first.recordDurableReviewerDecision(
            BIG_TASK_ID,
            winningDecision,
          );
          expectPlanningError(
            () =>
              second.recordDurableReviewerDecision(
                BIG_TASK_ID,
                losingDecision,
              ),
            "INVALID_INPUT",
          );
          expect(second.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(winner);
        } finally {
          first.close();
          second.close();
        }

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(reopened.getDurablePlanningSnapshot(BIG_TASK_ID)?.reviewDecisions).toHaveLength(1);
        reopened.close();
      });
    },
  );

  it("never exposes another handle's uncommitted planning write", () => {
    withTemporaryDatabasePath((databasePath) => {
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(seed);
      seed.close();
      const writer = openTaskDatabase({ databasePath, clock: fixedClock });
      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        let committed!: DurableOrchestrationPlanningSnapshot;
        writer.runInTransaction((transaction) => {
          committed = transaction.beginDurablePlanning(candidate());
          expect(reader.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
        });
        expect(reader.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(committed);
      } finally {
        writer.close();
        reader.close();
      }
    });
  });
});

describe("snapshot detachment, bounded scale, and public boundary", () => {
  it("detaches mutable inputs and resists returned nested mutation", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const input = candidate();
      const mutableSubtasks = input.subtasks.map((subtask) => ({ ...subtask }));
      const mutableDependencies = input.dependencies.map((edge) => ({ ...edge }));
      const mutableInput = {
        ...input,
        subtasks: mutableSubtasks,
        dependencies: mutableDependencies,
      };
      let snapshot = storage.beginDurablePlanning(mutableInput);
      mutableSubtasks[0]!.taskContractRef = "contracts/mutated.md";
      mutableDependencies.reverse();
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);

      const requirements = ["Original exact requirement."];
      snapshot = storage.recordDurableReviewerDecision(BIG_TASK_ID, {
        ...rejectionFor(snapshot.reviewState),
        revisionRequirements: requirements,
      });
      requirements[0] = "Mutated requirement.";
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      expect(Reflect.set(snapshot.reviewState.candidate.subtasks[0]!, "profile", "LOW")).toBe(false);
      expect(Reflect.set(snapshot.candidateHistory[0]!, "candidateBinding", "changed")).toBe(false);
      expect(Reflect.set(snapshot.reviewDecisions[0]!.decision, "outcome", "APPROVE")).toBe(false);
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      storage.close();
    });
  });

  it("deeply freezes a materialized graph independently of later reads", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const materialized = createMaterializedHistory(storage);
      expect(
        Reflect.set(materialized.materializedGraph!.subtasks[0]!, "profile", "LOW"),
      ).toBe(false);
      expect(
        Reflect.set(
          materialized.materializedGraph!.dependencies[0]!,
          "reason",
          "Changed.",
        ),
      ).toBe(false);
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(materialized);
      storage.close();
    });
  });

  it("replays and materializes a deterministic 64-Subtask three-candidate history", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const scaledCandidate = (revision: number): PlanCandidate => {
        const subtasks = Array.from({ length: 64 }, (_, index) =>
          proposedSubtask(`st_scale_${index.toString().padStart(2, "0")}`, revision),
        );
        const dependencies = subtasks.slice(1).flatMap((subtask, index) => {
          const edges = [
            dependency(subtasks[index]!.id, subtask.id, `chain ${index}`),
          ];
          if (index >= 8 && index % 4 === 0) {
            edges.push(
              SubtaskDependencySchema.parse({
                upstreamSubtaskId: subtask.id,
                downstreamSubtaskId: subtasks[index - 8]!.id,
                dependencyType: "INFORMATIONAL",
                requiredGate: "NONE",
                reason: `information ${index}`,
              }),
            );
          }
          return edges;
        });
        return {
          kind: "PLAN_CANDIDATE",
          projectId: PROJECT_ID,
          bigTaskId: BIG_TASK_ID,
          revision,
          subtasks,
          dependencies,
        };
      };

      let snapshot = storage.beginDurablePlanning(scaledCandidate(40));
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      snapshot = storage.submitDurablePlannerRevision(scaledCandidate(41));
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      snapshot = storage.submitDurablePlannerRevision(scaledCandidate(42));
      snapshot = approve(storage, snapshot);
      snapshot = storage.materializeDurablePlan(BIG_TASK_ID);
      expect(snapshot.candidateHistory).toHaveLength(3);
      expect(snapshot.materializedGraph?.subtasks).toHaveLength(64);
      expect(snapshot.materializedGraph?.dependencies).toHaveLength(77);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      storage.close();
    });
  });

  it("exposes only bounded source actions and uses only the public orchestration package", () => {
    const boundaryStorage = openTaskDatabase({
      databasePath: ":memory:",
      clock: fixedClock,
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(boundaryStorage));
    boundaryStorage.close();
    expect(methods).toEqual(
      expect.arrayContaining([
        "beginDurablePlanning",
        "recordDurableReviewerDecision",
        "submitDurablePlannerRevision",
        "materializeDurablePlan",
        "getDurablePlanningSnapshot",
      ]),
    );
    for (const forbiddenMethod of [
      "saveState",
      "setPhase",
      "saveGraph",
      "writeArtifactJson",
      "executeSql",
    ]) {
      expect(methods).not.toContain(forbiddenMethod);
    }
    const source = readFileSync(
      new URL("../src/orchestration-planning.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "@codex-task-console/orchestration"');
    expect(source).not.toMatch(/@codex-task-console\/orchestration\//);
    const orchestrationManifest = readFileSync(
      new URL("../../orchestration/package.json", import.meta.url),
      "utf8",
    );
    expect(orchestrationManifest).not.toContain("@codex-task-console/storage");
  });
});
