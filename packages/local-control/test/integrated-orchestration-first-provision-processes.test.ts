import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BIG_TASK_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

const cases = [
  { profile: "LOW", operation: "SAME" },
  { profile: "STANDARD", operation: "SAME" },
  { profile: "HIGH_RISK_FOUNDATION", operation: "SAME" },
  { profile: "STANDARD", operation: "SIBLING" },
  { profile: "STANDARD", operation: "CAPACITY" },
] as const;

it.each(cases)("converges across two processes for $profile / $operation first provisioning", async ({ profile, operation }) => {
  const f = new IntegratedOrchestrationFixture({ profiles: [profile, "STANDARD", "STANDARD"] });
  const workers: { child: ReturnType<typeof spawn>; done: Promise<void>; outcome: string }[] = [];
  try {
    const sibling = operation === "SIBLING" ? f.seedIndependentProject(true) : null;
    const committed = join(f.directory, "winner-outcome");
    for (const worker of ["LOSER", "WINNER"] as const) {
      const outcome = worker === "WINNER" ? committed : join(f.directory, "loser-outcome");
      const child = spawn(process.execPath, [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run",
        "packages/local-control/test/integrated-orchestration-first-provision-worker.test.ts", "--maxWorkers=1", "--reporter=dot"], {
        env: { ...process.env, CTC_FIRST_PROVISION_WORKER: worker, CTC_FIRST_PROVISION_DATABASE: f.databasePath,
          CTC_FIRST_PROVISION_ROOT: join(f.directory, "worktrees"), CTC_FIRST_PROVISION_OBSERVED: join(f.directory, "absent-observed"),
          CTC_FIRST_PROVISION_COMMITTED: committed, CTC_FIRST_PROVISION_OUTCOME: outcome, CTC_FIRST_PROVISION_OPERATION: operation,
          CTC_FIRST_PROVISION_ADDS: join(f.directory, "adds"), CTC_FIRST_PROVISION_SUBTASKS: SUBTASK_IDS.slice(1).join(","),
          CTC_FIRST_PROVISION_BIGTASK: worker === "WINNER" && sibling ? sibling.bigTaskId : BIG_TASK_ID },
        stdio: ["ignore", "ignore", "ignore"],
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", () => reject(new Error("Synthetic provisioning worker could not start.")));
        child.once("close", code => code === 0 ? resolve() : reject(new Error("Synthetic provisioning worker failed.")));
      });
      workers.push({ child, done, outcome });
    }
    await Promise.all(workers.map(worker => worker.done));
    const outcomes = workers.map(worker => JSON.parse(readFileSync(worker.outcome, "utf8")) as { kind: string; reason?: string });
    if (operation === "SAME") {
      expect(outcomes[0]!.kind).toBe("ROLE_AUTHORIZED");
      expect(outcomes[0]).toEqual(outcomes[1]);
    } else expect(outcomes[0]).toMatchObject({ kind: "BLOCKED",
      reason: ["SIBLING", "CAPACITY"].includes(operation) ? "CONCURRENCY_BLOCKED" : "WORKTREE_BLOCKED" });
    const ownerships = f.readRows("SELECT * FROM worktree_ownerships");
    expect(ownerships).toHaveLength(operation === "SAME" ? 1 : 2);
    expect(ownerships.every(row => row.status === "ACTIVE")).toBe(true);
    expect(new Set(ownerships.map(row => row.subtask_id)).size).toBe(ownerships.length);
    expect(f.readRows("SELECT * FROM worktree_checkout_generations")).toHaveLength(ownerships.length);
    expect(readFileSync(join(f.directory, "adds"), "utf8")).toBe("add\n".repeat(ownerships.length));
    expect(f.counts()).toMatchObject({ governed_dispatch_receipts: operation === "CAPACITY" ? 0 : 1,
      governed_role_authorizations: operation === "CAPACITY" ? 0 : 1, execution_runs: 0 });
    expect(f.readRows("SELECT * FROM governed_dispatch_receipts WHERE write_enabled=1 AND status IN ('ACTIVE','RESERVED')").length).toBeLessThanOrEqual(1);
    const before = f.counts();
    f.advanceClockForWorkerReadback(); f.reopen();
    expect(f.governed.prepareNextRole(BIG_TASK_ID)).toEqual(outcomes[0]);
    expect(f.counts()).toEqual(before);
    expect(readFileSync(join(f.directory, "adds"), "utf8")).toBe("add\n".repeat(ownerships.length));
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
    await Promise.allSettled(workers.map(worker => worker.done));
    f.close();
  }
});
