import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
  SubtaskImplementationCheckpointIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type { TaskContractV0 } from "@codex-task-console/domain";
import type {
  PlanCandidate,
  PlanReviewState,
  WorkflowProfile,
} from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import type {
  DurableWorkflowControlView,
  DurableWorkflowEvidenceKind,
  DurableWorkflowEvidenceProducer,
  TaskStorage,
  TaskStorageError,
} from "../src/index.js";
import {
  captureTaskStorageError,
  makeBigTask,
  makeImplementationCheckpoint,
  makeProject,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const OCCURRED_AT = "2026-09-03T00:00:00.000Z";

const incrementingClock = (): (() => Date) => {
  let current = new Date(OCCURRED_AT).getTime();
  return () => {
    current += 1_000;
    return new Date(current);
  };
};

const approval = (state: PlanReviewState) => ({
  outcome: "APPROVE" as const,
  planRevision: state.candidate.revision,
  candidateBinding: state.candidateBinding,
});

const makePlan = (
  projectId: string,
  bigTaskId: string,
  profiles: readonly WorkflowProfile[],
  writeEnabled = true,
): PlanCandidate => ({
  kind: "PLAN_CANDIDATE",
  projectId: ProjectIdSchema.parse(projectId),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
  revision: 1,
  subtasks: profiles.map((profile, index) => ({
    id: SubtaskIdSchema.parse(`st_${bigTaskId.slice(3)}_${index}`),
    bigTaskId: BigTaskIdSchema.parse(bigTaskId),
    profile,
    taskContractRef: `contract/${bigTaskId}/${index}`,
    writeEnabled,
  })),
  dependencies: [],
});

const contractsFor = (plan: PlanCandidate): readonly TaskContractV0[] =>
  plan.subtasks.map((subtask, index) =>
    TaskContractV0Schema.parse({
      taskContractRef: subtask.taskContractRef,
      projectId: plan.projectId,
      bigTaskId: plan.bigTaskId,
      subtaskId: subtask.id,
      title: `Workflow control ${index}`,
      goal: `Durable workflow control ${index}`,
      scopeIn: ["Step 8C"],
      scopeOut: ["Step 8D dispatch"],
      acceptanceCriteria: ["History-derived authority"],
      untouchedAreas: ["Provider execution"],
      promptSeed: `Execute bounded workflow ${index}.`,
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
    }),
  );

const seed = (
  storage: TaskStorage,
  options: Readonly<{
    suffix?: string;
    profiles?: readonly WorkflowProfile[];
    writeEnabled?: boolean;
    createProject?: boolean;
  }> = {},
) => {
  const suffix = options.suffix ?? "control";
  const projectId = ProjectIdSchema.parse("prj_workflow_control");
  const bigTaskId = BigTaskIdSchema.parse(`bt_${suffix}`);
  const plan = makePlan(
    projectId,
    bigTaskId,
    options.profiles ?? ["LOW"],
    options.writeEnabled ?? true,
  );
  if (options.createProject ?? true) {
    storage.createProject(makeProject(projectId, "workflow-control"));
  }
  storage.createBigTask(makeBigTask(bigTaskId, projectId));
  const bundle = storage.beginDurablePlanningBundle(plan, contractsFor(plan));
  storage.recordDurableReviewerDecision(bigTaskId, approval(bundle.reviewState));
  storage.materializeDurablePlan(bigTaskId);
  const source = storage.materializeApprovedCanonicalTasks(bigTaskId);
  storage.initializeDurableSubtaskWorkflows(bigTaskId);
  return { plan, source, projectId, bigTaskId };
};

const producerFor = (
  kind: DurableWorkflowEvidenceKind,
): DurableWorkflowEvidenceProducer => {
  if (
    kind === "REPOSITORY_PREFLIGHT_PASSED" ||
    kind === "CONTEXT_PREFLIGHT_PASSED" ||
    kind === "BUDGET_AVAILABLE" ||
    kind === "CONCURRENCY_AVAILABLE" ||
    kind === "WORKTREE_OWNERSHIP_AVAILABLE"
  ) {
    return "OPERATIONAL_GATE";
  }
  if (kind === "HUMAN_APPROVAL_SATISFIED") {
    return "HUMAN_AUTHORITY";
  }
  if (
    kind === "NO_UNRESOLVED_BLOCKING_FINDING" ||
    kind === "HANDOFF_PRESENT" ||
    kind === "PROMOTED_CONTEXT_DISPOSITION_RECORDED"
  ) {
    return "DELIVERY_CONTROL";
  }
  return "WORKFLOW_ROLE";
};

const acceptEvidence = (
  storage: TaskStorage,
  view: DurableWorkflowControlView,
  kind: DurableWorkflowEvidenceKind,
  suffix: string,
  outcome: "PASS" | "BLOCKING_FAIL" = "PASS",
) =>
  storage.acceptDurableWorkflowEvidence({
    evidenceId: `wfe_${suffix}`,
    projectId: view.projectId,
    bigTaskId: view.bigTaskId,
    candidateBinding: view.candidateBinding,
    subtaskId: view.subtaskId,
    observedStage: view.currentStage,
    observedRepairCyclesUsed: view.repairCyclesUsed,
    kind,
    outcome,
    producer: producerFor(kind),
    sourceReference: `source:${suffix}`,
    occurredAt:
      view.transitions[view.transitions.length - 1]?.occurredAt ??
      view.initializedAt,
  });

const workflowReference = (evidenceId: string) => ({
  sourceType: "WORKFLOW_EVIDENCE" as const,
  sourceReference: evidenceId,
});

const checkpointReference = (checkpointId: string) => ({
  sourceType: "IMPLEMENTATION_CHECKPOINT" as const,
  sourceReference: SubtaskImplementationCheckpointIdSchema.parse(checkpointId),
});

const viewFor = (storage: TaskStorage, subtaskId: string) => {
  const view = storage.getDurableWorkflowControlView(
    SubtaskIdSchema.parse(subtaskId),
  );
  expect(view).not.toBeNull();
  return view!;
};

const advance = (
  storage: TaskStorage,
  view: DurableWorkflowControlView,
  operationId: string,
  requestedNextStage: DurableWorkflowControlView["currentStage"],
  evidenceReferences: readonly (
    | ReturnType<typeof workflowReference>
    | ReturnType<typeof checkpointReference>
  )[],
) =>
  storage.advanceDurableWorkflow({
    operationId,
    projectId: view.projectId,
    bigTaskId: view.bigTaskId,
    candidateBinding: view.candidateBinding,
    subtaskId: view.subtaskId,
    requestedNextStage,
    evidenceReferences,
  });

const materializeToExecute = (
  storage: TaskStorage,
  view: DurableWorkflowControlView,
  prefix: string,
) => {
  const kinds = [
    "REPOSITORY_PREFLIGHT_PASSED",
    "CONTEXT_PREFLIGHT_PASSED",
    "BUDGET_AVAILABLE",
    "CONCURRENCY_AVAILABLE",
    "WORKTREE_OWNERSHIP_AVAILABLE",
    "HUMAN_APPROVAL_SATISFIED",
  ] as const;
  const evidence = kinds.map((kind, index) =>
    acceptEvidence(storage, view, kind, `${prefix}_gate_${index}`),
  );
  const result = advance(
    storage,
    view,
    `wop_${prefix}_materialize`,
    "EXECUTE",
    evidence.map(({ evidenceId }) => workflowReference(evidenceId)),
  );
  expect(result.kind).toBe("TRANSITION_RECORDED");
  return result.view;
};

const completeImplementation = (
  storage: TaskStorage,
  databasePath: string,
  view: DurableWorkflowControlView,
  suffix: string,
) => {
  const sqlite = new DatabaseSync(databasePath);
  sqlite.prepare("UPDATE subtasks SET status = 'IN_PROGRESS' WHERE id = ?")
    .run(view.subtaskId);
  sqlite.close();
  return storage.completeSubtaskImplementation({
    subtaskId: view.subtaskId,
    checkpoint: makeImplementationCheckpoint(
      `icp_${suffix}`,
      view.subtaskId,
      {
        occurredAt:
          view.transitions[view.transitions.length - 1]?.occurredAt ??
          view.initializedAt,
      },
    ),
  });
};

const completionEvidence = (
  storage: TaskStorage,
  view: DurableWorkflowControlView,
  outcomeKind:
    | "VERIFICATION_EVIDENCE_PASSED"
    | "FRESH_QA_OUTCOME_RECORDED"
    | "FOCUSED_RE_QA_OUTCOME_RECORDED",
  prefix: string,
  outcome: "PASS" | "BLOCKING_FAIL" = "PASS",
) => {
  const outcomeEvidence = acceptEvidence(
    storage,
    view,
    outcomeKind,
    `${prefix}_outcome`,
    outcome,
  );
  if (outcome === "BLOCKING_FAIL") {
    return [workflowReference(outcomeEvidence.evidenceId)] as const;
  }
  return [
    outcomeEvidence,
    acceptEvidence(
      storage,
      view,
      "NO_UNRESOLVED_BLOCKING_FINDING",
      `${prefix}_blocking`,
    ),
    acceptEvidence(storage, view, "HANDOFF_PRESENT", `${prefix}_handoff`),
    acceptEvidence(
      storage,
      view,
      "PROMOTED_CONTEXT_DISPOSITION_RECORDED",
      `${prefix}_context`,
    ),
  ].map(({ evidenceId }) => workflowReference(evidenceId));
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

describe("durable workflow control plane", () => {
  it("runs the LOW path without dispatch side effects and keeps COMPLETE distinct from ACCEPTED", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, { suffix: "low", profiles: ["LOW"] });
      const target = source.subtasks[0]!;
      let view = viewFor(storage, target.subtaskId);
      expect(view).toMatchObject({
        initialStage: "EXECUTE",
        currentStage: "EXECUTE",
        initialRepairCyclesUsed: 0,
        repairCyclesUsed: 0,
        boardStatus: "TODO",
        deliveryMaturity: "NOT_STARTED",
      });

      const completion = completeImplementation(storage, databasePath, view, "low");
      expect(completion.subtask).toMatchObject({
        status: "QA_DEBUG",
        maturity: "IMPLEMENTED",
      });
      const execution = advance(
        storage,
        view,
        "wop_low_execute",
        "VERIFY",
        [checkpointReference(completion.checkpoint.id)],
      );
      expect(execution.kind).toBe("TRANSITION_RECORDED");
      view = execution.view;
      const beforeRuns = new DatabaseSync(databasePath, { readOnly: true });
      expect(beforeRuns.prepare("SELECT count(*) AS count FROM chat_threads").get())
        .toEqual({ count: 0 });
      expect(beforeRuns.prepare("SELECT count(*) AS count FROM execution_runs").get())
        .toEqual({ count: 0 });
      beforeRuns.close();

      const completed = advance(
        storage,
        view,
        "wop_low_complete",
        "COMPLETE",
        completionEvidence(
          storage,
          view,
          "VERIFICATION_EVIDENCE_PASSED",
          "low_verify",
        ),
      );
      expect(completed).toMatchObject({
        kind: "TRANSITION_RECORDED",
        view: {
          currentStage: "COMPLETE",
          boardStatus: "DONE",
          deliveryMaturity: "IMPLEMENTED",
          repairCyclesUsed: 0,
        },
      });
      expect(completed.view.initialStage).toBe("EXECUTE");
      expect(completed.view.initialRepairCyclesUsed).toBe(0);
      storage.close();
    });
  });

  it("runs the STANDARD path while MATERIALIZE never starts board execution", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "standard",
        profiles: ["STANDARD"],
      });
      let view = viewFor(storage, source.subtasks[0]!.subtaskId);
      view = materializeToExecute(storage, view, "standard");
      expect(view).toMatchObject({
        initialStage: "MATERIALIZE",
        currentStage: "EXECUTE",
        boardStatus: "TODO",
        deliveryMaturity: "NOT_STARTED",
      });
      const completion = completeImplementation(
        storage,
        databasePath,
        view,
        "standard",
      );
      view = advance(
        storage,
        view,
        "wop_standard_execute",
        "VERIFY",
        [checkpointReference(completion.checkpoint.id)],
      ).view;
      const completed = advance(
        storage,
        view,
        "wop_standard_complete",
        "COMPLETE",
        completionEvidence(
          storage,
          view,
          "VERIFICATION_EVIDENCE_PASSED",
          "standard_verify",
        ),
      );
      expect(completed.view).toMatchObject({
        currentStage: "COMPLETE",
        boardStatus: "DONE",
        deliveryMaturity: "IMPLEMENTED",
        transitionCount: 3,
      });
      storage.close();
    });
  });

  it("atomically composes HIGH_RISK hardening and Fresh QA PASS with maturity and board state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, { suffix: "high", profiles: ["HIGH_RISK_FOUNDATION"] });
      let view = materializeToExecute(
        storage,
        viewFor(storage, source.subtasks[0]!.subtaskId),
        "high",
      );
      const implementation = completeImplementation(
        storage,
        databasePath,
        view,
        "high",
      );
      view = advance(storage, view, "wop_high_execute", "HARDEN", [
        checkpointReference(implementation.checkpoint.id),
      ]).view;
      const hardening = acceptEvidence(
        storage,
        view,
        "HARDENING_EVIDENCE_PASSED",
        "high_hardening",
      );
      view = advance(storage, view, "wop_high_harden", "FRESH_QA", [
        workflowReference(hardening.evidenceId),
      ]).view;
      expect(view).toMatchObject({
        currentStage: "FRESH_QA",
        boardStatus: "QA_DEBUG",
        deliveryMaturity: "HARDENED",
      });
      const completed = advance(
        storage,
        view,
        "wop_high_complete",
        "COMPLETE",
        completionEvidence(
          storage,
          view,
          "FRESH_QA_OUTCOME_RECORDED",
          "high_fqa",
        ),
      );
      expect(completed.view).toMatchObject({
        currentStage: "COMPLETE",
        boardStatus: "DONE",
        deliveryMaturity: "ACCEPTED",
        transitionCount: 4,
      });
      storage.close();
    });
  });

  it("runs the one bounded Repair and Focused Re-QA PASS path", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, { suffix: "repair", profiles: ["HIGH_RISK_FOUNDATION"] });
      let view = materializeToExecute(
        storage,
        viewFor(storage, source.subtasks[0]!.subtaskId),
        "repair",
      );
      const implementation = completeImplementation(
        storage,
        databasePath,
        view,
        "repair",
      );
      view = advance(storage, view, "wop_repair_execute", "HARDEN", [
        checkpointReference(implementation.checkpoint.id),
      ]).view;
      const hardening = acceptEvidence(
        storage,
        view,
        "HARDENING_EVIDENCE_PASSED",
        "repair_hardening",
      );
      view = advance(storage, view, "wop_repair_harden", "FRESH_QA", [
        workflowReference(hardening.evidenceId),
      ]).view;
      view = advance(
        storage,
        view,
        "wop_repair_enter",
        "REPAIR",
        completionEvidence(
          storage,
          view,
          "FRESH_QA_OUTCOME_RECORDED",
          "repair_fqa",
          "BLOCKING_FAIL",
        ),
      ).view;
      expect(view).toMatchObject({ currentStage: "REPAIR", repairCyclesUsed: 1 });
      const repairEvidence = acceptEvidence(
        storage,
        view,
        "REPAIR_EVIDENCE_PASSED",
        "repair_passed",
      );
      view = advance(storage, view, "wop_repair_reqa", "FOCUSED_RE_QA", [
        workflowReference(repairEvidence.evidenceId),
      ]).view;
      const completed = advance(
        storage,
        view,
        "wop_repair_complete",
        "COMPLETE",
        completionEvidence(
          storage,
          view,
          "FOCUSED_RE_QA_OUTCOME_RECORDED",
          "repair_reqa",
        ),
      );
      expect(completed.view).toMatchObject({
        currentStage: "COMPLETE",
        repairCyclesUsed: 1,
        deliveryMaturity: "ACCEPTED",
        boardStatus: "DONE",
      });
      storage.close();
    });
  });

  it("persists repair exhaustion once and rejects a conflicting or second Repair replay", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, { suffix: "exhausted", profiles: ["HIGH_RISK_FOUNDATION"] });
      let view = materializeToExecute(
        storage,
        viewFor(storage, source.subtasks[0]!.subtaskId),
        "exhausted",
      );
      const implementation = completeImplementation(storage, databasePath, view, "exhausted");
      view = advance(storage, view, "wop_exhausted_execute", "HARDEN", [
        checkpointReference(implementation.checkpoint.id),
      ]).view;
      const hardening = acceptEvidence(storage, view, "HARDENING_EVIDENCE_PASSED", "exhausted_hardening");
      view = advance(storage, view, "wop_exhausted_harden", "FRESH_QA", [workflowReference(hardening.evidenceId)]).view;
      view = advance(storage, view, "wop_exhausted_repair", "REPAIR", completionEvidence(storage, view, "FRESH_QA_OUTCOME_RECORDED", "exhausted_fqa", "BLOCKING_FAIL")).view;
      const repaired = acceptEvidence(storage, view, "REPAIR_EVIDENCE_PASSED", "exhausted_repaired");
      view = advance(storage, view, "wop_exhausted_focused", "FOCUSED_RE_QA", [workflowReference(repaired.evidenceId)]).view;
      const failureRefs = completionEvidence(storage, view, "FOCUSED_RE_QA_OUTCOME_RECORDED", "exhausted_reqa", "BLOCKING_FAIL");
      const request = {
        operationId: "wop_exhausted_human",
        projectId: view.projectId,
        bigTaskId: view.bigTaskId,
        candidateBinding: view.candidateBinding,
        subtaskId: view.subtaskId,
        requestedNextStage: "COMPLETE" as const,
        evidenceReferences: failureRefs,
      };
      const first = storage.advanceDurableWorkflow(request);
      expect(first).toMatchObject({
        kind: "HUMAN_REQUIRED",
        requirement: { reason: "REPAIR_REQA_EXHAUSTED", sequence: 6 },
        view: { currentStage: "FOCUSED_RE_QA", repairCyclesUsed: 1 },
      });
      expect(storage.advanceDurableWorkflow(request)).toEqual(first);
      expectStorageError(
        () => storage.advanceDurableWorkflow({ ...request, requestedNextStage: "REPAIR" }),
        "CONFLICT",
      );
      expectStorageError(
        () => advance(storage, first.view, "wop_exhausted_second_repair", "REPAIR", failureRefs),
        "CONFLICT",
      );
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("SELECT count(*) AS count FROM durable_workflow_human_requirements").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT count(*) AS count FROM durable_workflow_transitions WHERE subtask_id = ?").get(view.subtaskId)).toEqual({ count: 5 });
      sqlite.close();
      storage.close();
    });
  });

  it("rejects sibling, cross-authority, stale, unknown, and caller-authored state evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const first = seed(storage, { suffix: "scope_a", profiles: ["STANDARD", "STANDARD"] });
      const firstView = viewFor(storage, first.source.subtasks[0]!.subtaskId);
      const siblingView = viewFor(storage, first.source.subtasks[1]!.subtaskId);
      const siblingEvidence = acceptEvidence(storage, siblingView, "BUDGET_AVAILABLE", "sibling_budget");
      expectStorageError(
        () => advance(storage, firstView, "wop_sibling_rejected", "EXECUTE", [workflowReference(siblingEvidence.evidenceId)]),
        "CONFLICT",
      );

      const second = seed(storage, {
        suffix: "scope_b",
        profiles: ["STANDARD"],
        createProject: false,
      });
      const secondView = viewFor(storage, second.source.subtasks[0]!.subtaskId);
      const crossEvidence = acceptEvidence(storage, secondView, "BUDGET_AVAILABLE", "cross_budget");
      expectStorageError(
        () => advance(storage, firstView, "wop_cross_rejected", "EXECUTE", [workflowReference(crossEvidence.evidenceId)]),
        "CONFLICT",
      );
      expectStorageError(
        () => storage.acceptDurableWorkflowEvidence({
          evidenceId: "wfe_wrong_project",
          projectId: ProjectIdSchema.parse("prj_wrong"),
          bigTaskId: firstView.bigTaskId,
          candidateBinding: firstView.candidateBinding,
          subtaskId: firstView.subtaskId,
          observedStage: firstView.currentStage,
          observedRepairCyclesUsed: firstView.repairCyclesUsed,
          kind: "BUDGET_AVAILABLE",
          outcome: "PASS",
          producer: "OPERATIONAL_GATE",
          sourceReference: "source:wrong-project",
          occurredAt: OCCURRED_AT,
        }),
        "CONFLICT",
      );
      expectStorageError(
        () =>
          acceptEvidence(
            storage,
            firstView,
            "HARDENING_EVIDENCE_PASSED",
            "irrelevant_hardening",
          ),
        "CONFLICT",
      );
      expectStorageError(
        () => storage.acceptDurableWorkflowEvidence({
          evidenceId: "wfe_unknown",
          projectId: firstView.projectId,
          bigTaskId: firstView.bigTaskId,
          candidateBinding: firstView.candidateBinding,
          subtaskId: firstView.subtaskId,
          observedStage: firstView.currentStage,
          observedRepairCyclesUsed: firstView.repairCyclesUsed,
          kind: "UNKNOWN" as DurableWorkflowEvidenceKind,
          outcome: "PASS",
          producer: "OPERATIONAL_GATE",
          sourceReference: "source:unknown",
          occurredAt: OCCURRED_AT,
        }),
        "INVALID_INPUT",
      );
      expectStorageError(
        () => storage.advanceDurableWorkflow({
          operationId: "wop_naked_boolean",
          projectId: firstView.projectId,
          bigTaskId: firstView.bigTaskId,
          candidateBinding: firstView.candidateBinding,
          subtaskId: firstView.subtaskId,
          requestedNextStage: "EXECUTE",
          evidenceReferences: true as unknown as [],
          currentStage: "MATERIALIZE",
          repairCyclesUsed: 0,
          profile: "STANDARD",
          writeEnabled: true,
        } as unknown as Parameters<TaskStorage["advanceDurableWorkflow"]>[0]),
        "INVALID_INPUT",
      );

      const stale = acceptEvidence(storage, firstView, "BUDGET_AVAILABLE", "stale_budget");
      const current = materializeToExecute(storage, firstView, "scope_a");
      expectStorageError(
        () => advance(storage, current, "wop_stale_rejected", "VERIFY", [workflowReference(stale.evidenceId)]),
        "CONFLICT",
      );
      storage.close();
    });
  });

  it("keeps ordinary BLOCKED durable-free, records REPLAN_REQUIRED once, and preserves write-disabled authority", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "replan",
        profiles: ["STANDARD"],
        writeEnabled: false,
      });
      const view = viewFor(storage, source.subtasks[0]!.subtaskId);
      expect(view).toMatchObject({ writeEnabled: false, boardStatus: "TODO" });
      const blocked = advance(storage, view, "wop_replan_blocked", "EXECUTE", []);
      expect(blocked).toMatchObject({
        kind: "BLOCKED",
        decision: { reason: "BUDGET_BLOCKED" },
        view: { unresolvedHumanRequired: null },
      });
      const request = {
        operationId: "wop_replan_required",
        projectId: view.projectId,
        bigTaskId: view.bigTaskId,
        candidateBinding: view.candidateBinding,
        changeKind: "SPLIT_SUBTASK" as const,
      };
      const first = storage.requestDurableMaterializedGraphChange(request);
      expect(first).toMatchObject({
        kind: "HUMAN_REQUIRED",
        requirement: { scope: "BIG_TASK", reason: "REPLAN_REQUIRED" },
      });
      expect(storage.requestDurableMaterializedGraphChange(request)).toEqual(first);
      expect(viewFor(storage, view.subtaskId)).toMatchObject({
        currentStage: "MATERIALIZE",
        boardStatus: "TODO",
        deliveryMaturity: "NOT_STARTED",
        unresolvedHumanRequired: { reason: "REPLAN_REQUIRED" },
      });
      expect(storage.getCanonicalTaskMaterialization(view.bigTaskId)).toEqual(source);
      storage.close();
    });
  });

  it("persists an authority blocker as HUMAN_REQUIRED exactly once", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({
        databasePath,
        clock: incrementingClock(),
      });
      const { source } = seed(storage, {
        suffix: "authority",
        profiles: ["STANDARD"],
      });
      const view = viewFor(storage, source.subtasks[0]!.subtaskId);
      const kinds = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "BUDGET_AVAILABLE",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
      ] as const;
      const evidenceReferences = kinds.map((kind, index) =>
        workflowReference(
          acceptEvidence(
            storage,
            view,
            kind,
            `authority_gate_${index}`,
          ).evidenceId,
        ),
      );
      const request = {
        operationId: "wop_authority_human",
        projectId: view.projectId,
        bigTaskId: view.bigTaskId,
        candidateBinding: view.candidateBinding,
        subtaskId: view.subtaskId,
        requestedNextStage: "EXECUTE" as const,
        evidenceReferences,
      };
      const first = storage.advanceDurableWorkflow(request);
      expect(first).toMatchObject({
        kind: "HUMAN_REQUIRED",
        requirement: { reason: "AUTHORITY_BLOCKED", sequence: 1 },
        view: {
          currentStage: "MATERIALIZE",
          repairCyclesUsed: 0,
          transitionCount: 0,
        },
      });
      expect(storage.advanceDurableWorkflow(request)).toEqual(first);
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM durable_workflow_human_requirements",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM durable_workflow_transitions",
          )
          .get(),
      ).toEqual({ count: 0 });
      sqlite.close();
      storage.close();
    });
  });

  it("replays exactly after reopen and fails closed for gapped or wrong-candidate history", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, { suffix: "reopen", profiles: ["STANDARD"] });
      const target = source.subtasks[0]!.subtaskId;
      const first = materializeToExecute(storage, viewFor(storage, target), "reopen");
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      expect(viewFor(storage, target)).toEqual(first);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("DROP TRIGGER durable_workflow_transitions_immutable_update");
      sqlite.prepare("UPDATE durable_workflow_transitions SET sequence = 2 WHERE subtask_id = ?").run(target);
      sqlite.close();
      storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      expectStorageError(
        () => storage.getDurableWorkflowControlView(target),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });

    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, { suffix: "corrupt", profiles: ["STANDARD"] });
      const target = source.subtasks[0]!.subtaskId;
      materializeToExecute(storage, viewFor(storage, target), "corrupt");
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.exec("DROP TRIGGER durable_workflow_evidence_immutable_update");
      sqlite.prepare("UPDATE durable_workflow_evidence SET candidate_binding = 'wrong' WHERE evidence_id = 'wfe_corrupt_gate_0'").run();
      sqlite.close();
      expectStorageError(
        () => storage.getDurableWorkflowControlView(target),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("rolls back transition history when atomic maturity composition fails", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, { suffix: "atomic", profiles: ["HIGH_RISK_FOUNDATION"] });
      let view = materializeToExecute(storage, viewFor(storage, source.subtasks[0]!.subtaskId), "atomic");
      const implementation = completeImplementation(storage, databasePath, view, "atomic");
      view = advance(storage, view, "wop_atomic_execute", "HARDEN", [checkpointReference(implementation.checkpoint.id)]).view;
      const evidence = acceptEvidence(storage, view, "HARDENING_EVIDENCE_PASSED", "atomic_hardening");
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(`CREATE TRIGGER test_workflow_maturity_failure
        BEFORE UPDATE OF maturity ON subtasks
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      sqlite.close();
      expectStorageError(
        () => advance(storage, view, "wop_atomic_harden", "FRESH_QA", [workflowReference(evidence.evidenceId)]),
        "TRANSACTION_FAILED",
      );
      expect(viewFor(storage, view.subtaskId)).toMatchObject({
        currentStage: "HARDEN",
        deliveryMaturity: "IMPLEMENTED",
        transitionCount: 2,
        unresolvedHumanRequired: null,
      });
      storage.close();
    });
  });

  it("serializes competing next-transition attempts into one linear history", { timeout: 12_000 }, () => {
    withTemporaryDatabasePath((databasePath) => {
      const seedStorage = openTaskDatabase({
        databasePath,
        clock: incrementingClock(),
      });
      const { source } = seed(seedStorage, {
        suffix: "concurrent",
        profiles: ["STANDARD"],
      });
      const initial = viewFor(seedStorage, source.subtasks[0]!.subtaskId);
      const kinds = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "BUDGET_AVAILABLE",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
        "HUMAN_APPROVAL_SATISFIED",
      ] as const;
      const references = kinds.map((kind, index) =>
        workflowReference(
          acceptEvidence(
            seedStorage,
            initial,
            kind,
            `concurrent_gate_${index}`,
          ).evidenceId,
        ),
      );
      seedStorage.close();

      const first = openTaskDatabase({
        databasePath,
        clock: () => new Date("2026-09-04T00:00:00.000Z"),
      });
      const second = openTaskDatabase({
        databasePath,
        clock: () => new Date("2026-09-04T00:00:00.000Z"),
      });
      first.runInTransaction((transaction) => {
        expect(
          advance(
            transaction,
            initial,
            "wop_concurrent_winner",
            "EXECUTE",
            references,
          ).kind,
        ).toBe("TRANSITION_RECORDED");
        expectStorageError(
          () =>
            advance(
              second,
              initial,
              "wop_concurrent_loser",
              "EXECUTE",
              references,
            ),
          "TRANSACTION_FAILED",
        );
      });
      expect(viewFor(second, initial.subtaskId)).toMatchObject({
        currentStage: "EXECUTE",
        transitionCount: 1,
      });
      expectStorageError(
        () =>
          advance(
            second,
            initial,
            "wop_concurrent_loser",
            "EXECUTE",
            references,
          ),
        "CONFLICT",
      );
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare(
          "SELECT sequence, count(*) AS count FROM durable_workflow_transitions GROUP BY sequence",
        ).all(),
      ).toEqual([{ sequence: 1, count: 1 }]);
      sqlite.close();
      first.close();
      second.close();
    });
  });
});
