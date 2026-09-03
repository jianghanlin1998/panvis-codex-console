import { existsSync, writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { BigTaskIdSchema } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing canonical materialization worker field: ${name}`);
  }
  return value;
};

it("runs only as the bounded cross-process canonical materialization worker", () => {
  if (process.env.CTC_B2B_PROCESS_DATABASE_PATH === undefined) {
    expect(process.env.CTC_B2B_PROCESS_READY_PATH).toBeUndefined();
    return;
  }

  const databasePath = requiredEnvironment("CTC_B2B_PROCESS_DATABASE_PATH");
  const readyPath = requiredEnvironment("CTC_B2B_PROCESS_READY_PATH");
  const goPath = requiredEnvironment("CTC_B2B_PROCESS_GO_PATH");
  const outcomePath = requiredEnvironment("CTC_B2B_PROCESS_OUTCOME_PATH");
  const storage = openTaskDatabase({
    databasePath,
    clock: () => new Date("2040-01-01T00:00:00.000Z"),
  });
  try {
    writeFileSync(readyPath, "ready\n", { encoding: "utf-8" });
    for (let attempt = 0; attempt < 3_000 && !existsSync(goPath); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    expect(existsSync(goPath)).toBe(true);
    const result = storage.materializeApprovedCanonicalTasks(
      BigTaskIdSchema.parse("bt_b2b_hardening"),
    );
    writeFileSync(outcomePath, `${JSON.stringify(result)}\n`, {
      encoding: "utf-8",
    });
  } finally {
    storage.close();
  }
});
