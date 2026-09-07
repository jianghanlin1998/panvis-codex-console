import { describe, expect, it } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";

const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider entry point"); };

describe("continuous execution budget and pause boundaries", () => {
  it.each(["ROLE", "TOKEN", "UNKNOWN"] as const)("stops on %s without replaying a provider call", async boundary => {
    const f = makeExecutionFixture(undefined, () => boundary === "UNKNOWN" ? "missing-usage" : undefined);
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, f.execute, forbidden, f.governed);
    try {
      await service.approveExecution!({ ...f.approval, limits: { ...f.approval.limits,
        ...(boundary === "ROLE" ? { roleCallLimit: 1 } : boundary === "TOKEN" ? { totalTokenLimit: 18 } : {}),
      } });
      await service.startExecution!(f.approval.bigTaskId);
      let state = await service.inspectExecution!(f.approval.bigTaskId);
      while (state.phase === "RUNNING") {
        await new Promise<void>(resolve => setImmediate(resolve));
        state = await service.inspectExecution!(f.approval.bigTaskId);
      }
      expect(state).toMatchObject({ phase: "HUMAN_REQUIRED", roleCalls: 1,
        stopReason: boundary === "ROLE" ? "ROLE_LIMIT_REACHED" : boundary === "TOKEN" ? "TOKEN_LIMIT_REACHED" : "USAGE_UNKNOWN",
        usageComplete: boundary !== "UNKNOWN", unknownCompletedUsage: boundary === "UNKNOWN",
      });
      await expect(service.startExecution!(state.bigTaskId)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
      expect(f.starts).toHaveLength(1);
      expect(f.git(["rev-parse", "HEAD"]).toString().trim()).toBe(f.approval.repositoryHeadSha);
      expect(f.git(["status", "--porcelain"]).toString()).toBe("");
    } finally { await service.stopAndDrain!(); f.close(); }
  }, 20_000);

  it("pauses after a completed role and resumes at the next role without losing the budget", async () => {
    const f = makeExecutionFixture();
    const execute: typeof f.execute = async (...args) => {
      const result = await f.execute(...args);
      if (f.starts.length === 1) await service.pauseExecution!(f.approval.bigTaskId);
      return result;
    };
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, execute, forbidden, f.governed);
    try {
      await service.approveExecution!(f.approval);
      const started = await service.startExecution!(f.approval.bigTaskId);
      let state = await service.inspectExecution!(f.approval.bigTaskId);
      while (state.phase === "RUNNING") {
        await new Promise<void>(resolve => setImmediate(resolve));
        state = await service.inspectExecution!(f.approval.bigTaskId);
      }
      expect(state).toMatchObject({ phase: "PAUSED", knownTokens: 18, roleCalls: 1, activeRoleCount: 0 });
      // Let the stopped worker release its in-memory claim before resuming.
      await new Promise<void>(resolve => setImmediate(resolve));
      await service.startExecution!(state.bigTaskId);
      state = await service.inspectExecution!(state.bigTaskId);
      while (state.phase === "RUNNING") {
        await new Promise<void>(resolve => setImmediate(resolve));
        state = await service.inspectExecution!(state.bigTaskId);
      }
      expect(state).toMatchObject({ phase: "AWAITING_ACCEPTANCE", roleCalls: 6, knownTokens: 108, expiresAt: started.expiresAt });
      expect(new Set(f.starts).size).toBe(6);
    } finally { await service.stopAndDrain!(); f.close(); }
  }, 45_000);
});
