import {
  STAGE_EVIDENCE_CODES,
  WORKFLOW_PROFILES,
  WORKFLOW_STAGES,
} from "./contracts.js";
import type {
  QaOutcome,
  StageBlockReason,
  StageEvidenceCode,
  StageEvidenceFacts,
  StageTransitionInput,
  StageTransitionResult,
  WorkflowProfile,
  WorkflowInitializationStage,
  WorkflowStage,
} from "./contracts.js";
import { parseMaterializedGraph } from "./graph.js";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWorkflowProfile = (value: unknown): value is WorkflowProfile =>
  typeof value === "string" && WORKFLOW_PROFILES.some((profile) => profile === value);

const isWorkflowStage = (value: unknown): value is WorkflowStage =>
  typeof value === "string" && WORKFLOW_STAGES.some((stage) => stage === value);

const qaOutcomes: readonly QaOutcome[] = ["NOT_RUN", "PASS", "BLOCKING_FAIL"];

const evidenceKeys = [
  "budgetAvailable",
  "concurrencyAvailable",
  "contextPreflightPassed",
  "dependenciesReady",
  "executionEvidencePassed",
  "focusedReQaOutcome",
  "freshQaOutcome",
  "graphMaterialized",
  "hardeningEvidencePassed",
  "humanApprovalSatisfied",
  "planCandidatePresent",
  "planReviewSatisfied",
  "repairEvidencePassed",
  "repositoryPreflightPassed",
  "verificationEvidencePassed",
  "worktreeOwnershipAvailable",
] as const satisfies readonly (keyof StageEvidenceFacts)[];

const parseEvidenceFacts = (input: unknown): Readonly<StageEvidenceFacts> | null => {
  if (!isRecord(input) || Object.keys(input).some((key) => !evidenceKeys.includes(key as never))) {
    return null;
  }
  for (const key of evidenceKeys) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (key === "freshQaOutcome" || key === "focusedReQaOutcome") {
      if (!qaOutcomes.some((outcome) => outcome === value)) {
        return null;
      }
    } else if (typeof value !== "boolean") {
      return null;
    }
  }
  return Object.freeze({ ...input }) as Readonly<StageEvidenceFacts>;
};

interface ParsedStageTransitionInput {
  readonly profile: WorkflowProfile;
  readonly currentStage: WorkflowStage;
  readonly requestedNextStage: WorkflowStage;
  readonly evidence: Readonly<StageEvidenceFacts>;
  readonly repairCyclesUsed: 0 | 1;
}

const parseInput = (input: unknown): Readonly<ParsedStageTransitionInput> | null => {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 6 ||
    !Object.hasOwn(input, "graph") ||
    !Object.hasOwn(input, "subtaskId") ||
    !Object.hasOwn(input, "currentStage") ||
    !Object.hasOwn(input, "requestedNextStage") ||
    !Object.hasOwn(input, "evidence") ||
    !Object.hasOwn(input, "repairCyclesUsed") ||
    !isWorkflowStage(input.currentStage) ||
    !isWorkflowStage(input.requestedNextStage) ||
    (input.repairCyclesUsed !== 0 && input.repairCyclesUsed !== 1)
  ) {
    return null;
  }
  const graph = parseMaterializedGraph(input.graph);
  if (
    graph === null ||
    typeof input.subtaskId !== "string" ||
    !isRecord(input.evidence) ||
    Object.keys(input.evidence).length !== 3 ||
    !Object.hasOwn(input.evidence, "candidateBinding") ||
    !Object.hasOwn(input.evidence, "subtaskId") ||
    !Object.hasOwn(input.evidence, "facts") ||
    input.evidence.candidateBinding !== graph.candidateBinding ||
    typeof input.evidence.subtaskId !== "string"
  ) {
    return null;
  }
  const subtask = graph.subtasks.find(({ id }) => id === input.subtaskId);
  const evidence = parseEvidenceFacts(input.evidence.facts);
  if (
    subtask === undefined ||
    input.evidence.subtaskId !== subtask.id ||
    evidence === null
  ) {
    return null;
  }
  return Object.freeze({
    profile: subtask.profile,
    currentStage: input.currentStage,
    requestedNextStage: input.requestedNextStage,
    evidence,
    repairCyclesUsed: input.repairCyclesUsed,
  });
};

export const getWorkflowStagePath = (
  profile: WorkflowProfile,
): readonly WorkflowStage[] => {
  if (!isWorkflowProfile(profile)) {
    return Object.freeze([]);
  }
  switch (profile) {
    case "LOW":
      return Object.freeze(["EXECUTE", "VERIFY", "COMPLETE"]);
    case "STANDARD":
      return Object.freeze([
        "PLAN",
        "REVIEW",
        "MATERIALIZE",
        "EXECUTE",
        "VERIFY",
        "COMPLETE",
      ]);
    case "HIGH_RISK_FOUNDATION":
      return Object.freeze([
        "PLAN",
        "REVIEW",
        "MATERIALIZE",
        "EXECUTE",
        "HARDEN",
        "FRESH_QA",
        "COMPLETE",
      ]);
  }
};

export const deriveInitialWorkflowStage = (
  profile: WorkflowProfile,
): WorkflowInitializationStage | null => {
  if (!isWorkflowProfile(profile)) {
    return null;
  }
  return profile === "LOW" ? "EXECUTE" : "MATERIALIZE";
};

const executionEntryEvidence = [
  "GRAPH_MATERIALIZED",
  "DEPENDENCIES_READY",
  "REPOSITORY_PREFLIGHT_PASSED",
  "CONTEXT_PREFLIGHT_PASSED",
  "BUDGET_AVAILABLE",
  "CONCURRENCY_AVAILABLE",
  "WORKTREE_OWNERSHIP_AVAILABLE",
  "HUMAN_APPROVAL_SATISFIED",
] as const satisfies readonly StageEvidenceCode[];

const nextStageFor = (
  profile: WorkflowProfile,
  currentStage: WorkflowStage,
): WorkflowStage | null => {
  const path = getWorkflowStagePath(profile);
  const currentIndex = path.indexOf(currentStage);
  return currentIndex >= 0 ? (path[currentIndex + 1] ?? null) : null;
};

const standardRequirements = (
  currentStage: WorkflowStage,
  nextStage: WorkflowStage,
): readonly StageEvidenceCode[] => {
  const transition = `${currentStage}->${nextStage}`;
  switch (transition) {
    case "PLAN->REVIEW":
      return Object.freeze(["PLAN_CANDIDATE_PRESENT"]);
    case "REVIEW->MATERIALIZE":
      return Object.freeze(["PLAN_REVIEW_SATISFIED"]);
    case "MATERIALIZE->EXECUTE":
      return Object.freeze([...executionEntryEvidence]);
    case "EXECUTE->VERIFY":
    case "EXECUTE->HARDEN":
      return Object.freeze(["EXECUTION_EVIDENCE_PASSED"]);
    case "VERIFY->COMPLETE":
      return Object.freeze(["VERIFICATION_EVIDENCE_PASSED"]);
    case "HARDEN->FRESH_QA":
      return Object.freeze(["HARDENING_EVIDENCE_PASSED"]);
    case "REPAIR->FOCUSED_RE_QA":
      return Object.freeze(["REPAIR_EVIDENCE_PASSED"]);
    default:
      return Object.freeze([]);
  }
};

const evidenceValue = (
  evidence: Readonly<StageEvidenceFacts>,
  code: StageEvidenceCode,
): boolean => {
  switch (code) {
    case "PLAN_CANDIDATE_PRESENT":
      return evidence.planCandidatePresent === true;
    case "PLAN_REVIEW_SATISFIED":
      return evidence.planReviewSatisfied === true;
    case "GRAPH_MATERIALIZED":
      return evidence.graphMaterialized === true;
    case "DEPENDENCIES_READY":
      return evidence.dependenciesReady === true;
    case "REPOSITORY_PREFLIGHT_PASSED":
      return evidence.repositoryPreflightPassed === true;
    case "CONTEXT_PREFLIGHT_PASSED":
      return evidence.contextPreflightPassed === true;
    case "BUDGET_AVAILABLE":
      return evidence.budgetAvailable === true;
    case "CONCURRENCY_AVAILABLE":
      return evidence.concurrencyAvailable === true;
    case "WORKTREE_OWNERSHIP_AVAILABLE":
      return evidence.worktreeOwnershipAvailable === true;
    case "HUMAN_APPROVAL_SATISFIED":
      return evidence.humanApprovalSatisfied === true;
    case "EXECUTION_EVIDENCE_PASSED":
      return evidence.executionEvidencePassed === true;
    case "VERIFICATION_EVIDENCE_PASSED":
      return evidence.verificationEvidencePassed === true;
    case "HARDENING_EVIDENCE_PASSED":
      return evidence.hardeningEvidencePassed === true;
    case "FRESH_QA_OUTCOME_RECORDED":
      return (
        evidence.freshQaOutcome === "PASS" ||
        evidence.freshQaOutcome === "BLOCKING_FAIL"
      );
    case "REPAIR_EVIDENCE_PASSED":
      return evidence.repairEvidencePassed === true;
    case "FOCUSED_RE_QA_OUTCOME_RECORDED":
      return (
        evidence.focusedReQaOutcome === "PASS" ||
        evidence.focusedReQaOutcome === "BLOCKING_FAIL"
      );
  }
};

const evidenceKeyForCode = (
  code: StageEvidenceCode,
): keyof StageEvidenceFacts => {
  switch (code) {
    case "PLAN_CANDIDATE_PRESENT":
      return "planCandidatePresent";
    case "PLAN_REVIEW_SATISFIED":
      return "planReviewSatisfied";
    case "GRAPH_MATERIALIZED":
      return "graphMaterialized";
    case "DEPENDENCIES_READY":
      return "dependenciesReady";
    case "REPOSITORY_PREFLIGHT_PASSED":
      return "repositoryPreflightPassed";
    case "CONTEXT_PREFLIGHT_PASSED":
      return "contextPreflightPassed";
    case "BUDGET_AVAILABLE":
      return "budgetAvailable";
    case "CONCURRENCY_AVAILABLE":
      return "concurrencyAvailable";
    case "WORKTREE_OWNERSHIP_AVAILABLE":
      return "worktreeOwnershipAvailable";
    case "HUMAN_APPROVAL_SATISFIED":
      return "humanApprovalSatisfied";
    case "EXECUTION_EVIDENCE_PASSED":
      return "executionEvidencePassed";
    case "VERIFICATION_EVIDENCE_PASSED":
      return "verificationEvidencePassed";
    case "HARDENING_EVIDENCE_PASSED":
      return "hardeningEvidencePassed";
    case "FRESH_QA_OUTCOME_RECORDED":
      return "freshQaOutcome";
    case "REPAIR_EVIDENCE_PASSED":
      return "repairEvidencePassed";
    case "FOCUSED_RE_QA_OUTCOME_RECORDED":
      return "focusedReQaOutcome";
  }
};

const hasOnlyRelevantEvidence = (
  evidence: Readonly<StageEvidenceFacts>,
  requiredEvidence: readonly StageEvidenceCode[],
): boolean => {
  const relevantKeys = new Set(requiredEvidence.map(evidenceKeyForCode));
  return Object.keys(evidence).every((key) =>
    relevantKeys.has(key as keyof StageEvidenceFacts),
  );
};

const reasonForMissingEvidence = (
  missingEvidence: readonly StageEvidenceCode[],
): StageBlockReason => {
  if (missingEvidence.includes("DEPENDENCIES_READY")) {
    return "DEPENDENCY_BLOCKED";
  }
  if (missingEvidence.includes("BUDGET_AVAILABLE")) {
    return "BUDGET_BLOCKED";
  }
  if (missingEvidence.includes("CONCURRENCY_AVAILABLE")) {
    return "CONCURRENCY_BLOCKED";
  }
  if (missingEvidence.includes("HUMAN_APPROVAL_SATISFIED")) {
    return "AUTHORITY_BLOCKED";
  }
  return "EVIDENCE_BLOCKED";
};

const blocked = (
  reason: StageBlockReason,
  currentStage: WorkflowStage | null,
  nextStage: WorkflowStage | null,
  requiredEvidence: readonly StageEvidenceCode[] = [],
  missingEvidence: readonly StageEvidenceCode[] = [],
  repairCyclesUsed: 0 | 1 | null = null,
): StageTransitionResult =>
  Object.freeze({
    kind: "BLOCKED",
    reason,
    currentStage,
    nextStage,
    requiredEvidence: Object.freeze([...requiredEvidence]),
    missingEvidence: Object.freeze([...missingEvidence]),
    repairCyclesUsed,
  });

export const evaluateStageTransition = (
  inputValue: Readonly<StageTransitionInput>,
): StageTransitionResult => {
  const input = parseInput(inputValue);
  if (input === null) {
    return blocked("INVALID_INPUT", null, null);
  }

  if (
    (input.profile !== "HIGH_RISK_FOUNDATION" && input.repairCyclesUsed !== 0) ||
    (input.profile === "HIGH_RISK_FOUNDATION" &&
      (input.currentStage === "REPAIR" || input.currentStage === "FOCUSED_RE_QA") &&
      input.repairCyclesUsed !== 1) ||
    (input.profile === "HIGH_RISK_FOUNDATION" &&
      input.currentStage !== "REPAIR" &&
      input.currentStage !== "FOCUSED_RE_QA" &&
      input.currentStage !== "COMPLETE" &&
      input.repairCyclesUsed !== 0)
  ) {
    return blocked(
      "INVALID_INPUT",
      input.currentStage,
      null,
      [],
      [],
      input.repairCyclesUsed,
    );
  }

  let expectedNextStage = nextStageFor(input.profile, input.currentStage);
  let requiredEvidence: readonly StageEvidenceCode[] = [];
  let nextRepairCyclesUsed = input.repairCyclesUsed;

  if (input.profile === "HIGH_RISK_FOUNDATION" && input.currentStage === "FRESH_QA") {
    requiredEvidence = Object.freeze(["FRESH_QA_OUTCOME_RECORDED"]);
    if (!hasOnlyRelevantEvidence(input.evidence, requiredEvidence)) {
      return blocked(
        "INVALID_INPUT",
        input.currentStage,
        null,
        [],
        [],
        0,
      );
    }
    if (!evidenceValue(input.evidence, "FRESH_QA_OUTCOME_RECORDED")) {
      return blocked(
        "EVIDENCE_BLOCKED",
        input.currentStage,
        null,
        requiredEvidence,
        requiredEvidence,
        input.repairCyclesUsed,
      );
    }
    if (input.evidence.freshQaOutcome === "BLOCKING_FAIL") {
      expectedNextStage = "REPAIR";
      nextRepairCyclesUsed = 1;
    } else {
      expectedNextStage = "COMPLETE";
    }
  } else if (
    input.profile === "HIGH_RISK_FOUNDATION" &&
    input.currentStage === "REPAIR"
  ) {
    if (input.repairCyclesUsed !== 1) {
      return blocked(
        "INVALID_INPUT",
        input.currentStage,
        null,
        [],
        [],
        input.repairCyclesUsed,
      );
    }
    expectedNextStage = "FOCUSED_RE_QA";
    requiredEvidence = Object.freeze(["REPAIR_EVIDENCE_PASSED"]);
  } else if (
    input.profile === "HIGH_RISK_FOUNDATION" &&
    input.currentStage === "FOCUSED_RE_QA"
  ) {
    if (input.repairCyclesUsed !== 1) {
      return blocked(
        "INVALID_INPUT",
        input.currentStage,
        null,
        [],
        [],
        input.repairCyclesUsed,
      );
    }
    requiredEvidence = Object.freeze(["FOCUSED_RE_QA_OUTCOME_RECORDED"]);
    if (!hasOnlyRelevantEvidence(input.evidence, requiredEvidence)) {
      return blocked(
        "INVALID_INPUT",
        input.currentStage,
        null,
        [],
        [],
        input.repairCyclesUsed,
      );
    }
    if (!evidenceValue(input.evidence, "FOCUSED_RE_QA_OUTCOME_RECORDED")) {
      return blocked(
        "EVIDENCE_BLOCKED",
        input.currentStage,
        null,
        requiredEvidence,
        requiredEvidence,
        input.repairCyclesUsed,
      );
    }
    if (input.evidence.focusedReQaOutcome === "BLOCKING_FAIL") {
      return Object.freeze({
        kind: "HUMAN_REQUIRED",
        reason: "REPAIR_REQA_EXHAUSTED",
        currentStage: input.currentStage,
        nextStage: null,
        requiredEvidence,
        missingEvidence: Object.freeze([]),
        repairCyclesUsed: 1,
      });
    }
    expectedNextStage = "COMPLETE";
  } else if (expectedNextStage !== null) {
    requiredEvidence = standardRequirements(input.currentStage, expectedNextStage);
  }

  if (!hasOnlyRelevantEvidence(input.evidence, requiredEvidence)) {
    return blocked(
      "INVALID_INPUT",
      input.currentStage,
      expectedNextStage,
      requiredEvidence,
      [],
      input.repairCyclesUsed,
    );
  }

  if (
    expectedNextStage === null ||
    input.requestedNextStage !== expectedNextStage ||
    input.currentStage === "COMPLETE"
  ) {
    return blocked(
      "INVALID_STAGE_TRANSITION",
      input.currentStage,
      expectedNextStage,
      requiredEvidence,
      [],
      input.repairCyclesUsed,
    );
  }

  const missingEvidence = requiredEvidence.filter(
    (code) => !evidenceValue(input.evidence, code),
  );
  if (missingEvidence.length > 0) {
    const reason = reasonForMissingEvidence(missingEvidence);
    if (reason === "AUTHORITY_BLOCKED") {
      return Object.freeze({
        kind: "HUMAN_REQUIRED",
        reason,
        currentStage: input.currentStage,
        nextStage: null,
        requiredEvidence: Object.freeze([...requiredEvidence]),
        missingEvidence: Object.freeze([...missingEvidence]),
        repairCyclesUsed: input.repairCyclesUsed,
      });
    }
    return blocked(
      reason,
      input.currentStage,
      expectedNextStage,
      requiredEvidence,
      missingEvidence,
      input.repairCyclesUsed,
    );
  }

  return Object.freeze({
    kind: "ELIGIBLE",
    currentStage: input.currentStage,
    nextStage: expectedNextStage,
    requiredEvidence: Object.freeze([...requiredEvidence]),
    missingEvidence: Object.freeze([]),
    repairCyclesUsed: nextRepairCyclesUsed,
  });
};

export const isStageEvidenceCode = (input: unknown): input is StageEvidenceCode =>
  typeof input === "string" && STAGE_EVIDENCE_CODES.some((code) => code === input);
