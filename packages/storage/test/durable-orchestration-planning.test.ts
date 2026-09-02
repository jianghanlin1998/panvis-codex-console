import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
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
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_planning");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_planning");

const proposedSubtask = (
  id: string,
  revision: number,
  options: {
    readonly bigTaskId?: string;
    readonly taskContractRef?: string;
    readonly profile?: "LOW" | "STANDARD" | "HIGH_RISK_FOUNDATION";
    readonly writeEnabled?: boolean;
  } = {},
): ProposedSubtask => ({
  id: SubtaskIdSchema.parse(id),
  bigTaskId: BigTaskIdSchema.parse(options.bigTaskId ?? BIG_TASK_ID),
  profile: options.profile ?? "STANDARD",
  taskContractRef: options.taskContractRef ?? `contracts/${id}-r${revision}.md`,
  writeEnabled: options.writeEnabled ?? true,
});

const planCandidate = (
  revision = 1,
  options: {
    readonly projectId?: string;
    readonly bigTaskId?: string;
    readonly taskContractRef?: string;
    readonly dependencyReason?: string;
  } = {},
): PlanCandidate => {
  const bigTaskId = options.bigTaskId ?? BIG_TASK_ID;
  const subtasks = [
    proposedSubtask("st_plan_a", revision, {
      bigTaskId,
      ...(options.taskContractRef === undefined
        ? {}
        : { taskContractRef: options.taskContractRef }),
    }),
    proposedSubtask("st_plan_b", revision, { bigTaskId }),
  ];
  return {
    kind: "PLAN_CANDIDATE",
    projectId: ProjectIdSchema.parse(options.projectId ?? PROJECT_ID),
    bigTaskId: BigTaskIdSchema.parse(bigTaskId),
    revision,
    subtasks,
    dependencies: [
      SubtaskDependencySchema.parse({
        upstreamSubtaskId: subtasks[0]!.id,
        downstreamSubtaskId: subtasks[1]!.id,
        dependencyType: "BLOCKING",
        requiredGate: "ACCEPTED",
        reason:
          options.dependencyReason ??
          `Revision ${revision} must complete before the dependent task.`,
      }),
    ],
  };
};

const seedHierarchy = (
  storage: TaskStorage,
  projectId = PROJECT_ID,
  bigTaskId = BIG_TASK_ID,
): void => {
  storage.createProject(makeProject(projectId, projectId.replaceAll("_", "-")));
  storage.createBigTask(makeBigTask(bigTaskId, projectId));
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
  revisionRequirements: readonly string[] = ["Revise the deterministic graph."],
): Extract<ReviewDecision, { readonly outcome: "REJECT" }> => ({
  outcome: "REJECT",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
  revisionRequirements,
});

const escalationFor = (
  state: PlanReviewState,
): Extract<ReviewDecision, { readonly outcome: "ESCALATE" }> => ({
  outcome: "ESCALATE",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const expectPlanningError = (
  operation: () => unknown,
  codes: readonly TaskStorageError["code"][],
): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(codes).toContain(error.code);
  expect(error.message).not.toMatch(/SQLite|SQL|constraint|payload|\/Users\//i);
  return error;
};

const createMaterializedHistory = (storage: TaskStorage): DurableOrchestrationPlanningSnapshot => {
  seedHierarchy(storage);
  let snapshot = storage.beginDurablePlanning(planCandidate(1));
  storage.recordDurableReviewerDecision(
    BIG_TASK_ID,
    rejectionFor(snapshot.reviewState),
  );
  snapshot = storage.submitDurablePlannerRevision(planCandidate(2));
  storage.recordDurableReviewerDecision(
    BIG_TASK_ID,
    approvalFor(snapshot.reviewState),
  );
  return storage.materializeDurablePlan(BIG_TASK_ID);
};

describe("durable orchestration planning flow", () => {
  it("replays every meaningful phase exactly across close and reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);

      const reopenAt = (expected: DurableOrchestrationPlanningSnapshot): void => {
        storage.close();
        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(expected);
      };

      let snapshot = storage.beginDurablePlanning(planCandidate(1));
      expect(snapshot.reviewState.phase).toBe("AWAITING_REVIEW");
      reopenAt(snapshot);

      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState, ["保留顺序 😀 e\u0301"]),
      );
      expect(snapshot.reviewState).toMatchObject({
        phase: "AWAITING_REVISION",
        revisionRequirements: ["保留顺序 😀 e\u0301"],
      });
      reopenAt(snapshot);

      snapshot = storage.submitDurablePlannerRevision(planCandidate(2));
      expect(snapshot.reviewState).toMatchObject({
        phase: "AWAITING_REVIEW",
        automaticRevisionsUsed: 1,
      });
      reopenAt(snapshot);

      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(snapshot.reviewState),
      );
      expect(snapshot.reviewState.phase).toBe("APPROVED");
      reopenAt(snapshot);

      snapshot = storage.materializeDurablePlan(BIG_TASK_ID);
      expect(snapshot.materializedGraph).toMatchObject({
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        planRevision: 2,
      });
      expect(snapshot.materializedGraph?.subtasks.map(({ id }) => id)).toEqual([
        "st_plan_a",
        "st_plan_b",
      ]);
      expect(snapshot.materializedGraph?.dependencies).toEqual(
        snapshot.reviewState.candidate.dependencies,
      );
      expect(storage.getSubtaskById(SubtaskIdSchema.parse("st_plan_a"))).toBeNull();
      reopenAt(snapshot);
      storage.close();
    });
  });

  it("persists the two-revision ceiling and Reviewer escalation as terminal authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(planCandidate(5));
      for (const revision of [6, 7]) {
        snapshot = storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(snapshot.reviewState),
        );
        snapshot = storage.submitDurablePlannerRevision(planCandidate(revision));
      }
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      expect(snapshot.reviewState).toMatchObject({
        phase: "HUMAN_REQUIRED",
        humanReason: "PLAN_REVIEW_EXHAUSTED",
        automaticRevisionsUsed: 2,
      });
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      expectPlanningError(
        () => storage.submitDurablePlannerRevision(planCandidate(8)),
        ["INVALID_INPUT"],
      );
      storage.close();
    });

    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(planCandidate());
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        escalationFor(snapshot.reviewState),
      );
      expect(snapshot.reviewState).toMatchObject({
        phase: "HUMAN_REQUIRED",
        humanReason: "REVIEW_ESCALATED",
      });
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      expectPlanningError(() => storage.materializeDurablePlan(BIG_TASK_ID), ["INVALID_INPUT"]);
      storage.close();
    });
  });

  it("rejects stale decisions and invalid revisions without durable mutation", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(planCandidate(3));
      const before = snapshot;
      expectPlanningError(() => storage.materializeDurablePlan(BIG_TASK_ID), ["INVALID_INPUT"]);
      expectPlanningError(
        () =>
          storage.recordDurableReviewerDecision(BIG_TASK_ID, {
            ...approvalFor(snapshot.reviewState),
            candidateBinding: `${snapshot.reviewState.candidateBinding}-stale`,
          }),
        ["INVALID_INPUT"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(before);

      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      const awaitingRevision = snapshot;
      expectPlanningError(() => storage.submitDurablePlannerRevision(planCandidate(5)), ["INVALID_INPUT"]);
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(awaitingRevision);
      expectPlanningError(
        () => storage.recordDurableReviewerDecision(BIG_TASK_ID, rejectionFor(before.reviewState)),
        ["INVALID_INPUT"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(awaitingRevision);
    });
  });

  it("persists kernel-canonical dependency ordering without insertion-order drift", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const subtasks = [
        proposedSubtask("st_plan_a", 1),
        proposedSubtask("st_plan_b", 1),
        proposedSubtask("st_plan_c", 1),
      ];
      const candidate: PlanCandidate = {
        kind: "PLAN_CANDIDATE",
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        revision: 1,
        subtasks,
        dependencies: [
          SubtaskDependencySchema.parse({
            upstreamSubtaskId: "st_plan_b",
            downstreamSubtaskId: "st_plan_c",
            dependencyType: "BLOCKING",
            requiredGate: "ACCEPTED",
            reason: "Second canonical edge.",
          }),
          SubtaskDependencySchema.parse({
            upstreamSubtaskId: "st_plan_a",
            downstreamSubtaskId: "st_plan_b",
            dependencyType: "BLOCKING",
            requiredGate: "HARDENED",
            reason: "First canonical edge.",
          }),
        ],
      };
      const snapshot = storage.beginDurablePlanning(candidate);
      expect(snapshot.reviewState.candidate.dependencies.map(({ upstreamSubtaskId }) => upstreamSubtaskId)).toEqual([
        "st_plan_a",
        "st_plan_b",
      ]);
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(snapshot);
      storage.close();
    });
  });

  it("binds candidates to the stored hierarchy and permits only same-Big-Task existing IDs", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      storage.createProject(makeProject("prj_other", "other"));
      storage.createBigTask(makeBigTask("bt_other", "prj_other"));
      storage.createSubtask(makeSubtask("st_plan_a", "bt_other"));

      expectPlanningError(
        () => storage.beginDurablePlanning(planCandidate(1)),
        ["CONFLICT"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      expectPlanningError(
        () =>
          storage.beginDurablePlanning(
            planCandidate(1, { projectId: "prj_other", bigTaskId: BIG_TASK_ID }),
          ),
        ["PARENT_NOT_FOUND"],
      );
      expectPlanningError(
        () =>
          storage.beginDurablePlanning(
            planCandidate(1, { bigTaskId: "bt_missing" }),
          ),
        ["PARENT_NOT_FOUND"],
      );
    });

    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      storage.createSubtask(makeSubtask("st_plan_a", BIG_TASK_ID));
      expect(storage.beginDurablePlanning(planCandidate())).toMatchObject({
        reviewState: { phase: "AWAITING_REVIEW" },
      });
      expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toHaveLength(1);
    });
  });

  it("freezes all planning mutations after materialization and keeps exact rematerialization idempotent", () => {
    withMemoryStorage((storage) => {
      const materialized = createMaterializedHistory(storage);
      expect(storage.materializeDurablePlan(BIG_TASK_ID)).toEqual(materialized);
      expectPlanningError(
        () => storage.beginDurablePlanning(planCandidate()),
        ["CONFLICT"],
      );
      expectPlanningError(
        () =>
          storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            approvalFor(materialized.reviewState),
          ),
        ["CONFLICT"],
      );
      expectPlanningError(
        () => storage.submitDurablePlannerRevision(planCandidate(3)),
        ["CONFLICT"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(materialized);
    });
  });

  it("returns deeply immutable snapshots and rejects unknown source fields", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      expectPlanningError(
        () =>
          storage.beginDurablePlanning({
            ...planCandidate(),
            arbitraryAuthority: "APPROVED",
          } as unknown as PlanCandidate),
        ["INVALID_INPUT"],
      );
      const snapshot = storage.beginDurablePlanning(planCandidate());
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.candidateHistory)).toBe(true);
      expect(Object.isFrozen(snapshot.reviewState)).toBe(true);
      expect(Object.isFrozen(snapshot.reviewState.candidate.subtasks)).toBe(true);
      expect(Object.isFrozen(snapshot.reviewState.candidate.dependencies)).toBe(true);
      expect(Object.keys(Object.getPrototypeOf(storage))).not.toContain("savePlanReviewState");
      expect(Object.keys(Object.getPrototypeOf(storage))).not.toContain("saveMaterializedGraph");
    });
  });
});

describe("durable orchestration text policy", () => {
  const accepted = [
    "ordinary English",
    "普通中文",
    "valid emoji 😀",
    "combining e\u0301",
    "precomposed é",
  ];

  for (const text of accepted) {
    it(`preserves accepted Unicode exactly: ${text}`, () => {
      withMemoryStorage((storage) => {
        seedHierarchy(storage);
        const candidate = planCandidate(1, {
          taskContractRef: text,
          dependencyReason: text,
        });
        let snapshot = storage.beginDurablePlanning(candidate);
        expect(snapshot.reviewState.candidate.subtasks[0]?.taskContractRef).toBe(text);
        expect(snapshot.reviewState.candidate.dependencies[0]?.reason).toBe(text);
        snapshot = storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(snapshot.reviewState, [text]),
        );
        expect(snapshot.reviewState).toMatchObject({ revisionRequirements: [text] });
      });
    });
  }

  it("keeps canonically equivalent spellings distinct without normalization", () => {
    const bindings: string[] = [];
    for (const text of ["é", "e\u0301"]) {
      withMemoryStorage((storage) => {
        seedHierarchy(storage);
        const snapshot = storage.beginDurablePlanning(
          planCandidate(1, { taskContractRef: text }),
        );
        bindings.push(snapshot.reviewState.candidateBinding);
        expect(snapshot.reviewState.candidate.subtasks[0]?.taskContractRef).toBe(text);
      });
    }
    expect(bindings[0]).not.toBe(bindings[1]);
  });

  const rejected = [
    ["NUL", "\u0000"],
    ["TAB", "\u0009"],
    ["LF", "\u000a"],
    ["CR", "\u000d"],
    ["ESC", "\u001b"],
    ["C1", "\u0085"],
    ["unpaired high surrogate", "\ud800"],
    ["unpaired low surrogate", "\udc00"],
  ] as const;

  for (const [label, text] of rejected) {
    it(`rejects ${label} in candidate and Reviewer text without mutation`, () => {
      withMemoryStorage((storage) => {
        seedHierarchy(storage);
        expectPlanningError(
          () => storage.beginDurablePlanning(planCandidate(1, { taskContractRef: `x${text}` })),
          ["INVALID_INPUT"],
        );
        let snapshot = storage.beginDurablePlanning(planCandidate());
        expectPlanningError(
          () =>
            storage.recordDurableReviewerDecision(
              BIG_TASK_ID,
              rejectionFor(snapshot.reviewState, [`x${text}`]),
            ),
          ["INVALID_INPUT"],
        );
        snapshot = storage.getDurablePlanningSnapshot(BIG_TASK_ID)!;
        expect(snapshot.reviewState.phase).toBe("AWAITING_REVIEW");
        expect(snapshot.reviewDecisions).toEqual([]);
      });
    });
  }

  it("enforces the 1,000 UTF-16-unit boundary and accepts valid surrogate pairs", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      expect(
        storage.beginDurablePlanning(
          planCandidate(1, { taskContractRef: `${"a".repeat(998)}😀` }),
        ).reviewState.candidate.subtasks[0]?.taskContractRef,
      ).toHaveLength(1_000);
    });
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      expectPlanningError(
        () =>
          storage.beginDurablePlanning(
            planCandidate(1, { taskContractRef: `${"a".repeat(999)}😀` }),
          ),
        ["INVALID_INPUT"],
      );
    });
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(
        planCandidate(1, { dependencyReason: "a".repeat(1_000) }),
      );
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState, ["a".repeat(1_000)]),
      );
      expect(snapshot.reviewState).toMatchObject({ phase: "AWAITING_REVISION" });
    });
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const candidate = planCandidate();
      expectPlanningError(
        () =>
          storage.beginDurablePlanning(
            {
              ...candidate,
              dependencies: [
                { ...candidate.dependencies[0]!, reason: "a".repeat(1_001) },
              ],
            },
          ),
        ["INVALID_INPUT"],
      );
      const snapshot = storage.beginDurablePlanning(planCandidate());
      expectPlanningError(
        () =>
          storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            rejectionFor(snapshot.reviewState, ["a".repeat(1_001)]),
          ),
        ["INVALID_INPUT"],
      );
    });
  });
});

describe("durable orchestration atomicity and two-handle authority", () => {
  it("rolls back every planning mutation without partial artifacts", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      expectPlanningError(
        () =>
          storage.runInTransaction((transaction) => {
            transaction.beginDurablePlanning(planCandidate());
            throw new Error("inject begin failure");
          }),
        ["TRANSACTION_FAILED"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();

      let snapshot = storage.beginDurablePlanning(planCandidate());
      expectPlanningError(
        () =>
          storage.runInTransaction((transaction) => {
            transaction.recordDurableReviewerDecision(
              BIG_TASK_ID,
              rejectionFor(snapshot.reviewState),
            );
            throw new Error("inject decision failure");
          }),
        ["TRANSACTION_FAILED"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.reviewDecisions).toEqual([]);

      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      expectPlanningError(
        () =>
          storage.runInTransaction((transaction) => {
            transaction.submitDurablePlannerRevision(planCandidate(2));
            throw new Error("inject revision failure");
          }),
        ["TRANSACTION_FAILED"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.candidateHistory).toHaveLength(1);

      snapshot = storage.submitDurablePlannerRevision(planCandidate(2));
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(snapshot.reviewState),
      );
      expectPlanningError(
        () =>
          storage.runInTransaction((transaction) => {
            transaction.materializeDurablePlan(BIG_TASK_ID);
            throw new Error("inject materialization failure");
          }),
        ["TRANSACTION_FAILED"],
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.materializedGraph).toBeNull();
    });
  });

  it(
    "serializes competing handles into one linear planning authority",
    () => {
      withTemporaryDatabasePath((databasePath) => {
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        seed.close();
        const first = openTaskDatabase({ databasePath, clock: fixedClock });
        const second = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          first.runInTransaction((transaction) => {
            transaction.beginDurablePlanning(planCandidate());
            expectPlanningError(
              () => second.beginDurablePlanning(planCandidate()),
              ["TRANSACTION_FAILED"],
            );
          });
          expectPlanningError(
            () => second.beginDurablePlanning(planCandidate()),
            ["CONFLICT"],
          );

          let snapshot = first.getDurablePlanningSnapshot(BIG_TASK_ID)!;
          const rejection = rejectionFor(snapshot.reviewState);
          snapshot = first.recordDurableReviewerDecision(BIG_TASK_ID, rejection);
          expectPlanningError(
            () => second.recordDurableReviewerDecision(BIG_TASK_ID, rejection),
            ["INVALID_INPUT"],
          );

          snapshot = second.submitDurablePlannerRevision(planCandidate(2));
          expectPlanningError(
            () => first.submitDurablePlannerRevision(planCandidate(2)),
            ["INVALID_INPUT"],
          );
          expectPlanningError(
            () => first.submitDurablePlannerRevision(planCandidate(3)),
            ["INVALID_INPUT"],
          );

          snapshot = first.recordDurableReviewerDecision(
            BIG_TASK_ID,
            approvalFor(snapshot.reviewState),
          );
          const firstMaterialization = first.materializeDurablePlan(BIG_TASK_ID);
          const secondMaterialization = second.materializeDurablePlan(BIG_TASK_ID);
          expect(secondMaterialization).toEqual(firstMaterialization);
          expect(firstMaterialization.candidateHistory).toHaveLength(2);
          expect(firstMaterialization.reviewDecisions).toHaveLength(2);
        } finally {
          first.close();
          second.close();
        }
      });
    },
    10_000,
  );
});

describe("durable orchestration corruption handling", () => {
  const corruptAndRead = (mutation: (sqlite: DatabaseSync) => void): TaskStorageError => {
    let observed!: TaskStorageError;
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
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
        observed = captureTaskStorageError(() =>
          reopened.getDurablePlanningSnapshot(BIG_TASK_ID),
        );
        expect(observed.code).toBe("MALFORMED_STORED_DATA");
      } finally {
        reopened.close();
      }
    });
    return observed;
  };

  const mutateCandidatePayload = (
    sqlite: DatabaseSync,
    mutation: (payload: Record<string, unknown>) => void,
  ): void => {
    const row = sqlite
      .prepare(
        "SELECT candidate_payload FROM orchestration_plan_candidates WHERE big_task_id = ? AND revision = 2",
      )
      .get(BIG_TASK_ID) as { readonly candidate_payload: string };
    const payload = JSON.parse(row.candidate_payload) as Record<string, unknown>;
    mutation(payload);
    sqlite
      .prepare(
        "UPDATE orchestration_plan_candidates SET candidate_payload = ? WHERE big_task_id = ? AND revision = 2",
      )
      .run(JSON.stringify(payload), BIG_TASK_ID);
  };

  const payloadCases: readonly [string, (payload: Record<string, unknown>) => void][] = [
    ["Project ID", (payload) => { payload.projectId = "prj_other"; }],
    ["Big Task ID", (payload) => { payload.bigTaskId = "bt_other"; }],
    ["revision", (payload) => { payload.revision = 9; }],
    ["profile", (payload) => {
      (payload.subtasks as Record<string, unknown>[])[0]!.profile = "LOW";
    }],
    ["writeEnabled", (payload) => {
      (payload.subtasks as Record<string, unknown>[])[0]!.writeEnabled = 1;
    }],
    ["taskContractRef", (payload) => {
      (payload.subtasks as Record<string, unknown>[])[0]!.taskContractRef = "corrupt\u0000ref";
    }],
    ["dependency endpoint", (payload) => {
      (payload.dependencies as Record<string, unknown>[])[0]!.upstreamSubtaskId = "st_missing";
    }],
    ["dependency type", (payload) => {
      (payload.dependencies as Record<string, unknown>[])[0]!.dependencyType = "INFORMATIONAL";
    }],
    ["dependency gate", (payload) => {
      (payload.dependencies as Record<string, unknown>[])[0]!.requiredGate = "HARDENED";
    }],
    ["dependency reason", (payload) => {
      (payload.dependencies as Record<string, unknown>[])[0]!.reason = "changed";
    }],
  ];

  for (const [label, mutation] of payloadCases) {
    it(`fails closed for corrupted candidate ${label}`, () => {
      corruptAndRead((sqlite) => mutateCandidatePayload(sqlite, mutation));
    });
  }

  const rowCorruptions: readonly [string, (sqlite: DatabaseSync) => void][] = [
    ["candidate Project column", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_plan_candidates SET project_id = 'prj_other' WHERE revision = 2").run();
    }],
    ["candidate Big Task column", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_plan_candidates SET big_task_id = 'bt_other' WHERE revision = 1").run();
    }],
    ["candidate revision column", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_plan_candidates SET revision = 8 WHERE revision = 2").run();
    }],
    ["candidate binding", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_plan_candidates SET candidate_binding = candidate_binding || '-corrupt' WHERE revision = 2").run();
    }],
    ["Reviewer outcome", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_review_decisions SET outcome = 'ESCALATE', revision_requirements = NULL WHERE plan_revision = 1").run();
    }],
    ["Reviewer candidate binding", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_review_decisions SET candidate_binding = candidate_binding || '-corrupt' WHERE plan_revision = 2").run();
    }],
    ["Reviewer revision requirements", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_review_decisions SET revision_requirements = '[\"bad\\u0000text\"]' WHERE plan_revision = 1").run();
    }],
    ["materialization revision", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_materializations SET plan_revision = 9").run();
    }],
    ["materialization binding", (sqlite) => {
      sqlite.prepare("UPDATE orchestration_materializations SET candidate_binding = candidate_binding || '-corrupt'").run();
    }],
    ["missing history artifact", (sqlite) => {
      sqlite.prepare("DELETE FROM orchestration_review_decisions WHERE plan_revision = 1").run();
    }],
    ["branching artifact", (sqlite) => {
      const row = sqlite.prepare("SELECT * FROM orchestration_plan_candidates WHERE revision = 2").get() as Record<string, unknown>;
      sqlite.prepare(
        "INSERT INTO orchestration_plan_candidates (big_task_id, project_id, revision, candidate_payload, candidate_binding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        String(row.big_task_id),
        String(row.project_id),
        3,
        String(row.candidate_payload),
        `${String(row.candidate_binding)}-branch`,
        String(row.created_at),
      );
    }],
  ];

  for (const [label, mutation] of rowCorruptions) {
    it(`fails closed for corrupted ${label}`, () => {
      corruptAndRead(mutation);
    });
  }
});

describe("durable orchestration migration", () => {
  const previousMigrationNames = [
    "20260809002701_public_mephisto",
    "20260809150746_groovy_iron_monger",
    "20260810133952_messy_shatterstar",
    "20260810161248_crazy_lightspeed",
    "20260811143107_spicy_apocalypse",
    "20260830145904_tough_puma",
    "20260830155716_spicy_dust",
    "20260830175200_acoustic_scream",
    "20260831044031_tired_riptide",
  ] as const;
  const migrationsRoot = fileURLToPath(new URL("../drizzle", import.meta.url));

  const createPreviousDatabase = (databasePath: string): void => {
    const previousFolder = join(dirname(databasePath), "previous-migrations");
    mkdirSync(previousFolder);
    for (const name of previousMigrationNames) {
      cpSync(join(migrationsRoot, name), join(previousFolder, basename(name)), {
        recursive: true,
      });
    }
    const prior = openTaskDatabase({
      databasePath,
      clock: fixedClock,
      migrationsFolder: previousFolder,
    });
    seedHierarchy(prior);
    prior.close();
  };

  it("migrates the accepted latest database without data loss or fabricated planning rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      createPreviousDatabase(databasePath);
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getProjectById(PROJECT_ID)).toEqual(
        makeProject(PROJECT_ID, PROJECT_ID.replaceAll("_", "-")),
      );
      expect(storage.getBigTaskById(BIG_TASK_ID)).toEqual(makeBigTask(BIG_TASK_ID, PROJECT_ID));
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      const materialized = createMaterializedHistoryOnExistingHierarchy(storage);
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toEqual(materialized);
      expect(storage.isForeignKeyEnforcementEnabled()).toBe(true);
      storage.close();
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 11 });
      } finally {
        sqlite.close();
      }
    });
  });

  it("fails a colliding migration closed while preserving legacy user data", () => {
    withTemporaryDatabasePath((databasePath) => {
      createPreviousDatabase(databasePath);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("CREATE TABLE orchestration_planning_tracks (collision_sentinel TEXT)");
      sqlite.close();

      expect(() => openTaskDatabase({ databasePath, clock: fixedClock })).toThrow(
        expect.objectContaining({ code: "MIGRATION_FAILED" }),
      );
      const verified = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(verified.prepare("SELECT id FROM projects WHERE id = ?").get(PROJECT_ID)).toEqual({ id: PROJECT_ID });
        expect(verified.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 9 });
        expect(verified.prepare("PRAGMA table_info(orchestration_planning_tracks)").all()).toEqual([
          expect.objectContaining({ name: "collision_sentinel" }),
        ]);
      } finally {
        verified.close();
      }
    });
  });
});

const createMaterializedHistoryOnExistingHierarchy = (
  storage: TaskStorage,
): DurableOrchestrationPlanningSnapshot => {
  const snapshot = storage.beginDurablePlanning(planCandidate(1));
  storage.recordDurableReviewerDecision(
    BIG_TASK_ID,
    approvalFor(snapshot.reviewState),
  );
  return storage.materializeDurablePlan(BIG_TASK_ID);
};
