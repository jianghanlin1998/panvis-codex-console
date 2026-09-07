import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BigTaskExecutionRecoverySchema, BigTaskExecutionStatusSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";

async function stopped(clock?: () => Date) {
  const f = makeExecutionFixture(clock, (role, n) => role === "EXECUTE" && n === 1 ? "budget-exceeded" : undefined);
  f.approval.limits.totalTokenLimit = 480_000;
  f.execution.approve(f.approval); const original = f.execution.start(f.approval.bigTaskId).status;
  const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
  if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected first role");
  const result = await f.execute(f.governed, prepared.authorization.authorizationId);
  expect(result.success).toBe(false);
  f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
  return { f, original, prepared, result };
}

describe("explicit one-time Sol recovery", () => {
  it("preserves files, failed usage, deadline and QA stages while running a fresh model-bound attempt", async () => {
    const { f, original, prepared, result } = await stopped();
    try {
      const path = f.manager.resolveActiveOwnedWorktreeForSubtask(prepared.authorization.subtaskId).ownership.worktreePath;
      const partial = readFileSync(join(path, `candidate-${prepared.authorization.authorizationId}.txt`), "utf8");
      const before = f.storage.getExecutionRunById(result.executionRunId!);
      expect(before).toMatchObject({ status: "FAILED", normalizedUsage: { totalTokens: 143674 } });
      const review = f.governed.reviewExecutionRecovery(f.approval.bigTaskId);
      expect(BigTaskExecutionRecoverySchema.safeParse(review.request).success).toBe(true);
      const resumed = f.governed.recoverExecution(review.request);
      expect(resumed).toMatchObject({ phase: "PAUSED", knownTokens: 143674, roleCalls: 1, expiresAt: original.expiresAt,
        recovery: { model: "gpt-5.6-sol", reasoningEffort: "xhigh", subtaskBudgetMode: "WARNING_ONLY" } });
      expect(BigTaskExecutionStatusSchema.safeParse(resumed).success).toBe(true);
      expect(f.governed.recoverExecution(review.request)).toEqual(resumed);
      expect(readFileSync(join(path, `candidate-${prepared.authorization.authorizationId}.txt`), "utf8")).toBe(partial);
      f.execution.start(f.approval.bigTaskId);
      expect(() => getGovernedProviderBridge(f.governed).reserveRoleExecutionAttempt(prepared.authorization.authorizationId)).toThrow();
      const next = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected recovery role");
      expect(next.authorization.authorizationId).not.toBe(prepared.authorization.authorizationId);
      expect(next.authorization.role).toBe("EXECUTE");
      expect(next.budget).toMatchObject({ scope: "BIG_TASK", totalTokens: 143674, effectiveLimitTokens: 480000, allowed: true, warning: true });
      const second = await f.execute(f.governed, next.authorization.authorizationId);
      expect(second).toMatchObject({ success: true, model: { providerModelId: "gpt-5.6-sol" }, reconciliation: { kind: "TRANSITION_RECORDED" } });
      expect(f.storage.getExecutionRunById(result.executionRunId!)).toEqual(before);
      expect(f.execution.inspect(f.approval.bigTaskId)).toMatchObject({ knownTokens: 143692, roleCalls: 2, expiresAt: original.expiresAt });
      const hardening = f.governed.prepareNextRole(f.approval.bigTaskId);
      expect(hardening).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { role: "HARDEN", repairCyclesUsed: 0 } });
      expect(f.starts).toHaveLength(2);
      expect(() => f.governed.recoverExecution({ ...review.request, candidateDigest: "f".repeat(64) })).toThrow();
      f.execution.stop(f.approval.bigTaskId, "USER_PAUSED");
      f.reopen();
      const reopened = new BigTaskExecutionStore(f.storage);
      expect(reopened.inspect(f.approval.bigTaskId)).toMatchObject({ knownTokens: 143692, roleCalls: 2, expiresAt: original.expiresAt, recovery: { model: "gpt-5.6-sol" } });
    } finally { f.close(); }
  }, 30_000);

  it("rejects changed retained content, malformed requests and expired recovery without losing history", async () => {
    let now = Date.parse("2026-09-07T00:00:00.000Z");
    const { f, prepared, original } = await stopped(() => new Date(now++));
    try {
      const review = f.governed.reviewExecutionRecovery(f.approval.bigTaskId);
      for (const patch of [{ model: "gpt-6-astra" }, { reasoningEffort: "max" }, { totalTokenLimit: 900000 }, { failedExecutionRunId: "run_wrong" }])
        expect(() => f.governed.recoverExecution({ ...review.request, ...patch })).toThrow();
      const path = f.manager.resolveActiveOwnedWorktreeForSubtask(prepared.authorization.subtaskId).ownership.worktreePath;
      writeFileSync(join(path, `candidate-${prepared.authorization.authorizationId}.txt`), "changed since recovery review", "utf8");
      expect(() => f.governed.recoverExecution(review.request)).toThrow();
      now = Date.parse(original.expiresAt!);
      expect(() => f.governed.reviewExecutionRecovery(f.approval.bigTaskId)).toThrow();
      expect(f.execution.inspect(f.approval.bigTaskId)).toMatchObject({ phase: "HUMAN_REQUIRED", knownTokens: 143674, roleCalls: 1 });
      expect(f.execution.inspect(f.approval.bigTaskId).recovery).toBeUndefined();
    } finally { f.close(); }
  }, 30_000);

  it("rejects unknown usage and never treats an active or successful call as recoverable", async () => {
    const f = makeExecutionFixture(undefined, () => "missing-usage");
    try {
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      expect(() => f.governed.reviewExecutionRecovery(f.approval.bigTaskId)).toThrow();
      const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
      await f.execute(f.governed, prepared.authorization.authorizationId);
      f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
      expect(() => f.governed.reviewExecutionRecovery(f.approval.bigTaskId)).toThrow();
      expect(f.execution.inspect(f.approval.bigTaskId).recovery).toBeUndefined();
    } finally { f.close(); }
  }, 30_000);

  it("keeps recovery evidence append-only and rejects a forged recovery ordinal", async () => {
    const { f } = await stopped();
    let db: DatabaseSync | undefined;
    try {
      const request = f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request;
      f.governed.recoverExecution(request);
      db = new DatabaseSync(f.databasePath);
      expect(() => db!.exec("UPDATE governed_role_authorizations SET recovery_attempt=0 WHERE recovery_attempt=1")).toThrow();
      expect(() => db!.exec("DELETE FROM big_task_execution_events WHERE json_extract(payload,'$.kind')='RECOVERY'")).toThrow();
      expect(() => db!.exec("INSERT INTO governed_role_authorizations SELECT * FROM governed_role_authorizations WHERE recovery_attempt=1")).toThrow();
    } finally { db?.close(); f.close(); }
  }, 30_000);
  it("keeps the aggregate token ceiling active after removing the subtask stop", async () => {
    const f = makeExecutionFixture(undefined, (role, n) => role === "EXECUTE" && n === 1 ? "budget-exceeded" : undefined);
    try {
      f.approval.limits.totalTokenLimit = 143690;
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const first = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
      await f.execute(f.governed, first.authorization.authorizationId);
      f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
      f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
      f.execution.start(f.approval.bigTaskId);
      const next = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected recovery");
      expect(getGovernedProviderBridge(f.governed).approvedRoleBounds(next.authorization.authorizationId)?.remainingTokens).toBe(16);
      expect(await f.execute(f.governed, next.authorization.authorizationId)).toMatchObject({ success: false });
      f.execution.stop(f.approval.bigTaskId, "TOKEN_LIMIT_REACHED");
      expect(f.execution.inspect(f.approval.bigTaskId)).toMatchObject({ knownTokens: 143692, roleCalls: 2, phase: "HUMAN_REQUIRED", stopReason: "TOKEN_LIMIT_REACHED" });
      expect(() => f.execution.start(f.approval.bigTaskId)).toThrow();
      expect(() => f.governed.reviewExecutionRecovery(f.approval.bigTaskId)).toThrow();
    } finally { f.close(); }
  }, 30_000);

  it("rejects post-approval candidate deletion before a replacement provider call", async () => {
    const { f, prepared } = await stopped();
    try {
      const path = f.manager.resolveActiveOwnedWorktreeForSubtask(prepared.authorization.subtaskId).ownership.worktreePath;
      f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
      // Removing all partial work returns Git to clean, but violates the approved file digest.
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(path, `candidate-${prepared.authorization.authorizationId}.txt`));
      f.execution.start(f.approval.bigTaskId);
      const next = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected recovery");
      const bridge = getGovernedProviderBridge(f.governed);
      bridge.reserveRoleExecutionAttempt(next.authorization.authorizationId);
      expect(() => bridge.claimRoleProviderExecution(next.authorization.authorizationId)).toThrow();
      expect(f.starts).toHaveLength(1);
    } finally { f.close(); }
  }, 30_000);

  it("refuses a different returned model before starting a recovery turn", async () => {
    const f = makeExecutionFixture(undefined, (role, n) => role === "EXECUTE" ? n === 1 ? "budget-exceeded" : "wrong-model" : undefined);
    try {
      f.approval.limits.totalTokenLimit = 480000;
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const first = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
      const original = await f.execute(f.governed, first.authorization.authorizationId);
      expect(original.model?.providerModelId).toBe("fixture-governed-model");
      f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
      f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);
      f.execution.start(f.approval.bigTaskId);
      const next = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected recovery");
      const refused = await f.execute(f.governed, next.authorization.authorizationId);
      expect(refused).toMatchObject({ success: false, failureCode: "APP_SERVER_PROTOCOL_ERROR", diagnostics: { turnStartRequests: 0 }, roleResult: null });
      expect(f.starts).toHaveLength(2);
    } finally { f.close(); }
  }, 30_000);

});
