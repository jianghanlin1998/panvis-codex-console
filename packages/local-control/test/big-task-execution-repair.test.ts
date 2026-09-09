import { describe, expect, it } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";

const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider entry point"); };

describe("approved repair and re-QA limits", () => {
  it.each([[false, "two-blockers"], [true, "two-blockers"], [false, "sixteen-blockers"]] as const)("allows exactly two repair cycles, final failure=%s, findings=%s", async (finalFailure, findings) => {
    const f = makeExecutionFixture(undefined, (role, occurrence) =>
      role === "FRESH_QA" && occurrence === 1 || role === "FOCUSED_RE_QA" && (occurrence === 1 || finalFailure)
        ? findings : undefined);
    let progress = (): void => {};
    const execute: typeof f.execute = async (...args) => { try { return await f.execute(...args); } finally { progress(); } };
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, execute, forbidden, f.governed);
    let observing = true;
    try {
      await service.approveExecution!({ ...f.approval, limits: { ...f.approval.limits, repairCycleLimit: 2 } });
      // Inspect after role completion, not on every event-loop turn while Git or
      // the mock provider is running. Keep the final state and exact role checks.
      const completion = new Promise<Awaited<ReturnType<NonNullable<typeof service.inspectExecution>>>>((resolve, reject) => {
        progress = () => { setImmediate(() => setImmediate(() => {
          if (!observing) return;
          void service.inspectExecution!(f.approval.bigTaskId).then(state => {
            if (state.phase !== "RUNNING") { observing = false; resolve(state); }
          }, reject);
        })); };
      });
      await service.startExecution!(f.approval.bigTaskId);
      progress();
      const state = await completion;
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
    } finally { observing = false; await service.stopAndDrain!(); f.close(); }
  }, 60_000);
});
