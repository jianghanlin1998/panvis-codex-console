import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import { BIG_TASK_ID, fixtureGit, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

// Production governed advance must recover each durable/physical crash boundary.
describe("Step 8E governed completion to normal release crash seams", () => {
  it.each(["BEFORE_RELEASE", "BEFORE_REMOVE", "AFTER_REMOVE", "AFTER_RELEASE"] as const)(
    "finishes the approved normal release at %s",
    async seam => {
      const fixture = new IntegratedOrchestrationFixture();
      try {
        const [first, second, third] = SUBTASK_IDS;
        for (const id of [first!]) {
          await fixture.runRole(id, "EXECUTE");
          await fixture.runRole(id, "VERIFY");
          expect(fixture.storage.getDurableWorkflowControlView(id)).toMatchObject({
            currentStage: "COMPLETE", boardStatus: "DONE", deliveryMaturity: "IMPLEMENTED",
            unresolvedHumanRequired: null,
          });
        }
        const before = fixture.governed.inspectBigTask(BIG_TASK_ID);
        expect(before.dispatchReceipts.map(receipt => receipt.status)).toEqual(["COMPLETED"]);
        const counts = fixture.counts();
        fixture.worktrees.provisionOwnedWorktreeForSubtask(second!);
        const active = fixture.worktrees.resolveActiveOwnedWorktreeForSubtask(first!);
        const assessedSha = fixture.executions[1]!.after;
        expect(active.currentHeadSha).toBe(assessedSha);
        let interruptions = 0;
        const interrupt = () => {
          interruptions += 1;
          throw new Error("Synthetic release interruption.");
        };
        const interrupted = createWorktreeOwnershipManagerForTesting(fixture.storage, {
          worktreeRoot: join(fixture.directory, "worktrees"),
          idGenerator: () => { throw new Error("Release cannot provision a generation."); },
          failureHooks: seam === "BEFORE_REMOVE" ? { beforeGitRemove: interrupt }
            : seam === "AFTER_REMOVE" ? { afterGitRemove: interrupt } : {},
        });
        if (seam === "BEFORE_REMOVE" || seam === "AFTER_REMOVE") {
          expect(() => interrupted.releaseOwnedWorktreeForSubtask(first!)).toThrowError(
            expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
          );
          expect(interruptions).toBe(1);
          expect(interrupted.listWorktreeOwnershipHistoryForSubtask(first!)).toEqual([
            expect.objectContaining({ id: active.ownership.id, status: "RELEASING", releaseHeadSha: assessedSha }),
          ]);
        } else if (seam === "AFTER_RELEASE") {
          expect(interrupted.releaseOwnedWorktreeForSubtask(first!)).toMatchObject({
            id: active.ownership.id, status: "RELEASED", releaseHeadSha: assessedSha,
          });
        }
        fixture.reopen();
        if (seam === "BEFORE_REMOVE") {
          const pending = fixture.worktrees.listWorktreeOwnershipHistoryForSubtask(first!);
          expect(pending).toHaveLength(1);
          expect(pending[0]).toMatchObject({ id: active.ownership.id, status: "RELEASING", releaseHeadSha: assessedSha });
          expect(existsSync(active.ownership.worktreePath)).toBe(true);
          expect(fixtureGit(active.ownership.worktreePath, ["rev-parse", "HEAD"])).toBe(assessedSha);
          expect(fixtureGit(active.ownership.worktreePath, ["status", "--porcelain"])).toBe("");
          expect(() => fixture.worktrees.reconcileWorktreeOwnershipForSubtask(first!)).toThrowError(
            expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
          );
          expect(() => fixture.worktrees.releaseOwnedWorktreeForSubtask(first!)).toThrowError(
            expect.objectContaining({ code: "OWNERSHIP_NOT_ACTIVE" }),
          );
          expect(() => fixture.worktrees.provisionOwnedWorktreeForSubtask(third!)).toThrowError(
            expect.objectContaining({ code: "PROJECT_CAPACITY_EXCEEDED" }),
          );
        }
        // Read-only inspection observes pending/active/terminal ownership without
        // removal, dispatch, or invented completion. Ordinary reconcile still
        // cannot authorize removal of an intact pending checkout.
        expect(fixture.governed.inspectBigTask(BIG_TASK_ID)).toEqual(before);
        expect(fixture.counts()).toEqual(counts);
        const prepared = fixture.governed.prepareNextRole(BIG_TASK_ID);
        expect(prepared).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { subtaskId: second } });
        const released = fixture.worktrees.listWorktreeOwnershipHistoryForSubtask(first!)[0]!;
        expect(released).toMatchObject({ id: active.ownership.id, status: "RELEASED", releaseHeadSha: assessedSha });
        expect(existsSync(active.ownership.worktreePath)).toBe(false);
        expect(fixtureGit(fixture.repositoryPath, ["rev-parse", active.ownership.branchName])).toBe(assessedSha);
        expect(fixture.counts()).toMatchObject({ ...counts, governed_dispatch_receipts: 2, governed_role_authorizations: 3 });
        fixture.reopen();
        expect(fixture.governed.prepareNextRole(BIG_TASK_ID)).toEqual(prepared);
        expect(fixture.worktrees.reconcileWorktreeOwnershipForSubtask(first!)).toEqual(released);
        expect(fixture.worktrees.listWorktreeOwnershipHistoryForSubtask(first!)).toEqual([released]);
        expect(() => fixture.worktrees.resolveActiveOwnedWorktreeForSubtask(first!)).toThrowError(expect.objectContaining({ code: "OWNERSHIP_NOT_ACTIVE" }));
        expect(fixture.worktrees.provisionOwnedWorktreeForSubtask(third!)).toMatchObject({ status: "ACTIVE" });
        expect(fixture.storage.getBigTaskById(BIG_TASK_ID)?.status).toBe("IN_PROGRESS");
      } finally {
        fixture.close();
      }
    },
    30_000,
  );
});
