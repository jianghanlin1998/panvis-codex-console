import {
  createPlanCandidateBinding,
  parsePlanCandidate,
} from "./graph.js";
import type {
  PlanCandidate,
  PlanReviewOperationResult,
  PlanReviewState,
  ReviewDecision,
} from "./contracts.js";

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value).sort(compareCodeUnits);
  const sortedExpectedKeys = [...expectedKeys].sort(compareCodeUnits);
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
};

const parseRequirements = (input: unknown): readonly string[] | null => {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  const requirements: string[] = [];
  const seenRequirements = new Set<string>();
  for (const requirement of input) {
    if (
      typeof requirement !== "string" ||
      requirement.length === 0 ||
      requirement.length > 1_000 ||
      requirement.trim() !== requirement ||
      seenRequirements.has(requirement)
    ) {
      return null;
    }
    seenRequirements.add(requirement);
    requirements.push(requirement);
  }
  return Object.freeze(requirements);
};

const parseReviewDecision = (input: unknown): ReviewDecision | null => {
  if (
    !isRecord(input) ||
    !Number.isSafeInteger(input.planRevision) ||
    typeof input.candidateBinding !== "string"
  ) {
    return null;
  }
  if (
    input.outcome === "APPROVE" &&
    hasExactKeys(input, ["candidateBinding", "outcome", "planRevision"])
  ) {
    return Object.freeze({
      outcome: "APPROVE",
      planRevision: input.planRevision as number,
      candidateBinding: input.candidateBinding,
    });
  }
  if (
    input.outcome === "ESCALATE" &&
    hasExactKeys(input, ["candidateBinding", "outcome", "planRevision"])
  ) {
    return Object.freeze({
      outcome: "ESCALATE",
      planRevision: input.planRevision as number,
      candidateBinding: input.candidateBinding,
    });
  }
  if (
    input.outcome === "REJECT" &&
    hasExactKeys(input, [
      "candidateBinding",
      "outcome",
      "planRevision",
      "revisionRequirements",
    ])
  ) {
    const revisionRequirements = parseRequirements(input.revisionRequirements);
    if (revisionRequirements !== null) {
      return Object.freeze({
        outcome: "REJECT",
        planRevision: input.planRevision as number,
        candidateBinding: input.candidateBinding,
        revisionRequirements,
      });
    }
  }
  return null;
};

const freezeState = (state: PlanReviewState): PlanReviewState => {
  if (state.phase === "AWAITING_REVISION") {
    return Object.freeze({
      ...state,
      revisionRequirements: Object.freeze([...state.revisionRequirements]),
    });
  }
  return Object.freeze({ ...state });
};

export const parsePlanReviewState = (input: unknown): PlanReviewState | null => {
  if (!isRecord(input)) {
    return null;
  }
  const parsedCandidate = parsePlanCandidate(input.candidate);
  if (
    !parsedCandidate.valid ||
    !Number.isSafeInteger(input.initialPlanRevision) ||
    typeof input.initialPlanRevision !== "number" ||
    input.initialPlanRevision < 1 ||
    (input.automaticRevisionsUsed !== 0 &&
      input.automaticRevisionsUsed !== 1 &&
      input.automaticRevisionsUsed !== 2) ||
    input.initialPlanRevision >
      Number.MAX_SAFE_INTEGER - input.automaticRevisionsUsed ||
    parsedCandidate.candidate.revision !==
      input.initialPlanRevision + input.automaticRevisionsUsed
  ) {
    return null;
  }
  const candidateBinding = createPlanCandidateBinding(parsedCandidate.candidate);
  if (input.candidateBinding !== candidateBinding) {
    return null;
  }

  const base = {
    candidate: parsedCandidate.candidate,
    candidateBinding,
    initialPlanRevision: input.initialPlanRevision,
    automaticRevisionsUsed: input.automaticRevisionsUsed,
  } as const;

  if (
    input.phase === "AWAITING_REVIEW" &&
    hasExactKeys(input, [
      "automaticRevisionsUsed",
      "candidate",
      "candidateBinding",
      "initialPlanRevision",
      "phase",
    ])
  ) {
    return freezeState({ ...base, phase: "AWAITING_REVIEW" });
  }
  if (
    input.phase === "AWAITING_REVISION" &&
    input.automaticRevisionsUsed < 2 &&
    parsedCandidate.candidate.revision < Number.MAX_SAFE_INTEGER &&
    hasExactKeys(input, [
      "automaticRevisionsUsed",
      "candidate",
      "candidateBinding",
      "initialPlanRevision",
      "phase",
      "revisionRequirements",
    ])
  ) {
    const revisionRequirements = parseRequirements(input.revisionRequirements);
    if (revisionRequirements !== null) {
      return freezeState({
        ...base,
        phase: "AWAITING_REVISION",
        revisionRequirements,
      });
    }
  }
  if (
    input.phase === "APPROVED" &&
    hasExactKeys(input, [
      "automaticRevisionsUsed",
      "candidate",
      "candidateBinding",
      "initialPlanRevision",
      "phase",
    ])
  ) {
    return freezeState({ ...base, phase: "APPROVED" });
  }
  if (
    input.phase === "HUMAN_REQUIRED" &&
    (input.humanReason === "PLAN_REVIEW_EXHAUSTED" ||
      input.humanReason === "REVIEW_ESCALATED") &&
    (input.humanReason !== "PLAN_REVIEW_EXHAUSTED" ||
      input.automaticRevisionsUsed === 2 ||
      parsedCandidate.candidate.revision === Number.MAX_SAFE_INTEGER) &&
    hasExactKeys(input, [
      "automaticRevisionsUsed",
      "candidate",
      "candidateBinding",
      "humanReason",
      "initialPlanRevision",
      "phase",
    ])
  ) {
    return freezeState({
      ...base,
      phase: "HUMAN_REQUIRED",
      humanReason: input.humanReason,
    });
  }
  return null;
};

export const beginPlanReview = (candidateInput: PlanCandidate): PlanReviewOperationResult => {
  const parsed = parsePlanCandidate(candidateInput);
  if (!parsed.valid) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "INVALID_PLAN_CANDIDATE",
    });
  }
  return Object.freeze({
    kind: "REVIEW_STATE",
    state: freezeState({
      phase: "AWAITING_REVIEW",
      candidate: parsed.candidate,
      candidateBinding: createPlanCandidateBinding(parsed.candidate),
      initialPlanRevision: parsed.candidate.revision,
      automaticRevisionsUsed: 0,
    }),
  });
};

export const applyReviewerDecision = (
  stateInput: Readonly<PlanReviewState>,
  decisionInput: ReviewDecision,
): PlanReviewOperationResult => {
  const state = parsePlanReviewState(stateInput);
  if (state === null) {
    return Object.freeze({ kind: "INVALID_OPERATION", reason: "INVALID_REVIEW_STATE" });
  }
  if (state.phase !== "AWAITING_REVIEW") {
    return Object.freeze({ kind: "INVALID_OPERATION", reason: "REVIEW_NOT_PENDING" });
  }
  const decision = parseReviewDecision(decisionInput);
  if (decision === null) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "INVALID_REVIEW_DECISION",
    });
  }
  if (
    decision.planRevision !== state.candidate.revision ||
    decision.candidateBinding !== state.candidateBinding
  ) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "STALE_REVIEW_DECISION",
    });
  }

  if (decision.outcome === "APPROVE") {
    return Object.freeze({
      kind: "REVIEW_STATE",
      state: freezeState({ ...state, phase: "APPROVED" }),
    });
  }
  if (decision.outcome === "ESCALATE") {
    return Object.freeze({
      kind: "REVIEW_STATE",
      state: freezeState({
        ...state,
        phase: "HUMAN_REQUIRED",
        humanReason: "REVIEW_ESCALATED",
      }),
    });
  }
  if (
    state.automaticRevisionsUsed === 2 ||
    state.candidate.revision === Number.MAX_SAFE_INTEGER
  ) {
    return Object.freeze({
      kind: "REVIEW_STATE",
      state: freezeState({
        ...state,
        phase: "HUMAN_REQUIRED",
        humanReason: "PLAN_REVIEW_EXHAUSTED",
      }),
    });
  }
  return Object.freeze({
    kind: "REVIEW_STATE",
    state: freezeState({
      ...state,
      phase: "AWAITING_REVISION",
      revisionRequirements: decision.revisionRequirements,
    }),
  });
};

export const submitPlannerRevision = (
  stateInput: Readonly<PlanReviewState>,
  candidateInput: PlanCandidate,
): PlanReviewOperationResult => {
  const state = parsePlanReviewState(stateInput);
  if (state === null) {
    return Object.freeze({ kind: "INVALID_OPERATION", reason: "INVALID_REVIEW_STATE" });
  }
  if (state.phase !== "AWAITING_REVISION") {
    return Object.freeze({ kind: "INVALID_OPERATION", reason: "REVISION_NOT_EXPECTED" });
  }
  const parsed = parsePlanCandidate(candidateInput);
  if (!parsed.valid) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "INVALID_PLAN_CANDIDATE",
    });
  }
  if (
    parsed.candidate.projectId !== state.candidate.projectId ||
    parsed.candidate.bigTaskId !== state.candidate.bigTaskId
  ) {
    return Object.freeze({ kind: "INVALID_OPERATION", reason: "BIG_TASK_MISMATCH" });
  }
  if (parsed.candidate.revision !== state.candidate.revision + 1) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "INVALID_PLAN_REVISION",
    });
  }
  const nextAutomaticRevisionsUsed = state.automaticRevisionsUsed + 1;
  if (nextAutomaticRevisionsUsed !== 1 && nextAutomaticRevisionsUsed !== 2) {
    return Object.freeze({
      kind: "INVALID_OPERATION",
      reason: "INVALID_REVIEW_STATE",
    });
  }
  return Object.freeze({
    kind: "REVIEW_STATE",
    state: freezeState({
      phase: "AWAITING_REVIEW",
      candidate: parsed.candidate,
      candidateBinding: createPlanCandidateBinding(parsed.candidate),
      initialPlanRevision: state.initialPlanRevision,
      automaticRevisionsUsed: nextAutomaticRevisionsUsed,
    }),
  });
};
