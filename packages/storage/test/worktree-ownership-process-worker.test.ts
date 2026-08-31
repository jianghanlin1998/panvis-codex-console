import { existsSync, writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { ProjectIdSchema, SubtaskIdSchema } from "@codex-task-console/domain";
import { openTaskDatabase, WorktreeOwnershipError } from "../src/index.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing process worker fixture field: ${name}`);
  }
  return value;
};

it("runs only as the bounded cross-process worktree reservation worker", () => {
  if (process.env.CTC_PROCESS_WORKER_ROLE === undefined) {
    expect(process.env.CTC_PROCESS_DATABASE_PATH).toBeUndefined();
    return;
  }

  const databasePath = requiredEnvironment("CTC_PROCESS_DATABASE_PATH");
  const repositoryPath = requiredEnvironment("CTC_PROCESS_REPOSITORY_PATH");
  const worktreeRoot = requiredEnvironment("CTC_PROCESS_WORKTREE_ROOT");
  const ownershipId = requiredEnvironment("CTC_PROCESS_OWNERSHIP_ID");
  const readyPath = requiredEnvironment("CTC_PROCESS_READY_PATH");
  const goPath = requiredEnvironment("CTC_PROCESS_GO_PATH");
  const outcomePath = requiredEnvironment("CTC_PROCESS_OUTCOME_PATH");
  const storage = openTaskDatabase({
    databasePath,
    clock: () => new Date("2026-09-01T03:04:05.000Z"),
  });
  try {
    const project = storage.getProjectById(ProjectIdSchema.parse("prj_hardening"));
    expect(project?.repository).toEqual({ kind: "PATH", path: repositoryPath });
    const manager = createWorktreeOwnershipManagerForTesting(storage, {
      worktreeRoot,
      idGenerator: () => ownershipId,
    });
    writeFileSync(readyPath, "ready\n", "utf8");
    for (let attempt = 0; attempt < 3_000 && !existsSync(goPath); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    expect(existsSync(goPath)).toBe(true);

    let outcome: "ACTIVE" | "OWNERSHIP_CONFLICT";
    try {
      const ownership = manager.provisionOwnedWorktreeForSubtask(
        SubtaskIdSchema.parse("st_hard_a"),
      );
      expect(ownership.status).toBe("ACTIVE");
      outcome = "ACTIVE";
    } catch (error) {
      expect(error).toBeInstanceOf(WorktreeOwnershipError);
      expect((error as WorktreeOwnershipError).code).toBe("OWNERSHIP_CONFLICT");
      outcome = "OWNERSHIP_CONFLICT";
    }
    writeFileSync(outcomePath, `${outcome}\n`, "utf8");
  } finally {
    storage.close();
  }
});
