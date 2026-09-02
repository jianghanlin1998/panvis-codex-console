import { describe, expect, it } from "vitest";

import { evaluateStageTransition } from "../src/index.js";
import type {
  MaterializedGraph,
  StageEvidenceFacts,
  StageEvidenceSnapshot,
  StageTransitionInput,
  WorkflowStage,
} from "../src/index.js";
import {
  materializedGraphFor,
  planCandidate,
  proposedSubtask,
  stageEvidenceFor,
} from "./fixtures.js";

const standardGraph = materializedGraphFor(
  planCandidate({
    subtasks: [
      proposedSubtask("st_standard_a", "STANDARD"),
      proposedSubtask("st_standard_b", "STANDARD"),
    ],
  }),
);

const highRiskGraph = materializedGraphFor(
  planCandidate({
    subtasks: [
      proposedSubtask("st_high_a", "HIGH_RISK_FOUNDATION"),
      proposedSubtask("st_high_b", "HIGH_RISK_FOUNDATION"),
    ],
  }),
);

const transition = (
  graph: MaterializedGraph,
  subtaskId: MaterializedGraph["subtasks"][number]["id"],
  currentStage: WorkflowStage,
  requestedNextStage: WorkflowStage,
  evidence: Readonly<StageEvidenceSnapshot>,
  repairCyclesUsed: 0 | 1 = 0,
) =>
  evaluateStageTransition({
    graph,
    subtaskId,
    currentStage,
    requestedNextStage,
    evidence,
    repairCyclesUsed,
  });

describe("CTC-ORCH-FQA-001 stage-evidence Subtask authority binding", () => {
  it("rejects same-candidate sibling substitution and accepts the correctly bound Subtask", () => {
    const [subtaskA, subtaskB] = standardGraph.subtasks;
    const evidence = stageEvidenceFor(
      standardGraph,
      { executionEvidencePassed: true },
      subtaskA!.id,
    );

    expect(
      transition(
        standardGraph,
        subtaskB!.id,
        "EXECUTE",
        "VERIFY",
        evidence,
      ),
    ).toEqual({
      kind: "BLOCKED",
      reason: "INVALID_INPUT",
      currentStage: null,
      nextStage: null,
      requiredEvidence: [],
      missingEvidence: [],
      repairCyclesUsed: null,
    });
    expect(
      transition(
        standardGraph,
        subtaskA!.id,
        "EXECUTE",
        "VERIFY",
        evidence,
      ),
    ).toMatchObject({ kind: "ELIGIBLE", nextStage: "VERIFY" });
  });

  it("rejects sibling substitution across different workflow profiles", () => {
    const graph = materializedGraphFor(
      planCandidate({
        subtasks: [
          proposedSubtask("st_low", "LOW"),
          proposedSubtask("st_high", "HIGH_RISK_FOUNDATION"),
        ],
      }),
    );
    const evidence = stageEvidenceFor(
      graph,
      { executionEvidencePassed: true },
      graph.subtasks[0]!.id,
    );

    expect(
      transition(
        graph,
        graph.subtasks[1]!.id,
        "EXECUTE",
        "HARDEN",
        evidence,
      ),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
  });

  it.each<{
    readonly graph: MaterializedGraph;
    readonly currentStage: WorkflowStage;
    readonly requestedNextStage: WorkflowStage;
    readonly facts: Readonly<StageEvidenceFacts>;
    readonly repairCyclesUsed?: 0 | 1;
  }>([
    {
      graph: standardGraph,
      currentStage: "EXECUTE",
      requestedNextStage: "VERIFY",
      facts: { executionEvidencePassed: true },
    },
    {
      graph: standardGraph,
      currentStage: "VERIFY",
      requestedNextStage: "COMPLETE",
      facts: { verificationEvidencePassed: true },
    },
    {
      graph: highRiskGraph,
      currentStage: "EXECUTE",
      requestedNextStage: "HARDEN",
      facts: { executionEvidencePassed: true },
    },
    {
      graph: highRiskGraph,
      currentStage: "HARDEN",
      requestedNextStage: "FRESH_QA",
      facts: { hardeningEvidencePassed: true },
    },
    {
      graph: highRiskGraph,
      currentStage: "FRESH_QA",
      requestedNextStage: "COMPLETE",
      facts: { freshQaOutcome: "PASS" },
    },
    {
      graph: highRiskGraph,
      currentStage: "REPAIR",
      requestedNextStage: "FOCUSED_RE_QA",
      facts: { repairEvidencePassed: true },
      repairCyclesUsed: 1,
    },
    {
      graph: highRiskGraph,
      currentStage: "FOCUSED_RE_QA",
      requestedNextStage: "COMPLETE",
      facts: { focusedReQaOutcome: "PASS" },
      repairCyclesUsed: 1,
    },
  ])(
    "rejects sibling substitution for $currentStage->$requestedNextStage evidence",
    ({ graph, currentStage, requestedNextStage, facts, repairCyclesUsed = 0 }) => {
      const [subtaskA, subtaskB] = graph.subtasks;
      expect(
        transition(
          graph,
          subtaskB!.id,
          currentStage,
          requestedNextStage,
          stageEvidenceFor(graph, facts, subtaskA!.id),
          repairCyclesUsed,
        ),
      ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    },
  );

  it("preserves cross-candidate rejection when the Subtask ID matches", () => {
    const otherGraph = materializedGraphFor(
      planCandidate({
        subtasks: [
          {
            ...proposedSubtask("st_standard_a", "STANDARD"),
            taskContractRef: "contracts/other-candidate.md",
          },
          proposedSubtask("st_standard_b", "STANDARD"),
        ],
      }),
    );
    expect(otherGraph.candidateBinding).not.toBe(standardGraph.candidateBinding);

    expect(
      transition(
        standardGraph,
        standardGraph.subtasks[0]!.id,
        "EXECUTE",
        "VERIFY",
        stageEvidenceFor(
          otherGraph,
          { executionEvidencePassed: true },
          otherGraph.subtasks[0]!.id,
        ),
      ),
    ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
  });

  it("rejects missing, malformed, unknown, sibling, and non-graph Subtask bindings", () => {
    const target = standardGraph.subtasks[0]!.id;
    const valid = stageEvidenceFor(
      standardGraph,
      { executionEvidencePassed: true },
      target,
    );
    const missingSubtaskId = {
      candidateBinding: valid.candidateBinding,
      facts: valid.facts,
    };
    const malformedSnapshots = [
      missingSubtaskId,
      { ...valid, subtaskId: " st_standard_a " },
      { ...valid, unexpected: true },
      { ...valid, subtaskId: standardGraph.subtasks[1]!.id },
      { ...valid, subtaskId: "st_not_in_graph" },
    ];

    for (const evidence of malformedSnapshots) {
      expect(
        transition(
          standardGraph,
          target,
          "EXECUTE",
          "VERIFY",
          evidence as unknown as StageEvidenceSnapshot,
        ),
      ).toMatchObject({ kind: "BLOCKED", reason: "INVALID_INPUT" });
    }
  });

  it("detaches the immutable result from later source-evidence mutation", () => {
    const target = standardGraph.subtasks[0]!.id;
    const facts = { executionEvidencePassed: true };
    const evidence = {
      candidateBinding: standardGraph.candidateBinding,
      subtaskId: target,
      facts,
    };
    const input = {
      graph: standardGraph,
      subtaskId: target,
      currentStage: "EXECUTE",
      requestedNextStage: "VERIFY",
      evidence,
      repairCyclesUsed: 0,
    } as const satisfies StageTransitionInput;
    const result = evaluateStageTransition(input);
    const authoritativeResult = JSON.stringify(result);

    facts.executionEvidencePassed = false;
    evidence.subtaskId = standardGraph.subtasks[1]!.id;
    evidence.candidateBinding = `${standardGraph.candidateBinding}:mutated`;

    expect(JSON.stringify(result)).toBe(authoritativeResult);
    expect(result).toMatchObject({ kind: "ELIGIBLE", nextStage: "VERIFY" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.requiredEvidence)).toBe(true);
    expect(Object.isFrozen(result.missingEvidence)).toBe(true);
  });
});
