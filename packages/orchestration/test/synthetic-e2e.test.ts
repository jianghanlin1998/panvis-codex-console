import { describe, expect, it } from "vitest";

import {
  applyReviewerDecision,
  evaluateBigTaskCompletion,
  evaluateStageTransition,
  getWorkflowStagePath,
  materializeApprovedPlan,
  rejectMaterializedGraphChange,
  selectSerialWriteDispatch,
  submitPlannerRevision,
  validatePlanCandidateGraph,
} from "../src/index.js";
import type {
  PlanReviewState,
  StageEvidenceFacts,
  WorkflowStage,
  beginPlanReview,
} from "../src/index.js";
import {
  approvalFor,
  blockingDependency,
  dispatchState,
  executionFacts,
  executionFactsSnapshotFor,
  escalationFor,
  materializedGraphFor,
  planCandidate,
  proposedSubtask,
  projectWriteCapacityFor,
  rejectionFor,
  reviewStateFor,
  stageEvidenceFor,
  stateSnapshotFor,
} from "./fixtures.js";

const expectReviewState = (
  result: ReturnType<typeof beginPlanReview>,
): PlanReviewState => {
  expect(result.kind).toBe("REVIEW_STATE");
  if (result.kind !== "REVIEW_STATE") {
    throw new Error("Expected review state.");
  }
  return result.state;
};

const transition = (
  currentStage: WorkflowStage,
  requestedNextStage: WorkflowStage,
  evidence: Readonly<StageEvidenceFacts>,
  repairCyclesUsed: 0 | 1 = 0,
) =>
  evaluateStageTransition({
    graph: highRiskGraph,
    subtaskId: highRiskGraph.subtasks[0]!.id,
    currentStage,
    requestedNextStage,
    evidence: stageEvidenceFor(highRiskGraph, evidence),
    repairCyclesUsed,
  });

const highRiskGraph = materializedGraphFor(
  planCandidate({
    subtasks: [proposedSubtask("st_high", "HIGH_RISK_FOUNDATION")],
  }),
);

describe("Step 8A synthetic end-to-end oracle", () => {
  it("A. runs a rejected-then-approved Standard plan through serial dispatch to completion", () => {
    const dependencies = [blockingDependency("st_a", "st_b", "HARDENED")];
    const firstPlan = planCandidate({
      revision: 1,
      subtasks: [proposedSubtask("st_a"), proposedSubtask("st_b")],
      dependencies,
    });
    let review = reviewStateFor(firstPlan);

    const rejected = applyReviewerDecision(
      review,
      rejectionFor(review, ["Bind both Subtasks to explicit Task Contracts."]),
    );
    review = expectReviewState(rejected);
    const revisedPlan = planCandidate({
      revision: 2,
      subtasks: firstPlan.subtasks,
      dependencies,
    });
    const revised = submitPlannerRevision(review, revisedPlan);
    review = expectReviewState(revised);
    const approved = applyReviewerDecision(review, approvalFor(review));
    review = expectReviewState(approved);
    expect(review.phase).toBe("APPROVED");

    expect(validatePlanCandidateGraph(review.candidate).valid).toBe(true);
    const materialized = materializeApprovedPlan(review);
    expect(materialized.kind).toBe("MATERIALIZED");
    if (materialized.kind !== "MATERIALIZED") {
      throw new Error("Expected materialization.");
    }

    const firstDispatch = selectSerialWriteDispatch({
      graph: materialized.graph,
      subtaskStateSnapshot: stateSnapshotFor(materialized.graph, [
        dispatchState("st_a"),
        dispatchState("st_b"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(materialized.graph, [
        executionFacts("st_a"),
        executionFacts("st_b"),
      ]),
      projectWriteCapacity: projectWriteCapacityFor(materialized.graph),
    });
    expect(firstDispatch).toMatchObject({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: "st_a",
    });

    const secondDispatch = selectSerialWriteDispatch({
      graph: materialized.graph,
      subtaskStateSnapshot: stateSnapshotFor(materialized.graph, [
        dispatchState("st_a", "HARDENED", "COMPLETE"),
        dispatchState("st_b"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(materialized.graph, [
        executionFacts("st_a"),
        executionFacts("st_b"),
      ]),
      projectWriteCapacity: projectWriteCapacityFor(materialized.graph),
    });
    expect(secondDispatch).toMatchObject({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: "st_b",
    });

    expect(
      evaluateBigTaskCompletion(
        materialized.graph,
        stateSnapshotFor(materialized.graph, [
          dispatchState("st_b", "IMPLEMENTED", "COMPLETE"),
          dispatchState("st_a", "HARDENED", "COMPLETE"),
        ]),
      ),
    ).toEqual({
      kind: "BIG_TASK_COMPLETION_ELIGIBLE",
      bigTaskId: "bt_orchestration",
    });
  });

  it("B. permits exactly two automatic planner revisions and never forces approval", () => {
    let state = reviewStateFor(planCandidate({ revision: 1 }));

    for (const nextRevision of [2, 3] as const) {
      const rejection = applyReviewerDecision(
        state,
        rejectionFor(state, [`Produce revision ${nextRevision}.`]),
      );
      state = expectReviewState(rejection);
      const revision = submitPlannerRevision(
        state,
        planCandidate({ revision: nextRevision }),
      );
      state = expectReviewState(revision);
    }

    const exhausted = applyReviewerDecision(
      state,
      rejectionFor(state, ["A third automatic revision would be required."]),
    );
    state = expectReviewState(exhausted);
    expect(state).toMatchObject({
      phase: "HUMAN_REQUIRED",
      humanReason: "PLAN_REVIEW_EXHAUSTED",
      automaticRevisionsUsed: 2,
    });
    expect(submitPlannerRevision(state, planCandidate({ revision: 4 }))).toEqual({
      kind: "INVALID_OPERATION",
      reason: "REVISION_NOT_EXPECTED",
    });
  });

  it("C. escalates a Reviewer decision immediately", () => {
    const state = reviewStateFor(planCandidate());
    expect(
      applyReviewerDecision(state, escalationFor(state)),
    ).toMatchObject({
      kind: "REVIEW_STATE",
      state: { phase: "HUMAN_REQUIRED", humanReason: "REVIEW_ESCALATED" },
    });
  });

  it("D. selects one stable write and leaves the other eligible until capacity returns", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_a"), proposedSubtask("st_b")],
      }),
    );
    const input = {
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, [
        dispatchState("st_a"),
        dispatchState("st_b"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, [
        executionFacts("st_a"),
        executionFacts("st_b"),
      ]),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    } as const;

    const first = selectSerialWriteDispatch(input);
    expect(first).toEqual(selectSerialWriteDispatch(input));
    expect(first).toEqual({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: "st_a",
      eligibleSubtaskIds: ["st_a", "st_b"],
      eligibleButNotSelectedSubtaskIds: ["st_b"],
    });

    expect(
      selectSerialWriteDispatch({
        ...input,
        projectWriteCapacity: projectWriteCapacityFor(graph, [
          dispatchState("st_a").subtaskId,
        ]),
      }),
    ).toEqual({
      kind: "BLOCKED",
      reason: "CONCURRENCY_BLOCKED",
      eligibleSubtaskIds: ["st_b"],
    });
  });

  it("E. enforces existing HARDENED and ACCEPTED dependency gates", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [
          proposedSubtask("st_a"),
          proposedSubtask("st_b"),
          proposedSubtask("st_c"),
        ],
        dependencies: [
          blockingDependency("st_a", "st_b", "HARDENED"),
          blockingDependency("st_a", "st_c", "ACCEPTED"),
        ],
      }),
    );
    const facts = [executionFacts("st_a"), executionFacts("st_b"), executionFacts("st_c")];

    const hardened = selectSerialWriteDispatch({
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, [
        dispatchState("st_a", "HARDENED", "COMPLETE"),
        dispatchState("st_b"),
        dispatchState("st_c"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, facts),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    });
    expect(hardened).toMatchObject({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: "st_b",
      eligibleSubtaskIds: ["st_b"],
    });

    const accepted = selectSerialWriteDispatch({
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, [
        dispatchState("st_a", "ACCEPTED", "COMPLETE"),
        dispatchState("st_b", "IMPLEMENTED", "COMPLETE"),
        dispatchState("st_c"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, facts),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    });
    expect(accepted).toMatchObject({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: "st_c",
    });
  });

  it("F. completes the High-risk path after hardening and Fresh QA pass", () => {
    expect(transition("EXECUTE", "HARDEN", { executionEvidencePassed: true }).kind).toBe(
      "ELIGIBLE",
    );
    expect(transition("HARDEN", "FRESH_QA", { hardeningEvidencePassed: true }).kind).toBe(
      "ELIGIBLE",
    );
    expect(transition("FRESH_QA", "COMPLETE", { freshQaOutcome: "PASS" })).toMatchObject({
      kind: "ELIGIBLE",
      nextStage: "COMPLETE",
      repairCyclesUsed: 0,
    });
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_high", "HIGH_RISK_FOUNDATION")],
      }),
    );
    expect(
      evaluateBigTaskCompletion(
        graph,
        stateSnapshotFor(graph, [
          dispatchState("st_high", "ACCEPTED", "COMPLETE"),
        ]),
      ),
    ).toMatchObject({ kind: "BIG_TASK_COMPLETION_ELIGIBLE" });
  });

  it("G. permits one Repair and a passing Focused Re-QA", () => {
    const repair = transition("FRESH_QA", "REPAIR", {
      freshQaOutcome: "BLOCKING_FAIL",
    });
    expect(repair).toMatchObject({
      kind: "ELIGIBLE",
      nextStage: "REPAIR",
      repairCyclesUsed: 1,
    });
    expect(
      transition("REPAIR", "FOCUSED_RE_QA", { repairEvidencePassed: true }, 1),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "FOCUSED_RE_QA" });
    expect(
      transition(
        "FOCUSED_RE_QA",
        "COMPLETE",
        { focusedReQaOutcome: "PASS" },
        1,
      ),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "COMPLETE" });
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_repaired", "HIGH_RISK_FOUNDATION")],
      }),
    );
    expect(
      evaluateBigTaskCompletion(
        graph,
        stateSnapshotFor(graph, [
          dispatchState("st_repaired", "ACCEPTED", "COMPLETE"),
        ]),
      ),
    ).toMatchObject({ kind: "BIG_TASK_COMPLETION_ELIGIBLE" });
  });

  it("H. escalates a blocking Focused Re-QA without a second Repair", () => {
    expect(
      transition(
        "FOCUSED_RE_QA",
        "REPAIR",
        { focusedReQaOutcome: "BLOCKING_FAIL" },
        1,
      ),
    ).toEqual({
      kind: "HUMAN_REQUIRED",
      reason: "REPAIR_REQA_EXHAUSTED",
      currentStage: "FOCUSED_RE_QA",
      nextStage: null,
      requiredEvidence: ["FOCUSED_RE_QA_OUTCOME_RECORDED"],
      missingEvidence: [],
      repairCyclesUsed: 1,
    });
  });

  it("I. rejects post-materialization graph changes and preserves the frozen graph", () => {
    const graph = materializedGraphFor(planCandidate());
    const before = JSON.stringify(graph);
    const result = rejectMaterializedGraphChange(graph, "ADD_SUBTASK");

    expect(result).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPLAN_REQUIRED" });
    expect(JSON.stringify(graph)).toBe(before);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.subtasks)).toBe(true);
  });

  it("J. keeps the three primary profile paths distinct", () => {
    const low = getWorkflowStagePath("LOW");
    const standard = getWorkflowStagePath("STANDARD");
    const high = getWorkflowStagePath("HIGH_RISK_FOUNDATION");

    expect(low).toEqual(["EXECUTE", "VERIFY", "COMPLETE"]);
    expect(standard).toContain("PLAN");
    expect(standard).toContain("VERIFY");
    expect(high).toContain("HARDEN");
    expect(high).toContain("FRESH_QA");
    expect(new Set([JSON.stringify(low), JSON.stringify(standard), JSON.stringify(high)]).size).toBe(3);
  });

  it("K. returns equivalent decisions for non-authoritative input insertion order", () => {
    const dependencyA = blockingDependency("st_a", "st_c", "HARDENED");
    const dependencyB = blockingDependency("st_b", "st_c", "HARDENED");
    const subtasks = [
      proposedSubtask("st_a"),
      proposedSubtask("st_b"),
      proposedSubtask("st_c"),
    ];
    const left = validatePlanCandidateGraph(
      planCandidate({ subtasks, dependencies: [dependencyA, dependencyB] }),
    );
    const right = validatePlanCandidateGraph(
      planCandidate({ subtasks, dependencies: [dependencyB, dependencyA] }),
    );
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));

    const graph = materializedGraphFor(
      planCandidate({ subtasks: subtasks.slice(0, 2) }),
    );
    const canonical = selectSerialWriteDispatch({
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, [
        dispatchState("st_a"),
        dispatchState("st_b"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, [
        executionFacts("st_a"),
        executionFacts("st_b"),
      ]),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    });
    const reordered = selectSerialWriteDispatch({
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, [
        dispatchState("st_b"),
        dispatchState("st_a"),
      ]),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, [
        executionFacts("st_b"),
        executionFacts("st_a"),
      ]),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    });
    expect(reordered).toEqual(canonical);
  });
});
