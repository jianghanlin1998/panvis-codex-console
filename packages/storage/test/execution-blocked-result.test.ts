import { describe, expect, it } from "vitest";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";
import { TaskStorageError } from "../src/errors.js";
import { BigTaskRoleFailureSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";

describe("Preserved blocked execution results", () => {
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
