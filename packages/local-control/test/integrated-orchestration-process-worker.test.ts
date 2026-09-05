import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { BigTaskIdSchema, SubtaskIdSchema } from "@codex-task-console/domain";
import { openTaskDatabase } from "@codex-task-console/storage";
import { createGovernedExecutionStoreForTest } from "../../storage/src/governed-execution-public.js";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";

it("is inert unless invoked as the bounded Step 8E process worker", () => {
  if (!process.env.CTC_8E_WORKER) { expect(process.env.CTC_8E_DATABASE).toBeUndefined(); return; }
  const required = (name: string) => { const value = process.env[`CTC_8E_${name}`]; if (!value) throw new Error("Missing synthetic worker input."); return value; };
  const storage = openTaskDatabase({ databasePath: required("DATABASE"), clock: () => new Date("2026-09-06T00:00:00.000Z") });
  try {
    const worktrees = createWorktreeOwnershipManagerForTesting(storage, { worktreeRoot: required("ROOT"),
      idGenerator: () => "wt_ffffffffffffffffffffffffffffffff",
      failureHooks: { afterGitRemove: () => appendFileSync(required("REMOVALS"), "removed\n", { encoding: "utf8" }) } });
    const governed = createGovernedExecutionStoreForTest(storage, worktrees);
    writeFileSync(required("READY"), "ready", { encoding: "utf8" });
    for (let count = 0; count < 3000 && !existsSync(required("GO")); count++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    expect(existsSync(required("GO"))).toBe(true);
    let outcome;
    try {
      const operation = required("OPERATION");
      outcome = operation === "RECONCILE" ? worktrees.reconcileWorktreeOwnershipForSubtask(SubtaskIdSchema.parse(required("SUBTASK")))
        : operation === "PROVISION" ? worktrees.provisionOwnedWorktreeForSubtask(SubtaskIdSchema.parse(required("SUBTASK")))
        : governed.prepareNextRole(BigTaskIdSchema.parse(required("BIGTASK")));
      if ("kind" in outcome && outcome.kind === "ROLE_AUTHORIZED") outcome = {
        kind: outcome.kind, authorizationId: outcome.authorization.authorizationId, receiptId: outcome.receipt.receiptId };
    } catch (error) { outcome = { kind: "ERROR", code: (error as { code?: string }).code ?? "UNEXPECTED", message: (error as Error).message }; }
    writeFileSync(required("OUTCOME"), JSON.stringify(outcome), { encoding: "utf8" });
  } finally { storage.close(); }
}, 20_000);
