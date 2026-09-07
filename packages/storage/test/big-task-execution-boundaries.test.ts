import type * as ChildProcess from "node:child_process";
import { expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ afterGit: undefined as undefined | ((args: readonly string[]) => void),
  expired: false, writes: [] as string[], worktreeTimeouts: [] as number[] }));
vi.mock("node:child_process", async original => {
  const cp = await original<typeof ChildProcess>();
  return { ...cp, spawnSync: (...args: Parameters<typeof cp.spawnSync>) => {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (args[0] === "git" && argv.includes("worktree") && argv.includes("add")) {
      probe.worktreeTimeouts.push(Number(args[2]?.timeout));
    }
    if (args[0] === "git" && probe.expired && argv.some(arg =>
      ["hash-object", "update-index", "read-tree", "write-tree", "commit-tree", "update-ref", "worktree"].includes(arg))) {
      probe.writes.push(argv.join(" "));
    }
    const result = cp.spawnSync(...args);
    if (args[0] === "git") probe.afterGit?.(argv);
    return result;
  } };
});
import { appendFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";
import { createGovernedExecutionStoreForTest } from "../src/governed-execution-public.js";

it("rejects a filter installed after HEAD inspection before source status can execute it", () => {
  const f = makeExecutionFixture();
  try {
    f.execution.approve(f.approval);
    const marker = join(f.root, "late-filter-ran"), script = join(f.root, "late-filter.sh");
    writeFileSync(script, `#!/bin/sh\n/usr/bin/touch '${marker}'\n/bin/cat\n`, "utf8"); chmodSync(script, 0o700);
    let installed = false;
    probe.afterGit = args => {
      if (!installed && args.includes("rev-parse") && args.includes("HEAD^{commit}") && args.includes("maintenance.auto=false")) {
        installed = true; probe.afterGit = undefined;
        appendFileSync(join(f.repository, ".git/config"), `\n[filter "late"]\nclean = ${script}\nrequired = true\n`, "utf8");
        writeFileSync(join(f.repository, ".git/info/attributes"), "AGENTS.md filter=late\n", "utf8");
        writeFileSync(join(f.repository, "AGENTS.md"), "Xespect the approved task boundary.\n", "utf8");
      }
    };
    expect(() => f.execution.assertCurrent(f.approval.bigTaskId)).toThrow();
    expect(installed).toBe(true); expect(existsSync(marker)).toBe(false);
  } finally { probe.afterGit = undefined; f.close(); }
});

it.each(["identity", "reservation"])("expiry after %s prevents candidate worktree writes and role authorization", position => {
  let now = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(now));
  try {
    f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, durationMilliseconds: 1000 } });
    const state = f.execution.start(f.approval.bigTaskId).status;
    const expire = () => { now = Date.parse(state.expiresAt!); probe.expired = true; };
    const manager = createWorktreeOwnershipManagerForTesting(f.storage, {
      worktreeRoot: join(f.root, "worktrees"),
      idGenerator: () => { if (position === "identity") expire(); return `wt_${"3".repeat(32)}`; },
      failureHooks: { beforeGitAdd: () => { if (position === "reservation") expire(); } },
    });
    const governed = createGovernedExecutionStoreForTest(f.storage, manager);
    expect(() => governed.prepareNextRole(f.approval.bigTaskId)).toThrow();
    expect(probe.expired).toBe(true); expect(probe.writes).toEqual([]);
    expect(probe.worktreeTimeouts).toEqual([]);
    expect(f.execution.inspect(f.approval.bigTaskId).roleCalls).toBe(0);
  } finally { probe.expired = false; probe.writes = []; probe.worktreeTimeouts = []; f.close(); }
});

it("caps worktree creation by remaining approved time and refuses completion after expiry", () => {
  let now = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(now));
  try {
    f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, durationMilliseconds: 1000 } });
    const state = f.execution.start(f.approval.bigTaskId).status;
    probe.afterGit = args => { if (args.includes("worktree") && args.includes("add")) {
      now = Date.parse(state.expiresAt!); probe.expired = true;
    } };
    expect(() => f.governed.prepareNextRole(f.approval.bigTaskId)).toThrow();
    expect(probe.worktreeTimeouts).toEqual([1000]);
    expect(probe.writes).toEqual([]);
    expect(f.execution.inspect(f.approval.bigTaskId).roleCalls).toBe(0);
  } finally { probe.afterGit = undefined; probe.expired = false; probe.writes = []; probe.worktreeTimeouts = []; f.close(); }
});

it("a durably recorded pause inside the provisioning scope prevents all later Git operations", () => {
  const f = makeExecutionFixture();
  try {
    f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
    let paused = false;
    const manager = createWorktreeOwnershipManagerForTesting(f.storage, {
      worktreeRoot: join(f.root, "worktrees"), idGenerator: () => `wt_${"4".repeat(32)}`,
      failureHooks: { beforeReservation: () => {
        expect(f.execution.stop(f.approval.bigTaskId, "USER_PAUSED").phase).toBe("PAUSED");
        paused = true; probe.expired = true;
      } },
    });
    const governed = createGovernedExecutionStoreForTest(f.storage, manager);
    expect(() => governed.prepareNextRole(f.approval.bigTaskId)).toThrow();
    expect(paused).toBe(true);
    expect(f.execution.inspect(f.approval.bigTaskId)).toMatchObject({ phase: "PAUSED", roleCalls: 0 });
    expect(probe.writes).toEqual([]); expect(probe.worktreeTimeouts).toEqual([]);
    expect(existsSync(join(f.root, "worktrees", `wt_${"4".repeat(32)}`))).toBe(false);
  } finally { probe.expired = false; probe.writes = []; probe.worktreeTimeouts = []; f.close(); }
});
