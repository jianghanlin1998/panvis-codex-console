import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BIG_TASK_ID, PROJECT_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

const [a, b] = SUBTASK_IDS;

describe("Step 8E integrated governed workflow boundaries", () => {
  it("completes HIGH_RISK repair and exact ACCEPTED-gated STANDARD with isolated role context", async () => {
    const f = new IntegratedOrchestrationFixture({ profiles: ["HIGH_RISK_FOUNDATION", "STANDARD"], dependency: true });
    try {
      for (const role of ["EXECUTE", "HARDEN", "FRESH_QA", "REPAIR", "FOCUSED_RE_QA"] as const) {
        expect(f.storage.evaluateStoredSubtaskDependencyReadiness(b!).ready).toBe(false);
        expect(f.worktrees.listWorktreeOwnershipHistoryForSubtask(b!)).toHaveLength(0);
        await f.runRole(a!, role, role === "FRESH_QA" ? { scenario: "two-blockers" } : {});
        if (role === "FRESH_QA") {
          expect(f.readRows("SELECT blocking FROM governed_findings ORDER BY ordinal").map(row => row.blocking)).toEqual([1, 1, 0]);
          expect(f.storage.getDurableWorkflowControlView(a!)).toMatchObject({ currentStage: "REPAIR", repairCyclesUsed: 1 });
        }
        f.reopen(); // includes fresh fail before repair and repair commit before focused QA
      }
      expect(f.storage.getDurableWorkflowControlView(a!)).toMatchObject({ currentStage: "COMPLETE", deliveryMaturity: "ACCEPTED", boardStatus: "DONE", repairCyclesUsed: 1 });
      expect(f.storage.evaluateStoredSubtaskDependencyReadiness(b!).ready).toBe(true);
      const input = Object.fromEntries(f.inputs.map(item => [item.role, item.payload]));
      expect(String(input.EXECUTE!.canonicalContext)).toContain(`Current contract canary ${a} revision 2`);
      expect(JSON.stringify(input.EXECUTE)).not.toContain("revision 1");
      expect(input.HARDEN).toMatchObject({ candidateSha: f.executions[0]!.after, writeEnabled: true });
      for (const role of ["FRESH_QA", "REPAIR", "FOCUSED_RE_QA"]) {
        expect(JSON.stringify(input[role])).not.toContain("EXECUTE_REASONING_CANARY");
        expect(JSON.stringify(input[role])).not.toContain("HARDEN_REASONING_CANARY");
      }
      expect(input.REPAIR!.boundedFindings).toHaveLength(2);
      expect(input.FOCUSED_RE_QA!.boundedFindings).toHaveLength(2);
      expect(JSON.stringify(input.FOCUSED_RE_QA)).not.toContain("REPAIR_REASONING_CANARY");
      expect(input.FOCUSED_RE_QA!.candidateSha).toBe(f.executions[3]!.after);
      expect(f.readRows("SELECT * FROM governed_finding_resolutions")).toHaveLength(2);
      await f.runRole(b!, "EXECUTE");
      await f.runRole(b!, "VERIFY");
      expect(String(f.inputs.at(-2)!.payload.canonicalContext)).not.toContain("EXECUTE_REASONING_CANARY");
      const before = f.counts();
      f.reopen();
      expect(f.governed.inspectBigTask(BIG_TASK_ID).status).toBe("IN_PROGRESS");
      expect(f.counts()).toEqual(before);
      expect(f.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("BIG_TASK_COMPLETE");
      expect(f.counts()).toMatchObject({ governed_role_authorizations: 7, governed_role_results: 7,
        governed_handoffs: 2, governed_big_task_completion_receipts: 1, execution_runs: 7 });
    } finally { f.close(); }
  }, 40_000);

  it("bootstraps LOW at EXECUTE without dispatch, provider, readiness, or ownership authority", async () => {
    const f = new IntegratedOrchestrationFixture({ profiles: ["LOW"] });
    try {
      expect(f.storage.getDurableWorkflowControlView(a!)).toMatchObject({ currentStage: "EXECUTE", boardStatus: "TODO" });
      expect(f.counts()).toMatchObject({ governed_dispatch_receipts: 0, execution_runs: 0 });
      await f.runRole(a!, "EXECUTE"); await f.runRole(a!, "VERIFY");
      expect(f.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("BIG_TASK_COMPLETE");
    } finally { f.close(); }
  }, 15_000);

  it("stops after one repair and failed focused re-QA, preserving the exact candidate", async () => {
    const f = new IntegratedOrchestrationFixture({ profiles: ["HIGH_RISK_FOUNDATION"] });
    try {
      for (const role of ["EXECUTE", "HARDEN", "FRESH_QA", "REPAIR", "FOCUSED_RE_QA"] as const) {
        await f.runRole(a!, role, role === "FRESH_QA" || role === "FOCUSED_RE_QA" ? { scenario: "two-blockers" } : {});
        f.reopen();
      }
      expect(f.storage.getDurableWorkflowControlView(a!)).toMatchObject({ repairCyclesUsed: 1,
        unresolvedHumanRequired: { reason: "REPAIR_REQA_EXHAUSTED" } });
      const before = f.counts();
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPAIR_REQA_EXHAUSTED" });
      expect(f.counts()).toEqual(before);
      expect(f.worktrees.resolveActiveOwnedWorktreeForSubtask(a!).currentHeadSha).toBe(f.executions[3]!.after);
      expect(before.governed_handoffs).toBe(0);
    } finally { f.close(); }
  }, 30_000);

  it("keeps provider failure outside the semantic repair allowance with no autonomous retry", async () => {
    const f = new IntegratedOrchestrationFixture({ profiles: ["HIGH_RISK_FOUNDATION"] });
    try {
      await f.runRole(a!, "EXECUTE", { scenario: "process-exit", success: false });
      f.reopen();
      const before = f.counts();
      expect(before).toMatchObject({ execution_runs: 1, governed_role_results: 0 });
      expect(f.storage.getDurableWorkflowControlView(a!)?.repairCyclesUsed).toBe(0);
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "BLOCKED", reason: "PROVIDER_ROLE_FAILED" });
      expect(f.counts()).toEqual(before);
    } finally { f.close(); }
  }, 15_000);

  it("requires exact manual authority for each Subtask and preserves a completed candidate under REPLAN_REQUIRED", async () => {
    const f = new IntegratedOrchestrationFixture({ profiles: ["STANDARD", "STANDARD"], manual: true });
    try {
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "MANUAL_START_REQUIRED" });
      const authority = f.governed.authorizeManualStart(a!);
      expect(f.governed.authorizeManualStart(a!)).toEqual(authority);
      await f.runRole(a!, "EXECUTE"); await f.runRole(a!, "VERIFY");
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "MANUAL_START_REQUIRED", subtaskId: b });
      const graph = f.storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!;
      f.storage.requestDurableMaterializedGraphChange({ operationId: "wop_integrated_replan", projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID, candidateBinding: graph.candidateBinding, changeKind: "ADD_SUBTASK" });
      f.reopen();
      const before = f.counts();
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPLAN_REQUIRED" });
      expect(f.storage.getCanonicalTaskMaterialization(BIG_TASK_ID)).toEqual(graph);
      expect(f.counts()).toEqual(before);
      expect(existsSync(f.repositoryPath)).toBe(true);
    } finally { f.close(); }
  }, 20_000);
});
