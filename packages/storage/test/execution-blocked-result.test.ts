import { describe, expect, it } from "vitest";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";
import { TaskStorageError } from "../src/errors.js";
import { BigTaskRoleFailureSchema } from "@codex-task-console/domain";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";

describe("Preserved blocked execution results", () => {
  it("reassesses a retained blocked implementation without overwriting its verdict or consuming QA", async () => {
    const f = makeExecutionFixture(undefined, (role, n) => role === "EXECUTE" && n === 1 ? "blocked-after-edit" : undefined, "STANDARD");
    try {
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const first = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Role required");
      const result = await f.execute(f.governed, first.authorization.authorizationId);
      expect(result.roleResult?.outcome).toBe("BLOCKED");
      const original = f.storage.getExecutionRunById(result.executionRunId!);
      f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
      const request = f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request;
      const recovered = f.governed.recoverExecution(request);
      expect(recovered).toMatchObject({ phase: "PAUSED", roleCalls: 1, knownTokens: 18, integratedSubtaskIds: [] });
      expect(f.governed.recoverExecution(request)).toEqual(recovered);
      f.execution.start(f.approval.bigTaskId);
      const next = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Recovery role required");
      expect(next.authorization).toMatchObject({role: "EXECUTE", repairCyclesUsed: 0, candidateSha: result.roleResult!.candidateSha});
      expect(next.authorization.authorizationId).not.toBe(first.authorization.authorizationId);
      const retry = await f.execute(f.governed, next.authorization.authorizationId);
      expect(retry).toMatchObject({success: true, roleResult: {outcome: "READY"}, reconciliation: {kind: "TRANSITION_RECORDED"}});
      expect(f.storage.getExecutionRunById(result.executionRunId!)).toEqual(original);
      expect(f.governed.prepareNextRole(f.approval.bigTaskId)).toMatchObject({kind: "ROLE_AUTHORIZED", authorization: {role: "FRESH_QA", repairCyclesUsed: 0}});
      f.execution.stop(f.approval.bigTaskId, "USER_PAUSED");
      f.reopen();
      expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId).integratedSubtaskIds).toEqual([]);
    } finally { f.close(); }
  }, 30000);

  it.each(["RESULT_CHECKPOINT_FAILED", "RESULT_USAGE_INVALID", "RESULT_SAVE_FAILED"])("retains safe %s diagnostics without raw exception text", async expected => {
    const f = makeExecutionFixture();
    try {
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const prepared=f.governed.prepareNextRole(f.approval.bigTaskId);
      if(prepared.kind!=="ROLE_AUTHORIZED") throw new Error("Role required");
      getGovernedProviderBridge(f.governed).persistSuccessfulRoleResult=()=>{throw new TaskStorageError("CONFLICT", "PRIVATE_ERROR_CANARY", expected==="RESULT_SAVE_FAILED"?[]:[expected]);};
      const result=await f.execute(f.governed,prepared.authorization.authorizationId);
      expect(result).toMatchObject({success:false,failureCode:expected,terminalTurnStatus:"completed"});
      expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR_CANARY");
      expect(BigTaskRoleFailureSchema.safeParse({authorizationId:prepared.authorization.authorizationId,failureCode:result.failureCode,phase:"RESULT",diagnostics:result.diagnostics,appServerChildCleaned:result.appServerChildCleaned,transientRuntimeCleaned:result.transientRuntimeCleaned}).success).toBe(true);
    } finally { f.close(); }
  },15000);
  it("saves edits and the blocker without marking the task accepted", async () => {
    const f = makeExecutionFixture(undefined, () => "blocked-after-edit", "STANDARD");
    try {
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
      expect(prepared.kind).toBe("ROLE_AUTHORIZED");
      if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Role required");
      const result = await f.execute(f.governed, prepared.authorization.authorizationId);
      expect(result).toMatchObject({ success: true, failureCode: null, roleResult: {outcome: "BLOCKED", summary: "Edits preserved; external verification remains unavailable."} });
      expect(f.governed.latestRoleSummary(f.approval.bigTaskId)).toMatchObject({outcome:"BLOCKED", summary:"Edits preserved; external verification remains unavailable."});
      expect(f.governed.prepareNextRole(f.approval.bigTaskId).kind).toBe("BLOCKED");
      expect(f.execution.inspect(f.approval.bigTaskId).integratedSubtaskIds).toEqual([]);
      expect(f.storage.getExecutionRunById(result.executionRunId!)?.normalizedUsage?.totalTokens).toBe(18);
    } finally { f.close(); }
  }, 15000);
});
