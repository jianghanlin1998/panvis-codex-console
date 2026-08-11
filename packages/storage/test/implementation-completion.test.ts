import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type {
  SubtaskId,
  SubtaskImplementationCheckpoint,
  SubtaskImplementationCheckpointId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type {
  CompleteSubtaskImplementationInput,
  TaskStorage,
} from "../src/index.js";
import {
  FIXED_TIME,
  captureTaskStorageError,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeContextItem,
  makeDependency,
  makeImplementationCheckpoint,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const createImplementationHierarchy = (
  storage: TaskStorage,
  targetStatus: "TODO" | "IN_PROGRESS" | "QA_DEBUG" = "IN_PROGRESS",
): void => {
  storage.createProject(makeProject());
  storage.createBigTask(makeBigTask());
  storage.createSubtask(makeSubtask("st_a", "bt_v1", targetStatus));
};

const completionInput = (
  checkpoint = makeImplementationCheckpoint(),
  subtaskId = "st_a" as SubtaskId,
): CompleteSubtaskImplementationInput => ({ subtaskId, checkpoint });

const readStoredSubtaskState = (
  databasePath: string,
  subtaskId = "st_a",
): {
  readonly status: string;
  readonly maturity: string;
  readonly created_at: string;
  readonly updated_at: string;
} => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite
      .prepare(
        "SELECT status, maturity, created_at, updated_at FROM subtasks WHERE id = ?",
      )
      .get(subtaskId) as {
      readonly status: string;
      readonly maturity: string;
      readonly created_at: string;
      readonly updated_at: string;
    };
  } finally {
    sqlite.close();
  }
};

const countCheckpoints = (databasePath: string): number => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = sqlite
      .prepare("SELECT count(*) AS count FROM subtask_implementation_checkpoints")
      .get() as { readonly count: number };
    return row.count;
  } finally {
    sqlite.close();
  }
};

describe("durable Subtask implementation completion", () => {
  it("atomically persists the exact lifecycle boundary and leaves unrelated state unchanged", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date("2026-08-10T00:00:00.000Z"),
      });
      createImplementationHierarchy(storage);
      storage.createSubtask(makeSubtask("st_b"));
      const dependency = makeDependency(
        "st_b",
        "st_a",
        "BLOCKING",
        "ACCEPTED",
        "Upstream acceptance remains required.",
      );
      storage.replaceDependenciesForBigTask(makeBigTask().id, [dependency]);
      const scope = {
        scopeType: "SUBTASK" as const,
        projectId: makeProject().id,
        bigTaskId: makeBigTask().id,
        subtaskId: makeSubtask().id,
      };
      const contextItem = makeContextItem("ctx_completion", scope);
      const contextDigest = makeContextDigest("dgt_completion", scope);
      const auditEvent = makeAuditEvent("aud_completion", scope);
      storage.createContextItem(contextItem);
      storage.createContextDigest(contextDigest);
      storage.appendAuditEvent(auditEvent);

      const before = readStoredSubtaskState(databasePath);
      const checkpoint = makeImplementationCheckpoint(
        "icp_exact_completion",
        "st_a",
        {
          repositoryCommitSha: "0123456789abcdef".repeat(4),
          actorType: "HUMAN",
          actorReference: "hanlin",
          sourceReference: "codex-task://s1b2a",
          summary: "Completed the approved initial implementation.",
          occurredAt: "2026-08-10T09:30:00+09:00",
        },
      );

      const result = storage.completeSubtaskImplementation(
        completionInput(checkpoint),
      );
      expect(result).toEqual({
        subtask: {
          ...makeSubtask("st_a", "bt_v1", "IN_PROGRESS"),
          status: "QA_DEBUG",
          maturity: "IMPLEMENTED",
        },
        checkpoint,
      });
      expect(storage.getSubtaskImplementationCheckpointById(checkpoint.id)).toEqual(
        checkpoint,
      );
      expect(storage.listSubtaskImplementationCheckpoints(checkpoint.subtaskId)).toEqual([
        checkpoint,
      ]);

      const after = readStoredSubtaskState(databasePath);
      expect(after).toMatchObject({ status: "QA_DEBUG", maturity: "IMPLEMENTED" });
      expect(after.created_at).toBe(before.created_at);
      expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
        new Date(before.updated_at).getTime(),
      );
      expect(storage.getProjectById(makeProject().id)).toEqual(makeProject());
      expect(storage.getBigTaskById(makeBigTask().id)).toEqual(makeBigTask());
      expect(storage.getSubtaskById(makeSubtask("st_b").id)).toEqual(
        makeSubtask("st_b"),
      );
      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual([
        dependency,
      ]);
      expect(storage.getContextItemById(contextItem.id)).toEqual(contextItem);
      expect(storage.getContextDigestById(contextDigest.id)).toEqual(contextDigest);
      expect(storage.listAuditEventsByScope(scope)).toEqual([auditEvent]);
      storage.close();
    });
  });

  it.each([
    ["forward", "2026-08-10T00:00:00.000Z"],
    ["same-time", FIXED_TIME],
    ["backward", "2026-08-08T00:00:00.000Z"],
  ] as const)(
    "strictly advances updated_at with a %s clock",
    (_caseName, completionTime) => {
      withTemporaryDatabasePath((databasePath) => {
        const initial = openTaskDatabase({ databasePath, clock: fixedClock });
        createImplementationHierarchy(initial);
        initial.close();
        const before = readStoredSubtaskState(databasePath);

        const completion = openTaskDatabase({
          databasePath,
          clock: () => new Date(completionTime),
        });
        completion.completeSubtaskImplementation(completionInput());
        completion.close();

        const after = readStoredSubtaskState(databasePath);
        expect(after.created_at).toBe(before.created_at);
        expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
          new Date(before.updated_at).getTime(),
        );
      });
    },
  );

  it.each([
    ["TODO", "NOT_STARTED"],
    ["QA_DEBUG", "NOT_STARTED"],
    ["IN_PROGRESS", "IMPLEMENTED"],
  ] as const)(
    "rejects unsupported starting state %s + %s without partial state",
    (status, maturity) => {
      withTemporaryDatabasePath((databasePath) => {
        const initial = openTaskDatabase({ databasePath, clock: fixedClock });
        createImplementationHierarchy(initial, status);
        initial.close();
        if (maturity !== "NOT_STARTED") {
          const sqlite = new DatabaseSync(databasePath);
          sqlite
            .prepare("UPDATE subtasks SET maturity = ? WHERE id = ?")
            .run(maturity, "st_a");
          sqlite.close();
        }
        const before = readStoredSubtaskState(databasePath);

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        const error = captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(completionInput()),
        );
        expect(error.code).toBe("CONFLICT");
        expect(storage.listSubtaskImplementationCheckpoints("st_a" as SubtaskId)).toEqual(
          [],
        );
        expect(storage.getSubtaskById("st_a" as SubtaskId)).not.toBeNull();
        storage.close();

        expect(readStoredSubtaskState(databasePath)).toEqual(before);
        expect(countCheckpoints(databasePath)).toBe(0);
      });
    },
  );

  it("rejects missing and mismatched targets without creating evidence", () => {
    withMemoryStorage((storage) => {
      createImplementationHierarchy(storage);
      expect(
        captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(
            completionInput(
              makeImplementationCheckpoint("icp_missing", "st_missing"),
              "st_missing" as SubtaskId,
            ),
          ),
        ).code,
      ).toBe("PARENT_NOT_FOUND");
      expect(
        captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(
            completionInput(
              makeImplementationCheckpoint("icp_mismatch", "st_other"),
            ),
          ),
        ).code,
      ).toBe("CONFLICT");
      expect(storage.listSubtaskImplementationCheckpoints("st_a" as SubtaskId)).toEqual(
        [],
      );
      expect(storage.getSubtaskById("st_a" as SubtaskId)).toEqual(
        makeSubtask("st_a", "bt_v1", "IN_PROGRESS"),
      );
    });
  });

  it("rejects duplicate checkpoint IDs and repeated completion without extra rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      storage.createSubtask(makeSubtask("st_a", "bt_v1", "IN_PROGRESS"));
      storage.createSubtask(makeSubtask("st_b", "bt_v1", "IN_PROGRESS"));
      const duplicateId = "icp_duplicate";
      storage.completeSubtaskImplementation(
        completionInput(
          makeImplementationCheckpoint(duplicateId, "st_b"),
          "st_b" as SubtaskId,
        ),
      );
      const targetBefore = readStoredSubtaskState(databasePath);

      expect(
        captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(
            completionInput(makeImplementationCheckpoint(duplicateId, "st_a")),
          ),
        ).code,
      ).toBe("CONFLICT");
      expect(readStoredSubtaskState(databasePath)).toEqual(targetBefore);
      expect(countCheckpoints(databasePath)).toBe(1);

      const firstCheckpoint = makeImplementationCheckpoint("icp_first", "st_a");
      storage.completeSubtaskImplementation(completionInput(firstCheckpoint));
      expect(
        captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(completionInput(firstCheckpoint)),
        ).code,
      ).toBe("CONFLICT");
      expect(countCheckpoints(databasePath)).toBe(2);
      expect(storage.getProjectById(makeProject().id)).toEqual(makeProject());
      storage.close();
    });
  });

  it("rejects malformed caller input and closed storage through sanitized contracts", () => {
    withMemoryStorage((storage) => {
      createImplementationHierarchy(storage);
      const invalidInputs = [
        {
          ...completionInput(),
          subtaskId: " st_a" as SubtaskId,
        },
        completionInput({
          ...makeImplementationCheckpoint(),
          id: "aud_wrong" as SubtaskImplementationCheckpointId,
        }),
        completionInput({
          ...makeImplementationCheckpoint(),
          repositoryCommitSha: "A".repeat(40),
        } as SubtaskImplementationCheckpoint),
        {
          ...completionInput(),
          unexpected: true,
        } as CompleteSubtaskImplementationInput,
      ];
      for (const input of invalidInputs) {
        const error = captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(input),
        );
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).not.toMatch(/sqlite|sql|zod|subtasks|checkpoint.*table/i);
      }
      expect(storage.listSubtaskImplementationCheckpoints("st_a" as SubtaskId)).toEqual(
        [],
      );
      storage.close();
      expect(
        captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(completionInput()),
        ).code,
      ).toBe("DATABASE_CLOSED");
    });
  });

  it("uses a savepoint inside caller-owned transactions", () => {
    withMemoryStorage((storage) => {
      createImplementationHierarchy(storage);
      expect(() =>
        storage.runInTransaction((transaction) => {
          transaction.completeSubtaskImplementation(completionInput());
          throw new Error("roll back the caller transaction");
        }),
      ).toThrow(expect.objectContaining({ code: "TRANSACTION_FAILED" }));
      expect(storage.getSubtaskById("st_a" as SubtaskId)).toEqual(
        makeSubtask("st_a", "bt_v1", "IN_PROGRESS"),
      );
      expect(storage.listSubtaskImplementationCheckpoints("st_a" as SubtaskId)).toEqual(
        [],
      );

      storage.runInTransaction((transaction) => {
        transaction.createProject(makeProject("prj_outer", "outer"));
        const error = captureTaskStorageError(() =>
          transaction.completeSubtaskImplementation(
            completionInput(
              makeImplementationCheckpoint("icp_mismatch", "st_other"),
            ),
          ),
        );
        expect(error.code).toBe("CONFLICT");
      });
      expect(storage.getProjectById(makeProject("prj_outer", "outer").id)).toEqual(
        makeProject("prj_outer", "outer"),
      );
      expect(storage.getSubtaskById("st_a" as SubtaskId)).toEqual(
        makeSubtask("st_a", "bt_v1", "IN_PROGRESS"),
      );
      expect(storage.listSubtaskImplementationCheckpoints("st_a" as SubtaskId)).toEqual(
        [],
      );
    });
  });

  it("rolls back checkpoint insertion when a later target update fails", () => {
    withTemporaryDatabasePath((databasePath) => {
      const initial = openTaskDatabase({ databasePath, clock: fixedClock });
      createImplementationHierarchy(initial);
      initial.close();
      const before = readStoredSubtaskState(databasePath);

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(`
        CREATE TRIGGER reject_implementation_completion
        BEFORE UPDATE OF status ON subtasks
        WHEN NEW.status = 'QA_DEBUG'
        BEGIN
          SELECT RAISE(ABORT, 'private trigger detail');
        END
      `);
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const error = captureTaskStorageError(() =>
        storage.completeSubtaskImplementation(completionInput()),
      );
      expect(error.code).toBe("TRANSACTION_FAILED");
      expect(error.message).not.toMatch(/trigger|sqlite|sql|subtasks|checkpoint/i);
      expect(storage.getProjectById(makeProject().id)).toEqual(makeProject());
      storage.close();

      expect(readStoredSubtaskState(databasePath)).toEqual(before);
      expect(countCheckpoints(databasePath)).toBe(0);
    });
  });

  it("fails closed for a malformed relevant durable parent hierarchy", () => {
    withTemporaryDatabasePath((databasePath) => {
      const initial = openTaskDatabase({ databasePath, clock: fixedClock });
      createImplementationHierarchy(initial);
      initial.close();
      const before = readStoredSubtaskState(databasePath);

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite
        .prepare("UPDATE big_tasks SET project_id = ? WHERE id = ?")
        .run("prj_missing", "bt_v1");
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(
        captureTaskStorageError(() =>
          storage.completeSubtaskImplementation(completionInput()),
        ).code,
      ).toBe("MALFORMED_STORED_DATA");
      storage.close();
      expect(readStoredSubtaskState(databasePath)).toEqual(before);
      expect(countCheckpoints(databasePath)).toBe(0);
    });
  });
});

describe("Implementation Checkpoint durable reads", () => {
  it("orders canonical evidence deterministically and preserves it after reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createImplementationHierarchy(storage);
      const first = makeImplementationCheckpoint("icp_b", "st_a", {
        occurredAt: "2026-08-11T01:00:00.000Z",
      });
      storage.completeSubtaskImplementation(completionInput(first));
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      const insert = sqlite.prepare(
        `INSERT INTO subtask_implementation_checkpoints
          (id, subtask_id, repository_commit_sha, actor_type, actor_reference,
           source_reference, summary, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const checkpoint of [
        makeImplementationCheckpoint("icp_c", "st_a", {
          occurredAt: "2026-08-11T00:00:00.000Z",
        }),
        makeImplementationCheckpoint("icp_a", "st_a", {
          occurredAt: "2026-08-11T01:00:00.000Z",
        }),
      ]) {
        insert.run(
          checkpoint.id,
          checkpoint.subtaskId,
          checkpoint.repositoryCommitSha,
          checkpoint.actorType,
          checkpoint.actorReference ?? null,
          checkpoint.sourceReference,
          checkpoint.summary,
          checkpoint.occurredAt,
          FIXED_TIME,
        );
      }
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          reopened
            .listSubtaskImplementationCheckpoints("st_a" as SubtaskId)
            .map(({ id }) => id),
        ).toEqual(["icp_c", "icp_a", "icp_b"]);
        expect(reopened.getSubtaskImplementationCheckpointById(first.id)).toEqual(
          first,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed for noncanonical relevant evidence and malformed hierarchy", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createImplementationHierarchy(storage);
      const checkpoint = makeImplementationCheckpoint();
      storage.completeSubtaskImplementation(completionInput(checkpoint));
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET occurred_at = ? WHERE id = ?",
        )
        .run("2026-08-09T00:00:00Z", checkpoint.id);
      sqlite.close();

      const corrupted = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(() =>
        corrupted.getSubtaskImplementationCheckpointById(checkpoint.id),
      ).toThrow(expect.objectContaining({ code: "MALFORMED_STORED_DATA" }));
      expect(() =>
        corrupted.listSubtaskImplementationCheckpoints("st_a" as SubtaskId),
      ).toThrow(expect.objectContaining({ code: "MALFORMED_STORED_DATA" }));
      corrupted.close();

      const hierarchySqlite = new DatabaseSync(databasePath);
      hierarchySqlite
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET occurred_at = ? WHERE id = ?",
        )
        .run(FIXED_TIME, checkpoint.id);
      hierarchySqlite.exec("PRAGMA foreign_keys = OFF");
      hierarchySqlite
        .prepare("UPDATE big_tasks SET project_id = ? WHERE id = ?")
        .run("prj_missing", "bt_v1");
      hierarchySqlite.close();

      const malformedHierarchy = openTaskDatabase({
        databasePath,
        clock: fixedClock,
      });
      try {
        expect(() =>
          malformedHierarchy.getSubtaskImplementationCheckpointById(checkpoint.id),
        ).toThrow(expect.objectContaining({ code: "MALFORMED_STORED_DATA" }));
      } finally {
        malformedHierarchy.close();
      }
    });
  });

  it("isolates unrelated corrupted checkpoint evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      storage.createSubtask(makeSubtask("st_a", "bt_v1", "IN_PROGRESS"));
      storage.createSubtask(makeSubtask("st_b", "bt_v1", "IN_PROGRESS"));
      const target = makeImplementationCheckpoint("icp_target", "st_a");
      const unrelated = makeImplementationCheckpoint("icp_unrelated", "st_b");
      storage.completeSubtaskImplementation(completionInput(target));
      storage.completeSubtaskImplementation(
        completionInput(unrelated, "st_b" as SubtaskId),
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET repository_commit_sha = ? WHERE id = ?",
        )
        .run("INVALID", unrelated.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getSubtaskImplementationCheckpointById(target.id)).toEqual(
          target,
        );
        expect(
          reopened.listSubtaskImplementationCheckpoints("st_a" as SubtaskId),
        ).toEqual([target]);
        expect(() =>
          reopened.getSubtaskImplementationCheckpointById(unrelated.id),
        ).toThrow(expect.objectContaining({ code: "MALFORMED_STORED_DATA" }));
      } finally {
        reopened.close();
      }
    });
  });
});
