import { describe, expect, it } from "vitest";

import {
  MATERIALIZED_GRAPH_CHANGE_KINDS,
  applyReviewerDecision,
  beginPlanReview,
  evaluateBigTaskCompletion,
  evaluateStageTransition,
  materializeApprovedPlan,
  rejectMaterializedGraphChange,
  selectSerialWriteDispatch,
  submitPlannerRevision,
  validatePlanCandidateGraph,
} from "../src/index.js";
import type {
  MaterializedGraphChangeKind,
  PlanCandidate,
  ReviewDecision,
  StageTransitionInput,
} from "../src/index.js";
import {
  approvalFor,
  blockingDependency,
  dispatchState,
  executionFacts,
  executionFactsSnapshotFor,
  materializedGraphFor,
  planCandidate,
  proposedSubtask,
  projectWriteCapacityFor,
  rejectionFor,
  reviewStateFor,
  stageEvidenceFor,
  stateSnapshotFor,
} from "./fixtures.js";

const invalidGraphCodes = (input: unknown): readonly string[] => {
  const result = validatePlanCandidateGraph(input);
  return result.valid ? [] : result.errors.map(({ code }) => code);
};

describe("plan candidate and graph boundaries", () => {
  it("fails closed for noncanonical IDs, unknown profiles, and unknown fields", () => {
    const base = planCandidate();
    expect(
      invalidGraphCodes({
        ...base,
        subtasks: [{ ...base.subtasks[0], id: " st_a " }],
      }),
    ).toEqual(["INVALID_PLAN_CANDIDATE"]);
    expect(
      invalidGraphCodes({
        ...base,
        subtasks: [{ ...base.subtasks[0], profile: "CUSTOM" }],
      }),
    ).toEqual(["INVALID_PLAN_CANDIDATE"]);
    expect(invalidGraphCodes({ ...base, everythingReady: true })).toEqual([
      "INVALID_PLAN_CANDIDATE",
    ]);
  });

  it("rejects duplicate proposed Subtasks and mixed Big Task ownership", () => {
    expect(
      invalidGraphCodes(
        planCandidate({
          subtasks: [proposedSubtask("st_a"), proposedSubtask("st_a")],
        }),
      ),
    ).toContain("DUPLICATE_SUBTASK_ID");
    expect(
      invalidGraphCodes(
        planCandidate({
          subtasks: [
            proposedSubtask("st_a"),
            proposedSubtask("st_b", "STANDARD", "bt_other"),
          ],
        }),
      ),
    ).toContain("BIG_TASK_OWNERSHIP_MISMATCH");
  });

  it("reuses Domain validation for missing endpoints, self-dependency, and blocking cycles", () => {
    expect(
      invalidGraphCodes(
        planCandidate({
          subtasks: [proposedSubtask("st_a")],
          dependencies: [blockingDependency("st_missing", "st_a")],
        }),
      ),
    ).toContain("MISSING_UPSTREAM_SUBTASK");
    expect(
      invalidGraphCodes(
        planCandidate({
          subtasks: [proposedSubtask("st_a")],
          dependencies: [blockingDependency("st_a", "st_a")],
        }),
      ),
    ).toContain("SELF_DEPENDENCY");
    expect(
      invalidGraphCodes(
        planCandidate({
          subtasks: [proposedSubtask("st_a"), proposedSubtask("st_b")],
          dependencies: [
            blockingDependency("st_a", "st_b"),
            blockingDependency("st_b", "st_a"),
          ],
        }),
      ),
    ).toContain("DEPENDENCY_CYCLE");
  });

  it("rejects an illegal dependency type/gate combination before materialization", () => {
    const base = planCandidate({
      subtasks: [proposedSubtask("st_a"), proposedSubtask("st_b")],
    });
    expect(
      invalidGraphCodes({
        ...base,
        dependencies: [
          {
            upstreamSubtaskId: "st_a",
            downstreamSubtaskId: "st_b",
            dependencyType: "INFORMATIONAL",
            requiredGate: "HARDENED",
            reason: "This invalid combination must fail closed.",
          },
        ],
      }),
    ).toEqual(["INVALID_DEPENDENCY"]);
  });
});

describe("review authority boundaries", () => {
  it("binds approval to the exact current plan revision", () => {
    const state = reviewStateFor(planCandidate({ revision: 4 }));
    expect(
      applyReviewerDecision(state, {
        outcome: "APPROVE",
        planRevision: 3,
        candidateBinding: state.candidateBinding,
      }),
    ).toEqual({ kind: "INVALID_OPERATION", reason: "STALE_REVIEW_DECISION" });
  });

  it("does not let a Reviewer replace the plan inside an approval", () => {
    const state = reviewStateFor(planCandidate());
    const invalidDecision = {
      outcome: "APPROVE",
      planRevision: 1,
      candidateBinding: state.candidateBinding,
      replacementPlan: planCandidate({ revision: 2 }),
    } as unknown as ReviewDecision;
    expect(applyReviewerDecision(state, invalidDecision)).toEqual({
      kind: "INVALID_OPERATION",
      reason: "INVALID_REVIEW_DECISION",
    });
  });

  it("rejects stale or skipped planner revisions and preserves the automatic count", () => {
    const initial = reviewStateFor(planCandidate({ revision: 7 }));
    const rejection = applyReviewerDecision(
      initial,
      rejectionFor(initial, ["Revise the bounded graph."]),
    );
    expect(rejection.kind).toBe("REVIEW_STATE");
    if (rejection.kind !== "REVIEW_STATE") {
      throw new Error("Expected a rejected review state.");
    }
    expect(submitPlannerRevision(rejection.state, planCandidate({ revision: 9 }))).toEqual({
      kind: "INVALID_OPERATION",
      reason: "INVALID_PLAN_REVISION",
    });
    const revision = submitPlannerRevision(rejection.state, planCandidate({ revision: 8 }));
    expect(revision).toMatchObject({
      kind: "REVIEW_STATE",
      state: { automaticRevisionsUsed: 1, initialPlanRevision: 7 },
    });
  });

  it("requires review approval before materialization", () => {
    expect(materializeApprovedPlan(reviewStateFor(planCandidate()))).toEqual({
      kind: "HUMAN_REQUIRED",
      reason: "AUTHORITY_BLOCKED",
    });
  });

  it("refuses to materialize even an approved structurally invalid graph", () => {
    const candidate = planCandidate({
      dependencies: [blockingDependency("st_missing", "st_a")],
    });
    const started = reviewStateFor(candidate);
    const approved = applyReviewerDecision(started, approvalFor(started));
    expect(approved.kind).toBe("REVIEW_STATE");
    if (approved.kind !== "REVIEW_STATE") {
      throw new Error("Expected approval state.");
    }
    expect(materializeApprovedPlan(approved.state)).toMatchObject({
      kind: "GRAPH_INVALID",
      validation: {
        valid: false,
        errors: [{ code: "MISSING_UPSTREAM_SUBTASK" }],
      },
    });
  });
});

describe("stage, dispatch, and completion boundaries", () => {
  const standardGraph = materializedGraphFor(planCandidate());
  const stageInput = {
    graph: standardGraph,
    subtaskId: standardGraph.subtasks[0]!.id,
    currentStage: "MATERIALIZE",
    requestedNextStage: "EXECUTE",
    evidence: stageEvidenceFor(standardGraph, {
      graphMaterialized: true,
      dependenciesReady: true,
      repositoryPreflightPassed: true,
      contextPreflightPassed: true,
      budgetAvailable: true,
      concurrencyAvailable: true,
      worktreeOwnershipAvailable: true,
      humanApprovalSatisfied: true,
    }),
    repairCyclesUsed: 0,
  } as const satisfies StageTransitionInput;

  it("requires typed individual execution-entry gates", () => {
    expect(evaluateStageTransition(stageInput).kind).toBe("ELIGIBLE");
    expect(
      evaluateStageTransition({
        ...stageInput,
        evidence: stageEvidenceFor(standardGraph, {
          ...stageInput.evidence.facts,
          budgetAvailable: false,
        }),
      }),
    ).toMatchObject({
      kind: "BLOCKED",
      reason: "BUDGET_BLOCKED",
      missingEvidence: ["BUDGET_AVAILABLE"],
    });
  });

  it("fails closed for unknown profiles and invalid or post-completion transitions", () => {
    expect(
      evaluateStageTransition({
        ...stageInput,
        subtaskId: "st_missing",
      } as unknown as StageTransitionInput),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      evaluateStageTransition({
        ...stageInput,
        requestedNextStage: "VERIFY",
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_STAGE_TRANSITION" });
    expect(
      evaluateStageTransition({
        ...stageInput,
        currentStage: "COMPLETE",
        requestedNextStage: "EXECUTE",
        evidence: stageEvidenceFor(standardGraph, {}),
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_STAGE_TRANSITION" });
  });

  it("does not allow a used repair counter to enter a second repair", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_high", "HIGH_RISK_FOUNDATION")],
      }),
    );
    expect(
      evaluateStageTransition({
        graph,
        subtaskId: graph.subtasks[0]!.id,
        currentStage: "FRESH_QA",
        requestedNextStage: "REPAIR",
        evidence: stageEvidenceFor(graph, { freshQaOutcome: "BLOCKING_FAIL" }),
        repairCyclesUsed: 1,
      }),
    ).toMatchObject({
      kind: "BLOCKED",
      reason: "INVALID_INPUT",
      repairCyclesUsed: 1,
    });
  });

  it("blocks dispatch on dependency, budget, and serial-capacity facts", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_a"), proposedSubtask("st_b")],
        dependencies: [blockingDependency("st_a", "st_b", "ACCEPTED")],
      }),
    );
    const factsA = executionFacts("st_a");
    const factsB = executionFacts("st_b");
    const dependencyBlocked = selectSerialWriteDispatch({
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, [
        dispatchState("st_a", "IMPLEMENTED", "COMPLETE"),
        dispatchState("st_b"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, [factsA, factsB]),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    });
    expect(dependencyBlocked).toMatchObject({ kind: "BLOCKED", reason: "DEPENDENCY_BLOCKED" });

    expect(
      selectSerialWriteDispatch({
        graph,
        subtaskStateSnapshot: stateSnapshotFor(graph, [
          dispatchState("st_a", "ACCEPTED", "COMPLETE"),
          dispatchState("st_b"),
        ]),
        executionFactsSnapshot: executionFactsSnapshotFor(graph, [
          factsA,
          { ...factsB, budgetAvailable: false },
        ]),
        projectWriteCapacity: projectWriteCapacityFor(graph),
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "BUDGET_BLOCKED" });
    expect(
      selectSerialWriteDispatch({
        graph,
        subtaskStateSnapshot: stateSnapshotFor(graph, [
          dispatchState("st_a", "ACCEPTED", "COMPLETE"),
          dispatchState("st_b"),
        ]),
        executionFactsSnapshot: executionFactsSnapshotFor(graph, [
          factsA,
          { ...factsB, humanApprovalSatisfied: false },
        ]),
        projectWriteCapacity: projectWriteCapacityFor(graph),
      }),
    ).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "AUTHORITY_BLOCKED" });
    expect(
      selectSerialWriteDispatch({
        graph,
        subtaskStateSnapshot: stateSnapshotFor(graph, [
          dispatchState("st_a", "ACCEPTED", "COMPLETE"),
          dispatchState("st_b"),
        ]),
        executionFactsSnapshot: executionFactsSnapshotFor(graph, [factsA, factsB]),
        projectWriteCapacity: projectWriteCapacityFor(graph, [
          dispatchState("st_active").subtaskId,
        ]),
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "CONCURRENCY_BLOCKED" });
  });

  it("fails closed for malformed dispatch snapshots and incomplete completion", () => {
    const graph = materializedGraphFor(planCandidate());
    expect(
      selectSerialWriteDispatch({
        graph,
        subtaskStateSnapshot: stateSnapshotFor(graph, [
          dispatchState("st_a"),
          dispatchState("st_a"),
        ]),
        executionFactsSnapshot: executionFactsSnapshotFor(graph, [executionFacts("st_a")]),
        projectWriteCapacity: projectWriteCapacityFor(graph),
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      evaluateBigTaskCompletion(
        graph,
        stateSnapshotFor(graph, [dispatchState("st_a")]),
      ),
    ).toEqual({
      kind: "BLOCKED",
      reason: "REQUIRED_WORK_INCOMPLETE",
      incompleteSubtaskIds: ["st_a"],
    });
  });
});

describe("materialization freeze", () => {
  it.each(MATERIALIZED_GRAPH_CHANGE_KINDS)(
    "rejects %s as REPLAN_REQUIRED",
    (changeKind: MaterializedGraphChangeKind) => {
      const graph = materializedGraphFor(planCandidate());
      expect(rejectMaterializedGraphChange(graph, changeKind)).toMatchObject({
        kind: "HUMAN_REQUIRED",
        reason: "REPLAN_REQUIRED",
      });
    },
  );

  it("does not expose mutable graph arrays", () => {
    const graph = materializedGraphFor(planCandidate());
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.subtasks)).toBe(true);
    expect(Object.isFrozen(graph.subtasks[0])).toBe(true);
    expect(Object.isFrozen(graph.dependencies)).toBe(true);
  });
});

describe("malformed review candidate", () => {
  it("fails closed without starting review", () => {
    const malformed = {
      ...planCandidate(),
      revision: 0,
    } as unknown as PlanCandidate;
    expect(beginPlanReview(malformed)).toEqual({
      kind: "INVALID_OPERATION",
      reason: "INVALID_PLAN_CANDIDATE",
    });
  });
});
