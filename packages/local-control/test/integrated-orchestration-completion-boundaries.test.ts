import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { BIG_TASK_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

// Simulated durable corruption, not production authority: preserve the exact
// schema after mutation so source validation (not a missing guard) is tested.
const corrupt = (path: string, statement: string) => {
  const db = new DatabaseSync(path);
  try {
    const guards = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string; sql: string }[];
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("PRAGMA ignore_check_constraints = ON");
    for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
    db.exec(statement);
    for (const guard of guards) db.exec(guard.sql);
  } finally { db.close(); }
};

it.each([
  ["release SHA", "UPDATE worktree_ownerships SET release_head_sha = '1111111111111111111111111111111111111111'"],
  ["malformed SHA", "UPDATE worktree_ownerships SET release_head_sha = 'not-a-sha'"],
  ["pending state", "UPDATE worktree_ownerships SET status = 'RELEASING', released_at = NULL"],
  ["failed state", "UPDATE worktree_ownerships SET status = 'FAILED'"],
  ["provisioning state", "UPDATE worktree_ownerships SET status = 'PROVISIONING'"],
  ["Handoff SHA", "UPDATE governed_handoffs SET candidate_sha = '1111111111111111111111111111111111111111'"],
  ["assessment SHA", "UPDATE governed_role_results SET candidate_sha = '1111111111111111111111111111111111111111' WHERE authorization_id IN (SELECT authorization_id FROM governed_role_authorizations WHERE role = 'VERIFY')"],
  ["missing disposition", "DELETE FROM governed_promoted_context_dispositions"],
  ["missing generation", "DELETE FROM worktree_checkout_generations"],
  ["active provider execution", "UPDATE execution_runs SET status = 'RUNNING'"],
] as const)("rejects altered terminal completion provenance: %s", async (_label, mutation) => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["LOW"] });
  try {
    const id = SUBTASK_IDS[0]!;
    await f.runRole(id, "EXECUTE"); await f.runRole(id, "VERIFY");
    const released = f.worktrees.releaseOwnedWorktreeForSubtask(id);
    expect(released.status).toBe("RELEASED");
    corrupt(f.databasePath, mutation);
    // Reopen validates schema; malformed domain evidence is rejected on read.
    f.reopen();
    const before = f.counts();
    expect(() => f.governed.inspectBigTask(BIG_TASK_ID)).toThrow();
    // Pending + absent is legitimately reconcilable by advance, so its negative
    // contract is the completion proof above; all other corruption must reject.
    if (_label !== "pending state") expect(() => f.governed.prepareNextRole(BIG_TASK_ID)).toThrow();
    expect(f.counts()).toEqual(before);
    expect(f.storage.getBigTaskById(BIG_TASK_ID)?.status).toBe("IN_PROGRESS");
    expect(existsSync(released.worktreePath)).toBe(false);
  } finally { f.close(); }
}, 15_000);
