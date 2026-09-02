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
  ReviewDecision,
} from "@codex-task-console/orchestration";
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

const PROJECT_ID = ProjectIdSchema.parse("prj_contract_authority");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_contract_authority");

const candidate = (
  revision = 1,
  count = 2,
  referenceFor: (index: number) => string = (index) =>
    `contract-ref-${index}`,
): PlanCandidate => ({
  kind: "PLAN_CANDIDATE",
  projectId: PROJECT_ID,
  bigTaskId: BIG_TASK_ID,
  revision,
  subtasks: Array.from({ length: count }, (_, index) => ({
    id: SubtaskIdSchema.parse(`st_contract_${index}`),
    bigTaskId: BIG_TASK_ID,
    profile: index % 2 === 0 ? "STANDARD" : "HIGH_RISK_FOUNDATION",
    taskContractRef: referenceFor(index),
    writeEnabled: index % 2 === 0,
  })),
  dependencies: [],
});

const contractsFor = (
  plan: PlanCandidate,
  contentFor: (index: number) => string = (index) => `Intent ${index}`,
): readonly TaskContractV0[] =>
  plan.subtasks.map((subtask, index) =>
    TaskContractV0Schema.parse({
      taskContractRef: subtask.taskContractRef,
      projectId: plan.projectId,
      bigTaskId: plan.bigTaskId,
      subtaskId: subtask.id,
      title: `Task Contract ${index}`,
      goal: contentFor(index),
      scopeIn: [`Scope ${index}`],
      scopeOut: [],
      acceptanceCriteria: [`Acceptance ${index}`],
      untouchedAreas: [],
      promptSeed: `Prompt ${index}`,
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
    }),
  );

const seedHierarchy = (storage: TaskStorage): void => {
  storage.createProject(makeProject(PROJECT_ID, "contract-authority"));
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
  revisionRequirements: ["Revise the exact candidate."],
});

const expectError = (
  operation: () => unknown,
  code: TaskStorageError["code"],
): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe(code);
  expect(error.message).not.toMatch(/SQLite|SQL|constraint|payload|\/Users\//i);
  return error;
};

describe("immutable Task Contract authority", () => {
  it("persists an atomic pre-review bundle and derives approved/materialized authority", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const plan = candidate();
      const contracts = contractsFor(plan);
      const reviewBundle = storage.beginDurablePlanningBundle(plan, contracts);

      expect(reviewBundle).toMatchObject({
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        candidateBinding: reviewBundle.reviewState.candidateBinding,
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        taskContracts: contracts,
      });
      expect(reviewBundle.reviewState.phase).toBe("AWAITING_REVIEW");
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        reviewPhase: "AWAITING_REVIEW",
      });

      const approved = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(reviewBundle.reviewState),
      );
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toEqual({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        planRevision: 1,
        candidateBinding: approved.reviewState.candidateBinding,
        reviewPhase: "APPROVED",
        materialized: false,
        taskContracts: contracts,
      });

      storage.materializeDurablePlan(BIG_TASK_ID);
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        materialized: true,
        taskContracts: contracts,
      });
      for (const proposed of plan.subtasks) {
        expect(storage.getSubtaskById(proposed.id)).toBeNull();
      }
    });
  });

  it("keeps every plain Step 8B1 phase compatible and reports NOT READY", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      let snapshot = storage.beginDurablePlanning(candidate());
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        taskContracts: [],
      });
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(snapshot.reviewState),
      );
      expect(snapshot.reviewState.phase).toBe("APPROVED");
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        reviewPhase: "APPROVED",
      });
      storage.materializeDurablePlan(BIG_TASK_ID);
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        materialized: true,
      });
    });
  });

  it("rejects missing, extra, duplicate, and substituted contracts atomically", () => {
    const mutations: readonly ((
      plan: PlanCandidate,
      contracts: readonly TaskContractV0[],
    ) => readonly TaskContractV0[])[] = [
      (_plan, contracts) => contracts.slice(1),
      (_plan, contracts) => [
        ...contracts,
        TaskContractV0Schema.parse({
          ...contracts[0]!,
          subtaskId: "st_extra",
          taskContractRef: "extra-ref",
        }),
      ],
      (_plan, contracts) => [contracts[0]!, contracts[0]!],
      (_plan, contracts) => [
        TaskContractV0Schema.parse({
          ...contracts[0]!,
          taskContractRef: contracts[1]!.taskContractRef,
        }),
        contracts[1]!,
      ],
      (_plan, contracts) => [
        TaskContractV0Schema.parse({
          ...contracts[0]!,
          projectId: "prj_substitution",
        }),
        contracts[1]!,
      ],
      (_plan, contracts) => [
        TaskContractV0Schema.parse({
          ...contracts[0]!,
          bigTaskId: "bt_substitution",
        }),
        contracts[1]!,
      ],
    ];

    for (const mutate of mutations) {
      withMemoryStorage((storage) => {
        seedHierarchy(storage);
        const plan = candidate();
        expectError(
          () =>
            storage.beginDurablePlanningBundle(
              plan,
              mutate(plan, contractsFor(plan)),
            ),
          "INVALID_INPUT",
        );
        expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      });
    }
  });

  it("reuses an exact immutable artifact across Planner revisions with a new association", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const firstPlan = candidate(1);
      const firstContracts = contractsFor(firstPlan);
      let bundle = storage.beginDurablePlanningBundle(firstPlan, firstContracts);
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );

      const secondPlan = candidate(2);
      bundle = storage.submitDurablePlannerRevisionBundle(
        secondPlan,
        firstContracts,
      );
      expect(bundle.taskContracts).toEqual(firstContracts);
      expect(bundle.reviewState.candidate.revision).toBe(2);
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      expect(
        (sqlite.prepare("SELECT count(*) AS count FROM task_contracts").get() as {
          count: number;
        }).count,
      ).toBe(2);
      expect(
        (
          sqlite
            .prepare("SELECT count(*) AS count FROM candidate_task_contract_bindings")
            .get() as { count: number }
        ).count,
      ).toBe(4);
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        planRevision: 2,
        taskContracts: firstContracts,
      });
      storage.close();
    });
  });

  it("fails closed when a reference is retargeted and accepts changed content under a new ref", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const firstPlan = candidate(1);
      let bundle = storage.beginDurablePlanningBundle(
        firstPlan,
        contractsFor(firstPlan),
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );

      const sameRefs = candidate(2);
      expectError(
        () =>
          storage.submitDurablePlannerRevisionBundle(
            sameRefs,
            contractsFor(sameRefs, (index) => `Changed intent ${index}`),
          ),
        "CONFLICT",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.candidateHistory).toHaveLength(1);

      const newRefs = candidate(2, 2, (index) => `contract-ref-${index}-v2`);
      const changed = contractsFor(newRefs, (index) => `Changed intent ${index}`);
      bundle = storage.submitDurablePlannerRevisionBundle(newRefs, changed);
      expect(bundle.taskContracts).toEqual(changed);
    });
  });

  it("fails closed on any preexisting canonical Subtask ID without adoption", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      storage.createSubtask(makeSubtask("st_contract_0", BIG_TASK_ID));
      expectError(
        () => {
          const plan = candidate();
          storage.beginDurablePlanningBundle(plan, contractsFor(plan));
        },
        "CONFLICT",
      );
      expect(storage.getSubtaskById(SubtaskIdSchema.parse("st_contract_0"))).not.toBeNull();
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
    });
  });

  it("cannot retroactively attach authority after APPROVE or MATERIALIZE", () => {
    for (const materialize of [false, true]) {
      withMemoryStorage((storage) => {
        seedHierarchy(storage);
        const first = storage.beginDurablePlanning(candidate());
        storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          approvalFor(first.reviewState),
        );
        if (materialize) {
          storage.materializeDurablePlan(BIG_TASK_ID);
        }
        const revision = candidate(2);
        expectError(
          () =>
            storage.submitDurablePlannerRevisionBundle(
              revision,
              contractsFor(revision),
            ),
          materialize ? "CONFLICT" : "INVALID_INPUT",
        );
        expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
          taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        });
      });
    }
  });

  it("rolls back an inner partial bundle while the outer transaction commits unrelated work", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const firstPlan = candidate(1);
      const first = storage.beginDurablePlanningBundle(
        firstPlan,
        contractsFor(firstPlan),
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(first.reviewState),
      );

      storage.runInTransaction((transaction) => {
        const secondPlan = candidate(2);
        expectError(
          () =>
            transaction.submitDurablePlannerRevisionBundle(
              secondPlan,
              contractsFor(secondPlan, () => "Retargeted content"),
            ),
          "CONFLICT",
        );
        transaction.createProject(
          makeProject("prj_outer_commit", "outer-commit"),
        );
      });

      expect(storage.getProjectById(ProjectIdSchema.parse("prj_outer_commit"))).not.toBeNull();
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.candidateHistory).toHaveLength(1);
    });
  });

  it.each(Array.from({ length: 16 }, (_, index) => index))(
    "serializes competing handles without dirty or retargeted authority iteration %i",
    () => {
    withTemporaryDatabasePath((databasePath) => {
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(seed);
      seed.close();
      const first = openTaskDatabase({ databasePath, clock: fixedClock });
      const second = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const plan = candidate();
        const contracts = contractsFor(plan);
        const winner = first.beginDurablePlanningBundle(plan, contracts);
        expectError(
          () => second.beginDurablePlanningBundle(plan, contracts),
          "CONFLICT",
        );
        first.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(winner.reviewState),
        );
        const revision = candidate(2);
        const revisionBundle = second.submitDurablePlannerRevisionBundle(
          revision,
          contracts,
        );
        expectError(
          () =>
            first.submitDurablePlannerRevisionBundle(
              revision,
              contractsFor(revision, () => "Retargeted loser"),
            ),
          "INVALID_INPUT",
        );
        expect(first.getDurablePlanningReviewBundle(BIG_TASK_ID)).toEqual(
          revisionBundle,
        );
      } finally {
        first.close();
        second.close();
      }
    });
    },
  );

  it("does not expose an uncommitted Task Contract bundle to another handle", () => {
    withTemporaryDatabasePath((databasePath) => {
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(seed);
      seed.close();
      const writer = openTaskDatabase({ databasePath, clock: fixedClock });
      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        writer.runInTransaction((transaction) => {
          const pending = candidate();
          transaction.beginDurablePlanningBundle(
            pending,
            contractsFor(pending),
          );
          expect(reader.getDurablePlanningReviewBundle(BIG_TASK_ID)).toBeNull();
        });
        expect(reader.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
          taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        });
      } finally {
        writer.close();
        reader.close();
      }
    });
  });

  it("reopens rejected, revised, approved, and materialized history with only current authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const reopen = (): void => {
        storage.close();
        storage = openTaskDatabase({ databasePath, clock: fixedClock });
      };

      const firstPlan = candidate(1);
      const firstContracts = contractsFor(firstPlan);
      let bundle = storage.beginDurablePlanningBundle(firstPlan, firstContracts);
      reopen();
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toEqual(bundle);

      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );
      reopen();
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        reviewPhase: "AWAITING_REVISION",
      });

      const secondPlan = candidate(2, 2, (index) => `current-ref-${index}`);
      const secondContracts = contractsFor(
        secondPlan,
        (index) => `Current executable intent ${index}`,
      );
      bundle = storage.submitDurablePlannerRevisionBundle(
        secondPlan,
        secondContracts,
      );
      reopen();
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toEqual(bundle);
      const approved = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      reopen();
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toEqual({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID,
        planRevision: 2,
        candidateBinding: approved.reviewState.candidateBinding,
        reviewPhase: "APPROVED",
        materialized: false,
        taskContracts: secondContracts,
      });
      storage.materializeDurablePlan(BIG_TASK_ID);
      reopen();
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        materialized: true,
        taskContracts: secondContracts,
      });
      storage.close();
    });
  });

  it("uses Project-scoped opaque reference identity and rejects same-Project retargeting", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const firstPlan = candidate(1, 1, () => "shared-opaque-ref");
      storage.beginDurablePlanningBundle(firstPlan, contractsFor(firstPlan));

      const secondProjectId = ProjectIdSchema.parse("prj_second_contract_scope");
      const secondBigTaskId = BigTaskIdSchema.parse("bt_second_contract_scope");
      storage.createProject(makeProject(secondProjectId, "second-contract-scope"));
      storage.createBigTask(makeBigTask(secondBigTaskId, secondProjectId));
      const secondPlan: PlanCandidate = {
        kind: "PLAN_CANDIDATE",
        projectId: secondProjectId,
        bigTaskId: secondBigTaskId,
        revision: 1,
        subtasks: [
          {
            id: SubtaskIdSchema.parse("st_second_contract_scope"),
            bigTaskId: secondBigTaskId,
            profile: "STANDARD",
            taskContractRef: "shared-opaque-ref",
            writeEnabled: true,
          },
        ],
        dependencies: [],
      };
      expect(
        storage.beginDurablePlanningBundle(
          secondPlan,
          contractsFor(secondPlan),
        ).taskContracts[0]?.projectId,
      ).toBe(secondProjectId);

      const sameProjectBigTaskId = BigTaskIdSchema.parse("bt_same_project_scope");
      storage.createBigTask(makeBigTask(sameProjectBigTaskId, PROJECT_ID));
      const sameProjectPlan: PlanCandidate = {
        ...secondPlan,
        projectId: PROJECT_ID,
        bigTaskId: sameProjectBigTaskId,
        subtasks: [
          {
            ...secondPlan.subtasks[0]!,
            id: SubtaskIdSchema.parse("st_same_project_scope"),
            bigTaskId: sameProjectBigTaskId,
          },
        ],
      };
      expectError(
        () =>
          storage.beginDurablePlanningBundle(
            sameProjectPlan,
            contractsFor(sameProjectPlan),
          ),
        "CONFLICT",
      );
      expect(storage.getDurablePlanningSnapshot(sameProjectBigTaskId)).toBeNull();
    });
  });

  it("rejects invalid or regressing clocks atomically", () => {
    withTemporaryDatabasePath((databasePath) => {
      let now = new Date("2026-08-10T00:00:00.000Z");
      const storage = openTaskDatabase({ databasePath, clock: () => now });
      seedHierarchy(storage);
      const pending = candidate();
      const bundle = storage.beginDurablePlanningBundle(
        pending,
        contractsFor(pending),
      );
      now = new Date("2026-08-09T00:00:00.000Z");
      expectError(
        () =>
          storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            rejectionFor(bundle.reviewState),
          ),
        "STORAGE_OPERATION_FAILED",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.reviewDecisions).toEqual([]);
      storage.close();
    });

    withTemporaryDatabasePath((databasePath) => {
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(seed);
      seed.close();
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(Number.NaN),
      });
      const pending = candidate();
      expectError(
        () =>
          storage.beginDurablePlanningBundle(
            pending,
            contractsFor(pending),
          ),
        "STORAGE_OPERATION_FAILED",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      storage.close();
    });
  });

  it("round-trips canonical multilingual serialization without Unicode normalization", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const multilingualPlan = candidate(
        1,
        2,
        (index) => (index === 0 ? "ref-café-😀" : "ref-cafe\u0301-😀"),
      );
      const multilingualContracts = contractsFor(multilingualPlan).map(
        (contract, index) =>
          TaskContractV0Schema.parse({
            ...contract,
            title: index === 0 ? "任务 café 😀" : "任务 cafe\u0301 😀",
            promptSeed: `严格保留 ${index} 日本語 😀`,
          }),
      );
      const bundle = storage.beginDurablePlanningBundle(
        multilingualPlan,
        multilingualContracts,
      );
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toEqual(bundle);
      expect(bundle.taskContracts[0]?.title).not.toBe(bundle.taskContracts[1]?.title);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      const payloads = sqlite
        .prepare("SELECT contract_payload FROM task_contracts ORDER BY task_contract_ref")
        .all()
        .map((row) => (row as { readonly contract_payload: string }).contract_payload);
      expect(new Set(payloads)).toEqual(
        new Set(multilingualContracts.map((contract) => JSON.stringify(contract))),
      );
      sqlite.close();
    });
  });

  it.each([31, 64])("round-trips an immutable %i-Subtask bundle", (count) => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const plan = candidate(1, count);
      const contracts = contractsFor(plan);
      const bundle = storage.beginDurablePlanningBundle(plan, contracts);
      expect(bundle.taskContracts).toHaveLength(count);
      expect(Object.isFrozen(bundle)).toBe(true);
      expect(Object.isFrozen(bundle.taskContracts)).toBe(true);
      expect(Object.isFrozen(bundle.taskContracts[0])).toBe(true);
    });
  });
});
