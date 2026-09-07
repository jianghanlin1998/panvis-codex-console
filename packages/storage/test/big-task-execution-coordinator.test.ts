import type * as FileSystem from "node:fs";
import type * as ChildProcess from "node:child_process";
import { expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ expire: undefined as undefined | (() => void), armed: false, expired: false, mutations: [] as string[] }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof FileSystem>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    const value = fs.readFileSync(...args);
    if (probe.armed && String(args[0]).endsWith("deadline-first.txt")) { probe.armed = false; probe.expired = true; probe.expire!(); }
    return value;
  } };
});
vi.mock("node:child_process", async importOriginal => {
  const cp = await importOriginal<typeof ChildProcess>();
  return { ...cp, spawnSync: (...args: Parameters<typeof cp.spawnSync>) => {
    if (probe.expired && args[0] === "git") probe.mutations.push(JSON.stringify(args[1]));
    return cp.spawnSync(...args);
  } };
});
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { commitApprovedExecutionCandidate } from "../src/big-task-execution.js";

it("stops candidate traversal and every subsequent Git mutation immediately after approved expiry", () => {
  let now = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(now));
  try {
    f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, durationMilliseconds: 1000 } });
    const started = f.execution.start(f.approval.bigTaskId).status;
    const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
    const auth = prepared.authorization;
    const worktree = f.manager.resolveActiveOwnedWorktreeForSubtask(auth.subtaskId);
    writeFileSync(join(worktree.ownership.worktreePath, "deadline-first.txt"), "first", "utf8");
    writeFileSync(join(worktree.ownership.worktreePath, "deadline-second.txt"), "second", "utf8");
    probe.expire = () => { now = Date.parse(started.expiresAt!); }; probe.armed = true;
    expect(() => commitApprovedExecutionCandidate(f.storage, { bigTaskId: f.approval.bigTaskId,
      authorizationId: auth.authorizationId, parentSha: auth.candidateSha, authorizedAt: auth.authorizedAt, ownership: worktree.ownership,
    })).toThrow();
    expect(probe.expired).toBe(true);
    expect(probe.mutations.filter(command => /hash-object|update-index|write-tree|commit-tree|update-ref/u.test(command))).toEqual([]);
  } finally { probe.armed = false; probe.expired = false; probe.mutations = []; f.close(); }
});
