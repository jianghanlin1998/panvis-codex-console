import { expect, it } from "vitest";
import { BigTaskExecutionStatusSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";

it("renews an expired unused recovery once, preserving usage, files, original approval and all later deadlines", async () => {
  let instant = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(instant++), (role, n) => role === "EXECUTE" && n === 1 ? "budget-exceeded" : undefined);
  try {
    f.approval.limits.totalTokenLimit = 480_000;
    f.execution.approve(f.approval);
    const original = f.execution.start(f.approval.bigTaskId).status;
    const request = { bigTaskId: f.approval.bigTaskId, planDigest: f.approval.planDigest,
      previousExpiresAt: original.expiresAt, durationMilliseconds: 10_800_000 };
    expect(() => f.execution.renewWindow(request)).toThrow();
    const first = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Expected first role");
    const failed = await f.execute(f.governed, first.authorization.authorizationId);
    const failedRun = f.storage.getExecutionRunById(failed.executionRunId!);
    f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
    expect(() => f.execution.renewWindow(request)).toThrow();
    f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
    expect(() => f.execution.renewWindow(request)).toThrow(); // Original window still live.
    instant = Date.parse(original.expiresAt!) + 1;
    expect(() => f.execution.start(f.approval.bigTaskId)).toThrow();
    for (const patch of [{ planDigest: "f".repeat(64) }, { previousExpiresAt: original.startedAt },
      { durationMilliseconds: 10_800_001 }, { durationMilliseconds: 0 }, { durationMilliseconds: 0.5 }, { totalTokenLimit: 900_000 }])
      expect(() => f.execution.renewWindow({ ...request, ...patch })).toThrow();
    const renewed = f.execution.renewWindow(request);
    expect(renewed).toMatchObject({ phase: "PAUSED", startedAt: original.startedAt, knownTokens: 143674, roleCalls: 1,
      limits: original.limits, windowRenewal: { previousExpiresAt: original.expiresAt, durationMilliseconds: 10_800_000 } });
    expect(BigTaskExecutionStatusSchema.safeParse(renewed).success).toBe(true);
    expect(Date.parse(renewed.expiresAt!) - Date.parse(renewed.windowRenewal!.renewedAt)).toBe(10_800_000);
    instant += 1000;
    expect(f.execution.renewWindow(request)).toEqual(renewed);
    expect(() => f.execution.renewWindow({ ...request, durationMilliseconds: 1 })).toThrow();
    f.execution.start(f.approval.bigTaskId);
    const next = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected recovery role");
    const bounds = getGovernedProviderBridge(f.governed).approvedRoleBounds(next.authorization.authorizationId);
    expect(bounds?.remainingTokens).toBe(336326);
    expect(await f.execute(f.governed, next.authorization.authorizationId)).toMatchObject({ success: true });
    expect(f.storage.getExecutionRunById(failed.executionRunId!)).toEqual(failedRun);
    expect(f.governed.prepareNextRole(f.approval.bigTaskId)).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { role: "HARDEN", repairCyclesUsed: 0 } });
    f.execution.stop(f.approval.bigTaskId, "USER_PAUSED");
    f.reopen();
    const reopened = new BigTaskExecutionStore(f.storage);
    expect(reopened.inspect(f.approval.bigTaskId)).toMatchObject({ knownTokens: 143692, roleCalls: 2, expiresAt: renewed.expiresAt, windowRenewal: renewed.windowRenewal });
    instant = Date.parse(renewed.expiresAt!) + 1;
    expect(reopened.renewWindow(request).expiresAt).toBe(renewed.expiresAt);
    expect(() => reopened.renewWindow({ ...request, previousExpiresAt: renewed.expiresAt })).toThrow();
    expect(() => reopened.start(f.approval.bigTaskId)).toThrow();
    expect(f.starts).toHaveLength(2);
  } finally { f.close(); }
}, 30_000);

it("refuses to renew after the replacement has already run, even at a recovered checkpoint", async () => {
  let instant = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(instant++), (role, n) => role === "EXECUTE" && n === 1 ? "budget-exceeded" : undefined);
  try {
    f.approval.limits.totalTokenLimit = 480_000;
    f.execution.approve(f.approval);
    const original = f.execution.start(f.approval.bigTaskId).status;
    const first = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Expected first role");
    await f.execute(f.governed, first.authorization.authorizationId);
    f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
    f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
    f.execution.start(f.approval.bigTaskId);
    const next = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected recovery role");
    await f.execute(f.governed, next.authorization.authorizationId);
    f.execution.stop(f.approval.bigTaskId, "CHECKPOINT_RECOVERED");
    instant = Date.parse(original.expiresAt!) + 1;
    expect(() => f.execution.renewWindow({ bigTaskId: f.approval.bigTaskId, planDigest: f.approval.planDigest,
      previousExpiresAt: original.expiresAt, durationMilliseconds: 10_800_000 })).toThrow();
    expect(f.execution.inspect(f.approval.bigTaskId).windowRenewal).toBeUndefined();
  } finally { f.close(); }
}, 30_000);
