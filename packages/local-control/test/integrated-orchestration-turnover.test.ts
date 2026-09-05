import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BIG_TASK_ID, fixtureGit, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

describe("Step 8E three-Subtask ownership turnover", () => {
  it.each([false, true])("completes exact released candidates (explicit first release: %s)", async explicitRelease => {
    const fixture = new IntegratedOrchestrationFixture();
    try {
      const timeline = [];
      for (const [index, id] of SUBTASK_IDS.entries()) {
        await fixture.runRole(id, "EXECUTE");
        await fixture.runRole(id, "VERIFY");
        expect(fixture.storage.getDurableWorkflowControlView(id)).toMatchObject({ currentStage: "COMPLETE", boardStatus: "DONE" });
        const candidate = fixture.worktrees.resolveActiveOwnedWorktreeForSubtask(id);
        const beforeInspect = fixture.counts();
        expect(fixture.governed.inspectBigTask(BIG_TASK_ID).status).toBe("IN_PROGRESS");
        expect(fixture.counts()).toEqual(beforeInspect);
        expect(existsSync(candidate.ownership.worktreePath)).toBe(true); // read-only never releases
        if (index === 0 && explicitRelease) fixture.worktrees.releaseOwnedWorktreeForSubtask(id);
        fixture.reopen();
        const ownerships = SUBTASK_IDS.flatMap(subtask => fixture.worktrees.listWorktreeOwnershipHistoryForSubtask(subtask));
        const capacity = ownerships.filter(row => ["PROVISIONING", "ACTIVE", "RELEASING"].includes(row.status)).length;
        expect(capacity).toBeLessThanOrEqual(2);
        expect(ownerships.filter(row => row.status === "RELEASED")).toHaveLength(index + (index === 0 && explicitRelease ? 1 : 0));
        timeline.push({ id, capacity, candidateSha: candidate.currentHeadSha,
          ownership: ownerships.map(row => ({ subtaskId: row.subtaskId, status: row.status })),
          workflow: "COMPLETE", dispatch: "COMPLETED" });
      }
      expect(timeline).toHaveLength(3);
      expect(fixture.counts()).toMatchObject({ governed_dispatch_receipts: 3, governed_role_authorizations: 6,
        governed_role_results: 6, governed_handoffs: 3, execution_runs: 6, governed_big_task_completion_receipts: 0 });
      const completed = fixture.governed.prepareNextRole(BIG_TASK_ID);
      expect(completed.kind).toBe("BIG_TASK_COMPLETE");
      console.info("Step 8E synthetic turnover timeline", JSON.stringify({ explicitRelease, timeline, finalCapacity: 0 }));
      const counts = fixture.counts();
      expect(counts.governed_big_task_completion_receipts).toBe(1);
      for (const [index, id] of SUBTASK_IDS.entries()) {
        const history = fixture.worktrees.listWorktreeOwnershipHistoryForSubtask(id);
        expect(history).toEqual([expect.objectContaining({ status: "RELEASED", releaseHeadSha: timeline[index]!.candidateSha })]);
        expect(existsSync(history[0]!.worktreePath)).toBe(false);
        expect(fixtureGit(fixture.repositoryPath, ["rev-parse", history[0]!.branchName])).toBe(timeline[index]!.candidateSha);
        expect(() => fixture.worktrees.resolveActiveOwnedWorktreeForSubtask(id)).toThrowError(expect.objectContaining({ code: "OWNERSHIP_NOT_ACTIVE" }));
      }
      fixture.reopen();
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID)).toEqual(completed);
      expect(fixture.governed.inspectBigTask(BIG_TASK_ID).status).toBe("DONE");
      expect(fixture.counts()).toEqual(counts);
    } finally { fixture.close(); }
  }, 30_000);
});
