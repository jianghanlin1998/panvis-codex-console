import { describe, expect, it } from "vitest";
import { BIG_TASK_ID, IntegratedOrchestrationFixture, planner } from "./integrated-orchestration-fixture.js";

describe("Step 8E integrated planning hard stops", () => {
  it.each(["EXHAUST", "ESCALATE"] as const)("preserves %s after reopen and cannot dispatch or materialize", mode => {
    const f = new IntegratedOrchestrationFixture({ planning: false });
    try {
      for (let revision = 1; revision <= (mode === "EXHAUST" ? 3 : 1); revision++) {
        const produced = planner(revision);
        if (revision === 1) f.storage.beginDurablePlanningBundle(produced.candidate, produced.contracts);
        else f.storage.submitDurablePlannerRevisionBundle(produced.candidate, produced.contracts);
        const bundle = f.storage.getDurablePlanningReviewBundle(BIG_TASK_ID)!;
        f.storage.recordDurableReviewerDecision(BIG_TASK_ID, { planRevision: revision, candidateBinding: bundle.candidateBinding,
          ...(mode === "EXHAUST" ? { outcome: "REJECT", revisionRequirements: ["Provide independent verification evidence."] } : { outcome: "ESCALATE" }) });
        f.reopen();
      }
      expect(f.storage.getDurablePlanningSnapshot(BIG_TASK_ID)!.reviewState).toMatchObject({ phase: "HUMAN_REQUIRED",
        humanReason: mode === "EXHAUST" ? "PLAN_REVIEW_EXHAUSTED" : "REVIEW_ESCALATED" });
      const before = f.counts();
      const next = planner(mode === "EXHAUST" ? 4 : 2);
      expect(() => f.storage.submitDurablePlannerRevisionBundle(next.candidate, next.contracts)).toThrow();
      expect(() => f.storage.materializeDurablePlan(BIG_TASK_ID)).toThrow();
      expect(f.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("BLOCKED");
      expect(f.counts()).toEqual(before);
      expect(before).toMatchObject({ canonical_task_materializations: 0, subtask_workflow_instances: 0,
        governed_dispatch_receipts: 0, execution_runs: 0 });
    } finally { f.close(); }
  });
});

it("rejects stale/wrong Reviewer binding and mismatched Task Contracts atomically", () => {
  const f = new IntegratedOrchestrationFixture({ planning: false });
  try {
    const v1 = planner(1);
    f.storage.beginDurablePlanningBundle(v1.candidate, v1.contracts);
    const bundle = f.storage.getDurablePlanningReviewBundle(BIG_TASK_ID)!;
    const initial = f.counts();
    expect(() => f.storage.recordDurableReviewerDecision(BIG_TASK_ID, { outcome: "APPROVE", planRevision: 1,
      candidateBinding: `wrong-${bundle.candidateBinding}` })).toThrow();
    expect(() => f.storage.materializeDurablePlan(BIG_TASK_ID)).toThrow();
    expect(f.counts()).toEqual(initial);
    f.storage.recordDurableReviewerDecision(BIG_TASK_ID, { outcome: "REJECT", planRevision: 1,
      candidateBinding: bundle.candidateBinding, revisionRequirements: ["Require exact verified Task Contracts."] });
    const rejected = f.counts();
    const v2 = planner(2);
    expect(() => f.storage.submitDurablePlannerRevisionBundle(v2.candidate, v1.contracts)).toThrow();
    expect(f.counts()).toEqual(rejected);
    f.storage.submitDurablePlannerRevisionBundle(v2.candidate, v2.contracts);
    expect(() => f.storage.recordDurableReviewerDecision(BIG_TASK_ID, { outcome: "APPROVE", planRevision: 1,
      candidateBinding: bundle.candidateBinding })).toThrow();
    f.reopen();
    expect(f.storage.getDurablePlanningSnapshot(BIG_TASK_ID)!.candidateHistory).toHaveLength(2);
    expect(f.storage.getDurablePlanningReviewBundle(BIG_TASK_ID)!.taskContracts.map(contract => contract.taskContractRef))
      .toEqual(v2.contracts.map(contract => contract.taskContractRef));
    expect(f.counts()).toMatchObject({ orchestration_materializations: 0, canonical_task_materializations: 0,
      governed_dispatch_receipts: 0, execution_runs: 0 });
  } finally { f.close(); }
});
