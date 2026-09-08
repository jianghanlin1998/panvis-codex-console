import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { BigTaskExecutionStatusSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { BigTaskExecutionStore } from "../../storage/src/big-task-execution.js";
import { getGovernedProviderBridge } from "../../storage/src/governed-execution-public.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../src/state.js";

it.each([false, true])("renews after an earlier renewal and acknowledged QA, then resumes the expired HARDEN (new unknown=%s)", async newUnknown => {
  let instant = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(instant++), (role, n) => role === "EXECUTE" && n === 1 ? "budget-exceeded"
    : role === "HARDEN" && n === 2 ? "wrong-fields"
    : role === "FRESH_QA" ? n === 1 || newUnknown && n === 3 ? "missing-usage" : "read-command" : undefined);
  const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider path"); };
  const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, f.execute, forbidden, f.governed);
  const token = "a".repeat(64), http = createLocalControlHttpServer(service, token);
  const run = async (expected: string) => {
    const next = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (next.kind !== "ROLE_AUTHORIZED") throw new Error(`Expected ${expected}: ${next.kind}`);
    expect(next.authorization.role).toBe(expected);
    return f.execute(f.governed, next.authorization.authorizationId);
  };
  try {
    f.execution.approve(f.approval); const original = f.execution.start(f.approval.bigTaskId).status;
    expect((await run("EXECUTE")).success).toBe(false);
    f.execution.stop(f.approval.bigTaskId, "TOKEN_LIMIT_REACHED");
    f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
    instant = Date.parse(original.expiresAt!) + 1;
    const firstRequest = { bigTaskId: f.approval.bigTaskId, planDigest: f.approval.planDigest,
      previousExpiresAt: original.expiresAt, durationMilliseconds: 10_800_000 };
    const firstWindow = f.execution.renewWindow(firstRequest);
    f.execution.start(f.approval.bigTaskId);
    expect((await run("EXECUTE")).success).toBe(true);
    expect((await run("HARDEN")).success).toBe(true);
    expect((await run("FRESH_QA")).success).toBe(false);
    f.execution.stop(f.approval.bigTaskId, "USAGE_UNKNOWN");
    const qaRequest = f.governed.reviewQaExecutionRecovery(f.approval.bigTaskId).request;
    const originalUnknown = f.storage.getExecutionRunById(qaRequest.failedExecutionRunId);
    f.governed.recoverQaExecution(qaRequest);
    f.execution.start(f.approval.bigTaskId);
    expect((await run("FRESH_QA")).success).toBe(true);
    expect((await run("EXECUTE")).success).toBe(true);
    const failed = await run("HARDEN"); expect(failed.success).toBe(false);
    const failedRun = f.storage.getExecutionRunById(failed.executionRunId!);
    const oldExpiry = f.execution.inspect(f.approval.bigTaskId).expiresAt!;
    instant = Date.parse(oldExpiry);
    const stopped = f.execution.stop(f.approval.bigTaskId, "TIME_LIMIT_REACHED");
    expect(stopped).toMatchObject({ roleCalls: 7, knownTokens: 143764, totalBudgetMode: "WARNING_ONLY",
      unknownCompletedUsage: true, unacknowledgedUnknownUsage: false, activeRoleCount: 0 });
    expect(() => f.execution.start(f.approval.bigTaskId)).toThrow();
    expect(() => f.governed.reviewExecutionRecovery(f.approval.bigTaskId)).toThrow();

    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port; http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.root, "operator")); ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"a".repeat(32)}`, pid: 79, port,
      startedAt: "2026-09-07T00:00:00.000Z", sessionToken: token });
    const call = (args: string[]) => runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5000);
    const renewal = { ...firstRequest, previousExpiresAt: oldExpiry, durationMilliseconds: 5_400_000 };
    const file = join(f.root, "window.json"); writeFileSync(file, JSON.stringify(renewal), "utf8");
    for (const patch of [{ planDigest: "f".repeat(64) }, { previousExpiresAt: original.startedAt }, { totalTokenLimit: 9000000 }])
      expect(() => f.execution.renewWindow({ ...renewal, ...patch })).toThrow();
    const response = await call(["execution-renew-window", file]); expect(response.succeeded).toBe(true);
    const renewed = BigTaskExecutionStatusSchema.parse(response.body);
    expect(renewed).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "TIME_LIMIT_REACHED", knownTokens: stopped.knownTokens,
      roleCalls: 7, limits: stopped.limits, qaRecovery: stopped.qaRecovery, recovery: stopped.recovery,
      windowRenewal: firstWindow.windowRenewal, totalBudgetMode: "WARNING_ONLY",
      additionalWindowRenewals: [{ previousExpiresAt: oldExpiry, durationMilliseconds: 5_400_000 }] });
    expect(Date.parse(renewed.expiresAt!) - Date.parse(renewed.additionalWindowRenewals![0]!.renewedAt)).toBe(5_400_000);
    expect((await call(["execution-renew-window", file])).body).toEqual(response.body);
    expect(() => f.execution.start(f.approval.bigTaskId)).toThrow(); // A time amendment does not accept the failed role.
    expect(f.starts).toHaveLength(7);
    const recovery = f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request;
    expect(recovery.failedExecutionRunId).toBe(failed.executionRunId);
    f.governed.recoverExecution(recovery);
    f.execution.start(f.approval.bigTaskId);
    const next = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected retained HARDEN");
    expect(next.authorization).toMatchObject({ role: "HARDEN", repairCyclesUsed: 0 });
    expect(getGovernedProviderBridge(f.governed).approvedRoleBounds(next.authorization.authorizationId)?.remainingTokens).toBeNull();
    expect((await f.execute(f.governed, next.authorization.authorizationId)).success).toBe(true);
    expect((await run("FRESH_QA")).success).toBe(!newUnknown);
    if (newUnknown) f.execution.stop(f.approval.bigTaskId, "USAGE_UNKNOWN");
    else { f.governed.prepareNextRole(f.approval.bigTaskId); f.execution.deliver(f.approval.bigTaskId); }
    const result = f.execution.inspect(f.approval.bigTaskId);
    expect(result).toMatchObject({ phase: newUnknown ? "HUMAN_REQUIRED" : "AWAITING_ACCEPTANCE", roleCalls: 9,
      knownTokens: newUnknown ? 143782 : 143800, expiresAt: renewed.expiresAt, limits: stopped.limits,
      unknownCompletedUsage: true, unacknowledgedUnknownUsage: newUnknown, totalBudgetMode: "WARNING_ONLY" });
    expect(f.storage.getExecutionRunById(qaRequest.failedExecutionRunId)).toEqual(originalUnknown);
    expect(f.storage.getExecutionRunById(failed.executionRunId!)).toEqual(failedRun);
    expect(new Set(f.starts).size).toBe(9);
    expect(result.integratedSubtaskIds).toHaveLength(newUnknown ? 1 : 2);
    if (newUnknown) {
      instant = Date.parse(renewed.expiresAt!) + 1;
      expect(() => f.execution.renewWindow({ ...renewal, previousExpiresAt: renewed.expiresAt })).toThrow();
    }
    expect(BigTaskExecutionStatusSchema.safeParse({ ...result, additionalWindowRenewals: [
      { ...renewed.additionalWindowRenewals![0], previousExpiresAt: original.expiresAt },
    ] }).success).toBe(false);
    await service.stopAndDrain!(); f.reopen();
    expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(result);
  } finally { await service.stopAndDrain!(); await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); }); f.close(); }
}, 90_000);
