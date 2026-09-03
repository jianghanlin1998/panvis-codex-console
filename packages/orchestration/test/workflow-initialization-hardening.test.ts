import { describe, expect, it } from "vitest";

import {
  deriveInitialWorkflowStage,
  evaluateStageTransition,
  getWorkflowStagePath,
  selectSerialWriteDispatch,
} from "../src/index.js";
import type {
  MaterializedGraph,
  WorkflowProfile,
  WorkflowStage,
} from "../src/index.js";
import {
  executionFacts,
  executionFactsSnapshotFor,
  materializedGraphFor,
  planCandidate,
  projectWriteCapacityFor,
  proposedSubtask,
  stageEvidenceFor,
  stateSnapshotFor,
} from "./fixtures.js";

const expectedBootstrap = Object.freeze({
  LOW: "EXECUTE",
  STANDARD: "MATERIALIZE",
  HIGH_RISK_FOUNDATION: "MATERIALIZE",
} as const satisfies Readonly<Record<WorkflowProfile, WorkflowStage>>);

const graphFor = (profile: WorkflowProfile): MaterializedGraph =>
  materializedGraphFor(planCandidate({
    subtasks: [proposedSubtask("st_b3a_kernel", profile)],
  }));

describe("Step 8B3a initial-stage semantic hardening", () => {
  it.each(Object.entries(expectedBootstrap) as readonly (readonly [
    WorkflowProfile,
    WorkflowStage,
  ])[])("keeps %s bootstrap %s on the accepted profile path", (profile, stage) => {
    const path = getWorkflowStagePath(profile);
    expect(deriveInitialWorkflowStage(profile)).toBe(stage);
    expect(path).toContain(stage);
    expect(profile === "LOW" ? path[0] : path[2]).toBe(stage);
    expect(Object.isFrozen(path)).toBe(true);
  });

  it("fails closed for every tested unknown runtime profile", () => {
    for (const value of ["", "low", "STANDARD ", "HIGH", null, 1, {}]) {
      expect(deriveInitialWorkflowStage(value as never)).toBeNull();
      expect(getWorkflowStagePath(value as never)).toEqual([]);
    }
  });

  it("does not treat LOW bootstrap at EXECUTE as dispatch selection or readiness", () => {
    const graph = graphFor("LOW");
    const subtaskId = graph.subtasks[0]!.id;
    const result = selectSerialWriteDispatch({
      graph,
      subtaskStateSnapshot: stateSnapshotFor(graph, [{
        subtaskId,
        stage: deriveInitialWorkflowStage("LOW")!,
        maturity: "NOT_STARTED",
      }]),
      executionFactsSnapshot: executionFactsSnapshotFor(graph, [
        { ...executionFacts(subtaskId), repositoryPreflightPassed: false },
      ]),
      projectWriteCapacity: projectWriteCapacityFor(graph),
    });
    expect(result).toEqual({ kind: "BLOCKED", reason: "PREFLIGHT_BLOCKED", eligibleSubtaskIds: [] });
  });

  it.each(["STANDARD", "HIGH_RISK_FOUNDATION"] as const)(
    "requires exact execution-entry evidence after %s bootstrap at MATERIALIZE",
    (profile) => {
      const graph = graphFor(profile);
      const subtaskId = graph.subtasks[0]!.id;
      const blocked = evaluateStageTransition({
        graph,
        subtaskId,
        currentStage: deriveInitialWorkflowStage(profile)!,
        requestedNextStage: "EXECUTE",
        evidence: stageEvidenceFor(graph, { graphMaterialized: true }),
        repairCyclesUsed: 0,
      });
      expect(blocked).toMatchObject({
        kind: "BLOCKED",
        reason: "DEPENDENCY_BLOCKED",
        currentStage: "MATERIALIZE",
        nextStage: "EXECUTE",
      });
      expect(blocked).toHaveProperty("missingEvidence", expect.arrayContaining([
        "DEPENDENCIES_READY",
        "REPOSITORY_PREFLIGHT_PASSED",
        "CONTEXT_PREFLIGHT_PASSED",
        "BUDGET_AVAILABLE",
        "CONCURRENCY_AVAILABLE",
        "WORKTREE_OWNERSHIP_AVAILABLE",
        "HUMAN_APPROVAL_SATISFIED",
      ]));
    },
  );
});
