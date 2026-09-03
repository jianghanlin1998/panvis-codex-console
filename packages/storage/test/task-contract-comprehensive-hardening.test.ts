import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

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

const PROJECT_ID = ProjectIdSchema.parse("prj_b2a_hardening");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_b2a_hardening");

interface CandidateOptions {
  readonly projectId?: string;
  readonly bigTaskId?: string;
  readonly ids?: readonly string[];
  readonly refs?: readonly string[];
  readonly profileFor?: (index: number) => "LOW" | "STANDARD" | "HIGH_RISK_FOUNDATION";
  readonly writeEnabledFor?: (index: number) => boolean;
}

const candidate = (
  revision = 1,
  options: CandidateOptions = {},
): PlanCandidate => {
  const projectId = ProjectIdSchema.parse(options.projectId ?? PROJECT_ID);
  const bigTaskId = BigTaskIdSchema.parse(options.bigTaskId ?? BIG_TASK_ID);
  const ids = options.ids ?? ["st_b2a_a", "st_b2a_b"];
  const refs = options.refs ?? ids.map((id) => `contracts/${id}`);
  if (ids.length !== refs.length) {
    throw new Error("Test candidate IDs and refs must align.");
  }
  return {
    kind: "PLAN_CANDIDATE",
    projectId,
    bigTaskId,
    revision,
    subtasks: ids.map((id, index) => ({
      id: SubtaskIdSchema.parse(id),
      bigTaskId,
      profile: options.profileFor?.(index) ?? "STANDARD",
      taskContractRef: refs[index]!,
      writeEnabled: options.writeEnabledFor?.(index) ?? true,
    })),
    dependencies: [],
  };
};

const contractFor = (
  plan: PlanCandidate,
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): TaskContractV0 => {
  const subtask = plan.subtasks[index]!;
  return TaskContractV0Schema.parse({
    taskContractRef: subtask.taskContractRef,
    projectId: plan.projectId,
    bigTaskId: plan.bigTaskId,
    subtaskId: subtask.id,
    title: `Task Contract ${subtask.id}`,
    goal: `Goal for ${subtask.taskContractRef}`,
    scopeIn: [`Scope for ${subtask.id}`],
    scopeOut: [],
    acceptanceCriteria: [`Accept ${subtask.id}`],
    untouchedAreas: [],
    promptSeed: `Prompt for ${subtask.taskContractRef}`,
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
    ...overrides,
  });
};

const contractsFor = (plan: PlanCandidate): readonly TaskContractV0[] =>
  plan.subtasks.map((_subtask, index) => contractFor(plan, index));

const seedHierarchy = (
  storage: TaskStorage,
  projectId = PROJECT_ID,
  bigTaskId = BIG_TASK_ID,
  slug = "b2a-hardening",
): void => {
  storage.createProject(makeProject(projectId, slug));
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
): Extract<ReviewDecision, { readonly outcome: "REJECT" }> => ({
  outcome: "REJECT",
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
  revisionRequirements: ["Revise the exact current candidate."],
});

const expectStorageError = (
  operation: () => unknown,
  code: TaskStorageError["code"],
): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe(code);
  expect(error.message).not.toMatch(
    /SQLite|SQL|constraint|trigger|payload|\/Users\//i,
  );
  return error;
};

const installSql = (databasePath: string, sql: string): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec(sql);
  } finally {
    sqlite.close();
  }
};

const authorityCounts = (databasePath: string): Readonly<Record<string, number>> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: string): number =>
      (
        sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        }
      ).count;
    return {
      tracks: count("orchestration_planning_tracks"),
      candidates: count("orchestration_plan_candidates"),
      contracts: count("task_contracts"),
      bindings: count("candidate_task_contract_bindings"),
    };
  } finally {
    sqlite.close();
  }
};

describe("Step 8B2a authority identity and composition hardening", () => {
  it("reuses unchanged contracts while candidate profile and write authority change", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const firstPlan = candidate(1, {
        profileFor: (index) => (index === 0 ? "LOW" : "STANDARD"),
        writeEnabledFor: (index) => index === 0,
      });
      const immutableContracts = contractsFor(firstPlan);
      let bundle = storage.beginDurablePlanningBundle(
        firstPlan,
        immutableContracts,
      );
      const firstBinding = bundle.candidateBinding;
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );

      const revisedPlan = candidate(2, {
        profileFor: (index) =>
          index === 0 ? "HIGH_RISK_FOUNDATION" : "LOW",
        writeEnabledFor: (index) => index !== 0,
      });
      bundle = storage.submitDurablePlannerRevisionBundle(
        revisedPlan,
        immutableContracts,
      );
      expect(bundle.candidateBinding).not.toBe(firstBinding);
      expect(bundle.taskContracts).toEqual(immutableContracts);
      expect(bundle.reviewState.candidate.subtasks).toEqual(
        revisedPlan.subtasks,
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      storage.close();

      expect(authorityCounts(databasePath)).toMatchObject({
        contracts: 2,
        bindings: 4,
      });
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        planRevision: 2,
        taskContracts: immutableContracts,
      });
      storage.close();
    });
  });

  it.each([
    ["title", { title: "Retargeted title" }],
    ["goal", { goal: "Retargeted goal" }],
    ["scope", { scopeIn: ["Retargeted scope"] }],
    ["prompt", { promptSeed: "Retargeted prompt" }],
  ] as const)("fails closed when the same Project/ref retargets %s", (_label, change) => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const firstPlan = candidate();
      const initial = storage.beginDurablePlanningBundle(
        firstPlan,
        contractsFor(firstPlan),
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(initial.reviewState),
      );
      const revised = candidate(2);
      const changed = contractsFor(revised).map((contract, index) =>
        index === 0
          ? TaskContractV0Schema.parse({ ...contract, ...change })
          : contract,
      );
      expectStorageError(
        () => storage.submitDurablePlannerRevisionBundle(revised, changed),
        "CONFLICT",
      );
      expect(
        storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.candidateHistory,
      ).toHaveLength(1);
    });
  });

  it("fails a same-Project cross-Big-Task ref claim atomically and permits another Project", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const sharedRef = "shared-project-scoped-ref";
      const first = candidate(1, {
        ids: ["st_b2a_owner"],
        refs: [sharedRef],
      });
      storage.beginDurablePlanningBundle(first, contractsFor(first));

      const secondBigTaskId = BigTaskIdSchema.parse("bt_b2a_same_project");
      storage.createBigTask(makeBigTask(secondBigTaskId, PROJECT_ID));
      const sameProject = candidate(1, {
        bigTaskId: secondBigTaskId,
        ids: ["st_b2a_claim"],
        refs: [sharedRef],
      });
      expectStorageError(
        () =>
          storage.beginDurablePlanningBundle(
            sameProject,
            contractsFor(sameProject),
          ),
        "CONFLICT",
      );
      expect(storage.getDurablePlanningSnapshot(secondBigTaskId)).toBeNull();

      const otherProjectId = ProjectIdSchema.parse("prj_b2a_other");
      const otherBigTaskId = BigTaskIdSchema.parse("bt_b2a_other");
      seedHierarchy(
        storage,
        otherProjectId,
        otherBigTaskId,
        "b2a-other",
      );
      const otherProject = candidate(1, {
        projectId: otherProjectId,
        bigTaskId: otherBigTaskId,
        ids: ["st_b2a_other"],
        refs: [sharedRef],
      });
      expect(
        storage.beginDurablePlanningBundle(
          otherProject,
          contractsFor(otherProject),
        ).taskContracts[0]?.taskContractRef,
      ).toBe(sharedRef);
    });
  });

  it("treats path-, URL-, URN-, traversal-, and Unicode-looking refs as opaque text", () => {
    const refs = [
      "contracts/example.md",
      "../somewhere",
      "/absolute-looking/value",
      "https://example.invalid/contract",
      "urn:example:value",
      "任意の参照😀",
    ];
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const plan = candidate(1, {
        ids: refs.map((_ref, index) => `st_b2a_opaque_${index}`),
        refs,
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error("Task Contract refs must never be fetched.");
      }) as typeof fetch;
      try {
        expect(
          storage
            .beginDurablePlanningBundle(plan, contractsFor(plan))
            .taskContracts.map(({ taskContractRef }) => taskContractRef),
        ).toEqual(refs);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    const source = readFileSync(
      new URL("../src/orchestration-planning.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /node:(?:fs|path|http|https|net|child_process)|\bfetch\s*\(|@codex-task-console\/codex-adapter|\bgit\b/,
    );
  });

  it("composes plain and bundled candidates without promoting rejected history", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const snapshot = storage.beginDurablePlanning(candidate());
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      const bundledRevision = candidate(2);
      const current = storage.submitDurablePlannerRevisionBundle(
        bundledRevision,
        contractsFor(bundledRevision),
      );
      expect(current.taskContractAuthorityReadiness).toBe(
        "TASK_CONTRACT_AUTHORITY_READY",
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(current.reviewState),
      );
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        planRevision: 2,
      });
    });

    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const bundled = storage.beginDurablePlanningBundle(
        candidate(),
        contractsFor(candidate()),
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundled.reviewState),
      );
      const plain = storage.submitDurablePlannerRevision(candidate(2));
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(plain.reviewState),
      );
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
        reviewState: { phase: "APPROVED" },
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        taskContracts: [],
      });
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
      });
    });
  });

  it("keeps Review Bundle completeness distinct from review and execution authority", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      let bundle = storage.beginDurablePlanningBundle(
        candidate(),
        contractsFor(candidate()),
      );
      expect(bundle).toMatchObject({
        reviewState: { phase: "AWAITING_REVIEW" },
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
      });
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        reviewPhase: "AWAITING_REVIEW",
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
        materialized: false,
      });

      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
        reviewState: { phase: "AWAITING_REVISION" },
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
      });
      const revision = candidate(2, {
        refs: ["contracts/revision-2-a", "contracts/revision-2-b"],
      });
      bundle = storage.submitDurablePlannerRevisionBundle(
        revision,
        contractsFor(revision),
      );
      storage.recordDurableReviewerDecision(BIG_TASK_ID, {
        outcome: "ESCALATE",
        planRevision: bundle.reviewState.candidate.revision,
        candidateBinding: bundle.candidateBinding,
      });
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
        reviewState: { phase: "HUMAN_REQUIRED" },
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
      });
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        reviewPhase: "HUMAN_REQUIRED",
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
      });
    });
  });

  it("approves complete Task Contracts independently from an invalid graph", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const valid = candidate();
      const graphInvalid: PlanCandidate = {
        ...valid,
        subtasks: [
          {
            ...valid.subtasks[0]!,
            bigTaskId: BigTaskIdSchema.parse("bt_b2a_wrong_owner"),
          },
          valid.subtasks[1]!,
        ],
      };
      const contracts = contractsFor(graphInvalid);
      const bundle = storage.beginDurablePlanningBundle(graphInvalid, contracts);
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        materialized: false,
      });
      const error = expectStorageError(
        () => storage.materializeDurablePlan(BIG_TASK_ID),
        "DEPENDENCY_VALIDATION_FAILED",
      );
      expect(error.validationCodes).toContain("BIG_TASK_OWNERSHIP_MISMATCH");
      expect(storage.getSubtaskById(contracts[0]!.subtaskId)).toBeNull();
    });
  });
});

describe("Step 8B2a timing, collision, and corruption boundaries", () => {
  it("permits equal/forward reuse chronology and rejects a regressing revision clock", () => {
    withTemporaryDatabasePath((databasePath) => {
      let now = "2026-09-03T10:00:00.000Z";
      let storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(now),
      });
      seedHierarchy(storage);
      const firstPlan = candidate();
      const immutableContracts = contractsFor(firstPlan);
      let bundle = storage.beginDurablePlanningBundle(
        firstPlan,
        immutableContracts,
      );
      now = "2026-09-03T10:00:01.000Z";
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );

      now = "2026-09-03T09:59:59.000Z";
      expectStorageError(
        () =>
          storage.submitDurablePlannerRevisionBundle(
            candidate(2),
            immutableContracts,
          ),
        "STORAGE_OPERATION_FAILED",
      );
      expect(
        storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.candidateHistory,
      ).toHaveLength(1);

      now = "2026-09-03T10:00:01.000Z";
      bundle = storage.submitDurablePlannerRevisionBundle(
        candidate(2),
        immutableContracts,
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: () => new Date(now) });
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        planRevision: 2,
        taskContracts: immutableContracts,
      });
      storage.close();
    });
  });

  it.each([0, -1, 1.5, 99] as const)(
    "classifies bundle marker %s as malformed",
    (marker) => {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        storage.beginDurablePlanning(candidate());
        storage.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec(
          "DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable",
        );
        sqlite
          .prepare(
            "UPDATE orchestration_plan_candidates SET task_contract_count = ?",
          )
          .run(marker);
        sqlite.close();

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        expectStorageError(
          () => reopened.getDurablePlanningReviewBundle(BIG_TASK_ID),
          "MALFORMED_STORED_DATA",
        );
        reopened.close();
      });
    },
  );

  it("keeps legitimate NULL legacy history NOT_READY but rejects a legacy-owned artifact", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const plan = candidate();
      storage.beginDurablePlanning(plan);
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY",
      });
      storage.close();

      const contract = contractFor(plan, 0);
      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare(
          `INSERT INTO task_contracts
             (project_id, task_contract_ref, big_task_id, subtask_id, contract_payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          contract.projectId,
          contract.taskContractRef,
          contract.bigTaskId,
          contract.subtaskId,
          JSON.stringify(contract),
          "2026-08-09T00:00:00.000Z",
        );
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectStorageError(
        () => storage.getDurablePlanningReviewBundle(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("rejects forged post-approval attachment chronology", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const plan = candidate(1, {
        ids: ["st_b2a_forged"],
        refs: ["forged-ref"],
      });
      let snapshot = storage.beginDurablePlanning(plan);
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(snapshot.reviewState),
      );
      storage.close();

      const contract = contractFor(plan, 0);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        "DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable",
      );
      sqlite
        .prepare(
          "UPDATE orchestration_plan_candidates SET task_contract_count = 1",
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO task_contracts
             (project_id, task_contract_ref, big_task_id, subtask_id, contract_payload, created_at)
           VALUES (?, ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
        )
        .run(
          contract.projectId,
          contract.taskContractRef,
          contract.bigTaskId,
          contract.subtaskId,
          JSON.stringify(contract),
        );
      sqlite
        .prepare(
          `INSERT INTO candidate_task_contract_bindings
             (project_id, big_task_id, plan_revision, candidate_binding, subtask_id, task_contract_ref, created_at)
           VALUES (?, ?, 1, ?, ?, ?, '2026-08-09T00:00:00.000Z')`,
        )
        .run(
          plan.projectId,
          plan.bigTaskId,
          snapshot.reviewState.candidateBinding,
          contract.subtaskId,
          contract.taskContractRef,
        );
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectStorageError(
        () => storage.getApprovedTaskContractAuthority(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("does not let a rejected plain candidate acquire retroactive authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const plan = candidate(1, {
        ids: ["st_b2a_rejected_forge"],
        refs: ["rejected-forge-ref"],
      });
      let snapshot = storage.beginDurablePlanning(plan);
      snapshot = storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(snapshot.reviewState),
      );
      storage.close();

      const contract = contractFor(plan, 0);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        "DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable",
      );
      sqlite
        .prepare(
          "UPDATE orchestration_plan_candidates SET task_contract_count = 1",
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO task_contracts
             (project_id, task_contract_ref, big_task_id, subtask_id, contract_payload, created_at)
           VALUES (?, ?, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
        )
        .run(
          contract.projectId,
          contract.taskContractRef,
          contract.bigTaskId,
          contract.subtaskId,
          JSON.stringify(contract),
        );
      sqlite
        .prepare(
          `INSERT INTO candidate_task_contract_bindings
             (project_id, big_task_id, plan_revision, candidate_binding, subtask_id, task_contract_ref, created_at)
           VALUES (?, ?, 1, ?, ?, ?, '2026-08-10T00:00:00.000Z')`,
        )
        .run(
          plan.projectId,
          plan.bigTaskId,
          snapshot.reviewState.candidateBinding,
          contract.subtaskId,
          contract.taskContractRef,
        );
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectStorageError(
        () => storage.getDurablePlanningReviewBundle(BIG_TASK_ID),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("preserves historical authority when collisions appear after bundle creation", () => {
    for (const collisionPoint of [
      "BEFORE_REVISION",
      "BEFORE_APPROVAL",
      "AFTER_APPROVAL",
      "AFTER_MATERIALIZATION",
    ] as const) {
      withMemoryStorage((storage) => {
        seedHierarchy(storage);
        const bundle = storage.beginDurablePlanningBundle(
          candidate(),
          contractsFor(candidate()),
        );

        if (collisionPoint === "BEFORE_REVISION") {
          storage.recordDurableReviewerDecision(
            BIG_TASK_ID,
            rejectionFor(bundle.reviewState),
          );
          storage.createSubtask(makeSubtask("st_b2a_a", BIG_TASK_ID));
          const revision = candidate(2);
          expectStorageError(
            () =>
              storage.submitDurablePlannerRevisionBundle(
                revision,
                contractsFor(revision),
              ),
            "CONFLICT",
          );
          expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
            reviewState: { phase: "AWAITING_REVISION" },
            taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
          });
          return;
        }

        if (collisionPoint === "BEFORE_APPROVAL") {
          storage.createSubtask(makeSubtask("st_b2a_a", BIG_TASK_ID));
        }
        storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          approvalFor(bundle.reviewState),
        );
        if (collisionPoint === "AFTER_APPROVAL") {
          storage.createSubtask(makeSubtask("st_b2a_a", BIG_TASK_ID));
        }
        if (collisionPoint !== "AFTER_MATERIALIZATION") {
          storage.materializeDurablePlan(BIG_TASK_ID);
        } else {
          storage.materializeDurablePlan(BIG_TASK_ID);
          storage.createSubtask(makeSubtask("st_b2a_a", BIG_TASK_ID));
        }
        expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
          taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
          materialized: true,
        });
        expect(storage.listSubtasksByBigTask(BIG_TASK_ID)).toHaveLength(1);
      });
    }
  });

  it("documents the coherent same-user database-tampering boundary without overclaiming", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const plan = candidate(1, {
        ids: ["st_b2a_tamper"],
        refs: ["tamper-ref"],
      });
      const bundle = storage.beginDurablePlanningBundle(
        plan,
        contractsFor(plan),
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      expect(() =>
        sqlite
          .prepare("UPDATE task_contracts SET contract_payload = '{}' ")
          .run(),
      ).toThrow();
      sqlite.exec("DROP TRIGGER task_contracts_immutable_update");
      const row = sqlite.prepare("SELECT * FROM task_contracts").get() as {
        readonly contract_payload: string;
      };
      const changed = {
        ...(JSON.parse(row.contract_payload) as Record<string, unknown>),
        goal: "Coherently replaced by a same-user database owner.",
      };
      sqlite
        .prepare("UPDATE task_contracts SET contract_payload = ?")
        .run(JSON.stringify(changed));
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(
        storage.getApprovedTaskContractAuthority(BIG_TASK_ID),
      ).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        taskContracts: [
          expect.objectContaining({ goal: changed.goal }),
        ],
      });
      storage.close();
    });
  });
});

describe("Step 8B2a bundle atomicity and savepoint hardening", () => {
  const beginFailures = [
    [
      "after the planning track write",
      `CREATE TRIGGER b2a_fail_candidate
       BEFORE INSERT ON orchestration_plan_candidates
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      "TRANSACTION_FAILED",
    ],
    [
      "after the candidate and first artifact",
      `CREATE TRIGGER b2a_fail_second_artifact
       BEFORE INSERT ON task_contracts
       WHEN NEW.task_contract_ref = 'contracts/st_b2a_b'
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      "TRANSACTION_FAILED",
    ],
    [
      "after all artifacts and the first association",
      `CREATE TRIGGER b2a_fail_second_binding
       BEFORE INSERT ON candidate_task_contract_bindings
       WHEN NEW.subtask_id = 'st_b2a_b'
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      "TRANSACTION_FAILED",
    ],
    [
      "during final replay verification",
      `DROP TRIGGER candidate_task_contract_bindings_immutable_update;
       CREATE TRIGGER b2a_corrupt_binding
       AFTER INSERT ON candidate_task_contract_bindings
       WHEN NEW.subtask_id = 'st_b2a_b'
       BEGIN
         UPDATE candidate_task_contract_bindings
         SET candidate_binding = candidate_binding || '-corrupt'
         WHERE big_task_id = NEW.big_task_id
           AND plan_revision = NEW.plan_revision
           AND subtask_id = NEW.subtask_id;
       END`,
      "MALFORMED_STORED_DATA",
    ],
  ] as const;

  it.each(beginFailures)(
    "rolls back a bundle begin failure %s",
    (_label, triggerSql, code) => {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        storage.close();
        installSql(databasePath, triggerSql);

        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        const plan = candidate();
        expectStorageError(
          () => storage.beginDurablePlanningBundle(plan, contractsFor(plan)),
          code,
        );
        storage.close();
        expect(authorityCounts(databasePath)).toEqual({
          tracks: 0,
          candidates: 0,
          contracts: 0,
          bindings: 0,
        });
      });
    },
  );

  it("lets an outer transaction catch a failed inner bundle and commit unrelated work", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      storage.close();
      installSql(
        databasePath,
        `CREATE TRIGGER b2a_fail_second_binding_outer
         BEFORE INSERT ON candidate_task_contract_bindings
         WHEN NEW.subtask_id = 'st_b2a_b'
         BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      );
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.runInTransaction((outer) => {
        const plan = candidate();
        expectStorageError(
          () => outer.beginDurablePlanningBundle(plan, contractsFor(plan)),
          "TRANSACTION_FAILED",
        );
        outer.createProject(makeProject("prj_b2a_outer", "b2a-outer"));
      });
      expect(
        storage.getProjectById(ProjectIdSchema.parse("prj_b2a_outer")),
      ).not.toBeNull();
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
      storage.close();
      expect(authorityCounts(databasePath)).toMatchObject({
        tracks: 0,
        candidates: 0,
        contracts: 0,
        bindings: 0,
      });
    });
  });

  it("rolls back a successful inner bundle when the outer transaction fails", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      expectStorageError(
        () =>
          storage.runInTransaction((outer) => {
            const plan = candidate();
            outer.beginDurablePlanningBundle(plan, contractsFor(plan));
            throw new Error("Injected outer failure.");
          }),
        "TRANSACTION_FAILED",
      );
      expect(storage.getDurablePlanningSnapshot(BIG_TASK_ID)).toBeNull();
    });
  });

  it.each([
    "NEW_ARTIFACT",
    "SECOND_ASSOCIATION",
    "POST_WRITE_REPLAY",
  ] as const)(
    "rolls back a mixed reuse revision failure at %s",
    (failurePoint) => {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        const firstPlan = candidate();
        const firstContracts = contractsFor(firstPlan);
        const first = storage.beginDurablePlanningBundle(
          firstPlan,
          firstContracts,
        );
        storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(first.reviewState),
        );
        storage.close();

        installSql(
          databasePath,
          failurePoint === "NEW_ARTIFACT"
            ? `CREATE TRIGGER b2a_fail_revision_artifact
               BEFORE INSERT ON task_contracts
               WHEN NEW.task_contract_ref = 'contracts/st_b2a_b-v2'
               BEGIN SELECT RAISE(ABORT, 'injected'); END`
            : failurePoint === "SECOND_ASSOCIATION"
              ? `CREATE TRIGGER b2a_fail_revision_binding
                 BEFORE INSERT ON candidate_task_contract_bindings
                 WHEN NEW.plan_revision = 2 AND NEW.subtask_id = 'st_b2a_b'
                 BEGIN SELECT RAISE(ABORT, 'injected'); END`
              : `DROP TRIGGER candidate_task_contract_bindings_immutable_update;
                 CREATE TRIGGER b2a_corrupt_revision_replay
                 AFTER INSERT ON candidate_task_contract_bindings
                 WHEN NEW.plan_revision = 2 AND NEW.subtask_id = 'st_b2a_b'
                 BEGIN
                   UPDATE candidate_task_contract_bindings
                   SET candidate_binding = candidate_binding || '-corrupt'
                   WHERE big_task_id = NEW.big_task_id
                     AND plan_revision = NEW.plan_revision
                     AND subtask_id = NEW.subtask_id;
                 END`,
        );
        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        const revision = candidate(2, {
          refs: ["contracts/st_b2a_a", "contracts/st_b2a_b-v2"],
        });
        const revisionContracts = [
          firstContracts[0]!,
          contractFor(revision, 1),
        ];
        expectStorageError(
          () =>
            storage.submitDurablePlannerRevisionBundle(
              revision,
              revisionContracts,
            ),
          failurePoint === "POST_WRITE_REPLAY"
            ? "MALFORMED_STORED_DATA"
            : "TRANSACTION_FAILED",
        );
        expect(
          storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.candidateHistory,
        ).toHaveLength(1);
        storage.close();
        expect(authorityCounts(databasePath)).toMatchObject({
          tracks: 1,
          candidates: 1,
          contracts: 2,
          bindings: 2,
        });
      });
    },
  );
});

describe("Step 8B2a concurrent composition and deterministic history", () => {
  it.each(["PLAIN_FIRST", "BUNDLE_FIRST"] as const)(
    "serializes plain versus bundled begin for %s",
    (order) => {
      withTemporaryDatabasePath((databasePath) => {
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        seed.close();
        const first = openTaskDatabase({ databasePath, clock: fixedClock });
        const second = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const plan = candidate();
          if (order === "PLAIN_FIRST") {
            first.beginDurablePlanning(plan);
            expectStorageError(
              () => second.beginDurablePlanningBundle(plan, contractsFor(plan)),
              "CONFLICT",
            );
            expect(second.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
              taskContractAuthorityReadiness:
                "TASK_CONTRACT_AUTHORITY_NOT_READY",
            });
          } else {
            first.beginDurablePlanningBundle(plan, contractsFor(plan));
            expectStorageError(
              () => second.beginDurablePlanning(plan),
              "CONFLICT",
            );
            expect(second.getDurablePlanningReviewBundle(BIG_TASK_ID)).toMatchObject({
              taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
            });
          }
        } finally {
          first.close();
          second.close();
        }
      });
    },
  );

  it.each(["PLAIN_FIRST", "BUNDLE_FIRST"] as const)(
    "serializes competing plain and bundled revisions for %s",
    (order) => {
      withTemporaryDatabasePath((databasePath) => {
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        const firstPlan = candidate();
        const first = seed.beginDurablePlanningBundle(
          firstPlan,
          contractsFor(firstPlan),
        );
        seed.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(first.reviewState),
        );
        seed.close();

        const firstHandle = openTaskDatabase({
          databasePath,
          clock: fixedClock,
        });
        const secondHandle = openTaskDatabase({
          databasePath,
          clock: fixedClock,
        });
        try {
          const revision = candidate(2, {
            refs: ["contracts/rev2-a", "contracts/rev2-b"],
          });
          if (order === "PLAIN_FIRST") {
            firstHandle.submitDurablePlannerRevision(revision);
            expectStorageError(
              () =>
                secondHandle.submitDurablePlannerRevisionBundle(
                  revision,
                  contractsFor(revision),
                ),
              "INVALID_INPUT",
            );
            expect(
              secondHandle.getDurablePlanningReviewBundle(BIG_TASK_ID),
            ).toMatchObject({
              taskContractAuthorityReadiness:
                "TASK_CONTRACT_AUTHORITY_NOT_READY",
            });
          } else {
            firstHandle.submitDurablePlannerRevisionBundle(
              revision,
              contractsFor(revision),
            );
            expectStorageError(
              () => secondHandle.submitDurablePlannerRevision(revision),
              "INVALID_INPUT",
            );
            expect(
              secondHandle.getDurablePlanningReviewBundle(BIG_TASK_ID),
            ).toMatchObject({
              taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
            });
          }
        } finally {
          firstHandle.close();
          secondHandle.close();
        }
      });
    },
  );

  it.each(Array.from({ length: 16 }, (_value, index) => index))(
    "keeps one Project-scoped ref owner across competing Big Tasks iteration %i",
    (iteration) => {
      withTemporaryDatabasePath((databasePath) => {
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        const projectId = ProjectIdSchema.parse(`prj_ref_race_${iteration}`);
        const firstBigTaskId = BigTaskIdSchema.parse(`bt_ref_race_a_${iteration}`);
        const secondBigTaskId = BigTaskIdSchema.parse(`bt_ref_race_b_${iteration}`);
        seedHierarchy(
          seed,
          projectId,
          firstBigTaskId,
          `ref-race-${iteration}`,
        );
        seed.createBigTask(makeBigTask(secondBigTaskId, projectId));
        seed.close();
        const first = openTaskDatabase({ databasePath, clock: fixedClock });
        const second = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const sharedRef = "same-project-ref";
          const firstPlan = candidate(1, {
            projectId,
            bigTaskId: firstBigTaskId,
            ids: [`st_ref_race_a_${iteration}`],
            refs: [sharedRef],
          });
          const secondPlan = candidate(1, {
            projectId,
            bigTaskId: secondBigTaskId,
            ids: [`st_ref_race_b_${iteration}`],
            refs: [sharedRef],
          });
          first.beginDurablePlanningBundle(firstPlan, contractsFor(firstPlan));
          expectStorageError(
            () =>
              second.beginDurablePlanningBundle(
                secondPlan,
                contractsFor(secondPlan),
              ),
            "CONFLICT",
          );
          expect(second.getDurablePlanningSnapshot(secondBigTaskId)).toBeNull();
        } finally {
          first.close();
          second.close();
        }
      });
    },
  );

  it("isolates rejected history and follows candidate order through add/drop revisions", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const firstPlan = candidate(1, {
        ids: ["st_hist_a", "st_hist_b", "st_hist_c"],
        refs: ["hist-a", "hist-b", "hist-c-v1"],
      });
      const firstContracts = contractsFor(firstPlan);
      let bundle = storage.beginDurablePlanningBundle(
        firstPlan,
        firstContracts,
      );
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );

      const secondPlan = candidate(2, {
        ids: ["st_hist_a", "st_hist_c", "st_hist_d"],
        refs: ["hist-a", "hist-c-v2", "hist-d"],
      });
      const secondContracts = [
        firstContracts[0]!,
        contractFor(secondPlan, 1),
        contractFor(secondPlan, 2),
      ];
      bundle = storage.submitDurablePlannerRevisionBundle(secondPlan, [
        secondContracts[2]!,
        secondContracts[0]!,
        secondContracts[1]!,
      ]);
      expect(bundle.taskContracts).toEqual(secondContracts);
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        rejectionFor(bundle.reviewState),
      );

      const thirdPlan = candidate(3, {
        ids: ["st_hist_d", "st_hist_a", "st_hist_e"],
        refs: ["hist-d", "hist-a", "hist-e"],
      });
      const thirdContracts = [
        secondContracts[2]!,
        firstContracts[0]!,
        contractFor(thirdPlan, 2),
      ];
      bundle = storage.submitDurablePlannerRevisionBundle(thirdPlan, [
        thirdContracts[2]!,
        thirdContracts[1]!,
        thirdContracts[0]!,
      ]);
      expect(bundle.taskContracts).toEqual(thirdContracts);
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      storage.close();

      expect(authorityCounts(databasePath)).toMatchObject({
        candidates: 3,
        contracts: 6,
        bindings: 9,
      });
      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
        planRevision: 3,
        taskContracts: thirdContracts,
      });
      storage.close();
    });
  });

  it.each([31, 64])(
    "replays a mixed three-candidate history at %i Subtasks",
    (count) => {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage);
        const artifacts = new Map<string, TaskContractV0>();
        const makeScaled = (revision: number): PlanCandidate => {
          const ids = Array.from({ length: count }, (_value, index) =>
            index === count - 1 && revision > 1
              ? `st_scale_new_${revision}`
              : `st_scale_${index.toString().padStart(2, "0")}`,
          );
          const refs = ids.map((id, index) =>
            revision === 1 || index % 3 === 0
              ? `scale-${id}-stable`
              : `scale-${id}-v${revision}`,
          );
          return candidate(revision, {
            ids,
            refs,
            profileFor: (index) =>
              (index + revision) % 3 === 0
                ? "HIGH_RISK_FOUNDATION"
                : (index + revision) % 2 === 0
                  ? "LOW"
                  : "STANDARD",
            writeEnabledFor: (index) => (index + revision) % 2 === 0,
          });
        };
        const bundleFor = (plan: PlanCandidate): readonly TaskContractV0[] =>
          plan.subtasks.map((_subtask, index) => {
            const ref = plan.subtasks[index]!.taskContractRef;
            const existing = artifacts.get(ref);
            if (existing !== undefined) {
              return existing;
            }
            const created = contractFor(plan, index);
            artifacts.set(ref, created);
            return created;
          });

        let plan = makeScaled(1);
        let bundle = storage.beginDurablePlanningBundle(plan, bundleFor(plan));
        storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(bundle.reviewState),
        );
        plan = makeScaled(2);
        bundle = storage.submitDurablePlannerRevisionBundle(
          plan,
          [...bundleFor(plan)].reverse(),
        );
        storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          rejectionFor(bundle.reviewState),
        );
        plan = makeScaled(3);
        const currentContracts = bundleFor(plan);
        bundle = storage.submitDurablePlannerRevisionBundle(
          plan,
          [...currentContracts].sort((left, right) =>
            left.taskContractRef < right.taskContractRef ? 1 : -1,
          ),
        );
        storage.recordDurableReviewerDecision(
          BIG_TASK_ID,
          approvalFor(bundle.reviewState),
        );
        storage.materializeDurablePlan(BIG_TASK_ID);
        storage.close();

        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(storage.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
          taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
          materialized: true,
          taskContracts: currentContracts,
        });
        expect(
          storage.getDurablePlanningSnapshot(BIG_TASK_ID)?.candidateHistory,
        ).toHaveLength(3);
        storage.close();
      });
    },
  );
});

describe("Step 8B2a input/output, serialization, and public boundaries", () => {
  it("detaches large caller input and deeply freezes every authoritative output", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(storage);
      const plan = candidate(1, {
        ids: ["st_b2a_large"],
        refs: ["large-ref"],
      });
      const mutable = {
        ...contractFor(plan, 0),
        goal: "界".repeat(20_000),
        scopeIn: ["scope".repeat(4_000)],
        scopeOut: [] as string[],
        acceptanceCriteria: ["accept".repeat(3_000)],
        untouchedAreas: [] as string[],
        promptSeed: "prompt".repeat(4_000),
      };
      const bundle = storage.beginDurablePlanningBundle(plan, [mutable]);
      mutable.goal = "mutated";
      mutable.scopeIn[0] = "mutated";
      expect(bundle.taskContracts[0]?.goal).toHaveLength(20_000);
      expect(Object.isFrozen(bundle)).toBe(true);
      expect(Object.isFrozen(bundle.reviewState)).toBe(true);
      expect(Object.isFrozen(bundle.taskContracts)).toBe(true);
      expect(Object.isFrozen(bundle.taskContracts[0])).toBe(true);
      expect(Object.isFrozen(bundle.taskContracts[0]?.scopeIn)).toBe(true);
      expect(Reflect.set(bundle.taskContracts[0]!, "goal", "late")).toBe(false);
      expect(Reflect.set(bundle.reviewState, "phase", "APPROVED")).toBe(false);
      expect(storage.getDurablePlanningReviewBundle(BIG_TASK_ID)).toEqual(bundle);
      storage.recordDurableReviewerDecision(
        BIG_TASK_ID,
        approvalFor(bundle.reviewState),
      );
      const approved = storage.getApprovedTaskContractAuthority(BIG_TASK_ID)!;
      expect(Object.isFrozen(approved)).toBe(true);
      if (
        approved.taskContractAuthorityReadiness ===
        "TASK_CONTRACT_AUTHORITY_READY"
      ) {
        expect(Object.isFrozen(approved.taskContracts)).toBe(true);
        expect(Object.isFrozen(approved.taskContracts[0]?.scopeIn)).toBe(true);
        expect(Reflect.set(approved.taskContracts[0]!, "goal", "late")).toBe(
          false,
        );
      }
      storage.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(
        storage.getDurablePlanningReviewBundle(BIG_TASK_ID)?.taskContracts[0]
          ?.goal,
      ).toHaveLength(20_000);
      storage.close();
    });
  });

  it("exposes only bounded Task Contract authority operations and no Step 8B2b scope", () => {
    const storage = openTaskDatabase({ databasePath: ":memory:", clock: fixedClock });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(storage));
    storage.close();
    expect(methods).toEqual(
      expect.arrayContaining([
        "beginDurablePlanningBundle",
        "submitDurablePlannerRevisionBundle",
        "getDurablePlanningReviewBundle",
        "getApprovedTaskContractAuthority",
      ]),
    );
    for (const forbidden of [
      "saveTaskContract",
      "updateTaskContract",
      "deleteTaskContract",
      "setApproved",
      "markReviewed",
      "setContractsReady",
      "attachAfterApproval",
      "executeSql",
    ]) {
      expect(methods).not.toContain(forbidden);
    }

    const source = readFileSync(
      new URL("../src/orchestration-planning.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "@codex-task-console/orchestration"');
    expect(source).not.toMatch(/@codex-task-console\/orchestration\//);
    expect(source).not.toMatch(/\.insert\(subtasksTable\)/);
    expect(source).not.toContain("taskDependenciesTable");
    expect(source).not.toContain("localeCompare");
    expect(source).not.toMatch(
      /StageEvidenceSnapshot|TODO\s*->\s*IN_PROGRESS|Planner model|Reviewer model|worktree provisioning|Local Control/,
    );
    const orchestrationManifest = readFileSync(
      new URL("../../orchestration/package.json", import.meta.url),
      "utf8",
    );
    expect(orchestrationManifest).not.toContain("@codex-task-console/storage");
  });
});
