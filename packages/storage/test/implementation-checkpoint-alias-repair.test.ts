import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SubtaskIdSchema } from "@codex-task-console/domain";
import type {
  SubtaskId,
  SubtaskImplementationCheckpoint,
  SubtaskMaturity,
  SubtaskStatus,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  FIXED_TIME,
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeImplementationCheckpoint,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const TARGET = "st_alias_target" as SubtaskId;
const APPLICATION_TABLES = [
  "projects",
  "big_tasks",
  "subtasks",
  "task_dependencies",
  "subtask_implementation_checkpoints",
  "context_items",
  "context_digests",
  "audit_events",
] as const;

type ApplicationSnapshot = Readonly<
  Record<string, readonly Record<string, unknown>[]>
>;

const applicationSnapshot = (databasePath: string): ApplicationSnapshot => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      APPLICATION_TABLES.map((table) => [
        table,
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    sqlite.close();
  }
};

const seedTarget = (
  databasePath: string,
  target = TARGET,
  status: SubtaskStatus = "IN_PROGRESS",
): void => {
  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  storage.createProject(makeProject("prj_alias", "alias"));
  storage.createBigTask(makeBigTask("bt_alias", "prj_alias"));
  storage.createSubtask(makeSubtask(target, "bt_alias", status));
  storage.close();
};

const insertCheckpointWithConnection = (
  sqlite: DatabaseSync,
  checkpoint: SubtaskImplementationCheckpoint,
  rawSubtaskId = checkpoint.subtaskId as string,
): void => {
  sqlite
    .prepare(
      `INSERT INTO subtask_implementation_checkpoints
        (id, subtask_id, repository_commit_sha, actor_type, actor_reference,
         source_reference, summary, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      checkpoint.id,
      rawSubtaskId,
      checkpoint.repositoryCommitSha,
      checkpoint.actorType,
      checkpoint.actorReference ?? null,
      checkpoint.sourceReference,
      checkpoint.summary,
      checkpoint.occurredAt,
      FIXED_TIME,
    );
};

const insertCheckpoint = (
  databasePath: string,
  checkpoint: SubtaskImplementationCheckpoint,
  rawSubtaskId = checkpoint.subtaskId as string,
): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec("PRAGMA foreign_keys = OFF");
    insertCheckpointWithConnection(sqlite, checkpoint, rawSubtaskId);
  } finally {
    sqlite.close();
  }
};

const setSubtaskState = (
  databasePath: string,
  subtaskId: string,
  status: SubtaskStatus,
  maturity: SubtaskMaturity,
): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite
      .prepare("UPDATE subtasks SET status = ?, maturity = ? WHERE id = ?")
      .run(status, maturity, subtaskId);
  } finally {
    sqlite.close();
  }
};

const expectMalformed = (
  operation: () => unknown,
  privateRawValue?: string,
): void => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe("MALFORMED_STORED_DATA");
  expect(error.message).toBe("Stored task data is malformed.");
  expect(error.message).not.toMatch(
    /SQLite|\bSQL\b|subtask_implementation_checkpoints|subtask_id|constraint|\/Users\/|Zod|stack/i,
  );
  if (privateRawValue !== undefined) {
    expect(error.message).not.toContain(privateRawValue);
  }
};

const expectSnapshotUnchanged = (
  databasePath: string,
  before: ApplicationSnapshot,
): void => {
  expect(applicationSnapshot(databasePath)).toEqual(before);
};

const complete = (
  storage: TaskStorage,
  checkpoint: SubtaskImplementationCheckpoint,
  subtaskId = checkpoint.subtaskId,
) => storage.completeSubtaskImplementation({ subtaskId, checkpoint });

const TARGET_ALIASES = [
  ["leading SPACE", ` ${TARGET}`],
  ["trailing SPACE", `${TARGET} `],
  ["TAB", `\t${TARGET}\t`],
  ["CR", `\r${TARGET}\r`],
  ["LF", `\n${TARGET}\n`],
  ["CRLF", `\r\n${TARGET}\r\n`],
  ["NBSP", `\u00a0${TARGET}\u00a0`],
  ["EM SPACE", `\u2003${TARGET}\u2003`],
  ["BOM", `\ufeff${TARGET}\ufeff`],
] as const;

describe("S1B2a target checkpoint alias repair", () => {
  it.each(TARGET_ALIASES)(
    "fails closed across exact, list, and same/different-ID completion for %s",
    (_label, rawAlias) => {
      withTemporaryDatabasePath((databasePath) => {
        seedTarget(databasePath);
        expect(SubtaskIdSchema.parse(rawAlias)).toBe(TARGET);
        expect(rawAlias).not.toBe(TARGET);
        const existing = makeImplementationCheckpoint(
          "icp_alias_existing",
          TARGET,
        );
        insertCheckpoint(databasePath, existing, rawAlias);
        const before = applicationSnapshot(databasePath);

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expectMalformed(
          () => storage.getSubtaskImplementationCheckpointById(existing.id),
          rawAlias,
        );
        expectSnapshotUnchanged(databasePath, before);
        expectMalformed(
          () => storage.listSubtaskImplementationCheckpoints(TARGET),
          rawAlias,
        );
        expectSnapshotUnchanged(databasePath, before);
        expectMalformed(
          () =>
            complete(
              storage,
              makeImplementationCheckpoint("icp_alias_different", TARGET),
            ),
          rawAlias,
        );
        expectSnapshotUnchanged(databasePath, before);
        expectMalformed(
          () => complete(storage, makeImplementationCheckpoint(existing.id, TARGET)),
          rawAlias,
        );
        expectSnapshotUnchanged(databasePath, before);
        storage.close();
      });
    },
  );

  it("rejects a partial list when canonical rows coexist with a target alias", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedTarget(databasePath);
      setSubtaskState(databasePath, TARGET, "QA_DEBUG", "IMPLEMENTED");
      const canonicalA = makeImplementationCheckpoint("icp_canonical_a", TARGET);
      const canonicalB = makeImplementationCheckpoint("icp_canonical_b", TARGET, {
        occurredAt: "2026-08-10T00:00:00.000Z",
      });
      const alias = makeImplementationCheckpoint("icp_partial_alias", TARGET);
      insertCheckpoint(databasePath, canonicalA);
      insertCheckpoint(databasePath, canonicalB);
      insertCheckpoint(databasePath, alias, `\u00a0${TARGET}\u00a0`);
      const before = applicationSnapshot(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.getSubtaskImplementationCheckpointById(canonicalA.id)).toEqual(
        canonicalA,
      );
      expectMalformed(() => storage.getSubtaskImplementationCheckpointById(alias.id));
      expectMalformed(() => storage.listSubtaskImplementationCheckpoints(TARGET));
      expectSnapshotUnchanged(databasePath, before);
      storage.close();
    });
  });

  it.each([
    {
      label: "two raw aliases",
      rows: [
        makeImplementationCheckpoint("icp_two_alias_a", TARGET),
        makeImplementationCheckpoint("icp_two_alias_b", TARGET, {
          occurredAt: "2026-08-10T00:00:00.000Z",
        }),
      ],
      rawIds: [` ${TARGET}`, `\t${TARGET}\t`],
    },
    {
      label: "canonical plus alias",
      rows: [
        makeImplementationCheckpoint("icp_canonical_existing", TARGET),
        makeImplementationCheckpoint("icp_alias_existing", TARGET),
      ],
      rawIds: [TARGET, `\u2003${TARGET}\u2003`],
    },
    {
      label: "alias with different SHA and time",
      rows: [
        makeImplementationCheckpoint("icp_variant_alias", TARGET, {
          repositoryCommitSha: "b".repeat(64),
          occurredAt: "2000-01-01T00:00:00.000Z",
        }),
      ],
      rawIds: [`\r\n${TARGET}\r\n`],
    },
  ])("rejects initial completion with $label", ({ rows, rawIds }) => {
    withTemporaryDatabasePath((databasePath) => {
      seedTarget(databasePath);
      rows.forEach((row, index) =>
        insertCheckpoint(databasePath, row, rawIds[index]),
      );
      const before = applicationSnapshot(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectMalformed(() =>
        complete(
          storage,
          makeImplementationCheckpoint("icp_variant_attempt", TARGET, {
            repositoryCommitSha: "c".repeat(40),
            occurredAt: "2099-01-01T00:00:00.000Z",
          }),
        ),
      );
      expectSnapshotUnchanged(databasePath, before);
      storage.close();
    });
  });
});

describe("S1B2a checkpoint alias scope isolation", () => {
  it.each(["same Big Task", "another Big Task", "another Project"] as const)(
    "keeps an alias in %s relevant only to its canonical target",
    (placement) => {
      withTemporaryDatabasePath((databasePath) => {
        const targetA = `st_isolation_a_${placement.replaceAll(" ", "_").toLowerCase()}` as SubtaskId;
        const targetB = `st_isolation_b_${placement.replaceAll(" ", "_").toLowerCase()}` as SubtaskId;
        const targetC = `st_isolation_c_${placement.replaceAll(" ", "_").toLowerCase()}` as SubtaskId;
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        storage.createProject(makeProject("prj_isolation", "isolation"));
        storage.createBigTask(makeBigTask("bt_isolation", "prj_isolation"));
        let bBigTask = "bt_isolation";
        if (placement === "another Big Task") {
          bBigTask = "bt_isolation_other";
          storage.createBigTask(makeBigTask(bBigTask, "prj_isolation"));
        } else if (placement === "another Project") {
          storage.createProject(makeProject("prj_isolation_other", "isolation-other"));
          bBigTask = "bt_isolation_other_project";
          storage.createBigTask(makeBigTask(bBigTask, "prj_isolation_other"));
        }
        storage.createSubtask(makeSubtask(targetA, "bt_isolation", "IN_PROGRESS"));
        storage.createSubtask(makeSubtask(targetB, bBigTask, "IN_PROGRESS"));
        storage.createSubtask(makeSubtask(targetC, "bt_isolation", "IN_PROGRESS"));
        storage.close();

        const aliasB = makeImplementationCheckpoint("icp_isolation_b", targetB);
        const malformedC = makeImplementationCheckpoint("icp_isolation_c", targetC);
        insertCheckpoint(databasePath, aliasB, ` ${targetB} `);
        insertCheckpoint(databasePath, malformedC, "not_a_subtask_id");

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(reopened.listSubtaskImplementationCheckpoints(targetA)).toEqual([]);
        const checkpointA = makeImplementationCheckpoint("icp_isolation_a", targetA);
        expect(complete(reopened, checkpointA, targetA)).toMatchObject({
          checkpoint: checkpointA,
        });
        expect(reopened.listSubtaskImplementationCheckpoints(targetA)).toEqual([
          checkpointA,
        ]);
        const afterA = applicationSnapshot(databasePath);

        expectMalformed(() =>
          reopened.getSubtaskImplementationCheckpointById(aliasB.id),
        );
        expectMalformed(() =>
          reopened.getSubtaskImplementationCheckpointById(malformedC.id),
        );
        expectMalformed(() => reopened.listSubtaskImplementationCheckpoints(targetB));
        expectMalformed(() =>
          complete(
            reopened,
            makeImplementationCheckpoint("icp_isolation_b_attempt", targetB),
            targetB,
          ),
        );
        expectSnapshotUnchanged(databasePath, afterA);
        reopened.close();
      });
    },
  );

  it.each([
    ["unparseable", "not-a-valid-subtask"],
    ["wrong branded prefix", "bt_wrong_brand"],
    ["different canonical Subtask alias", " st_other_canonical "],
  ] as const)("ignores unrelated %s checkpoint ownership", (_label, rawSubtaskId) => {
    withTemporaryDatabasePath((databasePath) => {
      seedTarget(databasePath);
      const unrelated = makeImplementationCheckpoint("icp_unrelated_malformed", TARGET);
      insertCheckpoint(databasePath, unrelated, rawSubtaskId);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.listSubtaskImplementationCheckpoints(TARGET)).toEqual([]);
      const targetCheckpoint = makeImplementationCheckpoint(
        "icp_unrelated_target",
        TARGET,
      );
      expect(complete(storage, targetCheckpoint)).toMatchObject({
        checkpoint: targetCheckpoint,
      });
      const afterCompletion = applicationSnapshot(databasePath);
      expectMalformed(() =>
        storage.getSubtaskImplementationCheckpointById(unrelated.id),
      );
      expectSnapshotUnchanged(databasePath, afterCompletion);
      storage.close();
    });
  });
});

const commitAfterTargetRead = <T>(writer: DatabaseSync, operation: () => T): T => {
  const prototype = StatementSync.prototype as unknown as {
    get: (...parameters: unknown[]) => unknown;
    readonly sourceSQL: string;
  };
  const originalGet = prototype.get;
  let commits = 0;
  prototype.get = function (...parameters: unknown[]): unknown {
    const result = Reflect.apply(originalGet, this, parameters);
    if (commits === 0 && /from\s+"?subtasks"?/i.test(this.sourceSQL)) {
      writer.exec("COMMIT");
      commits += 1;
    }
    return result;
  };
  try {
    const result = operation();
    expect(commits).toBe(1);
    return result;
  } finally {
    prototype.get = originalGet;
  }
};

describe("S1B2a checkpoint alias transaction and snapshot placement", () => {
  it("keeps target validation and alias detection in one write transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedTarget(databasePath);
      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 0");
      const alias = makeImplementationCheckpoint("icp_interleaved_alias", TARGET);
      const prototype = StatementSync.prototype as unknown as {
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalGet = prototype.get;
      let attempted = 0;
      let insertionError: unknown;
      prototype.get = function (...parameters: unknown[]): unknown {
        const result = Reflect.apply(originalGet, this, parameters);
        if (attempted === 0 && /from\s+"?subtasks"?/i.test(this.sourceSQL)) {
          attempted += 1;
          try {
            insertCheckpointWithConnection(writer, alias, ` ${TARGET} `);
          } catch (error) {
            insertionError = error;
          }
        }
        return result;
      };
      const completed = makeImplementationCheckpoint("icp_atomic_completion", TARGET);
      try {
        expect(complete(storage, completed)).toMatchObject({ checkpoint: completed });
      } finally {
        prototype.get = originalGet;
        writer.close();
        storage.close();
      }
      expect(attempted).toBe(1);
      expect(insertionError).toBeDefined();
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          sqlite
            .prepare(
              "SELECT id, subtask_id FROM subtask_implementation_checkpoints ORDER BY id",
            )
            .all(),
        ).toEqual([{ id: completed.id, subtask_id: TARGET }]);
      } finally {
        sqlite.close();
      }
    });
  });

  it.each(["canonical", "deleted"] as const)(
    "returns the old alias classification and then the complete new %s snapshot",
    (newState) => {
      withTemporaryDatabasePath((databasePath) => {
        seedTarget(databasePath);
        setSubtaskState(databasePath, TARGET, "QA_DEBUG", "IMPLEMENTED");
        const checkpoint = makeImplementationCheckpoint("icp_snapshot_alias", TARGET);
        insertCheckpoint(databasePath, checkpoint, ` ${TARGET} `);
        const journal = new DatabaseSync(databasePath);
        journal.exec("PRAGMA journal_mode = WAL");
        journal.close();

        const reader = openTaskDatabase({ databasePath, clock: fixedClock });
        const writer = new DatabaseSync(databasePath);
        writer.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
        if (newState === "canonical") {
          writer
            .prepare(
              "UPDATE subtask_implementation_checkpoints SET subtask_id = ? WHERE id = ?",
            )
            .run(TARGET, checkpoint.id);
        } else {
          writer
            .prepare("DELETE FROM subtask_implementation_checkpoints WHERE id = ?")
            .run(checkpoint.id);
        }
        try {
          expectMalformed(() =>
            commitAfterTargetRead(writer, () =>
              reader.listSubtaskImplementationCheckpoints(TARGET),
            ),
          );
          expect(
            reader.listSubtaskImplementationCheckpoints(TARGET),
          ).toEqual(newState === "canonical" ? [checkpoint] : []);
        } finally {
          if (writer.isTransaction) {
            writer.exec("ROLLBACK");
          }
          writer.close();
          reader.close();
        }
      });
    },
  );

  it("observes a committed alias as one complete new read snapshot", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedTarget(databasePath);
      setSubtaskState(databasePath, TARGET, "QA_DEBUG", "IMPLEMENTED");
      const checkpoint = makeImplementationCheckpoint("icp_snapshot_new_alias", TARGET);
      insertCheckpoint(databasePath, checkpoint);
      const writer = new DatabaseSync(databasePath);
      writer.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      writer
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET subtask_id = ? WHERE id = ?",
        )
        .run(`\u00a0${TARGET}\u00a0`, checkpoint.id);
      writer.exec("COMMIT");
      writer.close();
      const before = applicationSnapshot(databasePath);

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      expectMalformed(() => reader.listSubtaskImplementationCheckpoints(TARGET));
      reader.close();
      expectSnapshotUnchanged(databasePath, before);
    });
  });
});

describe("S1B2a checkpoint alias scale boundary", () => {
  it.each([257, 2_049, 8_193])(
    "detects target aliases and isolates unrelated aliases across %i unrelated rows",
    (size) => {
      withTemporaryDatabasePath((databasePath) => {
        const cleanTarget = "st_scale_clean" as SubtaskId;
        const aliasTarget = "st_scale_alias" as SubtaskId;
        const unrelatedTarget = "st_scale_unrelated" as SubtaskId;
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        setup.createProject(makeProject("prj_scale_alias", "scale-alias"));
        setup.createBigTask(makeBigTask("bt_scale_alias", "prj_scale_alias"));
        setup.createSubtask(
          makeSubtask(cleanTarget, "bt_scale_alias", "IN_PROGRESS"),
        );
        setup.createSubtask(
          makeSubtask(aliasTarget, "bt_scale_alias", "IN_PROGRESS"),
        );
        setup.createSubtask(
          makeSubtask(unrelatedTarget, "bt_scale_alias", "QA_DEBUG"),
        );
        setup.close();
        setSubtaskState(
          databasePath,
          unrelatedTarget,
          "QA_DEBUG",
          "IMPLEMENTED",
        );

        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("PRAGMA foreign_keys = OFF; BEGIN");
        try {
          for (let index = 0; index < size; index += 1) {
            insertCheckpointWithConnection(
              sqlite,
              makeImplementationCheckpoint(
                `icp_scale_alias_${size}_${index.toString().padStart(5, "0")}`,
                unrelatedTarget,
              ),
              ` ${unrelatedTarget} `,
            );
          }
          insertCheckpointWithConnection(
            sqlite,
            makeImplementationCheckpoint("icp_scale_target_alias", aliasTarget),
            `\u2003${aliasTarget}\u2003`,
          );
          sqlite.exec("COMMIT");
        } catch (error) {
          if (sqlite.isTransaction) {
            sqlite.exec("ROLLBACK");
          }
          throw error;
        } finally {
          sqlite.close();
        }

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(storage.listSubtaskImplementationCheckpoints(cleanTarget)).toEqual([]);
        const cleanCheckpoint = makeImplementationCheckpoint(
          "icp_scale_clean_completion",
          cleanTarget,
        );
        expect(complete(storage, cleanCheckpoint, cleanTarget)).toMatchObject({
          checkpoint: cleanCheckpoint,
        });
        expect(storage.listSubtaskImplementationCheckpoints(cleanTarget)).toEqual([
          cleanCheckpoint,
        ]);
        const beforeRejectedReads = applicationSnapshot(databasePath);
        expectMalformed(() =>
          storage.listSubtaskImplementationCheckpoints(unrelatedTarget),
        );
        expectMalformed(() =>
          storage.listSubtaskImplementationCheckpoints(aliasTarget),
        );
        expectMalformed(() =>
          complete(
            storage,
            makeImplementationCheckpoint("icp_scale_alias_attempt", aliasTarget),
            aliasTarget,
          ),
        );
        expectSnapshotUnchanged(databasePath, beforeRejectedReads);
        storage.close();
      });
    },
    15_000,
  );
});
