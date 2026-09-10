import { describe, expect, it } from "vitest";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";

describe("Execution preparation and retry", () => {
  it("dispatches a six-task plan beyond 2 KB and retains its binding for graph changes", () => {
    const f = makeExecutionFixture(undefined, undefined, "STANDARD", { taskCount: 6 });
    try {
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
      expect(prepared.kind).toBe("ROLE_AUTHORIZED");
      if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
      const view = f.storage.getDurableWorkflowControlView(prepared.authorization.subtaskId)!;
      expect(Buffer.byteLength(view.candidateBinding)).toBeGreaterThan(2048);
      expect(view.currentStage).toBe("EXECUTE");
      const change = { operationId: "wop_large_plan_change", projectId: view.projectId, bigTaskId: view.bigTaskId,
        candidateBinding: view.candidateBinding, changeKind: "SPLIT_SUBTASK" as const };
      expect(f.storage.requestDurableMaterializedGraphChange(change).kind).toBe("HUMAN_REQUIRED");
      expect(() => f.storage.requestDurableMaterializedGraphChange({ ...change, candidateBinding: "中".repeat(349526) })).toThrow();
      expect(f.starts).toHaveLength(0);
    } finally { f.close(); }
  });

  it("retries a local preparation failure with unchanged approval, history and model-call count", () => {
    const f = makeExecutionFixture();
    try {
      f.execution.approve(f.approval); const original = f.execution.start(f.approval.bigTaskId).status;
      f.execution.recordControlFailure(f.approval.bigTaskId, { phase: "PREPARE_ROLE", failureCode: "INVALID_INPUT" });
      const stopped = f.execution.stop(f.approval.bigTaskId, "LOCAL_OPERATION_FAILED");
      expect(f.execution.canRetryPreparation(f.approval.bigTaskId)).toBe(true);
      const resumed = f.execution.start(f.approval.bigTaskId);
      expect(resumed.claimed).toBe(true);
      expect(resumed.status).toMatchObject({ phase: "RUNNING", limits: original.limits, planDigest: original.planDigest,
        expiresAt: original.expiresAt, knownTokens: 0, roleCalls: 0, lastControlFailure: stopped.lastControlFailure });
      expect(f.execution.start(f.approval.bigTaskId).claimed).toBe(false);
      expect(f.governed.prepareNextRole(f.approval.bigTaskId).kind).toBe("ROLE_AUTHORIZED");
      f.reopen();
      expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId).lastControlFailure).toEqual(stopped.lastControlFailure);
      expect(f.starts).toHaveLength(0);
    } finally { f.close(); }
  });

  it.each(["provider-phase", "active-role", "expired", "changed-repository"])("does not retry past %s", boundary => {
    let instant = Date.parse("2026-09-07T00:00:00.000Z");
    const f = makeExecutionFixture(() => new Date(instant++));
    try {
      f.execution.approve(f.approval); const original = f.execution.start(f.approval.bigTaskId).status;
      if (boundary === "active-role") {
        const role = f.governed.prepareNextRole(f.approval.bigTaskId);
        if (role.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
        getGovernedProviderBridge(f.governed).reserveRoleExecutionAttempt(role.authorization.authorizationId);
      }
      f.execution.recordControlFailure(f.approval.bigTaskId, { phase: boundary === "provider-phase" ? "EXECUTE_ROLE" : "PREPARE_ROLE", failureCode: "INVALID_INPUT" });
      f.execution.stop(f.approval.bigTaskId, "LOCAL_OPERATION_FAILED");
      if (boundary === "expired") instant = Date.parse(original.expiresAt!) + 1;
      if (boundary === "changed-repository") f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Changed baseline"]);
      expect(() => f.execution.start(f.approval.bigTaskId)).toThrow();
      expect(f.execution.inspect(f.approval.bigTaskId).phase).toBe("HUMAN_REQUIRED");
      expect(f.starts).toHaveLength(0);
    } finally { f.close(); }
  });
});
