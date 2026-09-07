import { getGovernedProviderBridge } from "../../storage/src/governed-execution-public.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { BigTaskExecutionStatusSchema } from "@codex-task-console/domain";

const forbidden = async (): Promise<never> => { throw new Error("No standalone or planning provider calls"); };

describe("human-approved continuous Big Task execution", () => {
  // Each case receives a private repository/database in the separately bounded
  // setup phase. Keep the six-role execution deadline and every assertion intact.
  const fixtures = new WeakMap<object, ReturnType<typeof makeExecutionFixture>>();
  beforeEach(context => { fixtures.set(context, makeExecutionFixture()); });
  afterEach(context => { fixtures.get(context)?.close(); });
  it("materializes only the confirmed plan and authorizes its first governed role", context => {
    const f = fixtures.get(context)!;
    f.execution.approve(f.approval);
    f.execution.start(f.approval.bigTaskId);
    const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
    expect(prepared).toMatchObject({ kind: "ROLE_AUTHORIZED" });
    if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected exact role authority");
    const bridge = getGovernedProviderBridge(f.governed);
    const attempt = bridge.reserveRoleExecutionAttempt(prepared.authorization.authorizationId);
    expect(bridge.claimRoleProviderExecution(prepared.authorization.authorizationId).attempt).toEqual(attempt);
  });
  it("requires exact human approval, executes dependencies from integrated commits and waits for final human acceptance", async context => {
    const f = fixtures.get(context)!;
    let reportProgress = (): void => {};
    let observing = true;
    const executeObserved = async (...args: Parameters<typeof f.execute>) => {
      try { return await f.execute(...args); }
      finally { reportProgress(); }
    };
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, executeObserved, forbidden, f.governed);
    try {
      await expect(service.startExecution!(f.approval.bigTaskId)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
      expect(f.starts).toHaveLength(0);
      expect(f.storage.listSubtasksByBigTask(f.approval.bigTaskId)).toHaveLength(0);
      await expect(service.approveExecution!({ ...f.approval, planDigest: "f".repeat(64) })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
      expect((await service.approveExecution!(f.approval)).phase).toBe("APPROVED");
      // Observe once per provider completion, after the coordinator's normal
      // setImmediate continuation, instead of hot-looping synchronous SQLite
      // reads while local child processes are trying to make progress.
      const completed = new Promise<Awaited<ReturnType<NonNullable<typeof service.inspectExecution>>>>((resolve, reject) => {
        reportProgress = () => {
          setImmediate(() => setImmediate(() => {
            if (!observing) return;
            void service.inspectExecution!(f.approval.bigTaskId).then(status => {
              if (status.phase !== "RUNNING") { observing = false; resolve(status); }
            }, error => { observing = false; reject(error); });
          }));
        };
      });
      const started = await service.startExecution!(f.approval.bigTaskId);
      expect(started.phase).toBe("RUNNING");
      await service.startExecution!(f.approval.bigTaskId);
      reportProgress();
      const status = await completed;
      expect(status, JSON.stringify({ status, starts: f.starts, outcomes: f.outcomes, decisions: f.decisions })).toMatchObject({ phase: "AWAITING_ACCEPTANCE", roleCalls: 6, usageComplete: true, pendingIntegration: null });
      expect(BigTaskExecutionStatusSchema.safeParse(status).success).toBe(true);
      expect(f.starts).toHaveLength(6);
      expect(new Set(f.starts).size).toBe(6);
      expect(status.integratedSubtaskIds).toHaveLength(2);
      const files = f.git(["ls-tree", "-r", "--name-only", status.resultHeadSha]).toString();
      expect(files.match(/candidate-gra_/gu)).toHaveLength(4);
      expect(f.git(["rev-parse", "HEAD"]).toString().trim()).toBe(f.approval.repositoryHeadSha);
      expect(f.git(["status", "--porcelain"]).toString()).toBe("");
      await expect(service.acceptExecution!(f.approval.bigTaskId, f.approval.repositoryHeadSha)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
      f.git(["checkout", status.resultRef.slice("refs/heads/".length)]);
      expect((await service.acceptExecution!(f.approval.bigTaskId, status.resultHeadSha)).phase).toBe("ACCEPTED");
      await service.startExecution!(f.approval.bigTaskId);
      expect(f.starts).toHaveLength(6);
    } finally { observing = false; await service.stopAndDrain!(); }
  }, 30_000);
});
