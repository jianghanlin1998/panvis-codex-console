import {
  ProjectIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import { describe, expect, it } from "vitest";

import {
  MATERIALIZED_GRAPH_CHANGE_KINDS,
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
  beginPlanReview,
  DispatchExecutionFacts,
  DispatchSubtaskState,
  MaterializedGraph,
  PlanCandidate,
  PlanReviewState,
  StageEvidenceFacts,
  WorkflowStage,
} from "../src/index.js";
import {
  approvalFor,
  blockingDependency,
  dispatchState,
  escalationFor,
  executionFacts,
  executionFactsSnapshotFor,
  materializedGraphFor,
  planCandidate,
  projectWriteCapacityFor,
  proposedSubtask,
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
    throw new Error("Expected a review state.");
  }
  return result.state;
};

const informationalDependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  reason = `${upstreamSubtaskId} informs ${downstreamSubtaskId}.`,
) =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "INFORMATIONAL",
    requiredGate: "NONE",
    reason,
  });

const transition = (
  graph: MaterializedGraph,
  currentStage: WorkflowStage,
  requestedNextStage: WorkflowStage,
  facts: Readonly<StageEvidenceFacts>,
  repairCyclesUsed: 0 | 1 = 0,
) =>
  evaluateStageTransition({
    graph,
    subtaskId: graph.subtasks[0]!.id,
    currentStage,
    requestedNextStage,
    evidence: stageEvidenceFor(graph, facts),
    repairCyclesUsed,
  });

const dispatch = (
  graph: MaterializedGraph,
  subtaskStates: readonly DispatchSubtaskState[],
  facts: readonly DispatchExecutionFacts[],
  activeWriteSubtaskIds: readonly ReturnType<typeof SubtaskIdSchema.parse>[] = [],
) =>
  selectSerialWriteDispatch({
    graph,
    subtaskStateSnapshot: stateSnapshotFor(graph, subtaskStates),
    executionFactsSnapshot: executionFactsSnapshotFor(graph, facts),
    projectWriteCapacity: projectWriteCapacityFor(graph, activeWriteSubtaskIds),
  });

describe("CTC-ORCH-HARD review binding and revision ceiling", () => {
  it("binds every review outcome to exact candidate content, not just revision", () => {
    const original = planCandidate({
      revision: 19,
      subtasks: [proposedSubtask("st_alpha"), proposedSubtask("st_beta")],
      dependencies: [blockingDependency("st_alpha", "st_beta")],
    });
    const originalState = reviewStateFor(original);
    const originalApproval = approvalFor(originalState);
    const variants: readonly PlanCandidate[] = [
      planCandidate({ revision: 19, subtasks: [proposedSubtask("st_alpha")] }),
      planCandidate({
        revision: 19,
        subtasks: [
          { ...proposedSubtask("st_alpha"), taskContractRef: "contracts/changed.md" },
          proposedSubtask("st_beta"),
        ],
        dependencies: original.dependencies,
      }),
      planCandidate({
        revision: 19,
        subtasks: [
          { ...proposedSubtask("st_alpha"), profile: "HIGH_RISK_FOUNDATION" },
          proposedSubtask("st_beta"),
        ],
        dependencies: original.dependencies,
      }),
      planCandidate({
        revision: 19,
        subtasks: [
          { ...proposedSubtask("st_alpha"), writeEnabled: false },
          proposedSubtask("st_beta"),
        ],
        dependencies: original.dependencies,
      }),
      planCandidate({
        revision: 19,
        subtasks: original.subtasks,
        dependencies: [],
      }),
      planCandidate({
        revision: 19,
        projectId: "prj_substitute",
        subtasks: original.subtasks,
        dependencies: original.dependencies,
      }),
      planCandidate({
        revision: 19,
        bigTaskId: "bt_substitute",
        subtasks: [
          proposedSubtask("st_alpha", "STANDARD", "bt_substitute"),
          proposedSubtask("st_beta", "STANDARD", "bt_substitute"),
        ],
        dependencies: original.dependencies,
      }),
    ];

    for (const variant of variants) {
      const substitutedState = reviewStateFor(variant);
      expect(substitutedState.candidateBinding).not.toBe(
        originalState.candidateBinding,
      );
      expect(applyReviewerDecision(substitutedState, originalApproval)).toEqual({
        kind: "INVALID_OPERATION",
        reason: "STALE_REVIEW_DECISION",
      });
    }

    const reject = rejectionFor(originalState, ["Revise the exact candidate."]);
    const escalate = escalationFor(originalState);
    const changed = reviewStateFor(variants[0]!);
    expect(applyReviewerDecision(changed, reject)).toMatchObject({
      kind: "INVALID_OPERATION",
      reason: "STALE_REVIEW_DECISION",
    });
    expect(applyReviewerDecision(changed, escalate)).toMatchObject({
      kind: "INVALID_OPERATION",
      reason: "STALE_REVIEW_DECISION",
    });
  });

  it("canonicalizes dependency order without erasing authoritative Subtask order", () => {
    const subtasks = [
      proposedSubtask("st_first"),
      proposedSubtask("st_second"),
      proposedSubtask("st_third"),
    ];
    const dependencies = [
      blockingDependency("st_first", "st_third"),
      informationalDependency("st_second", "st_third"),
    ];
    const forward = reviewStateFor(planCandidate({ subtasks, dependencies }));
    const reversedEdges = reviewStateFor(
      planCandidate({ subtasks, dependencies: [...dependencies].reverse() }),
    );
    const reversedSubtasks = reviewStateFor(
      planCandidate({ subtasks: [...subtasks].reverse(), dependencies }),
    );
    expect(reversedEdges.candidateBinding).toBe(forward.candidateBinding);
    expect(reversedSubtasks.candidateBinding).not.toBe(forward.candidateBinding);
  });

  it("rejects candidate mutation after decision creation and freezes review state deeply", () => {
    const candidate = planCandidate({
      subtasks: [proposedSubtask("st_bound")],
    });
    const state = reviewStateFor(candidate);
    const approval = approvalFor(state);
    const substitutedCandidate = planCandidate({
      subtasks: [
        { ...proposedSubtask("st_bound"), taskContractRef: "contracts/substitute.md" },
      ],
    });
    const mutatedState = {
      ...state,
      candidate: substitutedCandidate,
    } as PlanReviewState;
    expect(applyReviewerDecision(mutatedState, approval)).toEqual({
      kind: "INVALID_OPERATION",
      reason: "INVALID_REVIEW_STATE",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.candidate)).toBe(true);
    expect(Object.isFrozen(state.candidate.subtasks)).toBe(true);
    expect(Object.isFrozen(state.candidate.subtasks[0])).toBe(true);
  });

  it("permits exactly two sequential revisions from a large initial revision", () => {
    let state = reviewStateFor(planCandidate({ revision: 8_000_000_000 }));
    for (const nextRevision of [8_000_000_001, 8_000_000_002]) {
      state = expectReviewState(
        applyReviewerDecision(
          state,
          rejectionFor(state, [`Produce ${nextRevision}.`]),
        ),
      );
      expect(
        submitPlannerRevision(state, planCandidate({ revision: nextRevision + 1 })),
      ).toMatchObject({ kind: "INVALID_OPERATION", reason: "INVALID_PLAN_REVISION" });
      state = expectReviewState(
        submitPlannerRevision(state, planCandidate({ revision: nextRevision })),
      );
    }
    state = expectReviewState(
      applyReviewerDecision(
        state,
        rejectionFor(state, ["A third revision requires a human."]),
      ),
    );
    expect(state).toMatchObject({
      phase: "HUMAN_REQUIRED",
      humanReason: "PLAN_REVIEW_EXHAUSTED",
      automaticRevisionsUsed: 2,
    });
    expect(applyReviewerDecision(state, approvalFor(state))).toEqual({
      kind: "INVALID_OPERATION",
      reason: "REVIEW_NOT_PENDING",
    });
  });

  it("fails closed at MAX_SAFE_INTEGER instead of entering an impossible revision state", () => {
    const state = reviewStateFor(
      planCandidate({ revision: Number.MAX_SAFE_INTEGER }),
    );
    expect(
      applyReviewerDecision(
        state,
        rejectionFor(state, ["A numeric successor is unavailable."]),
      ),
    ).toMatchObject({
      kind: "REVIEW_STATE",
      state: {
        phase: "HUMAN_REQUIRED",
        humanReason: "PLAN_REVIEW_EXHAUSTED",
        automaticRevisionsUsed: 0,
      },
    });

    const impossibleAwaitingRevision = {
      ...state,
      phase: "AWAITING_REVISION",
      revisionRequirements: ["No safe successor exists."],
    } as PlanReviewState;
    expect(
      submitPlannerRevision(
        impossibleAwaitingRevision,
        planCandidate({ revision: Number.MAX_SAFE_INTEGER }),
      ),
    ).toEqual({ kind: "INVALID_OPERATION", reason: "INVALID_REVIEW_STATE" });
  });

  it("rejects reconstructed exhaustion states that never consumed the ceiling", () => {
    const state = reviewStateFor(planCandidate({ revision: 51 }));
    const fabricated = {
      ...state,
      phase: "HUMAN_REQUIRED",
      humanReason: "PLAN_REVIEW_EXHAUSTED",
    } as PlanReviewState;
    expect(applyReviewerDecision(fabricated, approvalFor(fabricated))).toEqual({
      kind: "INVALID_OPERATION",
      reason: "INVALID_REVIEW_STATE",
    });
  });

  it("rejects duplicate, empty, padded, and overlong revision requirements", () => {
    const state = reviewStateFor(planCandidate());
    const invalidRequirements = [
      [],
      [""],
      [" padded"],
      ["duplicate", "duplicate"],
      ["x".repeat(1_001)],
    ];
    for (const requirements of invalidRequirements) {
      expect(
        applyReviewerDecision(state, {
          ...rejectionFor(state, ["placeholder"]),
          revisionRequirements: requirements,
        }),
      ).toMatchObject({
        kind: "INVALID_OPERATION",
        reason: "INVALID_REVIEW_DECISION",
      });
    }
    expect(
      applyReviewerDecision(
        state,
        rejectionFor(state, ["é".repeat(1_000)]),
      ),
    ).toMatchObject({ kind: "REVIEW_STATE", state: { phase: "AWAITING_REVISION" } });
  });

  it("rejects replayed decisions and revisions after terminal review phases", () => {
    const awaiting = reviewStateFor(planCandidate({ revision: 31 }));
    const approved = expectReviewState(
      applyReviewerDecision(awaiting, approvalFor(awaiting)),
    );
    expect(applyReviewerDecision(approved, approvalFor(approved))).toMatchObject({
      kind: "INVALID_OPERATION",
      reason: "REVIEW_NOT_PENDING",
    });
    expect(submitPlannerRevision(approved, planCandidate({ revision: 32 }))).toMatchObject({
      kind: "INVALID_OPERATION",
      reason: "REVISION_NOT_EXPECTED",
    });

    const escalated = expectReviewState(
      applyReviewerDecision(awaiting, escalationFor(awaiting)),
    );
    expect(applyReviewerDecision(escalated, approvalFor(escalated))).toMatchObject({
      kind: "INVALID_OPERATION",
      reason: "REVIEW_NOT_PENDING",
    });
  });
});

describe("CTC-ORCH-HARD graph validation and materialization", () => {
  it("accepts one-node, chain, diamond, fan-in, fan-out, disconnected, and informational-cycle graphs", () => {
    const cases: readonly PlanCandidate[] = [
      planCandidate({ subtasks: [proposedSubtask("st_single")] }),
      planCandidate({
        subtasks: [
          proposedSubtask("st_chain_a"),
          proposedSubtask("st_chain_b"),
          proposedSubtask("st_chain_c"),
          proposedSubtask("st_chain_d"),
        ],
        dependencies: [
          blockingDependency("st_chain_a", "st_chain_b"),
          blockingDependency("st_chain_b", "st_chain_c"),
          blockingDependency("st_chain_c", "st_chain_d"),
        ],
      }),
      planCandidate({
        subtasks: [
          proposedSubtask("st_diamond_a"),
          proposedSubtask("st_diamond_b"),
          proposedSubtask("st_diamond_c"),
          proposedSubtask("st_diamond_d"),
        ],
        dependencies: [
          blockingDependency("st_diamond_a", "st_diamond_b"),
          blockingDependency("st_diamond_a", "st_diamond_c"),
          blockingDependency("st_diamond_b", "st_diamond_d"),
          blockingDependency("st_diamond_c", "st_diamond_d"),
        ],
      }),
      planCandidate({
        subtasks: [
          proposedSubtask("st_fan_a"),
          proposedSubtask("st_fan_b"),
          proposedSubtask("st_fan_c"),
          proposedSubtask("st_fan_d"),
        ],
        dependencies: [
          blockingDependency("st_fan_a", "st_fan_b"),
          blockingDependency("st_fan_a", "st_fan_c"),
          blockingDependency("st_fan_a", "st_fan_d"),
          blockingDependency("st_fan_b", "st_fan_d"),
          blockingDependency("st_fan_c", "st_fan_d"),
        ],
      }),
      planCandidate({
        subtasks: [
          proposedSubtask("st_disconnected_a"),
          proposedSubtask("st_disconnected_b"),
          proposedSubtask("st_disconnected_c"),
          proposedSubtask("st_disconnected_d"),
        ],
        dependencies: [
          blockingDependency("st_disconnected_a", "st_disconnected_b"),
          blockingDependency("st_disconnected_c", "st_disconnected_d"),
        ],
      }),
      planCandidate({
        subtasks: [
          proposedSubtask("st_info_a"),
          proposedSubtask("st_info_b"),
          proposedSubtask("st_info_c"),
        ],
        dependencies: [
          informationalDependency("st_info_a", "st_info_b"),
          informationalDependency("st_info_b", "st_info_c"),
          informationalDependency("st_info_c", "st_info_a"),
        ],
      }),
    ];
    for (const candidate of cases) {
      expect(validatePlanCandidateGraph(candidate).valid).toBe(true);
    }
  });

  it("rejects blocking and mixed cycles while preserving Domain informational semantics", () => {
    const subtasks = [
      proposedSubtask("st_cycle_a"),
      proposedSubtask("st_cycle_b"),
      proposedSubtask("st_cycle_c"),
    ];
    const blocking = validatePlanCandidateGraph(
      planCandidate({
        subtasks,
        dependencies: [
          blockingDependency("st_cycle_a", "st_cycle_b"),
          blockingDependency("st_cycle_b", "st_cycle_a"),
        ],
      }),
    );
    const mixed = validatePlanCandidateGraph(
      planCandidate({
        subtasks,
        dependencies: [
          blockingDependency("st_cycle_a", "st_cycle_b"),
          informationalDependency("st_cycle_b", "st_cycle_c"),
          blockingDependency("st_cycle_b", "st_cycle_a"),
        ],
      }),
    );
    expect(blocking).toMatchObject({
      valid: false,
      errors: [{ code: "DEPENDENCY_CYCLE" }],
    });
    expect(mixed).toMatchObject({
      valid: false,
      errors: [{ code: "DEPENDENCY_CYCLE" }],
    });
  });

  it("returns deterministic errors for reordered duplicate and missing edges", () => {
    const subtasks = [proposedSubtask("st_edge_a"), proposedSubtask("st_edge_b")];
    const edges = [
      blockingDependency("st_edge_a", "st_edge_b"),
      SubtaskDependencySchema.parse({
        ...blockingDependency("st_edge_a", "st_edge_b"),
        reason: "A second description does not make a second edge.",
      }),
      blockingDependency("st_missing", "st_edge_b"),
    ];
    const forward = validatePlanCandidateGraph(planCandidate({ subtasks, dependencies: edges }));
    const reversed = validatePlanCandidateGraph(
      planCandidate({ subtasks, dependencies: [...edges].reverse() }),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(forward).toMatchObject({
      valid: false,
      errors: [
        { code: "DUPLICATE_DEPENDENCY" },
        { code: "MISSING_UPSTREAM_SUBTASK" },
      ],
    });
  });

  it("preserves approved plan order and canonicalizes non-authoritative dependency order", () => {
    const candidate = planCandidate({
      subtasks: [
        proposedSubtask("st_zeta"),
        proposedSubtask("st_alpha"),
        proposedSubtask("st_middle"),
      ],
      dependencies: [
        informationalDependency("st_middle", "st_alpha"),
        informationalDependency("st_zeta", "st_middle"),
      ],
    });
    const validation = validatePlanCandidateGraph(candidate);
    expect(validation.valid).toBe(true);
    if (!validation.valid) {
      throw new Error("Expected a valid graph.");
    }
    expect(validation.orderedSubtaskIds).toEqual([
      "st_zeta",
      "st_alpha",
      "st_middle",
    ]);
    expect(validation.dependencies.map(({ upstreamSubtaskId }) => upstreamSubtaskId)).toEqual([
      "st_middle",
      "st_zeta",
    ]);
  });

  it("orders dependency tuples deterministically even when fields contain the old delimiter", () => {
    const subtasks = [
      proposedSubtask("st_a"),
      proposedSubtask("st_b\u0000st_c"),
      proposedSubtask("st_a\u0000st_b"),
      proposedSubtask("st_c"),
    ];
    const dependencies = [
      SubtaskDependencySchema.parse({
        upstreamSubtaskId: "st_a",
        downstreamSubtaskId: "st_b\u0000st_c",
        dependencyType: "INFORMATIONAL",
        requiredGate: "NONE",
        reason: "Tuple A.",
      }),
      SubtaskDependencySchema.parse({
        upstreamSubtaskId: "st_a\u0000st_b",
        downstreamSubtaskId: "st_c",
        dependencyType: "INFORMATIONAL",
        requiredGate: "NONE",
        reason: "Tuple A.",
      }),
    ];
    const forward = reviewStateFor(planCandidate({ subtasks, dependencies }));
    const reverse = reviewStateFor(
      planCandidate({ subtasks, dependencies: [...dependencies].reverse() }),
    );
    expect(reverse.candidateBinding).toBe(forward.candidateBinding);
    expect(reverse.candidate.dependencies).toEqual(forward.candidate.dependencies);
  });

  it("accepts distinct canonical Unicode IDs and rejects malformed structural boundaries", () => {
    const composed = proposedSubtask("st_café");
    const decomposed = proposedSubtask("st_cafe\u0301");
    expect(
      validatePlanCandidateGraph(
        planCandidate({ subtasks: [composed, decomposed] }),
      ).valid,
    ).toBe(true);
    const invalidCases = [
      { ...planCandidate(), subtasks: [] },
      { ...planCandidate(), revision: 0 },
      { ...planCandidate(), revision: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...planCandidate(),
        subtasks: [
          { ...proposedSubtask("st_a"), taskContractRef: " x" },
        ],
      },
      {
        ...planCandidate(),
        subtasks: [
          { ...proposedSubtask("st_a"), taskContractRef: "x".repeat(1_001) },
        ],
      },
    ];
    for (const invalid of invalidCases) {
      expect(validatePlanCandidateGraph(invalid)).toMatchObject({
        valid: false,
        errors: [{ code: "INVALID_PLAN_CANDIDATE" }],
      });
    }
  });

  it("deep-freezes valid and invalid validation outputs and detaches candidate inputs", () => {
    const inputSubtask = { ...proposedSubtask("st_detached") };
    const valid = validatePlanCandidateGraph(
      planCandidate({ subtasks: [inputSubtask] }),
    );
    const invalid = validatePlanCandidateGraph(
      planCandidate({
        subtasks: [proposedSubtask("st_dup"), proposedSubtask("st_dup")],
      }),
    );
    expect(valid.valid).toBe(true);
    expect(Object.isFrozen(valid)).toBe(true);
    if (valid.valid) {
      expect(Object.isFrozen(valid.candidate)).toBe(true);
      expect(Object.isFrozen(valid.candidate.subtasks)).toBe(true);
      expect(Object.isFrozen(valid.candidate.subtasks[0])).toBe(true);
      inputSubtask.taskContractRef = "contracts/mutated-after-return.md";
      expect(valid.candidate.subtasks[0]!.taskContractRef).toBe(
        "contracts/st_detached.md",
      );
    }
    expect(Object.isFrozen(invalid)).toBe(true);
    if (!invalid.valid) {
      expect(Object.isFrozen(invalid.errors)).toBe(true);
      expect(Object.isFrozen(invalid.errors[0])).toBe(true);
      expect(Object.isFrozen(invalid.errors[0]!.subtaskIds)).toBe(true);
    }
  });

  it("materializes only the exact approved candidate and freezes every nested graph value", () => {
    const dependencies = [blockingDependency("st_mat_a", "st_mat_b")];
    const candidate = planCandidate({
      revision: 23,
      subtasks: [proposedSubtask("st_mat_a"), proposedSubtask("st_mat_b")],
      dependencies,
    });
    const awaiting = reviewStateFor(candidate);
    const approved = expectReviewState(
      applyReviewerDecision(awaiting, approvalFor(awaiting)),
    );
    const materialized = materializeApprovedPlan(approved);
    expect(materialized.kind).toBe("MATERIALIZED");
    if (materialized.kind !== "MATERIALIZED") {
      throw new Error("Expected materialization.");
    }
    expect(materialized.graph.candidateBinding).toBe(approved.candidateBinding);
    expect(Object.isFrozen(materialized)).toBe(true);
    expect(Object.isFrozen(materialized.graph)).toBe(true);
    expect(Object.isFrozen(materialized.graph.subtasks)).toBe(true);
    expect(Object.isFrozen(materialized.graph.subtasks[0])).toBe(true);
    expect(Object.isFrozen(materialized.graph.dependencies)).toBe(true);
    expect(Object.isFrozen(materialized.graph.dependencies[0])).toBe(true);

    const substituted = {
      ...approved,
      candidate: planCandidate({
        ...candidate,
        subtasks: [
          { ...proposedSubtask("st_mat_a"), writeEnabled: false },
          proposedSubtask("st_mat_b"),
        ],
      }),
    } as PlanReviewState;
    expect(materializeApprovedPlan(substituted)).toEqual({
      kind: "HUMAN_REQUIRED",
      reason: "AUTHORITY_BLOCKED",
    });
  });

  it.each(MATERIALIZED_GRAPH_CHANGE_KINDS)(
    "preserves the graph while escalating %s",
    (changeKind) => {
      const graph = materializedGraphFor(planCandidate());
      const before = JSON.stringify(graph);
      const result = rejectMaterializedGraphChange(graph, changeKind);
      expect(result).toMatchObject({
        kind: "HUMAN_REQUIRED",
        reason: "REPLAN_REQUIRED",
        graph,
      });
      expect(JSON.stringify(result.kind === "HUMAN_REQUIRED" ? result.graph : graph)).toBe(
        before,
      );
    },
  );

  it("fails closed for an unknown change kind and a substituted graph binding", () => {
    const graph = materializedGraphFor(planCandidate());
    expect(
      rejectMaterializedGraphChange(graph, "UNKNOWN" as never),
    ).toEqual({ kind: "INVALID_OPERATION", reason: "INVALID_CHANGE_KIND" });
    expect(
      rejectMaterializedGraphChange(
        { ...graph, candidateBinding: `${graph.candidateBinding}:substituted` },
        "ADD_SUBTASK",
      ),
    ).toEqual({
      kind: "INVALID_OPERATION",
      reason: "INVALID_MATERIALIZED_GRAPH",
    });
  });
});

describe("CTC-ORCH-HARD serial dispatch and dependency readiness", () => {
  it("selects at most one write in approved plan order across input permutations", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [
          proposedSubtask("st_dispatch_z"),
          proposedSubtask("st_dispatch_a"),
          proposedSubtask("st_dispatch_m"),
        ],
      }),
    );
    const states = graph.subtasks.map(({ id }) => dispatchState(id));
    const facts = graph.subtasks.map(({ id }) => executionFacts(id));
    const canonical = dispatch(graph, states, facts);
    expect(canonical).toEqual({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: "st_dispatch_z",
      eligibleSubtaskIds: ["st_dispatch_z", "st_dispatch_a", "st_dispatch_m"],
      eligibleButNotSelectedSubtaskIds: ["st_dispatch_a", "st_dispatch_m"],
    });
    expect(dispatch(graph, [...states].reverse(), [...facts].reverse())).toEqual(
      canonical,
    );
  });

  it("skips blocked plan-order entries and selects the first later eligible Subtask", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [
          proposedSubtask("st_blocked_budget"),
          proposedSubtask("st_blocked_dependency"),
          proposedSubtask("st_eligible_later"),
        ],
        dependencies: [
          blockingDependency(
            "st_blocked_budget",
            "st_blocked_dependency",
            "ACCEPTED",
          ),
        ],
      }),
    );
    const states = [
      dispatchState("st_blocked_budget"),
      dispatchState("st_blocked_dependency"),
      dispatchState("st_eligible_later"),
    ];
    const facts = [
      { ...executionFacts("st_blocked_budget"), budgetAvailable: false },
      executionFacts("st_blocked_dependency"),
      executionFacts("st_eligible_later"),
    ];
    expect(dispatch(graph, states, facts)).toEqual({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: "st_eligible_later",
      eligibleSubtaskIds: ["st_eligible_later"],
      eligibleButNotSelectedSubtaskIds: [],
    });
  });

  it("uses deterministic blocker precedence when no candidate is eligible", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [
          proposedSubtask("st_precedence_a"),
          proposedSubtask("st_precedence_b"),
          proposedSubtask("st_precedence_c"),
        ],
        dependencies: [
          blockingDependency("st_precedence_a", "st_precedence_b", "ACCEPTED"),
        ],
      }),
    );
    const states = [
      dispatchState("st_precedence_a"),
      dispatchState("st_precedence_b"),
      dispatchState("st_precedence_c"),
    ];
    const facts = [
      { ...executionFacts("st_precedence_a"), budgetAvailable: false },
      executionFacts("st_precedence_b"),
      { ...executionFacts("st_precedence_c"), humanApprovalSatisfied: false },
    ];
    expect(dispatch(graph, states, facts)).toMatchObject({
      kind: "BLOCKED",
      reason: "DEPENDENCY_BLOCKED",
      eligibleSubtaskIds: [],
    });
    expect(dispatch(graph, [...states].reverse(), [...facts].reverse())).toEqual(
      dispatch(graph, states, facts),
    );
  });

  it("binds authoritative snapshots to the exact graph candidate", () => {
    const graphA = materializedGraphFor(
      planCandidate({ subtasks: [proposedSubtask("st_same")] }),
    );
    const graphB = materializedGraphFor(
      planCandidate({
        subtasks: [
          { ...proposedSubtask("st_same"), taskContractRef: "contracts/plan-b.md" },
        ],
      }),
    );
    expect(graphA.candidateBinding).not.toBe(graphB.candidateBinding);
    expect(
      selectSerialWriteDispatch({
        graph: graphB,
        subtaskStateSnapshot: stateSnapshotFor(graphA, [dispatchState("st_same")]),
        executionFactsSnapshot: executionFactsSnapshotFor(graphB, [
          executionFacts("st_same"),
        ]),
        projectWriteCapacity: projectWriteCapacityFor(graphB),
      }),
    ).toEqual({
      kind: "BLOCKED",
      reason: "INVALID_INPUT",
      eligibleSubtaskIds: [],
    });
    expect(
      selectSerialWriteDispatch({
        graph: graphB,
        subtaskStateSnapshot: stateSnapshotFor(graphB, [dispatchState("st_same")]),
        executionFactsSnapshot: executionFactsSnapshotFor(graphA, [
          executionFacts("st_same"),
        ]),
        projectWriteCapacity: projectWriteCapacityFor(graphB),
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
  });

  it("rejects profile-incompatible stages and impossible stage/maturity composition", () => {
    const standardGraph = materializedGraphFor(planCandidate());
    for (const state of [
      dispatchState("st_a", "ACCEPTED", "EXECUTE"),
      dispatchState("st_a", "NOT_STARTED", "COMPLETE"),
      dispatchState("st_a", "IMPLEMENTED", "HARDEN"),
    ]) {
      expect(
        dispatch(standardGraph, [state], [executionFacts("st_a")]),
      ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    }
    const highGraph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_high_state", "HIGH_RISK_FOUNDATION")],
      }),
    );
    expect(
      dispatch(
        highGraph,
        [dispatchState("st_high_state", "IMPLEMENTED", "VERIFY")],
        [executionFacts("st_high_state")],
      ),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
  });

  it("requires an exact Project-scoped serial-capacity snapshot", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_capacity_a"), proposedSubtask("st_capacity_b")],
      }),
    );
    const states = [dispatchState("st_capacity_a"), dispatchState("st_capacity_b")];
    const facts = [executionFacts("st_capacity_a"), executionFacts("st_capacity_b")];
    expect(
      dispatch(graph, states, facts, [SubtaskIdSchema.parse("st_other_big_task")]),
    ).toEqual({
      kind: "BLOCKED",
      reason: "CONCURRENCY_BLOCKED",
      eligibleSubtaskIds: ["st_capacity_a", "st_capacity_b"],
    });
    expect(
      dispatch(graph, states, facts, [SubtaskIdSchema.parse("st_capacity_a")]),
    ).toEqual({
      kind: "BLOCKED",
      reason: "CONCURRENCY_BLOCKED",
      eligibleSubtaskIds: ["st_capacity_b"],
    });

    const base = {
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, states),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, facts),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    } as const;
    expect(
      selectSerialWriteDispatch({
        ...base,
        projectWriteCapacity: {
          projectId: ProjectIdSchema.parse("prj_other"),
          activeWriteSubtaskIds: [],
        },
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      selectSerialWriteDispatch({
        ...base,
        projectWriteCapacity: projectWriteCapacityFor(graph, [
          SubtaskIdSchema.parse("st_capacity_a"),
          SubtaskIdSchema.parse("st_capacity_b"),
        ]),
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      selectSerialWriteDispatch({
        ...base,
        projectWriteCapacity: {
          projectId: graph.projectId,
          activeWriteSubtaskIds: [" st_capacity_a " as never],
        },
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      selectSerialWriteDispatch({
        ...base,
        projectWriteCapacity: {
          projectId: graph.projectId,
          activeWriteSubtaskIds: [
            SubtaskIdSchema.parse("st_capacity_a"),
            SubtaskIdSchema.parse("st_capacity_a"),
          ],
        },
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
  });

  it("implements exact HARDENED, ACCEPTED, and INFORMATIONAL readiness semantics", () => {
    const hardenedGraph = materializedGraphFor(
      planCandidate({
        subtasks: [
          { ...proposedSubtask("st_up_h"), writeEnabled: false },
          proposedSubtask("st_down_h"),
        ],
        dependencies: [blockingDependency("st_up_h", "st_down_h", "HARDENED")],
      }),
    );
    const acceptedGraph = materializedGraphFor(
      planCandidate({
        subtasks: [
          { ...proposedSubtask("st_up_a"), writeEnabled: false },
          proposedSubtask("st_down_a"),
        ],
        dependencies: [blockingDependency("st_up_a", "st_down_a", "ACCEPTED")],
      }),
    );
    for (const maturity of ["NOT_STARTED", "IMPLEMENTED"] as const) {
      expect(
        dispatch(
          hardenedGraph,
          [
            dispatchState(
              "st_up_h",
              maturity,
              maturity === "NOT_STARTED" ? "EXECUTE" : "COMPLETE",
            ),
            dispatchState("st_down_h"),
          ],
          [executionFacts("st_up_h"), executionFacts("st_down_h")],
        ),
      ).toMatchObject({ kind: "BLOCKED", reason: "DEPENDENCY_BLOCKED" });
    }
    for (const maturity of ["HARDENED", "ACCEPTED"] as const) {
      expect(
        dispatch(
          hardenedGraph,
          [
            dispatchState("st_up_h", maturity, "COMPLETE"),
            dispatchState("st_down_h"),
          ],
          [executionFacts("st_up_h"), executionFacts("st_down_h")],
        ),
      ).toMatchObject({ kind: "DISPATCH_SELECTED", selectedSubtaskId: "st_down_h" });
    }
    for (const maturity of ["NOT_STARTED", "IMPLEMENTED", "HARDENED"] as const) {
      expect(
        dispatch(
          acceptedGraph,
          [
            dispatchState(
              "st_up_a",
              maturity,
              maturity === "NOT_STARTED" ? "EXECUTE" : "COMPLETE",
            ),
            dispatchState("st_down_a"),
          ],
          [executionFacts("st_up_a"), executionFacts("st_down_a")],
        ),
      ).toMatchObject({ kind: "BLOCKED", reason: "DEPENDENCY_BLOCKED" });
    }
    expect(
      dispatch(
        acceptedGraph,
        [
          dispatchState("st_up_a", "ACCEPTED", "COMPLETE"),
          dispatchState("st_down_a"),
        ],
        [executionFacts("st_up_a"), executionFacts("st_down_a")],
      ),
    ).toMatchObject({ kind: "DISPATCH_SELECTED", selectedSubtaskId: "st_down_a" });

    const informationalGraph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_info_up"), proposedSubtask("st_info_down")],
        dependencies: [informationalDependency("st_info_up", "st_info_down")],
      }),
    );
    expect(
      dispatch(
        informationalGraph,
        [dispatchState("st_info_up"), dispatchState("st_info_down")],
        [executionFacts("st_info_up"), executionFacts("st_info_down")],
      ),
    ).toMatchObject({
      kind: "DISPATCH_SELECTED",
      eligibleSubtaskIds: ["st_info_up", "st_info_down"],
    });
  });

  it("reports zero candidates and authority failure without mutable outputs", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [{ ...proposedSubtask("st_read_only"), writeEnabled: false }],
      }),
    );
    const none = dispatch(
      graph,
      [dispatchState("st_read_only")],
      [executionFacts("st_read_only")],
    );
    expect(none).toEqual({
      kind: "BLOCKED",
      reason: "NO_ELIGIBLE_SUBTASK",
      eligibleSubtaskIds: [],
    });
    expect(Object.isFrozen(none)).toBe(true);
    expect(Object.isFrozen(none.eligibleSubtaskIds)).toBe(true);

    const writableGraph = materializedGraphFor(planCandidate());
    const authority = dispatch(
      writableGraph,
      [dispatchState("st_a")],
      [{ ...executionFacts("st_a"), humanApprovalSatisfied: false }],
    );
    expect(authority).toMatchObject({
      kind: "HUMAN_REQUIRED",
      reason: "AUTHORITY_BLOCKED",
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.eligibleSubtaskIds)).toBe(true);
  });
});

describe("CTC-ORCH-HARD stage composition and QA/repair", () => {
  const lowGraph = materializedGraphFor(
    planCandidate({ subtasks: [proposedSubtask("st_low", "LOW")] }),
  );
  const standardGraph = materializedGraphFor(
    planCandidate({ subtasks: [proposedSubtask("st_standard", "STANDARD")] }),
  );
  const highGraph = materializedGraphFor(
    planCandidate({
      subtasks: [proposedSubtask("st_high", "HIGH_RISK_FOUNDATION")],
    }),
  );

  it("runs every primary profile as the declared state machine", () => {
    expect(getWorkflowStagePath("LOW")).toEqual(["EXECUTE", "VERIFY", "COMPLETE"]);
    expect(getWorkflowStagePath("STANDARD")).toEqual([
      "PLAN",
      "REVIEW",
      "MATERIALIZE",
      "EXECUTE",
      "VERIFY",
      "COMPLETE",
    ]);
    expect(getWorkflowStagePath("HIGH_RISK_FOUNDATION")).toEqual([
      "PLAN",
      "REVIEW",
      "MATERIALIZE",
      "EXECUTE",
      "HARDEN",
      "FRESH_QA",
      "COMPLETE",
    ]);
    expect(getWorkflowStagePath("UNKNOWN" as never)).toEqual([]);

    expect(
      transition(lowGraph, "EXECUTE", "VERIFY", { executionEvidencePassed: true }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "VERIFY" });
    expect(
      transition(lowGraph, "VERIFY", "COMPLETE", { verificationEvidencePassed: true }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "COMPLETE" });

    expect(
      transition(standardGraph, "PLAN", "REVIEW", { planCandidatePresent: true }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "REVIEW" });
    expect(
      transition(standardGraph, "REVIEW", "MATERIALIZE", {
        planReviewSatisfied: true,
      }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "MATERIALIZE" });
    expect(
      transition(standardGraph, "MATERIALIZE", "EXECUTE", {
        graphMaterialized: true,
        dependenciesReady: true,
        repositoryPreflightPassed: true,
        contextPreflightPassed: true,
        budgetAvailable: true,
        concurrencyAvailable: true,
        worktreeOwnershipAvailable: true,
        humanApprovalSatisfied: true,
      }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "EXECUTE" });
    expect(
      transition(standardGraph, "EXECUTE", "VERIFY", {
        executionEvidencePassed: true,
      }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "VERIFY" });
    expect(
      transition(standardGraph, "VERIFY", "COMPLETE", {
        verificationEvidencePassed: true,
      }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "COMPLETE" });

    expect(
      transition(highGraph, "EXECUTE", "HARDEN", {
        executionEvidencePassed: true,
      }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "HARDEN" });
    expect(
      transition(highGraph, "HARDEN", "FRESH_QA", {
        hardeningEvidencePassed: true,
      }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "FRESH_QA" });
    expect(
      transition(highGraph, "FRESH_QA", "COMPLETE", { freshQaOutcome: "PASS" }),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "COMPLETE" });
  });

  it("rejects skipped, backward, replayed, foreign-profile, and post-completion transitions", () => {
    const invalidCases = [
      transition(standardGraph, "PLAN", "MATERIALIZE", { planCandidatePresent: true }),
      transition(standardGraph, "VERIFY", "EXECUTE", {
        verificationEvidencePassed: true,
      }),
      transition(lowGraph, "PLAN", "REVIEW", { planCandidatePresent: true }),
      transition(highGraph, "REPAIR", "FOCUSED_RE_QA", {
        repairEvidencePassed: true,
      }),
      transition(standardGraph, "COMPLETE", "EXECUTE", {}),
    ];
    for (const result of invalidCases) {
      expect(result).toMatchObject({ kind: "BLOCKED" });
      expect(["INVALID_INPUT", "INVALID_STAGE_TRANSITION"]).toContain(
        result.kind === "BLOCKED" ? result.reason : "",
      );
    }
  });

  it("derives profile from the exact graph and rejects stale candidate evidence", () => {
    expect(
      evaluateStageTransition({
        graph: highGraph,
        subtaskId: highGraph.subtasks[0]!.id,
        currentStage: "EXECUTE",
        requestedNextStage: "HARDEN",
        evidence: stageEvidenceFor(lowGraph, { executionEvidencePassed: true }),
        repairCyclesUsed: 0,
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      transition(highGraph, "EXECUTE", "VERIFY", {
        executionEvidencePassed: true,
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_STAGE_TRANSITION" });
  });

  it("rejects future, stale, contradictory, unknown, and malformed evidence", () => {
    expect(
      transition(highGraph, "FRESH_QA", "COMPLETE", {
        freshQaOutcome: "PASS",
        focusedReQaOutcome: "BLOCKING_FAIL",
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      transition(standardGraph, "PLAN", "REVIEW", {
        planCandidatePresent: true,
        verificationEvidencePassed: true,
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      evaluateStageTransition({
        graph: standardGraph,
        subtaskId: standardGraph.subtasks[0]!.id,
        currentStage: "PLAN",
        requestedNextStage: "REVIEW",
        evidence: stageEvidenceFor(standardGraph, {
          unknown: true,
        } as StageEvidenceFacts),
        repairCyclesUsed: 0,
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      transition(highGraph, "FRESH_QA", "COMPLETE", {
        freshQaOutcome: "NOT_RUN",
      }),
    ).toMatchObject({
      kind: "BLOCKED",
      reason: "EVIDENCE_BLOCKED",
      missingEvidence: ["FRESH_QA_OUTCOME_RECORDED"],
    });
  });

  it("permits one Repair and Focused Re-QA, then escalates exhaustion", () => {
    expect(
      transition(highGraph, "FRESH_QA", "REPAIR", {
        freshQaOutcome: "BLOCKING_FAIL",
      }),
    ).toMatchObject({ kind: "ELIGIBLE", repairCyclesUsed: 1 });
    expect(
      transition(
        highGraph,
        "REPAIR",
        "FOCUSED_RE_QA",
        { repairEvidencePassed: true },
        1,
      ),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "FOCUSED_RE_QA" });
    expect(
      transition(
        highGraph,
        "FOCUSED_RE_QA",
        "COMPLETE",
        { focusedReQaOutcome: "PASS" },
        1,
      ),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "COMPLETE" });
    expect(
      transition(
        highGraph,
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

  it("rejects repair-counter reset and impossible counter/profile compositions", () => {
    expect(
      transition(highGraph, "REPAIR", "FOCUSED_RE_QA", {
        repairEvidencePassed: true,
      }),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      transition(
        highGraph,
        "FRESH_QA",
        "REPAIR",
        { freshQaOutcome: "BLOCKING_FAIL" },
        1,
      ),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    expect(
      transition(
        standardGraph,
        "EXECUTE",
        "VERIFY",
        { executionEvidencePassed: true },
        1,
      ),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
  });

  it("isolates gate failures and freezes all result arrays", () => {
    const blocked = transition(standardGraph, "MATERIALIZE", "EXECUTE", {
      graphMaterialized: true,
      dependenciesReady: true,
      repositoryPreflightPassed: true,
      contextPreflightPassed: true,
      budgetAvailable: false,
      concurrencyAvailable: true,
      worktreeOwnershipAvailable: true,
      humanApprovalSatisfied: true,
    });
    expect(blocked).toMatchObject({
      kind: "BLOCKED",
      reason: "BUDGET_BLOCKED",
      missingEvidence: ["BUDGET_AVAILABLE"],
    });
    expect(Object.isFrozen(blocked)).toBe(true);
    expect(Object.isFrozen(blocked.requiredEvidence)).toBe(true);
    expect(Object.isFrozen(blocked.missingEvidence)).toBe(true);

    const authority = transition(standardGraph, "MATERIALIZE", "EXECUTE", {
      graphMaterialized: true,
      dependenciesReady: true,
      repositoryPreflightPassed: true,
      contextPreflightPassed: true,
      budgetAvailable: true,
      concurrencyAvailable: true,
      worktreeOwnershipAvailable: true,
      humanApprovalSatisfied: false,
    });
    expect(authority).toMatchObject({
      kind: "HUMAN_REQUIRED",
      reason: "AUTHORITY_BLOCKED",
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.requiredEvidence)).toBe(true);
    expect(Object.isFrozen(authority.missingEvidence)).toBe(true);
  });
});

describe("CTC-ORCH-HARD completion eligibility and cross-operation consistency", () => {
  it("rejects missing, duplicate, extra, malformed, and stale-plan state snapshots", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [proposedSubtask("st_complete_a"), proposedSubtask("st_complete_b")],
      }),
    );
    const completeA = dispatchState("st_complete_a", "IMPLEMENTED", "COMPLETE");
    const completeB = dispatchState("st_complete_b", "IMPLEMENTED", "COMPLETE");
    for (const states of [
      [completeA],
      [completeA, completeA],
      [completeA, completeB, dispatchState("st_extra", "IMPLEMENTED", "COMPLETE")],
    ]) {
      expect(
        evaluateBigTaskCompletion(graph, stateSnapshotFor(graph, states)),
      ).toEqual({
        kind: "BLOCKED",
        reason: "INVALID_INPUT",
        incompleteSubtaskIds: [],
      });
    }
    expect(
      evaluateBigTaskCompletion(
        graph,
        stateSnapshotFor(graph, [
          { ...completeA, maturity: "UNKNOWN" as never },
          completeB,
        ]),
      ),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });

    const changedGraph = materializedGraphFor(
      planCandidate({
        subtasks: [
          { ...proposedSubtask("st_complete_a"), profile: "HIGH_RISK_FOUNDATION" },
          proposedSubtask("st_complete_b"),
        ],
      }),
    );
    expect(
      evaluateBigTaskCompletion(
        changedGraph,
        stateSnapshotFor(graph, [completeA, completeB]),
      ),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
  });

  it("rejects the impossible COMPLETE plus NOT_STARTED maturity snapshot", () => {
    const graph = materializedGraphFor(planCandidate());
    expect(
      evaluateBigTaskCompletion(
        graph,
        stateSnapshotFor(graph, [dispatchState("st_a", "NOT_STARTED", "COMPLETE")]),
      ),
    ).toEqual({
      kind: "BLOCKED",
      reason: "INVALID_INPUT",
      incompleteSubtaskIds: [],
    });
  });

  it("reports incomplete work in authoritative plan order independent of state order", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [
          proposedSubtask("st_completion_z"),
          proposedSubtask("st_completion_a"),
          proposedSubtask("st_completion_m"),
        ],
      }),
    );
    const states = [
      dispatchState("st_completion_m", "IMPLEMENTED", "EXECUTE"),
      dispatchState("st_completion_a", "IMPLEMENTED", "COMPLETE"),
      dispatchState("st_completion_z", "IMPLEMENTED", "VERIFY"),
    ];
    const result = evaluateBigTaskCompletion(graph, stateSnapshotFor(graph, states));
    expect(result).toEqual({
      kind: "BLOCKED",
      reason: "REQUIRED_WORK_INCOMPLETE",
      incompleteSubtaskIds: ["st_completion_z", "st_completion_m"],
    });
    if (result.kind !== "BLOCKED") {
      throw new Error("Expected incomplete completion output.");
    }
    expect(
      evaluateBigTaskCompletion(
        graph,
        stateSnapshotFor(graph, [...states].reverse()),
      ),
    ).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.incompleteSubtaskIds)).toBe(true);
  });

  it("claims eligibility only for exact complete snapshots with implemented-or-higher maturity", () => {
    for (const profile of ["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"] as const) {
      const id = SubtaskIdSchema.parse(`st_complete_${profile.toLowerCase()}`);
      const graph = materializedGraphFor(
        planCandidate({ subtasks: [proposedSubtask(id, profile)] }),
      );
      for (const maturity of ["IMPLEMENTED", "HARDENED", "ACCEPTED"] as const) {
        const result = evaluateBigTaskCompletion(
          graph,
          stateSnapshotFor(graph, [dispatchState(id, maturity, "COMPLETE")]),
        );
        expect(result).toEqual({
          kind: "BIG_TASK_COMPLETION_ELIGIBLE",
          bigTaskId: graph.bigTaskId,
        });
        expect(Object.isFrozen(result)).toBe(true);
      }
    }
  });
});

describe("CTC-ORCH-HARD determinism, bounded scale, text, and public boundary", () => {
  it("handles a 64-Subtask chain plus informational fan-out deterministically", () => {
    const ids = Array.from({ length: 64 }, (_, index) =>
      SubtaskIdSchema.parse(`st_scale_${String(index).padStart(2, "0")}`),
    );
    const subtasks = ids.map((id) => proposedSubtask(id));
    const dependencies = [
      ...ids.slice(1).map((id, index) => blockingDependency(ids[index]!, id)),
      ...ids.slice(2).map((id) =>
        informationalDependency(ids[0]!, id, `Scale information for ${id}.`),
      ),
    ];
    const forward = validatePlanCandidateGraph(
      planCandidate({ subtasks, dependencies }),
    );
    const reverse = validatePlanCandidateGraph(
      planCandidate({ subtasks, dependencies: [...dependencies].reverse() }),
    );
    expect(forward.valid).toBe(true);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));

    const graph = materializedGraphFor(planCandidate({ subtasks, dependencies }));
    const states = ids.map((id, index) =>
      index === 0
        ? dispatchState(id)
        : dispatchState(id, "NOT_STARTED", "EXECUTE"),
    );
    const facts = ids.map((id) => executionFacts(id));
    expect(dispatch(graph, states, facts)).toMatchObject({
      kind: "DISPATCH_SELECTED",
      selectedSubtaskId: ids[0],
      eligibleSubtaskIds: [ids[0]],
    });
  });

  it("preserves bounded text exactly at accepted limits and rejects structural overflow", () => {
    const taskContractRef = `${"界".repeat(999)}x`;
    const candidate = planCandidate({
      subtasks: [
        {
          ...proposedSubtask("st_text"),
          taskContractRef,
        },
      ],
    });
    const state = reviewStateFor(candidate);
    expect(state.candidate.subtasks[0]!.taskContractRef).toBe(taskContractRef);
    const requirement = `${"e\u0301".repeat(499)}ok`;
    const rejected = applyReviewerDecision(
      state,
      rejectionFor(state, [requirement]),
    );
    expect(rejected).toMatchObject({
      kind: "REVIEW_STATE",
      state: { phase: "AWAITING_REVISION", revisionRequirements: [requirement] },
    });
  });

  it("exposes only the bounded runtime API and no mutable parser or side-effect hook", async () => {
    const orchestration = await import("../src/index.js");
    expect(Object.keys(orchestration).sort()).toEqual(
      [
        "GRAPH_VALIDATION_ERROR_CODES",
        "HUMAN_REQUIRED_REASONS",
        "MATERIALIZED_GRAPH_CHANGE_KINDS",
        "STAGE_EVIDENCE_CODES",
        "WORKFLOW_PROFILES",
        "WORKFLOW_STAGES",
        "applyReviewerDecision",
        "beginPlanReview",
        "evaluateBigTaskCompletion",
        "evaluateStageTransition",
        "getWorkflowStagePath",
        "materializeApprovedPlan",
        "rejectMaterializedGraphChange",
        "selectSerialWriteDispatch",
        "submitPlannerRevision",
        "validatePlanCandidateGraph",
      ].sort(),
    );
    for (const forbidden of [
      "createPlanCandidateBinding",
      "parseMaterializedGraph",
      "parsePlanCandidate",
      "parsePlanReviewState",
      "persistOrchestrationState",
      "spawnCodexRole",
    ]) {
      expect(orchestration).not.toHaveProperty(forbidden);
    }
  });

  it("keeps every exported constant deeply immutable", async () => {
    const orchestration = await import("../src/index.js");
    for (const constant of [
      orchestration.GRAPH_VALIDATION_ERROR_CODES,
      orchestration.HUMAN_REQUIRED_REASONS,
      orchestration.MATERIALIZED_GRAPH_CHANGE_KINDS,
      orchestration.STAGE_EVIDENCE_CODES,
      orchestration.WORKFLOW_PROFILES,
      orchestration.WORKFLOW_STAGES,
    ]) {
      expect(Object.isFrozen(constant)).toBe(true);
    }
  });

  it("uses no time, randomness, or side-effect-layer imports in production sources", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const file of [
      "completion.ts",
      "contracts.ts",
      "dispatch.ts",
      "graph.ts",
      "index.ts",
      "materialization.ts",
      "plan-review.ts",
      "stages.ts",
    ]) {
      const source = readFileSync(join(sourceRoot, file), "utf-8");
      expect(source).not.toMatch(/Date\.now|Math\.random|node:crypto/);
      expect(source).not.toMatch(
        /@codex-task-console\/(storage|codex-adapter|local-control)/,
      );
    }
  });
});
