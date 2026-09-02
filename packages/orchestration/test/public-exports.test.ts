import { describe, expect, it } from "vitest";

import * as orchestration from "../src/index.js";

describe("orchestration package public exports", () => {
  it("exposes the bounded deterministic kernel surface", () => {
    expect(orchestration.WORKFLOW_PROFILES).toEqual([
      "LOW",
      "STANDARD",
      "HIGH_RISK_FOUNDATION",
    ]);
    for (const publicOperation of [
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
    ]) {
      expect(orchestration).toHaveProperty(publicOperation);
      expect(orchestration[publicOperation as keyof typeof orchestration]).toBeTypeOf("function");
    }
  });

  it("does not expose mutable parsers, test hooks, persistence, or generic dispatch", () => {
    for (const forbiddenExport of [
      "dispatch",
      "parseMaterializedGraph",
      "parsePlanCandidate",
      "parsePlanReviewState",
      "persistOrchestrationState",
      "spawnCodexRole",
      "writeTaskStorage",
    ]) {
      expect(orchestration).not.toHaveProperty(forbiddenExport);
    }
  });
});
