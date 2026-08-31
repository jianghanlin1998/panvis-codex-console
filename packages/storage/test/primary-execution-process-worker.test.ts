import { existsSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import {
  ChatThreadIdSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  SubtaskIdSchema,
  WorktreeOwnershipIdSchema,
} from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing primary process worker field: ${name}`);
  }
  return value;
};

it("runs only as the bounded cross-process primary reservation worker", () => {
  if (process.env.CTC_PRIMARY_PROCESS_ROLE === undefined) {
    expect(process.env.CTC_PRIMARY_PROCESS_DATABASE).toBeUndefined();
    return;
  }

  const role = requiredEnvironment("CTC_PRIMARY_PROCESS_ROLE");
  const readyPath = requiredEnvironment("CTC_PRIMARY_PROCESS_READY");
  const goPath = requiredEnvironment("CTC_PRIMARY_PROCESS_GO");
  const outcomePath = requiredEnvironment("CTC_PRIMARY_PROCESS_OUTCOME");
  const storage = openTaskDatabase({
    databasePath: requiredEnvironment("CTC_PRIMARY_PROCESS_DATABASE"),
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
  });
  try {
    writeFileSync(readyPath, "ready\n", "utf8");
    for (let attempt = 0; attempt < 3_000 && !existsSync(goPath); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    expect(existsSync(goPath)).toBe(true);
    let outcome: "WINNER" | "CONFLICT";
    try {
      storage.reservePrimaryExecutionAttempt({
        subtaskId: SubtaskIdSchema.parse("st_primary_a"),
        worktreeOwnershipId: WorktreeOwnershipIdSchema.parse(
          `wt_${"a".repeat(32)}`,
        ),
        chatThreadId: ChatThreadIdSchema.parse(`thr_process_${role}`),
        executionRunId: ExecutionRunIdSchema.parse(`run_process_${role}`),
        providerId: ExecutionProviderIdSchema.parse("openai-codex-app-server"),
      });
      outcome = "WINNER";
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TaskStorageError);
      expect((error as TaskStorageError).code).toBe("CONFLICT");
      outcome = "CONFLICT";
    }
    writeFileSync(outcomePath, `${outcome}\n`, "utf8");
  } finally {
    storage.close();
  }
});
