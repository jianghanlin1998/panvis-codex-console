import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { BigTaskQaRecoveryReviewSchema, BigTaskExecutionStatusSchema, GovernedExecutionFailureCodeSchema, BigTaskRoleFailureSchema, BigTaskControlFailureSchema } from "@codex-task-console/domain";
import { TaskStorageError } from "@codex-task-console/storage";
import { GOVERNED_ROLE_CODEX_EXECUTION_FAILURE_CODES } from "@codex-task-console/codex-adapter";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { getGovernedProviderBridge } from "../../storage/src/governed-execution-public.js";
import { BigTaskExecutionStore } from "../../storage/src/big-task-execution.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../src/state.js";

it("keeps the durable diagnostic allowlist equal to every adapter failure code", () => {
  expect([...GovernedExecutionFailureCodeSchema.options].sort()).toEqual([...GOVERNED_ROLE_CODEX_EXECUTION_FAILURE_CODES].sort());
  expect(BigTaskControlFailureSchema.safeParse({ phase: "PREPARE_ROLE", failureCode: "CONFLICT", message: "private text" }).success).toBe(false);
  expect(GovernedExecutionFailureCodeSchema.safeParse("arbitrary provider error").success).toBe(false);
});

it.each([true, false])("records safe local failure stage without exception text (classified=%s)", async classified => {
  const f = makeExecutionFixture();
  const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider path"); };
  const bridge = getGovernedProviderBridge(f.governed);
  bridge.prepareNextRole = () => { throw classified ? new TaskStorageError("CONFLICT", "private diagnostic") : new Error("private diagnostic"); };
  const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, f.execute, forbidden, f.governed);
  try {
    f.execution.approve(f.approval);
    await service.startExecution!(f.approval.bigTaskId);
    await new Promise<void>(resolve => setImmediate(resolve));
    const state = await service.inspectExecution!(f.approval.bigTaskId);
    expect(state).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "LOCAL_OPERATION_FAILED", roleCalls: 0,
      lastControlFailure: { phase: "PREPARE_ROLE", failureCode: classified ? "CONFLICT" : "UNCLASSIFIED" } });
    expect(JSON.stringify(state)).not.toContain("private diagnostic");
    expect(f.starts).toHaveLength(0);
    await service.stopAndDrain!(); f.reopen();
    expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(state);
  } finally { await service.stopAndDrain!(); f.close(); }
});

it.each([false, true])("recovers one unknown QA through the operator without erasing history (later unknown=%s)", async laterUnknown => {
  let instant = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(instant++), (role, n) => role === "EXECUTE" && n === 1 ? "budget-exceeded"
    : role === "FRESH_QA" ? n === 1 || laterUnknown && n === 3 ? "missing-usage" : "read-command" : undefined);
  f.approval.limits.totalTokenLimit = 480_000;
  const forbidden = async (): Promise<never> => { throw new Error("No other provider path"); };
  let report = () => {}, observing = true;
  const execute = async (...args: Parameters<typeof f.execute>) => { try { return await f.execute(...args); } finally { report(); } };
  const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, execute, forbidden, f.governed);
  const token = "e".repeat(64), http = createLocalControlHttpServer(service, token);
  const completed = () => new Promise<Awaited<ReturnType<NonNullable<typeof service.inspectExecution>>>>((resolve, reject) => {
    report = () => setImmediate(() => setImmediate(() => {
      if (!observing) return;
      void service.inspectExecution!(f.approval.bigTaskId).then(state => { if (state.phase !== "RUNNING") resolve(state); }, reject);
    }));
  });
  try {
    f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, repairCycleLimit: 2 } });
    const original = f.execution.start(f.approval.bigTaskId).status;
    const first = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
    await f.execute(f.governed, first.authorization.authorizationId);
    f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
    f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
    const stopped = completed(); await service.startExecution!(f.approval.bigTaskId); report();
    const failed = await stopped;
    expect(failed).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "USAGE_UNKNOWN", knownTokens: 143710, roleCalls: 4,
      lastRoleFailure: { phase: "RESULT", appServerChildCleaned: true, transientRuntimeCleaned: true } });
    expect(failed.lastRoleFailure?.failureCode).toBeDefined();
    expect(failed.lastRoleFailure?.diagnostics.turnStartRequests).toBe(1);
    expect(BigTaskRoleFailureSchema.safeParse({ ...failed.lastRoleFailure, rawError: "private text" }).success).toBe(false);
    const failedId = failed.lastRoleFailure!.authorizationId;
    const failedAuth = f.governed.getRoleAuthorization(failedId)!;
    const failedRun = getGovernedProviderBridge(f.governed).reserveRoleExecutionAttempt;
    expect(() => failedRun.call(getGovernedProviderBridge(f.governed), failedId)).toThrow();
    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port; http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.root, "operator")); ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"e".repeat(32)}`, pid: 77, port, startedAt: "2026-09-07T00:00:00.000Z", sessionToken: token });
    const call = (args: string[]) => runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5000);
    instant = Date.parse(original.expiresAt!) + 1;
    const view = await call(["execution-qa-recovery-review", f.approval.bigTaskId]);
    expect(view.succeeded).toBe(true);
    const { request } = BigTaskQaRecoveryReviewSchema.parse(view.body);
    const oldRun = f.storage.getExecutionRunById(request.failedExecutionRunId);
    const file = join(f.root, "qa-recovery.json");
    for (const patch of [{ acknowledgeUnknownUsage: false }, { knownTokenLimit: 2_000_001 }, { durationMilliseconds: 10_800_001 }, { acknowledgedKnownTokens: 0 }, { previousExpiresAt: "2026-09-07T00:00:00.000Z" }]) {
      writeFileSync(file, JSON.stringify({ ...request, ...patch }), "utf8");
      let rejected = false;
      try { rejected = !(await call(["execution-recover-qa", file])).succeeded; } catch { rejected = true; }
      expect(rejected).toBe(true);
    }
    writeFileSync(file, JSON.stringify(request), "utf8");
    const path = f.manager.resolveActiveOwnedWorktreeForSubtask(failedAuth.subtaskId).ownership.worktreePath;
    const drift = join(path, "qa-drift.txt"); writeFileSync(drift, "unreviewed", "utf8");
    expect((await call(["execution-recover-qa", file])).succeeded).toBe(false); unlinkSync(drift);
    const recovered = await call(["execution-recover-qa", file]);
    expect(recovered.succeeded).toBe(true);
    const state = BigTaskExecutionStatusSchema.parse(recovered.body);
    expect(state).toMatchObject({ phase: "PAUSED", startedAt: original.startedAt, knownTokens: 143710, roleCalls: 4,
      usageComplete: false, unknownCompletedUsage: true, unacknowledgedUnknownUsage: false, limits: { totalTokenLimit: 2_000_000, repairCycleLimit: 2 },
      qaRecovery: { failedAuthorizationId: failedId, acknowledgeUnknownUsage: true } });
    expect(Date.parse(state.expiresAt!) - Date.parse(state.qaRecovery!.authorizedAt)).toBe(10_800_000);
    expect((await call(["execution-recover-qa", file])).body).toEqual(recovered.body);
    const nextDone = completed(); expect((await call(["execution-start", f.approval.bigTaskId])).body.phase).toBe("RUNNING"); report();
    const result = await nextDone;
    expect(result, JSON.stringify({ result, outcomes: f.outcomes, decisions: f.decisions })).toMatchObject({ phase: laterUnknown ? "HUMAN_REQUIRED" : "AWAITING_ACCEPTANCE", roleCalls: 8, usageComplete: false,
      unknownCompletedUsage: true, unacknowledgedUnknownUsage: laterUnknown, expiresAt: state.expiresAt });
    expect(result.integratedSubtaskIds).toHaveLength(laterUnknown ? 1 : 2);
    const budgets = await call(["governed-status", f.approval.bigTaskId]);
    expect(budgets.succeeded).toBe(true);
    if (!laterUnknown) {
      expect(budgets.body.budgets).toContainEqual({ scope: "BIG_TASK", status: "AVAILABLE", allowed: true,
        totalTokens: 143782, subtaskKnownTokens: 54, warning: false, extensionApplied: false, effectiveLimitTokens: 2_000_000 });
    }
    expect(f.storage.getExecutionRunById(request.failedExecutionRunId)).toEqual(oldRun);
    expect(new Set(f.starts).size).toBe(8);
    expect((await call(["execution-recover-qa", file])).succeeded).toBe(true);
    if (laterUnknown) {
      expect(result.stopReason).toBe("USAGE_UNKNOWN");
      expect((await call(["execution-qa-recovery-review", f.approval.bigTaskId])).succeeded).toBe(false);
      expect((await call(["execution-start", f.approval.bigTaskId])).succeeded).toBe(false);
    }
    expect(f.starts).toHaveLength(8);
    expect(f.git(["rev-parse", "HEAD"]).toString().trim()).toBe(f.approval.repositoryHeadSha);
    await service.stopAndDrain!(); f.reopen();
    expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(result);
  } finally {
    observing = false; await service.stopAndDrain!();
    await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); }); f.close();
  }
}, 90_000);
