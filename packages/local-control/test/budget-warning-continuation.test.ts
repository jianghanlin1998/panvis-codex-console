import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { BigTaskExecutionRecoveryReviewSchema, BigTaskExecutionStatusSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { getGovernedProviderBridge } from "../../storage/src/governed-execution-public.js";
import { BigTaskExecutionStore } from "../../storage/src/big-task-execution.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../src/state.js";

it.each(["complete", "unknown", "expired"] as const)("resumes a retained HARDEN with explicitly approved token warnings (%s)", async mode => {
  let instant = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(instant++), (role, n) => role === "EXECUTE" && n === 1 || role === "HARDEN" ? "budget-exceeded"
    : role === "FRESH_QA" ? mode === "unknown" && n === 1 ? "missing-usage" : "read-command" : undefined);
  f.approval.limits.totalTokenLimit = 200_000;
  const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider path"); };
  let report = () => {}, observing = true;
  const bounds: Array<number | null | undefined> = [];
  const execute = async (...args: Parameters<typeof f.execute>) => {
    if (f.execution.inspect(f.approval.bigTaskId).totalBudgetMode === "WARNING_ONLY")
      bounds.push(getGovernedProviderBridge(f.governed).approvedRoleBounds(args[1])?.remainingTokens);
    try { return await f.execute(...args); } finally { report(); }
  };
  const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, execute, forbidden, f.governed);
  const token = "f".repeat(64), http = createLocalControlHttpServer(service, token);
  const completed = () => new Promise<Awaited<ReturnType<NonNullable<typeof service.inspectExecution>>>>((resolve, reject) => {
    report = () => setImmediate(() => setImmediate(() => {
      if (observing) void service.inspectExecution!(f.approval.bigTaskId).then(state => { if (state.phase !== "RUNNING") resolve(state); }, reject);
    }));
  });
  try {
    f.execution.approve(f.approval); const original = f.execution.start(f.approval.bigTaskId).status;
    const first = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Expected first role");
    await f.execute(f.governed, first.authorization.authorizationId);
    f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
    f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
    const stopped = completed(); await service.startExecution!(f.approval.bigTaskId); report();
    const failed = await stopped;
    expect(failed).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "TOKEN_LIMIT_REACHED", knownTokens: 287366, roleCalls: 3 });
    expect(failed.totalBudgetMode).toBeUndefined();
    const failedAuth = f.governed.getRoleAuthorization(failed.lastRoleFailure!.authorizationId)!;
    expect(failedAuth.role).toBe("HARDEN");
    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port; http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.root, "operator")); ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"f".repeat(32)}`, pid: 78, port, startedAt: "2026-09-07T00:00:00.000Z", sessionToken: token });
    const call = (args: string[]) => runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5000);
    const review = await call(["execution-recovery-review", f.approval.bigTaskId]);
    expect(review.succeeded).toBe(true);
    const { request } = BigTaskExecutionRecoveryReviewSchema.parse(review.body);
    expect(request).toMatchObject({ failedAuthorizationId: failedAuth.authorizationId, totalBudgetMode: "WARNING_ONLY" });
    expect(f.execution.inspect(f.approval.bigTaskId)).toEqual(failed);
    const oldRun = f.storage.getExecutionRunById(request.failedExecutionRunId);
    const { totalBudgetMode: _mode, ...withoutApproval } = request; void _mode;
    expect(() => f.governed.recoverExecution(withoutApproval)).toThrow();
    const worktree = f.manager.resolveActiveOwnedWorktreeForSubtask(failedAuth.subtaskId).ownership.worktreePath;
    const drift = join(worktree, "unreviewed.txt"); writeFileSync(drift, "changed", "utf8");
    expect(() => f.governed.recoverExecution(request)).toThrow(); unlinkSync(drift);
    const file = join(f.root, "continue-stage.json"); writeFileSync(file, JSON.stringify(request), "utf8");
    const recovery = await call(["execution-recover", file]); expect(recovery.succeeded).toBe(true);
    const paused = BigTaskExecutionStatusSchema.parse(recovery.body);
    expect(paused).toMatchObject({ phase: "PAUSED", knownTokens: 287366, roleCalls: 3, totalBudgetMode: "WARNING_ONLY",
      expiresAt: original.expiresAt, limits: failed.limits, recovery: failed.recovery });
    expect(paused.additionalRecoveries).toHaveLength(1);
    expect((await call(["execution-recover", file])).body).toEqual(recovery.body);
    expect(f.storage.getExecutionRunById(request.failedExecutionRunId)).toEqual(oldRun);
    if (mode === "expired") {
      instant = Date.parse(original.expiresAt!);
      expect(() => f.execution.start(f.approval.bigTaskId)).toThrow();
      expect(f.starts).toHaveLength(3); return;
    }
    const done = completed(); expect((await call(["execution-start", f.approval.bigTaskId])).succeeded).toBe(true); report();
    const result = await done;
    expect(result, JSON.stringify({result, outcomes:f.outcomes, decisions:f.decisions})).toMatchObject({
      phase: mode === "unknown" ? "HUMAN_REQUIRED" : "AWAITING_ACCEPTANCE", stopReason: mode === "unknown" ? "USAGE_UNKNOWN" : null,
      roleCalls: mode === "unknown" ? 5 : 8, knownTokens: mode === "unknown" ? 431040 : 574768,
      totalBudgetMode: "WARNING_ONLY", expiresAt: original.expiresAt, limits: failed.limits,
    });
    expect(result.integratedSubtaskIds).toHaveLength(mode === "unknown" ? 0 : 2);
    expect(bounds).toEqual(Array.from({ length: mode === "unknown" ? 2 : 5 }, () => null));
    expect(new Set(f.starts).size).toBe(f.starts.length);
    if (mode === "complete") {
      const status = await call(["governed-status", f.approval.bigTaskId]); expect(status.succeeded).toBe(true);
      expect(status.body.budgets).toHaveLength(2);
      for (const budget of status.body.budgets as Array<Record<string, unknown>>)
        expect(budget).toMatchObject({ allowed: true, scope: "BIG_TASK", totalTokens: 574768, totalBudgetMode: "WARNING_ONLY", warning: true, status: "AVAILABLE_WARNING", effectiveLimitTokens: 200_000 });
    }
    observing = false; await service.stopAndDrain!(); f.reopen();
    expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(result);
  } finally { observing = false; await service.stopAndDrain!(); await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); }); f.close(); }
}, 90_000);
