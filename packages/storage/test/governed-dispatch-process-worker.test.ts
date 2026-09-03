import { existsSync, writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { BigTaskIdSchema } from "@codex-task-console/domain";
import {
  createGovernedExecutionStore,
  openTaskDatabase,
  TaskStorageError,
} from "../src/index.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing governed-dispatch worker field: ${name}`);
  }
  return value;
};

it("runs only as the bounded cross-process governed-dispatch worker", () => {
  if (process.env.CTC_8D_PROCESS_DATABASE_PATH === undefined) {
    expect(process.env.CTC_8D_PROCESS_READY_PATH).toBeUndefined();
    return;
  }

  const databasePath = requiredEnvironment("CTC_8D_PROCESS_DATABASE_PATH");
  const worktreeRoot = requiredEnvironment("CTC_8D_PROCESS_WORKTREE_ROOT");
  const bigTaskId = BigTaskIdSchema.parse(
    requiredEnvironment("CTC_8D_PROCESS_BIG_TASK_ID"),
  );
  const readyPath = requiredEnvironment("CTC_8D_PROCESS_READY_PATH");
  const goPath = requiredEnvironment("CTC_8D_PROCESS_GO_PATH");
  const outcomePath = requiredEnvironment("CTC_8D_PROCESS_OUTCOME_PATH");
  const storage = openTaskDatabase({
    databasePath,
    clock: () => new Date("2026-09-04T00:30:00.000Z"),
  });
  try {
    const worktrees = createWorktreeOwnershipManagerForTesting(storage, {
      worktreeRoot,
      idGenerator: () => "wt_ffffffffffffffffffffffffffffffff",
    });
    const governed = createGovernedExecutionStore(storage, worktrees);
    writeFileSync(readyPath, "ready\n", { encoding: "utf-8" });
    for (let attempt = 0; attempt < 3_000 && !existsSync(goPath); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    expect(existsSync(goPath)).toBe(true);
    let outcome: Readonly<Record<string, unknown>>;
    for (let retry = 0; ; retry += 1) {
      try {
        const result = governed.prepareNextRole(bigTaskId);
        outcome =
          result.kind === "ROLE_AUTHORIZED"
            ? {
                kind: result.kind,
                receiptId: result.receipt.receiptId,
                authorizationId: result.authorization.authorizationId,
              }
            : { kind: result.kind, reason: "reason" in result ? result.reason : null };
        break;
      } catch (error) {
        if (!(error instanceof TaskStorageError)) {
          throw error;
        }
        if (error.code === "TRANSACTION_FAILED" && retry < 20) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          continue;
        }
        outcome = { kind: "ERROR", code: error.code };
        break;
      }
    }
    writeFileSync(outcomePath, `${JSON.stringify(outcome)}\n`, {
      encoding: "utf-8",
    });
  } finally {
    storage.close();
  }
});
