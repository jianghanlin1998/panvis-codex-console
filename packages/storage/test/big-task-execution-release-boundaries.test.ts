import type * as ChildProcess from "node:child_process";
import { expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ expired: false, removals: [] as number[], lateMutations: [] as string[] }));
vi.mock("node:child_process", async original => {
  const cp = await original<typeof ChildProcess>();
  return { ...cp, spawnSync: (...args: Parameters<typeof cp.spawnSync>) => {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (args[0] === "git") {
      if (argv.includes("worktree") && argv.includes("remove")) probe.removals.push(Number(args[2]?.timeout));
      if (probe.expired && argv.some(arg => ["hash-object", "update-index", "read-tree", "write-tree", "commit-tree", "update-ref", "worktree"].includes(arg))) {
        probe.lateMutations.push(argv.join(" "));
      }
    }
    return cp.spawnSync(...args);
  } };
});
import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";
import { createGovernedExecutionStoreForTest } from "../src/governed-execution-public.js";

function installFilter(repository: string, worktree: string, marker: string): void {
  const script = `${marker}.sh`;
  writeFileSync(script, `#!/bin/sh\n/usr/bin/touch '${marker}'\n/bin/cat\n`, "utf8"); chmodSync(script, 0o700);
  appendFileSync(join(repository, ".git/config"), `\n[filter "late"]\nclean = ${script}\nrequired = true\n`, "utf8");
  writeFileSync(join(repository, ".git/info/attributes"), "AGENTS.md filter=late\n", "utf8");
  writeFileSync(join(worktree, "AGENTS.md"), "Xespect the approved task boundary.\n", "utf8");
}

it("checks filters again when candidate validation follows a completed provisioning scope", () => {
  const f = makeExecutionFixture();
  try {
    f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
    const marker = join(f.root, "candidate-filter-ran");
    const provision = f.manager.provisionOwnedWorktreeForSubtask.bind(f.manager);
    let injected = false;
    f.manager.provisionOwnedWorktreeForSubtask = id => {
      const owned = provision(id);
      installFilter(f.repository, owned.worktreePath, marker); injected = true;
      return owned;
    };
    expect(() => f.governed.prepareNextRole(f.approval.bigTaskId)).toThrow();
    expect(injected).toBe(true); expect(existsSync(marker)).toBe(false);
    expect(f.execution.inspect(f.approval.bigTaskId).roleCalls).toBe(0);
  } finally { f.close(); }
});

it.each(["expiry", "filter", "normal"] as const)("governed completed release preserves the %s boundary", async mode => {
  let now = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(now++));
  try {
    f.execution.approve(f.approval);
    const started = f.execution.start(f.approval.bigTaskId).status;
    let completedSubtaskId: Parameters<typeof f.manager.resolveActiveOwnedWorktreeForSubtask>[0] | undefined;
    for (let role = 0; role < 3; role += 1) {
      const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
      expect(prepared.kind).toBe("ROLE_AUTHORIZED");
      if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected governed role");
      completedSubtaskId ??= prepared.authorization.subtaskId;
      expect((await f.execute(f.governed, prepared.authorization.authorizationId)).success).toBe(true);
    }
    const candidate = f.manager.resolveActiveOwnedWorktreeForSubtask(completedSubtaskId!);
    const marker = join(f.root, "release-filter-ran");
    let injected = false;
    const manager = createWorktreeOwnershipManagerForTesting(f.storage, {
      worktreeRoot: join(f.root, "worktrees"), idGenerator: () => `wt_${"2".repeat(32)}`,
      failureHooks: { beforeGitRemove: () => {
        injected = true;
        if (mode === "expiry") { now = Date.parse(started.expiresAt!); probe.expired = true; }
        if (mode === "filter") installFilter(f.repository, candidate.ownership.worktreePath, marker);
        if (mode === "normal") now = Date.parse(started.expiresAt!) - 1000;
      } },
    });
    const governed = createGovernedExecutionStoreForTest(f.storage, manager);
    if (mode === "normal") {
      const next = governed.prepareNextRole(f.approval.bigTaskId);
      expect(next.kind).toBe("ROLE_AUTHORIZED");
      if (next.kind !== "ROLE_AUTHORIZED") throw new Error("Expected next governed task");
      expect(next.authorization.subtaskId).not.toBe(completedSubtaskId);
      expect(existsSync(candidate.ownership.worktreePath)).toBe(false);
      expect(probe.removals).toHaveLength(1);
      expect(probe.removals[0]).toBeGreaterThan(0); expect(probe.removals[0]).toBeLessThanOrEqual(1000);
      expect(f.execution.inspect(f.approval.bigTaskId).integratedSubtaskIds).toEqual([completedSubtaskId]);
    } else {
      expect(() => governed.prepareNextRole(f.approval.bigTaskId)).toThrow();
      expect(probe.removals).toEqual([]); expect(probe.lateMutations).toEqual([]);
      expect(existsSync(candidate.ownership.worktreePath)).toBe(true);
      expect(existsSync(marker)).toBe(false);
      const state = f.execution.inspect(f.approval.bigTaskId);
      expect(state.integratedSubtaskIds).toEqual([]); expect(state.roleCalls).toBe(3);
      expect(manager.listWorktreeOwnershipHistoryForSubtask(completedSubtaskId!).at(-1)?.status).toBe("RELEASING");
    }
    expect(injected).toBe(true);
  } finally { probe.expired = false; probe.removals = []; probe.lateMutations = []; f.close(); }
}, 60_000);
