import { expect, it } from "vitest";
import { BIG_TASK_ID, PROJECT_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

it("keeps a blocked dependency and eligible sibling behind the active Project writer", async () => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["HIGH_RISK_FOUNDATION", "STANDARD", "STANDARD"], dependency: true });
  try {
    const siblingTask = f.seedIndependentProject(true);
    let observations = 0;
    await f.runRole(SUBTASK_IDS[0]!, "EXECUTE", { onTurn: () => {
      observations++;
      expect(f.storage.evaluateStoredSubtaskDependencyReadiness(SUBTASK_IDS[1]!).ready).toBe(false);
      expect(f.storage.evaluateStoredSubtaskDependencyReadiness(SUBTASK_IDS[2]!).ready).toBe(true);
      // The running provider has not reported usage yet; this earlier gate
      // pauses this graph. A separate ready Big Task in the same Project reaches
      // and must fail the serial-write gate independently of that unknown usage.
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "BLOCKED", reason: "BUDGET_BLOCKED", subtaskId: SUBTASK_IDS[0] });
      expect(f.governed.prepareNextRole(siblingTask.bigTaskId)).toMatchObject({ kind: "BLOCKED", reason: "CONCURRENCY_BLOCKED", subtaskId: siblingTask.subtaskId });
      expect(f.counts()).toMatchObject({ governed_dispatch_receipts: 1, execution_runs: 1 });
    } });
    expect(observations).toBe(1);
  } finally { f.close(); }
}, 15_000);

it("allows two Projects to progress independently in one database without cross-Project context", async () => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["LOW"] });
  try {
    const other = f.seedIndependentProject();
    await f.runRole(SUBTASK_IDS[0]!, "EXECUTE", { onTurn: () => {
      expect(f.governed.prepareNextRole(other.bigTaskId)).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { subtaskId: other.subtaskId } });
      expect(f.readRows("SELECT project_id, count(*) AS count FROM governed_dispatch_receipts WHERE status IN ('ACTIVE', 'RESERVED') GROUP BY project_id")).toHaveLength(2);
    } });
    await f.runRole(other.subtaskId, "EXECUTE", { bigTaskId: other.bigTaskId });
    expect(String(f.inputs.at(-1)!.payload.canonicalContext)).toContain("Independent Project approved contract canary");
    expect(JSON.stringify(f.inputs.at(-1)!.payload)).not.toContain(`Current contract canary ${SUBTASK_IDS[0]}`);
    await f.runRole(other.subtaskId, "VERIFY", { bigTaskId: other.bigTaskId });
    expect(f.governed.prepareNextRole(other.bigTaskId).kind).toBe("BIG_TASK_COMPLETE");
    await f.runRole(SUBTASK_IDS[0]!, "VERIFY");
    expect(f.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("BIG_TASK_COMPLETE");
  } finally { f.close(); }
}, 25_000);

it("revalidates an applicable human boundary after dispatch and before provider execution", async () => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["LOW"] });
  try {
    await f.runRole(SUBTASK_IDS[0]!, "EXECUTE", { success: false, beforeProvider: () => {
      f.storage.requestDurableMaterializedGraphChange({ operationId: "wop_before_provider", projectId: PROJECT_ID,
        bigTaskId: BIG_TASK_ID, candidateBinding: f.storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!.candidateBinding,
        changeKind: "REPLACE_SUBTASK" });
    } });
    expect(f.inputs).toHaveLength(0);
    expect(f.counts().governed_role_results).toBe(0);
    expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPLAN_REQUIRED" });
  } finally { f.close(); }
}, 15_000);
