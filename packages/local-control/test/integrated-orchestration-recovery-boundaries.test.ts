import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import { BIG_TASK_ID, PROJECT_ID, fixtureGit, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

const first = SUBTASK_IDS[0]!;

describe("Step 8E recovery rejects altered candidates and human boundaries", () => {
  it.each(["dirty", "head", "branch", "marker", "admin", "generation", "human"] as const)("preserves pending release for %s", async mode => {
    const f = new IntegratedOrchestrationFixture();
    try {
      await f.runRole(first, "EXECUTE"); await f.runRole(first, "VERIFY");
      const active = f.worktrees.resolveActiveOwnedWorktreeForSubtask(first);
      const interrupted = createWorktreeOwnershipManagerForTesting(f.storage, { worktreeRoot: join(f.directory, "worktrees"),
        idGenerator: () => { throw new Error("No provisioning authority."); },
        failureHooks: { beforeGitRemove: () => { throw new Error("Synthetic crash."); } } });
      expect(() => interrupted.releaseOwnedWorktreeForSubtask(first)).toThrow();
      const path = active.ownership.worktreePath;
      const admin = fixtureGit(path, ["rev-parse", "--absolute-git-dir"]);
      if (mode === "dirty") writeFileSync(join(path, "uncommitted.txt"), "dirty\n", { encoding: "utf8" });
      if (mode === "head") fixtureGit(path, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Unassessed drift"]);
      if (mode === "branch") fixtureGit(path, ["switch", "-c", "synthetic-wrong-branch"]);
      if (mode === "marker") {
        const marker = join(admin, "ctc-worktree-ownership-v0");
        const contents = readFileSync(marker, "utf8");
        renameSync(marker, `${marker}.original`);
        writeFileSync(marker, contents, { encoding: "utf8", mode: 0o600 });
      }
      if (mode === "admin") {
        const contents = readFileSync(join(path, ".git"), "utf8");
        writeFileSync(join(path, ".git"), `${contents.trim()}-missing\n`, { encoding: "utf8" });
      }
      if (mode === "generation") {
        // Adversarial fixture recreation: same path/branch/HEAD is not the
        // original administrative/marker generation. Production may not adopt it.
        fixtureGit(f.repositoryPath, ["worktree", "remove", path]);
        fixtureGit(f.repositoryPath, ["worktree", "add", path, active.ownership.branchName]);
      }
      if (mode === "human") {
        const graph = f.storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!;
        f.storage.requestDurableMaterializedGraphChange({ operationId: "wop_release_human", projectId: PROJECT_ID, bigTaskId: BIG_TASK_ID,
          candidateBinding: graph.candidateBinding, changeKind: "CHANGE_DEPENDENCIES" });
      }
      f.reopen();
      const before = f.counts();
      if (mode === "human") expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPLAN_REQUIRED" });
      else expect(() => f.governed.prepareNextRole(BIG_TASK_ID)).toThrow();
      expect(existsSync(path)).toBe(true);
      expect(f.worktrees.listWorktreeOwnershipHistoryForSubtask(first)).toEqual([
        expect.objectContaining({ id: active.ownership.id, status: "RELEASING", releaseHeadSha: active.currentHeadSha })]);
      expect(f.counts()).toEqual(before);
      expect(() => f.worktrees.resolveActiveOwnedWorktreeForSubtask(first)).toThrow();
    } finally { f.close(); }
  }, 15_000);

  it("preserves an ACTIVE completed candidate when an applicable Big Task human boundary arrives", async () => {
    const f = new IntegratedOrchestrationFixture();
    try {
      await f.runRole(first, "EXECUTE"); await f.runRole(first, "VERIFY");
      const active = f.worktrees.resolveActiveOwnedWorktreeForSubtask(first);
      f.storage.requestDurableMaterializedGraphChange({ operationId: "wop_active_human", projectId: PROJECT_ID, bigTaskId: BIG_TASK_ID,
        candidateBinding: f.storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!.candidateBinding, changeKind: "ADD_SUBTASK" });
      f.reopen();
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPLAN_REQUIRED" });
      expect(f.worktrees.resolveActiveOwnedWorktreeForSubtask(first)).toEqual(active);
      expect(f.counts()).toMatchObject({ execution_runs: 2, governed_dispatch_receipts: 1 });
    } finally { f.close(); }
  }, 15_000);
});
