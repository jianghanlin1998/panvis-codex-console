import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGovernedExecutionStoreForTest } from "../../storage/src/governed-execution-public.js";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import { BIG_TASK_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

it.each(["PREPARE", "RECONCILE", "PROVISION", "TWO_PROJECTS"] as const)("serializes exact release resume against %s in another process", async operation => {
  const f = new IntegratedOrchestrationFixture();
  try {
    const [first, second, third] = SUBTASK_IDS;
    const other = operation === "TWO_PROJECTS" ? f.seedIndependentProject() : null;
    await f.runRole(first!, "EXECUTE"); await f.runRole(first!, "VERIFY");
    f.worktrees.provisionOwnedWorktreeForSubtask(second!);
    const interrupted = createWorktreeOwnershipManagerForTesting(f.storage, { worktreeRoot: join(f.directory, "worktrees"),
      idGenerator: () => { throw new Error("Cannot provision."); }, failureHooks: { beforeGitRemove: () => { throw new Error("Synthetic crash."); } } });
    expect(() => interrupted.releaseOwnedWorktreeForSubtask(first!)).toThrow();
    f.reopen();
    const workers = ["PREPARE", operation].map((op, index) => {
      const ready = join(f.directory, `ready-${index}`), outcome = join(f.directory, `outcome-${index}`);
      const child = spawn(process.execPath, [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run",
        "packages/local-control/test/integrated-orchestration-process-worker.test.ts", "--maxWorkers=1", "--reporter=dot"], {
        env: { ...process.env, CTC_8E_WORKER: "1", CTC_8E_DATABASE: f.databasePath, CTC_8E_ROOT: join(f.directory, "worktrees"),
          CTC_8E_READY: ready, CTC_8E_GO: join(f.directory, "go"), CTC_8E_OUTCOME: outcome,
          CTC_8E_REMOVALS: join(f.directory, "removals"), CTC_8E_OPERATION: op, CTC_8E_BIGTASK: index === 1 && other !== null ? other.bigTaskId : BIG_TASK_ID,
          CTC_8E_SUBTASK: op === "PROVISION" ? third : first }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { output += String(data); });
      const done = new Promise<void>((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error(output))));
      return { ready, outcome, done };
    });
    for (let count = 0; count < 3000 && !workers.every(worker => existsSync(worker.ready)); count++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(workers.every(worker => existsSync(worker.ready))).toBe(true);
    writeFileSync(join(f.directory, "go"), "go", { encoding: "utf8" });
    await Promise.all(workers.map(worker => worker.done));
    const outcomes = workers.map(worker => JSON.parse(readFileSync(worker.outcome, "utf8")) as { kind?: string; code?: string; status?: string });
    expect(outcomes[0]!.kind, JSON.stringify(outcomes)).toBe("ROLE_AUTHORIZED");
    if (operation === "PREPARE") expect(outcomes[1]).toEqual(outcomes[0]);
    else if (operation === "TWO_PROJECTS") {
      expect(outcomes[1]!.kind).toBe("ROLE_AUTHORIZED");
      expect(outcomes[1]).not.toEqual(outcomes[0]);
      expect(f.readRows("SELECT project_id FROM governed_dispatch_receipts WHERE status IN ('ACTIVE', 'RESERVED') GROUP BY project_id")).toHaveLength(2);
    }
    else if (operation === "RECONCILE") expect(outcomes[1]!.status === "RELEASED" || outcomes[1]!.code === "RECOVERY_REQUIRED").toBe(true);
    else expect(outcomes[1]!.status === "ACTIVE" || outcomes[1]!.code === "PROJECT_CAPACITY_EXCEEDED").toBe(true);
    expect(readFileSync(join(f.directory, "removals"), "utf8")).toBe("removed\n");
    expect(f.worktrees.listWorktreeOwnershipHistoryForSubtask(first!)).toEqual([expect.objectContaining({ status: "RELEASED" })]);
    expect(f.counts()).toMatchObject({ governed_dispatch_receipts: other === null ? 2 : 3, governed_role_authorizations: other === null ? 3 : 4, execution_runs: 2 });
    const active = SUBTASK_IDS.flatMap(id => f.worktrees.listWorktreeOwnershipHistoryForSubtask(id)).filter(row => ["PROVISIONING", "ACTIVE", "RELEASING"].includes(row.status));
    expect(active.length).toBeLessThanOrEqual(2);
    const beforeRepeat = f.counts();
    f.advanceClockForWorkerReadback(); f.reopen();
    const repeated = f.governed.prepareNextRole(BIG_TASK_ID);
    expect(repeated.kind).toBe("ROLE_AUTHORIZED");
    if (repeated.kind === "ROLE_AUTHORIZED") expect(outcomes[0]).toEqual({ kind: repeated.kind,
      authorizationId: repeated.authorization.authorizationId, receiptId: repeated.receipt.receiptId });
    expect(f.counts()).toEqual(beforeRepeat);
    expect(readFileSync(join(f.directory, "removals"), "utf8")).toBe("removed\n");
  } finally { f.close(); }
}, 25_000);

it.each(["LOW", "STANDARD"] as const)("reuses a competing %s authorization committed immediately after ownership resolution", profile => {
  const f = new IntegratedOrchestrationFixture({ profiles: [profile] });
  try {
    f.worktrees.provisionOwnedWorktreeForSubtask(SUBTASK_IDS[0]!);
    let winner: ReturnType<typeof f.governed.prepareNextRole> | undefined;
    let armed = true;
    const worktrees = new Proxy(f.worktrees, {
      get(target, property) {
        if (property === "resolveActiveOwnedWorktreeForSubtask") return (id: typeof SUBTASK_IDS[number]) => {
          const resolved = target.resolveActiveOwnedWorktreeForSubtask(id);
          if (armed) { armed = false; winner = f.governed.prepareNextRole(BIG_TASK_ID); }
          return resolved;
        };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const contender = createGovernedExecutionStoreForTest(f.storage, worktrees);
    expect(contender.prepareNextRole(BIG_TASK_ID)).toEqual(winner);
    expect(winner?.kind).toBe("ROLE_AUTHORIZED");
    expect(f.counts()).toMatchObject({ governed_dispatch_receipts: 1, governed_role_authorizations: 1, execution_runs: 0 });
  } finally { f.close(); }
}, 10_000);
