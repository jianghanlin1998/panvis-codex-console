import { existsSync, writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import type { AdvanceDurableWorkflowInput } from "../src/index.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing workflow-control worker field: ${name}`);
  }
  return value;
};

it("runs only as the bounded cross-process workflow-control worker", () => {
  if (process.env.CTC_8C_PROCESS_DATABASE_PATH === undefined) {
    expect(process.env.CTC_8C_PROCESS_READY_PATH).toBeUndefined();
    return;
  }

  const databasePath = requiredEnvironment("CTC_8C_PROCESS_DATABASE_PATH");
  const readyPath = requiredEnvironment("CTC_8C_PROCESS_READY_PATH");
  const goPath = requiredEnvironment("CTC_8C_PROCESS_GO_PATH");
  const outcomePath = requiredEnvironment("CTC_8C_PROCESS_OUTCOME_PATH");
  const request = JSON.parse(
    requiredEnvironment("CTC_8C_PROCESS_REQUEST"),
  ) as AdvanceDurableWorkflowInput;
  const storage = openTaskDatabase({
    databasePath,
    clock: () => new Date("2026-09-04T00:00:00.000Z"),
  });
  try {
    writeFileSync(readyPath, "ready\n", { encoding: "utf-8" });
    for (let attempt = 0; attempt < 3_000 && !existsSync(goPath); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    expect(existsSync(goPath)).toBe(true);
    let outcome: Readonly<Record<string, unknown>>;
    try {
      const result = storage.advanceDurableWorkflow(request);
      outcome = {
        kind: result.kind,
        transitionCount: result.view.transitionCount,
        operationId:
          result.kind === "TRANSITION_RECORDED"
            ? result.transition.operationId
            : null,
      };
    } catch (error) {
      if (!(error instanceof TaskStorageError)) {
        throw error;
      }
      outcome = { kind: "ERROR", code: error.code };
    }
    writeFileSync(outcomePath, `${JSON.stringify(outcome)}\n`, {
      encoding: "utf-8",
    });
  } finally {
    storage.close();
  }
});
