import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  DURABLE_WORKFLOW_EVIDENCE_KINDS,
  openTaskDatabase,
} from "../src/index.js";
import type {
  DurableWorkflowControlView,
  DurableWorkflowEvidenceKind,
  DurableWorkflowEvidenceProducer,
  TaskStorage,
  TaskStorageError,
} from "../src/index.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
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

const authoritySourceTypeFor = (
  kind: DurableWorkflowEvidenceKind,
) => {
  switch (kind) {
    case "REPOSITORY_PREFLIGHT_PASSED":
      return "REPOSITORY_PREFLIGHT" as const;
    case "CONTEXT_PREFLIGHT_PASSED":
      return "CONTEXT_PREFLIGHT" as const;
    case "BUDGET_AVAILABLE":
      return "BUDGET_GATE" as const;
    case "CONCURRENCY_AVAILABLE":
      return "CONCURRENCY_GATE" as const;
    case "WORKTREE_OWNERSHIP_AVAILABLE":
      return "WORKTREE_OWNERSHIP" as const;
    case "HUMAN_APPROVAL_SATISFIED":
      return "HUMAN_APPROVAL" as const;
    case "VERIFICATION_EVIDENCE_PASSED":
      return "VERIFICATION_ROLE" as const;
    case "HARDENING_EVIDENCE_PASSED":
      return "HARDENING_ROLE" as const;
    case "FRESH_QA_OUTCOME_RECORDED":
      return "FRESH_INDEPENDENT_QA" as const;
    case "REPAIR_EVIDENCE_PASSED":
      return "REPAIR_ROLE" as const;
    case "FOCUSED_RE_QA_OUTCOME_RECORDED":
      return "FOCUSED_RE_QA" as const;
    case "NO_UNRESOLVED_BLOCKING_FINDING":
      return "BLOCKING_FINDING_CONTROL" as const;
    case "HANDOFF_PRESENT":
      return "HANDOFF_CONTROL" as const;
    case "PROMOTED_CONTEXT_DISPOSITION_RECORDED":
      return "PROMOTED_CONTEXT_DISPOSITION" as const;
  }
};

const acceptEvidence = (
  storage: TaskStorage,
  view: DurableWorkflowControlView,
  kind: DurableWorkflowEvidenceKind,
  suffix: string,
  outcome: "PASS" | "BLOCKING_FAIL" = "PASS",
) =>
  {
    const access = getTaskStorageWorktreeAccess(storage);
    expect(access).not.toBeNull();
    const occurredAt =
      view.transitions[view.transitions.length - 1]?.occurredAt ??
      view.initializedAt;
    const authorityValues = [
      `wfa_${suffix}`,
      view.projectId,
      view.bigTaskId,
      view.planRevision,
      view.candidateBinding,
      view.subtaskId,
      view.transitionCount + 1,
      view.currentStage,
      view.repairCyclesUsed,
      authoritySourceTypeFor(kind),
      kind,
      outcome,
      producerFor(kind),
      `source:${suffix}`,
      occurredAt,
      occurredAt,
    ] as const;
    access!.sqlite.exec("SAVEPOINT trusted_workflow_evidence_fixture");
    try {
      access!.sqlite.prepare(
        `INSERT INTO durable_workflow_evidence_authorities
          (authority_id, project_id, big_task_id, plan_revision,
           candidate_binding, subtask_id, expected_sequence, observed_stage,
           observed_repair_cycles_used, source_type, evidence_kind, outcome,
           producer, source_reference, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...authorityValues);
      access!.sqlite.prepare(
        `INSERT INTO durable_workflow_evidence
          (evidence_id, authority_id, project_id, big_task_id, plan_revision,
           candidate_binding, subtask_id, expected_sequence, observed_stage,
           observed_repair_cycles_used, evidence_kind, outcome, producer,
           source_reference, occurred_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `wfe_${suffix}`,
        authorityValues[0],
        ...authorityValues.slice(1, 9),
        ...authorityValues.slice(10),
      );
      const stored = storage.getDurableWorkflowEvidence(`wfe_${suffix}`);
      access!.sqlite.exec("RELEASE trusted_workflow_evidence_fixture");
      return stored!;
    } catch (error) {
      access!.sqlite.exec("ROLLBACK TO trusted_workflow_evidence_fixture");
      access!.sqlite.exec("RELEASE trusted_workflow_evidence_fixture");
      throw error;
    }
  };

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

const mutateBehindImmutableUpdateTrigger = (
  sqlite: DatabaseSync,
  table: string,
  mutation: string,
): void => {
  const trigger = `${table}_immutable_update`;
  sqlite.exec(`DROP TRIGGER ${trigger}`);
  sqlite.exec(mutation);
  sqlite.exec(
    `CREATE TRIGGER ${trigger}
       BEFORE UPDATE ON ${table}
       BEGIN SELECT RAISE(ABORT, 'immutable hardening fixture'); END`,
  );
};

const waitForFiles = async (paths: readonly string[]): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Cross-process workflow-control barrier was not reached.");
};

const runWorkflowControlWorker = (
  databasePath: string,
  readyPath: string,
  goPath: string,
  outcomePath: string,
  request: Parameters<TaskStorage["advanceDurableWorkflow"]>[0],
): Promise<Readonly<{ readonly status: number | null; readonly output: string }>> =>
  new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
        "run",
        "packages/storage/test/workflow-control-process-worker.test.ts",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CTC_8C_PROCESS_DATABASE_PATH: databasePath,
          CTC_8C_PROCESS_READY_PATH: readyPath,
          CTC_8C_PROCESS_GO_PATH: goPath,
          CTC_8C_PROCESS_OUTCOME_PATH: outcomePath,
          CTC_8C_PROCESS_REQUEST: JSON.stringify(request),
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
    child.on("close", (status) =>
      resolvePromise(Object.freeze({ status, output })),
    );
  });

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
      expect(storage).not.toHaveProperty("acceptDurableWorkflowEvidence");
      expectStorageError(
        () =>
          acceptEvidence(
            storage,
            firstView,
            "HARDENING_EVIDENCE_PASSED",
            "irrelevant_hardening",
          ),
        "MALFORMED_STORED_DATA",
      );
      expectStorageError(
        () => advance(
          storage,
          firstView,
          "wop_forged_source",
          "EXECUTE",
          [workflowReference("wfe_forged_source")],
        ),
        "CONFLICT",
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
      const remaining = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
        "HUMAN_APPROVAL_SATISFIED",
      ] as const;
      const current = advance(
        storage,
        firstView,
        "wop_scope_a_materialize",
        "EXECUTE",
        [
          workflowReference(stale.evidenceId),
          ...remaining.map((kind, index) =>
            workflowReference(
              acceptEvidence(
                storage,
                firstView,
                kind,
                `scope_a_gate_${index}`,
              ).evidenceId,
            ),
          ),
        ],
      ).view;
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

  it("CTC-ORCH-8C-HARD-001 removes public self-attested evidence minting for every authority kind", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "public_authority",
        profiles: ["HIGH_RISK_FOUNDATION"],
      });
      const view = viewFor(storage, source.subtasks[0]!.subtaskId);
      expect(storage).not.toHaveProperty("acceptDurableWorkflowEvidence");
      for (const [index, kind] of DURABLE_WORKFLOW_EVIDENCE_KINDS.entries()) {
        expectStorageError(
          () =>
            storage.advanceDurableWorkflow({
              operationId: `wop_public_forgery_${index}`,
              projectId: view.projectId,
              bigTaskId: view.bigTaskId,
              candidateBinding: view.candidateBinding,
              subtaskId: view.subtaskId,
              requestedNextStage: "EXECUTE",
              evidenceReferences: [
                workflowReference(`wfe_public_${kind.toLowerCase()}`),
              ],
            }),
          "CONFLICT",
        );
      }
      expectStorageError(
        () =>
          storage.advanceDurableWorkflow({
            operationId: "wop_public_extra_authority",
            projectId: view.projectId,
            bigTaskId: view.bigTaskId,
            candidateBinding: view.candidateBinding,
            subtaskId: view.subtaskId,
            requestedNextStage: "EXECUTE",
            evidenceReferences: [],
            kind: "HUMAN_APPROVAL_SATISFIED",
            producer: "HUMAN_AUTHORITY",
            sourceReference: "caller:self",
          } as unknown as Parameters<TaskStorage["advanceDurableWorkflow"]>[0]),
        "INVALID_INPUT",
      );
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare(
          `SELECT
             (SELECT count(*) FROM durable_workflow_evidence_authorities) AS authorities,
             (SELECT count(*) FROM durable_workflow_evidence) AS evidence,
             (SELECT count(*) FROM durable_workflow_transitions) AS transitions,
             (SELECT count(*) FROM durable_workflow_human_requirements) AS requirements`,
        ).get(),
      ).toEqual({ authorities: 0, evidence: 0, transitions: 0, requirements: 0 });
      sqlite.close();
      storage.close();
    });
  });

  it.each([
    ["project identity", "project_id = 'prj_wrong'"],
    ["Big Task identity", "big_task_id = 'bt_wrong'"],
    ["candidate identity", "candidate_binding = 'wrong-binding'"],
    ["Subtask identity", "subtask_id = 'st_wrong'"],
    ["sequence", "expected_sequence = 2"],
    ["stage", "observed_stage = 'VERIFY'"],
    ["repair counter", "observed_repair_cycles_used = 1"],
    ["source type", "source_type = 'HUMAN_APPROVAL'"],
    ["semantic kind", "evidence_kind = 'HUMAN_APPROVAL_SATISFIED'"],
    ["producer category", "producer = 'HUMAN_AUTHORITY'"],
    ["source reference", "source_reference = 'source:forged'"],
    ["outcome", "outcome = 'BLOCKING_FAIL'"],
    ["occurred timestamp", "occurred_at = 'not-a-timestamp'"],
    ["recorded chronology", "recorded_at = '2000-01-01T00:00:00.000Z'"],
  ] as const)("fails closed for trusted-authority %s corruption", (_label, assignment) => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "authority_corruption",
        profiles: ["STANDARD"],
      });
      const view = viewFor(storage, source.subtasks[0]!.subtaskId);
      const evidence = acceptEvidence(
        storage,
        view,
        "BUDGET_AVAILABLE",
        "authority_corruption",
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
      mutateBehindImmutableUpdateTrigger(
        sqlite,
        "durable_workflow_evidence_authorities",
        `UPDATE durable_workflow_evidence_authorities SET ${assignment}
          WHERE authority_id = '${evidence.authorityId}'`,
      );
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      expectStorageError(
        () => storage.getDurableWorkflowEvidence(evidence.evidenceId),
        "MALFORMED_STORED_DATA",
      );
      expectStorageError(
        () => storage.getDurableWorkflowControlView(view.subtaskId),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it.each([
    ["authority link", "authority_id = 'wfa_missing'"],
    ["candidate identity", "candidate_binding = 'wrong-binding'"],
    ["sequence", "expected_sequence = 2"],
    ["stage", "observed_stage = 'VERIFY'"],
    ["kind", "evidence_kind = 'HUMAN_APPROVAL_SATISFIED'"],
    ["producer", "producer = 'HUMAN_AUTHORITY'"],
    ["source", "source_reference = 'source:forged'"],
    ["accepted chronology", "accepted_at = '2000-01-01T00:00:00.000Z'"],
  ] as const)("fails closed for accepted-evidence %s corruption", (_label, assignment) => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "evidence_corruption",
        profiles: ["STANDARD"],
      });
      const view = viewFor(storage, source.subtasks[0]!.subtaskId);
      const evidence = acceptEvidence(
        storage,
        view,
        "BUDGET_AVAILABLE",
        "evidence_corruption",
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
      mutateBehindImmutableUpdateTrigger(
        sqlite,
        "durable_workflow_evidence",
        `UPDATE durable_workflow_evidence SET ${assignment}
          WHERE evidence_id = '${evidence.evidenceId}'`,
      );
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      expectStorageError(
        () => storage.getDurableWorkflowEvidence(evidence.evidenceId),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("blocks update, delete, duplicate, replacement, and upsert mutations for every Step 8C authority table", () => {
    for (const recursiveTriggers of [0, 1]) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
        const { source } = seed(storage, {
          suffix: `immutable_${recursiveTriggers}`,
          profiles: ["STANDARD"],
        });
        const initial = viewFor(storage, source.subtasks[0]!.subtaskId);
        materializeToExecute(storage, initial, `immutable_${recursiveTriggers}`);
        storage.requestDurableMaterializedGraphChange({
          operationId: `wop_immutable_human_${recursiveTriggers}`,
          projectId: initial.projectId,
          bigTaskId: initial.bigTaskId,
          candidateBinding: initial.candidateBinding,
          changeKind: "SPLIT_SUBTASK",
        });

        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec(`PRAGMA recursive_triggers = ${recursiveTriggers}`);
        const targets = [
          ["durable_workflow_evidence_authorities", "authority_id"],
          ["durable_workflow_evidence", "evidence_id"],
          ["durable_workflow_transitions", "operation_id"],
          ["durable_workflow_human_requirements", "operation_id"],
        ] as const;
        for (const [table, primaryKey] of targets) {
          const statements = [
            `UPDATE ${table} SET ${primaryKey} = ${primaryKey}`,
            `DELETE FROM ${table}`,
            `INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1`,
            `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`,
            `INSERT INTO ${table} SELECT * FROM ${table} WHERE 1
               ON CONFLICT(${primaryKey}) DO UPDATE SET ${primaryKey} = excluded.${primaryKey}`,
          ];
          for (const statement of statements) {
            expect(() => sqlite.exec(statement)).toThrow();
          }
          expect(
            sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
          ).toEqual({ count: table.includes("human_requirements") ? 1 : table.includes("transitions") ? 1 : 6 });
        }
        sqlite.close();
        expect(viewFor(storage, initial.subtaskId)).toMatchObject({
          currentStage: "EXECUTE",
          transitionCount: 1,
          unresolvedHumanRequired: { reason: "REPLAN_REQUIRED" },
        });
        storage.close();
      });
    }
  });

  it("fails closed when any durable workflow authority trigger is lost and recovers only when the exact trigger is restored", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "trigger_integrity",
        profiles: ["STANDARD"],
      });
      const target = source.subtasks[0]!.subtaskId;
      const sqlite = new DatabaseSync(databasePath);
      const triggers = sqlite.prepare(
        `SELECT name, sql FROM sqlite_schema
          WHERE type = 'trigger' AND name LIKE 'durable_workflow_%'
          ORDER BY name`,
      ).all() as unknown as readonly { readonly name: string; readonly sql: string }[];
      expect(triggers).toHaveLength(17);
      for (const trigger of triggers) {
        sqlite.exec(`DROP TRIGGER ${trigger.name}`);
        expectStorageError(
          () => storage.getDurableWorkflowControlView(target),
          "MALFORMED_STORED_DATA",
        );
        sqlite.exec(trigger.sql);
        expect(viewFor(storage, target)).toMatchObject({
          currentStage: "MATERIALIZE",
          transitionCount: 0,
        });
      }
      sqlite.close();
      storage.close();
    });
  });

  it.each([
    ["sequence gap", "sequence = 2"],
    ["forked prior stage", "prior_stage = 'EXECUTE'"],
    ["wrong resulting stage", "resulting_stage = 'VERIFY'"],
    ["impossible prior repair count", "prior_repair_cycles_used = 1"],
    ["impossible resulting repair count", "resulting_repair_cycles_used = 1"],
    ["wrong Project", "project_id = 'prj_wrong'"],
    ["wrong Big Task", "big_task_id = 'bt_wrong'"],
    ["wrong candidate", "candidate_binding = 'wrong-binding'"],
    ["wrong Subtask", "subtask_id = 'st_wrong'"],
    ["malformed evidence JSON", "evidence_references = 'not-json'"],
    ["missing evidence references", "evidence_references = '[]'"],
    ["regressing timestamp", "occurred_at = '2000-01-01T00:00:00.000Z'"],
  ] as const)("rejects transition-history corruption: %s", (_label, assignment) => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "history_corruption",
        profiles: ["STANDARD"],
      });
      const target = source.subtasks[0]!.subtaskId;
      materializeToExecute(storage, viewFor(storage, target), "history_corruption");
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
      mutateBehindImmutableUpdateTrigger(
        sqlite,
        "durable_workflow_transitions",
        `UPDATE durable_workflow_transitions SET ${assignment}`,
      );
      sqlite.close();
      storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      expectStorageError(
        () => storage.getDurableWorkflowControlView(target),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("rejects reordered and duplicate stored evidence-reference encodings", () => {
    for (const mode of ["REORDERED", "DUPLICATE"] as const) {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
        const { source } = seed(storage, {
          suffix: `reference_${mode.toLowerCase()}`,
          profiles: ["STANDARD"],
        });
        const target = source.subtasks[0]!.subtaskId;
        materializeToExecute(
          storage,
          viewFor(storage, target),
          `reference_${mode.toLowerCase()}`,
        );
        storage.close();

        const sqlite = new DatabaseSync(databasePath);
        const row = sqlite.prepare(
          "SELECT evidence_references AS encoded FROM durable_workflow_transitions",
        ).get() as { readonly encoded: string };
        const references = JSON.parse(row.encoded) as unknown[];
        const malformed = mode === "REORDERED"
          ? JSON.stringify([...references].reverse())
          : JSON.stringify([...references, references[0]]);
        const triggerSql = sqlite.prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'trigger'
              AND name = 'durable_workflow_transitions_immutable_update'`,
        ).get() as { readonly sql: string };
        sqlite.exec("DROP TRIGGER durable_workflow_transitions_immutable_update");
        sqlite.prepare(
          "UPDATE durable_workflow_transitions SET evidence_references = ?",
        ).run(malformed);
        sqlite.exec(triggerSql.sql);
        sqlite.close();

        storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
        expectStorageError(
          () => storage.getDurableWorkflowControlView(target),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("rejects history whose final stage disagrees with board or maturity composition", () => {
    for (const corruption of [
      "status = 'QA_DEBUG'",
      "maturity = 'ACCEPTED'",
    ]) {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
        const { source } = seed(storage, {
          suffix: `composition_${corruption.startsWith("status") ? "status" : "maturity"}`,
          profiles: ["LOW"],
        });
        const target = source.subtasks[0]!.subtaskId;
        let view = viewFor(storage, target);
        const implementation = completeImplementation(
          storage,
          databasePath,
          view,
          "composition",
        );
        view = advance(storage, view, "wop_composition_verify", "VERIFY", [
          checkpointReference(implementation.checkpoint.id),
        ]).view;
        advance(
          storage,
          view,
          "wop_composition_complete",
          "COMPLETE",
          completionEvidence(
            storage,
            view,
            "VERIFICATION_EVIDENCE_PASSED",
            "composition",
          ),
        );
        storage.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec(`UPDATE subtasks SET ${corruption} WHERE id = '${target}'`);
        sqlite.close();
        storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
        expectStorageError(
          () => storage.getDurableWorkflowControlView(target),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("fails a regressing storage clock atomically without consuming trusted evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "regressing_clock",
        profiles: ["STANDARD"],
      });
      const target = source.subtasks[0]!.subtaskId;
      const initial = viewFor(storage, target);
      const references = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "BUDGET_AVAILABLE",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
        "HUMAN_APPROVAL_SATISFIED",
      ].map((kind, index) =>
        workflowReference(
          acceptEvidence(
            storage,
            initial,
            kind as DurableWorkflowEvidenceKind,
            `regressing_clock_${index}`,
          ).evidenceId,
        ),
      );
      storage.close();
      storage = openTaskDatabase({
        databasePath,
        clock: () => new Date("2000-01-01T00:00:00.000Z"),
      });
      expectStorageError(
        () =>
          advance(
            storage,
            initial,
            "wop_regressing_clock",
            "EXECUTE",
            references,
          ),
        "STORAGE_OPERATION_FAILED",
      );
      expect(viewFor(storage, target)).toMatchObject({
        currentStage: "MATERIALIZE",
        transitionCount: 0,
      });
      storage.close();
    });
  });

  it("serializes exact retries and competing operation IDs across processes without forking history", { timeout: 30_000 }, async () => {
    for (const mode of ["EXACT_RETRY", "COMPETING_IDS"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "ctc-step8c-process-"));
      const databasePath = join(directory, "workflow.sqlite");
      try {
        const storage = openTaskDatabase({
          databasePath,
          clock: incrementingClock(),
        });
        const suffix = mode.toLowerCase();
        const { source } = seed(storage, {
          suffix,
          profiles: ["STANDARD"],
        });
        const view = viewFor(storage, source.subtasks[0]!.subtaskId);
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
              storage,
              view,
              kind,
              `${suffix}_process_${index}`,
            ).evidenceId,
          ),
        );
        storage.close();

        const baseRequest = {
          projectId: view.projectId,
          bigTaskId: view.bigTaskId,
          candidateBinding: view.candidateBinding,
          subtaskId: view.subtaskId,
          requestedNextStage: "EXECUTE" as const,
          evidenceReferences: references,
        };
        const readyPaths = [join(directory, "ready-a"), join(directory, "ready-b")];
        const outcomePaths = [
          join(directory, "outcome-a.json"),
          join(directory, "outcome-b.json"),
        ];
        const goPath = join(directory, "go");
        const workers = [0, 1].map((index) =>
          runWorkflowControlWorker(
            databasePath,
            readyPaths[index]!,
            goPath,
            outcomePaths[index]!,
            {
              ...baseRequest,
              operationId:
                mode === "EXACT_RETRY"
                  ? "wop_process_exact"
                  : `wop_process_competing_${index}`,
            },
          ),
        );
        await waitForFiles(readyPaths);
        writeFileSync(goPath, "go\n", { encoding: "utf-8" });
        const results = await Promise.all(workers);
        for (const result of results) {
          expect(result.status, result.output).toBe(0);
        }
        await waitForFiles(outcomePaths);
        const outcomes = outcomePaths.map((path) =>
          JSON.parse(readFileSync(path, "utf-8")) as {
            readonly kind: string;
            readonly code?: string;
            readonly operationId?: string;
          },
        );
        if (mode === "EXACT_RETRY") {
          expect(outcomes).toEqual([
            {
              kind: "TRANSITION_RECORDED",
              operationId: "wop_process_exact",
              transitionCount: 1,
            },
            {
              kind: "TRANSITION_RECORDED",
              operationId: "wop_process_exact",
              transitionCount: 1,
            },
          ]);
        } else {
          expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
            "ERROR",
            "TRANSITION_RECORDED",
          ]);
          expect(outcomes.find(({ kind }) => kind === "ERROR")?.code).toBe(
            "CONFLICT",
          );
        }
        const reopened = openTaskDatabase({
          databasePath,
          clock: incrementingClock(),
        });
        expect(viewFor(reopened, view.subtaskId)).toMatchObject({
          currentStage: "EXECUTE",
          transitionCount: 1,
        });
        const sqlite = new DatabaseSync(databasePath, { readOnly: true });
        expect(
          sqlite.prepare(
            `SELECT sequence, count(*) AS count
               FROM durable_workflow_transitions GROUP BY sequence`,
          ).all(),
        ).toEqual([{ sequence: 1, count: 1 }]);
        sqlite.close();
        reopened.close();
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  });

  it("serializes trusted-evidence acceptance against transition and HUMAN_REQUIRED creation", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(first, {
        suffix: "evidence_transition_race",
        profiles: ["STANDARD"],
      });
      const initial = viewFor(first, source.subtasks[0]!.subtaskId);
      const kinds = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
        "HUMAN_APPROVAL_SATISFIED",
      ] as const;
      const references = kinds.map((kind, index) =>
        workflowReference(
          acceptEvidence(
            first,
            initial,
            kind,
            `evidence_transition_race_${index}`,
          ).evidenceId,
        ),
      );
      const second = openTaskDatabase({
        databasePath,
        clock: () => new Date("2026-09-04T00:00:00.000Z"),
      });
      getTaskStorageWorktreeAccess(second)!.sqlite.exec("PRAGMA busy_timeout = 0");
      const budget = first.runInTransaction((transaction) => {
        const accepted = acceptEvidence(
          transaction,
          initial,
          "BUDGET_AVAILABLE",
          "evidence_transition_race_budget",
        );
        expectStorageError(
          () =>
            advance(
              second,
              initial,
              "wop_evidence_transition_race",
              "EXECUTE",
              [...references, workflowReference(accepted.evidenceId)],
            ),
          "TRANSACTION_FAILED",
        );
        return accepted;
      });
      const transitioned = advance(
        second,
        initial,
        "wop_evidence_transition_race",
        "EXECUTE",
        [...references, workflowReference(budget.evidenceId)],
      );
      expect(transitioned).toMatchObject({
        kind: "TRANSITION_RECORDED",
        view: { currentStage: "EXECUTE", transitionCount: 1 },
      });
      first.close();
      second.close();
    });

    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(first, {
        suffix: "evidence_human_race",
        profiles: ["STANDARD"],
      });
      const initial = viewFor(first, source.subtasks[0]!.subtaskId);
      const firstFour = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "BUDGET_AVAILABLE",
        "CONCURRENCY_AVAILABLE",
      ] as const;
      const references = firstFour.map((kind, index) =>
        workflowReference(
          acceptEvidence(
            first,
            initial,
            kind,
            `evidence_human_race_${index}`,
          ).evidenceId,
        ),
      );
      const second = openTaskDatabase({
        databasePath,
        clock: () => new Date("2026-09-04T00:00:00.000Z"),
      });
      getTaskStorageWorktreeAccess(second)!.sqlite.exec("PRAGMA busy_timeout = 0");
      const worktree = first.runInTransaction((transaction) => {
        const accepted = acceptEvidence(
          transaction,
          initial,
          "WORKTREE_OWNERSHIP_AVAILABLE",
          "evidence_human_race_worktree",
        );
        expectStorageError(
          () =>
            advance(
              second,
              initial,
              "wop_evidence_human_race",
              "EXECUTE",
              [...references, workflowReference(accepted.evidenceId)],
            ),
          "TRANSACTION_FAILED",
        );
        return accepted;
      });
      const human = advance(
        second,
        initial,
        "wop_evidence_human_race",
        "EXECUTE",
        [...references, workflowReference(worktree.evidenceId)],
      );
      expect(human).toMatchObject({
        kind: "HUMAN_REQUIRED",
        requirement: { reason: "AUTHORITY_BLOCKED", sequence: 1 },
        view: { currentStage: "MATERIALIZE", transitionCount: 0 },
      });
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare(
          `SELECT
             (SELECT count(*) FROM durable_workflow_transitions) AS transitions,
             (SELECT count(*) FROM durable_workflow_human_requirements) AS requirements`,
        ).get(),
      ).toEqual({ transitions: 0, requirements: 1 });
      sqlite.close();
      first.close();
      second.close();
    });
  });

  it("serializes graph-change HUMAN_REQUIRED against a competing transition with no partial write", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(first, {
        suffix: "graph_transition_race",
        profiles: ["STANDARD"],
      });
      const initial = viewFor(first, source.subtasks[0]!.subtaskId);
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
            first,
            initial,
            kind,
            `graph_transition_race_${index}`,
          ).evidenceId,
        ),
      );
      const second = openTaskDatabase({ databasePath, clock: incrementingClock() });
      getTaskStorageWorktreeAccess(second)!.sqlite.exec("PRAGMA busy_timeout = 0");
      first.runInTransaction((transaction) => {
        expect(
          transaction.requestDurableMaterializedGraphChange({
            operationId: "wop_graph_transition_human",
            projectId: initial.projectId,
            bigTaskId: initial.bigTaskId,
            candidateBinding: initial.candidateBinding,
            changeKind: "CHANGE_DEPENDENCIES",
          }).kind,
        ).toBe("HUMAN_REQUIRED");
        expectStorageError(
          () =>
            advance(
              second,
              initial,
              "wop_graph_transition_competitor",
              "EXECUTE",
              references,
            ),
          "TRANSACTION_FAILED",
        );
      });
      expectStorageError(
        () =>
          advance(
            second,
            initial,
            "wop_graph_transition_competitor",
            "EXECUTE",
            references,
          ),
        "CONFLICT",
      );
      expect(viewFor(second, initial.subtaskId)).toMatchObject({
        currentStage: "MATERIALIZE",
        transitionCount: 0,
        unresolvedHumanRequired: { reason: "REPLAN_REQUIRED" },
      });
      first.close();
      second.close();
    });
  });

  it("enforces one trusted semantic source and one evidence record under competing inserts", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "unique_source",
        profiles: ["STANDARD"],
      });
      const view = viewFor(storage, source.subtasks[0]!.subtaskId);
      const evidence = acceptEvidence(
        storage,
        view,
        "BUDGET_AVAILABLE",
        "unique_source",
      );
      const sqlite = new DatabaseSync(databasePath);
      expect(() =>
        sqlite.exec(
          `INSERT INTO durable_workflow_evidence_authorities
           SELECT 'wfa_same_source_other_kind', project_id, big_task_id,
                  plan_revision, candidate_binding, subtask_id,
                  expected_sequence, observed_stage, observed_repair_cycles_used,
                  'CONTEXT_PREFLIGHT', 'CONTEXT_PREFLIGHT_PASSED', outcome,
                  producer, source_reference, occurred_at, recorded_at
             FROM durable_workflow_evidence_authorities
            WHERE authority_id = '${evidence.authorityId}'`,
        ),
      ).toThrow();
      expect(() =>
        sqlite.exec(
          `INSERT INTO durable_workflow_evidence_authorities
           SELECT 'wfa_same_semantic_other_source', project_id, big_task_id,
                  plan_revision, candidate_binding, subtask_id,
                  expected_sequence, observed_stage, observed_repair_cycles_used,
                  source_type, evidence_kind, outcome, producer,
                  'source:other', occurred_at, recorded_at
             FROM durable_workflow_evidence_authorities
            WHERE authority_id = '${evidence.authorityId}'`,
        ),
      ).toThrow();
      expect(
        sqlite.prepare(
          `SELECT
             (SELECT count(*) FROM durable_workflow_evidence_authorities) AS authorities,
             (SELECT count(*) FROM durable_workflow_evidence) AS evidence`,
        ).get(),
      ).toEqual({ authorities: 1, evidence: 1 });
      sqlite.close();
      expect(storage.getDurableWorkflowEvidence(evidence.evidenceId)).toEqual(
        evidence,
      );
      storage.close();
    });
  });

  it("fails closed for simultaneous Big-Task and Subtask HUMAN_REQUIRED corruption", () => {
    withTemporaryDatabasePath((databasePath) => {
      let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "double_human",
        profiles: ["STANDARD"],
      });
      const initial = viewFor(storage, source.subtasks[0]!.subtaskId);
      const kinds = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "BUDGET_AVAILABLE",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
      ] as const;
      const references = kinds.map((kind, index) =>
        workflowReference(
          acceptEvidence(
            storage,
            initial,
            kind,
            `double_human_${index}`,
          ).evidenceId,
        ),
      );
      const scoped = advance(
        storage,
        initial,
        "wop_double_human_scoped",
        "EXECUTE",
        references,
      );
      expect(scoped.kind).toBe("HUMAN_REQUIRED");
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      const trigger = sqlite.prepare(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'trigger'
            AND name = 'durable_workflow_human_requirements_current_state_guard'`,
      ).get() as { readonly sql: string };
      sqlite.exec("DROP TRIGGER durable_workflow_human_requirements_current_state_guard");
      sqlite.prepare(
        `INSERT INTO durable_workflow_human_requirements
          (operation_id, project_id, big_task_id, plan_revision,
           candidate_binding, scope_kind, scope_key, subtask_id, sequence,
           current_stage, requested_next_stage, repair_cycles_used, reason,
           evidence_references, source_reference, created_at)
         VALUES ('wop_double_human_global', ?, ?, ?, ?, 'BIG_TASK', ?, NULL,
                 NULL, NULL, NULL, NULL, 'REPLAN_REQUIRED', '[]',
                 'materialized-graph-change:SPLIT_SUBTASK', ?)`,
      ).run(
        initial.projectId,
        initial.bigTaskId,
        initial.planRevision,
        initial.candidateBinding,
        initial.bigTaskId,
        scoped.kind === "HUMAN_REQUIRED"
          ? scoped.requirement.createdAt
          : initial.initializedAt,
      );
      sqlite.exec(trigger.sql);
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      expectStorageError(
        () => storage.getDurableWorkflowControlView(initial.subtaskId),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
    });
  });

  it("fails closed when any durable workflow authority index is lost", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "index_integrity",
        profiles: ["STANDARD"],
      });
      const target = source.subtasks[0]!.subtaskId;
      const sqlite = new DatabaseSync(databasePath);
      const indexes = sqlite.prepare(
        `SELECT name, sql FROM sqlite_schema
          WHERE type = 'index' AND name LIKE 'durable_workflow_%'
          ORDER BY name`,
      ).all() as unknown as readonly { readonly name: string; readonly sql: string }[];
      expect(indexes).toHaveLength(11);
      for (const index of indexes) {
        sqlite.exec(`DROP INDEX ${index.name}`);
        expectStorageError(
          () => storage.getDurableWorkflowControlView(target),
          "MALFORMED_STORED_DATA",
        );
        sqlite.exec(index.sql);
        expect(viewFor(storage, target).currentStage).toBe("MATERIALIZE");
      }
      sqlite.close();
      storage.close();
    });
  });

  it("rejects orphan authority receipts and evidence created before stage entry", () => {
    for (const mode of ["ORPHAN_AUTHORITY", "STALE_EVIDENCE"] as const) {
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
        const { source } = seed(storage, {
          suffix: mode.toLowerCase(),
          profiles: ["STANDARD"],
        });
        const view = viewFor(storage, source.subtasks[0]!.subtaskId);
        storage.close();
        const sqlite = new DatabaseSync(databasePath);
        const occurredAt = mode === "STALE_EVIDENCE"
          ? "2000-01-01T00:00:00.000Z"
          : view.initializedAt;
        sqlite.prepare(
          `INSERT INTO durable_workflow_evidence_authorities
            (authority_id, project_id, big_task_id, plan_revision,
             candidate_binding, subtask_id, expected_sequence, observed_stage,
             observed_repair_cycles_used, source_type, evidence_kind, outcome,
             producer, source_reference, occurred_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'MATERIALIZE', 0, 'BUDGET_GATE',
                   'BUDGET_AVAILABLE', 'PASS', 'OPERATIONAL_GATE', ?, ?, ?)`,
        ).run(
          `wfa_${mode.toLowerCase()}`,
          view.projectId,
          view.bigTaskId,
          view.planRevision,
          view.candidateBinding,
          view.subtaskId,
          `source:${mode.toLowerCase()}`,
          occurredAt,
          occurredAt,
        );
        if (mode === "STALE_EVIDENCE") {
          sqlite.prepare(
            `INSERT INTO durable_workflow_evidence
              (evidence_id, authority_id, project_id, big_task_id,
               plan_revision, candidate_binding, subtask_id, expected_sequence,
               observed_stage, observed_repair_cycles_used, evidence_kind,
               outcome, producer, source_reference, occurred_at, accepted_at)
             SELECT 'wfe_stale_evidence', authority_id, project_id, big_task_id,
                    plan_revision, candidate_binding, subtask_id,
                    expected_sequence, observed_stage,
                    observed_repair_cycles_used, evidence_kind, outcome,
                    producer, source_reference, occurred_at, recorded_at
               FROM durable_workflow_evidence_authorities`,
          ).run();
        }
        sqlite.close();
        storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
        expectStorageError(
          () => storage.getDurableWorkflowControlView(view.subtaskId),
          "MALFORMED_STORED_DATA",
        );
        storage.close();
      });
    }
  });

  it("keeps future evidence pending and rolls back a transition whose clock has not reached it", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: incrementingClock() });
      const { source } = seed(storage, {
        suffix: "future_evidence",
        profiles: ["STANDARD"],
      });
      const view = viewFor(storage, source.subtasks[0]!.subtaskId);
      const budget = acceptEvidence(
        storage,
        view,
        "BUDGET_AVAILABLE",
        "future_evidence_budget",
      );
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      mutateBehindImmutableUpdateTrigger(
        sqlite,
        "durable_workflow_evidence_authorities",
        `UPDATE durable_workflow_evidence_authorities
            SET occurred_at = '2099-01-01T00:00:00.000Z',
                recorded_at = '2099-01-01T00:00:00.000Z'
          WHERE authority_id = '${budget.authorityId}'`,
      );
      mutateBehindImmutableUpdateTrigger(
        sqlite,
        "durable_workflow_evidence",
        `UPDATE durable_workflow_evidence
            SET occurred_at = '2099-01-01T00:00:00.000Z',
                accepted_at = '2099-01-01T00:00:00.000Z'
          WHERE evidence_id = '${budget.evidenceId}'`,
      );
      sqlite.close();
      const futureBudget = storage.getDurableWorkflowEvidence(budget.evidenceId)!;
      const otherKinds = [
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
        "HUMAN_APPROVAL_SATISFIED",
      ] as const;
      const references = [
        workflowReference(futureBudget.evidenceId),
        ...otherKinds.map((kind, index) =>
          workflowReference(
            acceptEvidence(
              storage,
              view,
              kind,
              `future_evidence_${index}`,
            ).evidenceId,
          ),
        ),
      ];
      expectStorageError(
        () =>
          advance(
            storage,
            view,
            "wop_future_evidence",
            "EXECUTE",
            references,
          ),
        "STORAGE_OPERATION_FAILED",
      );
      expect(viewFor(storage, view.subtaskId)).toMatchObject({
        currentStage: "MATERIALIZE",
        transitionCount: 0,
      });
      storage.close();
    });
  });

  it("reopens high-risk history after every stage with equal source timestamps and preserves one repair ceiling", () => {
    withTemporaryDatabasePath((databasePath) => {
      const sharedClock = incrementingClock();
      let storage = openTaskDatabase({ databasePath, clock: sharedClock });
      const { source } = seed(storage, {
        suffix: "equal_reopen",
        profiles: ["HIGH_RISK_FOUNDATION"],
      });
      const target = source.subtasks[0]!.subtaskId;
      let view = materializeToExecute(
        storage,
        viewFor(storage, target),
        "equal_reopen",
      );
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: sharedClock });
      expect(viewFor(storage, target)).toEqual(view);
      const implementation = completeImplementation(
        storage,
        databasePath,
        view,
        "equal_reopen",
      );
      view = advance(storage, view, "wop_equal_reopen_harden", "HARDEN", [
        checkpointReference(implementation.checkpoint.id),
      ]).view;
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: sharedClock });
      expect(viewFor(storage, target)).toEqual(view);
      const hardened = acceptEvidence(
        storage,
        view,
        "HARDENING_EVIDENCE_PASSED",
        "equal_reopen_hardening",
      );
      view = advance(storage, view, "wop_equal_reopen_fresh", "FRESH_QA", [
        workflowReference(hardened.evidenceId),
      ]).view;
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: sharedClock });
      expect(viewFor(storage, target)).toEqual(view);
      view = advance(
        storage,
        view,
        "wop_equal_reopen_repair",
        "REPAIR",
        completionEvidence(
          storage,
          view,
          "FRESH_QA_OUTCOME_RECORDED",
          "equal_reopen_fqa",
          "BLOCKING_FAIL",
        ),
      ).view;
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: sharedClock });
      expect(viewFor(storage, target)).toEqual(view);
      const repair = acceptEvidence(
        storage,
        view,
        "REPAIR_EVIDENCE_PASSED",
        "equal_reopen_repair",
      );
      view = advance(
        storage,
        view,
        "wop_equal_reopen_focused",
        "FOCUSED_RE_QA",
        [workflowReference(repair.evidenceId)],
      ).view;
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: sharedClock });
      expect(viewFor(storage, target)).toEqual(view);
      const completed = advance(
        storage,
        view,
        "wop_equal_reopen_complete",
        "COMPLETE",
        completionEvidence(
          storage,
          view,
          "FOCUSED_RE_QA_OUTCOME_RECORDED",
          "equal_reopen_reqa",
        ),
      );
      expect(completed.view).toMatchObject({
        currentStage: "COMPLETE",
        repairCyclesUsed: 1,
        boardStatus: "DONE",
        deliveryMaturity: "ACCEPTED",
      });
      storage.close();
      storage = openTaskDatabase({ databasePath, clock: sharedClock });
      expect(viewFor(storage, target)).toEqual(completed.view);
      storage.close();
    });
  });
});
