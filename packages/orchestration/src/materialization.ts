import type {
  GraphValidationResult,
  MaterializationResult,
  PlanReviewState,
} from "./contracts.js";
import {
  parseMaterializedGraph,
  validatePlanCandidateGraph,
} from "./graph.js";
import { parsePlanReviewState } from "./plan-review.js";

export const materializeApprovedPlan = (
  reviewStateInput: Readonly<PlanReviewState>,
): MaterializationResult => {
  const reviewState = parsePlanReviewState(reviewStateInput);
  if (reviewState === null || reviewState.phase !== "APPROVED") {
    return Object.freeze({ kind: "HUMAN_REQUIRED", reason: "AUTHORITY_BLOCKED" });
  }

  const validation = validatePlanCandidateGraph(reviewState.candidate);
  if (!validation.valid) {
    return Object.freeze({ kind: "GRAPH_INVALID", validation });
  }

  const graph = parseMaterializedGraph({
    kind: "MATERIALIZED_GRAPH",
    projectId: validation.candidate.projectId,
    bigTaskId: validation.candidate.bigTaskId,
    planRevision: validation.candidate.revision,
    subtasks: validation.candidate.subtasks,
    dependencies: validation.dependencies,
  });
  if (graph === null) {
    const validationFailure: Extract<GraphValidationResult, { readonly valid: false }> = {
      valid: false,
      errors: Object.freeze([
        Object.freeze({
          code: "INVALID_PLAN_CANDIDATE",
          subtaskIds: Object.freeze([]),
        }),
      ]),
    };
    return Object.freeze({
      kind: "GRAPH_INVALID",
      validation: validationFailure,
    });
  }
  return Object.freeze({ kind: "MATERIALIZED", graph });
};
