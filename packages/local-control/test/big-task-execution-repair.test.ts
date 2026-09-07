import { describe, expect, it } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";

const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider entry point"); };

describe("approved repair and re-QA limits", () => {
  it.each([[false, "two-blockers"], [true, "two-blockers"], [false, "sixteen-blockers"]] as const)("allows exactly two repair cycles, final failure=%s, findings=%s", async (finalFailure, findings) => {
    const f = makeExecutionFixture(undefined, (role, occurrence) =>
      role === "FRESH_QA" && occurrence === 1 || role === "FOCUSED_RE_QA" && (occurrence === 1 || finalFailure)
        ? findings : undefined);
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, f.execute, forbidden, f.governed);
    try {
      await service.approveExecution!({ ...f.approval, limits: { ...f.approval.limits, repairCycleLimit: 2 } });
      await service.startExecution!(f.approval.bigTaskId);
      let state = await service.inspectExecution!(f.approval.bigTaskId);
      while (state.phase === "RUNNING") {
        await new Promise<void>(resolve => setImmediate(resolve));
        state = await service.inspectExecution!(f.approval.bigTaskId);
      }
      expect(state, JSON.stringify({ state, outcomes: f.outcomes, decisions: f.decisions })).toMatchObject({
        phase: finalFailure ? "HUMAN_REQUIRED" : "AWAITING_ACCEPTANCE", roleCalls: finalFailure ? 7 : 10,
        usageComplete: true, knownTokens: (finalFailure ? 7 : 10) * 18,
      });
      const roles = f.starts.map(id => f.governed.getRoleAuthorization(id)!);
      expect(roles.filter(role => role.role === "REPAIR").map(role => role.repairCyclesUsed)).toEqual([1, 2]);
      expect(roles.filter(role => role.role === "FOCUSED_RE_QA").map(role => role.repairCyclesUsed)).toEqual([1, 2]);
      const view = f.storage.getDurableWorkflowControlView(roles[0]!.subtaskId)!;
      expect(view.repairCyclesUsed).toBe(2);
      expect(view.unresolvedHumanRequired?.reason ?? null).toBe(finalFailure ? "REPAIR_REQA_EXHAUSTED" : null);
      if (finalFailure) await expect(service.startExecution!(state.bigTaskId)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
      else expect(state.integratedSubtaskIds).toHaveLength(2);
      expect(f.starts).toHaveLength(finalFailure ? 7 : 10);
    } finally { await service.stopAndDrain!(); f.close(); }
  }, 60_000);
});
