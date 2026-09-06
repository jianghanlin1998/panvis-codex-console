import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { BigTaskIdSchema, SubtaskIdSchema } from "@codex-task-console/domain";
import { openTaskDatabase } from "@codex-task-console/storage";
import { createGovernedExecutionStoreForTest } from "../../storage/src/governed-execution-public.js";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";

it("is inert unless invoked as the first-provisioning barrier worker", () => {
  if (!process.env.CTC_FIRST_PROVISION_WORKER) {
    expect(process.env.CTC_FIRST_PROVISION_DATABASE).toBeUndefined();
    return;
  }
  const required = (name: string) => {
    const value = process.env[`CTC_FIRST_PROVISION_${name}`];
    if (!value) throw new Error("Missing synthetic worker input.");
    return value;
  };
  // Synchronization is signalled by the exact competing commit, never sleeps
  // used to guess who wins. The bounded wait only guards a broken harness.
  const wait = (name: string) => {
    const signal = required(name);
    for (let count = 0; count < 1200 && !existsSync(signal); count++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    expect(existsSync(signal)).toBe(true);
  };
  const storage = openTaskDatabase({ databasePath: required("DATABASE"), clock: () => new Date("2026-09-06T00:00:00.000Z") });
  try {
    const loser = required("WORKER") === "LOSER";
    let next = 0;
    const worktrees = createWorktreeOwnershipManagerForTesting(storage, {
      worktreeRoot: required("ROOT"),
      idGenerator: () => `wt_${loser ? "e" : "f"}${(++next).toString(16).padStart(31, "0")}`,
      failureHooks: { beforeGitAdd: () => appendFileSync(required("ADDS"), "add\n", { encoding: "utf8" }) },
    });
    const governed = createGovernedExecutionStoreForTest(storage, worktrees);
    if (loser) {
      const history = worktrees.listWorktreeOwnershipHistoryForSubtask.bind(worktrees);
      vi.spyOn(worktrees, "listWorktreeOwnershipHistoryForSubtask").mockImplementationOnce(id => {
        const observed = history(id);
        expect(observed).toEqual([]);
        writeFileSync(required("OBSERVED"), "absent", { encoding: "utf8" });
        wait("COMMITTED");
        return observed;
      });
    } else wait("OBSERVED");
    const result = !loser && required("OPERATION") === "CAPACITY"
      ? required("SUBTASKS").split(",").map(id => worktrees.provisionOwnedWorktreeForSubtask(SubtaskIdSchema.parse(id)))
      : governed.prepareNextRole(BigTaskIdSchema.parse(required("BIGTASK")));
    writeFileSync(required("OUTCOME"), JSON.stringify(result), { encoding: "utf8" });
  } finally { storage.close(); }
});
