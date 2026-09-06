import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createGovernedExecutionStoreForTest } from "../../storage/src/governed-execution-public.js";
import { createWorktreeOwnershipManagerForTesting, WorktreeOwnershipError } from "../../storage/src/worktree-ownership.js";
import { BIG_TASK_ID, PROJECT_ID, fixtureGit, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

const profiles = ["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"] as const;
const first = SUBTASK_IDS[0]!;

it.each(profiles.flatMap(profile => ["absent-resolution", "absent-history", "before-reservation"].map(seam => ({ profile, seam })) ))(
  "converges on competing $profile first provisioning/dispatch at $seam", ({ profile, seam }) => {
    const f = new IntegratedOrchestrationFixture({ profiles: [profile] });
    try {
      let winner: ReturnType<typeof f.governed.prepareNextRole> | undefined;
      const win = () => { winner = f.governed.prepareNextRole(BIG_TASK_ID); };
      const worktrees = createWorktreeOwnershipManagerForTesting(f.storage, {
        worktreeRoot: join(f.directory, "worktrees"), idGenerator: () => "wt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        failureHooks: seam === "before-reservation" ? { beforeReservation: win } : {},
      });
      if (seam === "absent-resolution") {
        const resolve = worktrees.resolveActiveOwnedWorktreeForSubtask.bind(worktrees);
        vi.spyOn(worktrees, "resolveActiveOwnedWorktreeForSubtask").mockImplementationOnce(id => {
          try { return resolve(id); } catch (error) { win(); throw error; }
        });
      }
      if (seam === "absent-history") {
        const history = worktrees.listWorktreeOwnershipHistoryForSubtask.bind(worktrees);
        vi.spyOn(worktrees, "listWorktreeOwnershipHistoryForSubtask").mockImplementationOnce(id => {
          const observed = history(id);
          expect(observed).toEqual([]);
          win();
          return observed;
        });
      }
      const provision = vi.spyOn(worktrees, "provisionOwnedWorktreeForSubtask");
      const contender = createGovernedExecutionStoreForTest(f.storage, worktrees);
      const result = contender.prepareNextRole(BIG_TASK_ID);
      expect(winner?.kind).toBe("ROLE_AUTHORIZED");
      expect(result).toEqual(winner);
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toEqual(winner);
      expect(provision).toHaveBeenCalledTimes(1);
      expect(provision.mock.results[0]).toMatchObject({ type: "throw", value: { code:
        seam === "before-reservation" ? "TASK_HIERARCHY_UNAVAILABLE" : "OWNERSHIP_CONFLICT" } });
      expect(f.worktrees.listWorktreeOwnershipHistoryForSubtask(first)).toEqual([
        expect.objectContaining({ status: "ACTIVE", id: "wt_00000000000000000000000000000001" }),
      ]);
      expect(f.readRows("SELECT * FROM worktree_checkout_generations")).toHaveLength(1);
      expect(fixtureGit(f.repositoryPath, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(2);
      expect(f.counts()).toMatchObject({ governed_dispatch_receipts: 1, governed_role_authorizations: 1, execution_runs: 0 });
    } finally { f.close(); }
  },
);

it.each(profiles)("uses exact competing %s ownership through normal gates before any dispatch exists", profile => {
  const f = new IntegratedOrchestrationFixture({ profiles: [profile] });
  try {
    const history = f.worktrees.listWorktreeOwnershipHistoryForSubtask.bind(f.worktrees);
    vi.spyOn(f.worktrees, "listWorktreeOwnershipHistoryForSubtask").mockImplementationOnce(id => {
      const observed = history(id);
      f.worktrees.provisionOwnedWorktreeForSubtask(id);
      return observed;
    });
    const prepared = f.governed.prepareNextRole(BIG_TASK_ID);
    expect(prepared.kind).toBe("ROLE_AUTHORIZED");
    expect(f.governed.prepareNextRole(BIG_TASK_ID)).toEqual(prepared);
    expect(history(first)).toHaveLength(1);
    expect(f.counts()).toMatchObject({ governed_dispatch_receipts: 1, governed_role_authorizations: 1, execution_runs: 0 });
  } finally { f.close(); }
});

it.each(["sibling", "capacity"] as const)("preserves the real %s blocker after an absent ownership observation", mode => {
  const f = new IntegratedOrchestrationFixture();
  try {
    const sibling = mode === "sibling" ? f.seedIndependentProject(true) : null;
    const history = f.worktrees.listWorktreeOwnershipHistoryForSubtask.bind(f.worktrees);
    vi.spyOn(f.worktrees, "listWorktreeOwnershipHistoryForSubtask").mockImplementationOnce(id => {
      const observed = history(id);
      if (sibling) expect(f.governed.prepareNextRole(sibling.bigTaskId).kind).toBe("ROLE_AUTHORIZED");
      else for (const id of SUBTASK_IDS.slice(1)) f.worktrees.provisionOwnedWorktreeForSubtask(id);
      return observed;
    });
    expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "BLOCKED",
      reason: mode === "sibling" ? "CONCURRENCY_BLOCKED" : "WORKTREE_BLOCKED", subtaskId: first });
    const ownership = f.readRows("SELECT * FROM worktree_ownerships WHERE status IN ('PROVISIONING','ACTIVE','RELEASING')");
    expect(ownership).toHaveLength(2);
    expect(history(first)).toHaveLength(mode === "sibling" ? 1 : 0);
    expect(f.counts()).toMatchObject({ governed_dispatch_receipts: mode === "sibling" ? 1 : 0, execution_runs: 0 });
    expect(f.readRows("SELECT * FROM governed_dispatch_receipts WHERE write_enabled=1 AND status IN ('ACTIVE','RESERVED')").length).toBeLessThanOrEqual(1);
  } finally { f.close(); }
});

it.each(["dirty", "generation", "repository", "human", "candidate-head", "ownership-generation"] as const)("does not converge on a competing candidate with %s drift", mode => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["LOW"] });
  try {
    const history = f.worktrees.listWorktreeOwnershipHistoryForSubtask.bind(f.worktrees);
    vi.spyOn(f.worktrees, "listWorktreeOwnershipHistoryForSubtask").mockImplementationOnce(id => {
      const observed = history(id);
      expect(f.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("ROLE_AUTHORIZED");
      const path = f.worktrees.resolveActiveOwnedWorktreeForSubtask(first).ownership.worktreePath;
      if (mode === "dirty") writeFileSync(join(path, "uncommitted.txt"), "Synthetic dirty state.\n", { encoding: "utf8" });
      if (mode === "generation") {
        const marker = join(fixtureGit(path, ["rev-parse", "--absolute-git-dir"]), "ctc-worktree-ownership-v0");
        const contents = readFileSync(marker, "utf8");
        renameSync(marker, `${marker}.original`);
        writeFileSync(marker, contents, { encoding: "utf8", mode: 0o600 });
      }
      if (mode === "repository") writeFileSync(join(path, ".git"), "gitdir: /nonexistent-synthetic-repository\n", { encoding: "utf8" });
      if (mode === "candidate-head") fixtureGit(path, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Changed after dispatch"]);
      if (mode === "ownership-generation") {
        f.worktrees.releaseOwnedWorktreeForSubtask(first);
        f.worktrees.provisionOwnedWorktreeForSubtask(first);
      }
      if (mode === "human") f.storage.requestDurableMaterializedGraphChange({ operationId: "wop_first_provision_human",
        projectId: PROJECT_ID, bigTaskId: BIG_TASK_ID, candidateBinding: f.storage.getCanonicalTaskMaterialization(BIG_TASK_ID)!.candidateBinding,
        changeKind: "ADD_SUBTASK" });
      return observed;
    });
    expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject(mode === "human"
      ? { kind: "HUMAN_REQUIRED", reason: "REPLAN_REQUIRED" } : { kind: "BLOCKED", reason: "WORKTREE_BLOCKED" });
    expect(history(first)).toHaveLength(mode === "ownership-generation" ? 2 : 1);
    expect(f.counts()).toMatchObject({ governed_dispatch_receipts: 1, governed_role_authorizations: 1, execution_runs: 0 });
  } finally { f.close(); }
});

it.each(["PROJECT_CAPACITY_EXCEEDED", "RECOVERY_REQUIRED", "GIT_OPERATION_FAILED"] as const)(
  "does not use active readback to mask an unrelated %s provisioning failure", code => {
    const f = new IntegratedOrchestrationFixture({ profiles: ["LOW"] });
    try {
      const provision = vi.spyOn(f.worktrees, "provisionOwnedWorktreeForSubtask");
      let failures = 0;
      // The one-shot seam lets the competitor use the real manager, then emits
      // the exact non-race failure at the loser's provisioning boundary.
      provision.mockImplementationOnce(() => {
        failures++;
        provision.mockRestore();
        expect(f.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("ROLE_AUTHORIZED");
        throw new WorktreeOwnershipError(code, "Synthetic bounded failure.");
      });
      expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "BLOCKED", reason: "WORKTREE_BLOCKED" });
      expect(failures).toBe(1);
      expect(f.counts()).toMatchObject({ governed_dispatch_receipts: 1, governed_role_authorizations: 1 });
    } finally { f.close(); }
  },
);

it.each([false, true])("reconciles only the exact pending first generation (evidence persisted: %s)", evidencePersisted => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["STANDARD"] });
  try {
    const crash = () => { throw new Error("Synthetic provisioning interruption."); };
    const interrupted = createWorktreeOwnershipManagerForTesting(f.storage, {
      worktreeRoot: join(f.directory, "worktrees"), idGenerator: () => "wt_dddddddddddddddddddddddddddddddd",
      failureHooks: evidencePersisted ? { afterGitAdd: crash } : { beforeGenerationEvidencePersist: crash },
    });
    expect(() => interrupted.provisionOwnedWorktreeForSubtask(first)).toThrowError(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
    const history = f.worktrees.listWorktreeOwnershipHistoryForSubtask.bind(f.worktrees);
    let winner: ReturnType<typeof f.governed.prepareNextRole> | undefined;
    vi.spyOn(f.worktrees, "listWorktreeOwnershipHistoryForSubtask").mockImplementationOnce(id => {
      const observed = history(id);
      expect(observed).toEqual([expect.objectContaining({ status: "PROVISIONING" })]);
      winner = f.governed.prepareNextRole(BIG_TASK_ID);
      return observed;
    });
    const prepared = f.governed.prepareNextRole(BIG_TASK_ID);
    expect(prepared).toEqual(winner);
    expect(prepared).toMatchObject(evidencePersisted ? { kind: "ROLE_AUTHORIZED" } : { kind: "BLOCKED", reason: "WORKTREE_BLOCKED" });
    expect(history(first)).toEqual([expect.objectContaining({ id: "wt_dddddddddddddddddddddddddddddddd",
      status: evidencePersisted ? "ACTIVE" : "PROVISIONING" })]);
    expect(f.counts()).toMatchObject({ governed_dispatch_receipts: evidencePersisted ? 1 : 0, execution_runs: 0 });
  } finally { f.close(); }
});
