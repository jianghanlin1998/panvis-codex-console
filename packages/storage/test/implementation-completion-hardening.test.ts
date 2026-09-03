import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ContextScopeSchema,
  SubtaskImplementationCheckpointSchema,
} from "@codex-task-console/domain";
import type {
  SubtaskId,
  SubtaskImplementationCheckpoint,
  SubtaskMaturity,
  SubtaskStatus,
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
  withTemporaryDatabasePath,
} from "./fixtures.js";

const TARGET = "st_hardening_target" as SubtaskId;
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

const acceptedS0B1Migration = fileURLToPath(
  new URL("../drizzle/20260809002701_public_mephisto", import.meta.url),
);
const acceptedS0B2aMigration = fileURLToPath(
  new URL("../drizzle/20260809150746_groovy_iron_monger", import.meta.url),
);
const acceptedS0B2bMigration = fileURLToPath(
  new URL("../drizzle/20260810133952_messy_shatterstar", import.meta.url),
);
const acceptedS1aMigration = fileURLToPath(
  new URL("../drizzle/20260810161248_crazy_lightspeed", import.meta.url),
);

const seedTarget = (storage: TaskStorage): void => {
  storage.createProject(makeProject("prj_hardening", "hardening"));
  storage.createBigTask(makeBigTask("bt_hardening", "prj_hardening"));
  storage.createSubtask(makeSubtask(TARGET, "bt_hardening", "IN_PROGRESS"));
};

const insertCheckpoint = (
  sqlite: DatabaseSync,
  checkpoint: ReturnType<typeof makeImplementationCheckpoint>,
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
      checkpoint.subtaskId,
      checkpoint.repositoryCommitSha,
      checkpoint.actorType,
      checkpoint.actorReference ?? null,
      checkpoint.sourceReference,
      checkpoint.summary,
      checkpoint.occurredAt,
      FIXED_TIME,
    );
};

const applicationSnapshot = (
  databasePath: string,
): Readonly<Record<string, readonly Record<string, unknown>[]>> => {
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

const expectSanitized = (
  operation: () => unknown,
  code?: string,
): ReturnType<typeof captureTaskStorageError> => {
  const error = captureTaskStorageError(operation);
  if (code !== undefined) {
    expect(error.code).toBe(code);
  }
  expect(error.message).not.toMatch(
    /SQLite|\bSQL\b|subtasks|big_tasks|projects|checkpoint.*table|constraint|trigger|private|\/Users\/|Zod|stack/i,
  );
  return error;
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

const complete = (
  storage: TaskStorage,
  checkpoint = makeImplementationCheckpoint("icp_hardening", TARGET),
  subtaskId = TARGET,
) => storage.completeSubtaskImplementation({ subtaskId, checkpoint });

const commitAfterRead = <T>(
  writer: DatabaseSync,
  table: string,
  operation: () => T,
): T => {
  const prototype = StatementSync.prototype as unknown as {
    get: (...parameters: unknown[]) => unknown;
    readonly sourceSQL: string;
  };
  const originalGet = prototype.get;
  let commits = 0;
  prototype.get = function (...parameters: unknown[]): unknown {
    const result = Reflect.apply(originalGet, this, parameters);
    if (
      commits === 0 &&
      new RegExp(`from\\s+"?${table}"?`, "i").test(this.sourceSQL)
    ) {
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

describe("S1B2a primary hardening reproductions", () => {
  it("fails closed instead of combining an old exact checkpoint with a repaired new hierarchy", () => {
    withTemporaryDatabasePath((databasePath) => {
      const checkpoint = makeImplementationCheckpoint(
        "icp_snapshot_exact",
        TARGET,
      );
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      setup.completeSubtaskImplementation({ subtaskId: TARGET, checkpoint });
      setup.close();

      const corrupt = new DatabaseSync(databasePath);
      corrupt.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF");
      corrupt
        .prepare("UPDATE big_tasks SET project_id = 'prj_missing' WHERE id = ?")
        .run("bt_hardening");
      corrupt.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      writer
        .prepare("UPDATE big_tasks SET project_id = 'prj_hardening' WHERE id = ?")
        .run("bt_hardening");
      writer
        .prepare("DELETE FROM subtask_implementation_checkpoints WHERE id = ?")
        .run(checkpoint.id);
      try {
        const error = captureTaskStorageError(() =>
          commitAfterRead(
            writer,
            "subtask_implementation_checkpoints",
            () => reader.getSubtaskImplementationCheckpointById(checkpoint.id),
          ),
        );
        expect(error.code).toBe("MALFORMED_STORED_DATA");
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("fails closed instead of combining an old hierarchy with newly repaired list evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const checkpoint = makeImplementationCheckpoint(
        "icp_snapshot_list",
        TARGET,
      );
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      setup.completeSubtaskImplementation({ subtaskId: TARGET, checkpoint });
      setup.close();

      const corrupt = new DatabaseSync(databasePath);
      corrupt.exec(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON",
      );
      corrupt
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET repository_commit_sha = 'INVALID' WHERE id = ?",
        )
        .run(checkpoint.id);
      corrupt.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      writer
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET repository_commit_sha = ? WHERE id = ?",
        )
        .run(checkpoint.repositoryCommitSha, checkpoint.id);
      writer
        .prepare("UPDATE big_tasks SET project_id = 'prj_missing' WHERE id = ?")
        .run("bt_hardening");
      try {
        const error = captureTaskStorageError(() =>
          commitAfterRead(writer, "projects", () =>
            reader.listSubtaskImplementationCheckpoints(TARGET),
          ),
        );
        expect(error.code).toBe("MALFORMED_STORED_DATA");
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("rejects a second completion when initial state already has checkpoint evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const existing = makeImplementationCheckpoint(
        "icp_corrupt_existing",
        TARGET,
      );
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      insertCheckpoint(sqlite, existing);
      const before = sqlite
        .prepare(
          "SELECT status, maturity, created_at, updated_at FROM subtasks WHERE id = ?",
        )
        .get(TARGET);
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const attempted = makeImplementationCheckpoint(
        "icp_corrupt_second",
        TARGET,
      );
      const error = captureTaskStorageError(() =>
        storage.completeSubtaskImplementation({
          subtaskId: TARGET,
          checkpoint: attempted,
        }),
      );
      expect(error.code).toBe("MALFORMED_STORED_DATA");
      storage.close();

      const verify = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          verify
            .prepare(
              "SELECT status, maturity, created_at, updated_at FROM subtasks WHERE id = ?",
            )
            .get(TARGET),
        ).toEqual(before);
        expect(
          verify
            .prepare(
              "SELECT id FROM subtask_implementation_checkpoints ORDER BY id",
            )
            .all(),
        ).toEqual([{ id: existing.id }]);
      } finally {
        verify.close();
      }
    });
  });

  it.each([
    {
      label: "Subtask ownership change plus evidence corruption",
      mutate: (writer: DatabaseSync, checkpointId: string) => {
        writer
          .prepare("UPDATE subtasks SET big_task_id = 'bt_snapshot_other' WHERE id = ?")
          .run(TARGET);
        writer
          .prepare(
            "UPDATE subtask_implementation_checkpoints SET repository_commit_sha = 'INVALID' WHERE id = ?",
          )
          .run(checkpointId);
      },
      deleted: false,
    },
    {
      label: "Big Task ownership change plus evidence corruption",
      mutate: (writer: DatabaseSync, checkpointId: string) => {
        writer
          .prepare("UPDATE big_tasks SET project_id = 'prj_snapshot_other' WHERE id = 'bt_hardening'")
          .run();
        writer
          .prepare(
            "UPDATE subtask_implementation_checkpoints SET summary = ' padded ' WHERE id = ?",
          )
          .run(checkpointId);
      },
      deleted: false,
    },
    {
      label: "checkpoint deletion",
      mutate: (writer: DatabaseSync, checkpointId: string) => {
        writer
          .prepare("DELETE FROM subtask_implementation_checkpoints WHERE id = ?")
          .run(checkpointId);
      },
      deleted: true,
    },
  ])("returns one coherent old snapshot across $label", ({ mutate, deleted }) => {
    withTemporaryDatabasePath((databasePath) => {
      const checkpoint = makeImplementationCheckpoint(
        "icp_snapshot_old_state",
        TARGET,
      );
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      setup.createProject(makeProject("prj_snapshot_other", "snapshot-other"));
      setup.createBigTask(
        makeBigTask("bt_snapshot_other", "prj_snapshot_other"),
      );
      complete(setup, checkpoint);
      setup.close();
      const journal = new DatabaseSync(databasePath);
      journal.exec(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON",
      );
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec(
        "PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; BEGIN IMMEDIATE",
      );
      mutate(writer, checkpoint.id);
      try {
        expect(
          commitAfterRead(
            writer,
            "subtask_implementation_checkpoints",
            () => reader.getSubtaskImplementationCheckpointById(checkpoint.id),
          ),
        ).toEqual(checkpoint);
        if (deleted) {
          expect(
            reader.getSubtaskImplementationCheckpointById(checkpoint.id),
          ).toBeNull();
        } else {
          expectSanitized(
            () => reader.getSubtaskImplementationCheckpointById(checkpoint.id),
            "MALFORMED_STORED_DATA",
          );
        }
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });
});

const STATUS_MATRIX: readonly SubtaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "QA_DEBUG",
  "DONE",
  "DROPPED",
  "ARCHIVED",
];
const MATURITY_MATRIX: readonly SubtaskMaturity[] = [
  "NOT_STARTED",
  "IMPLEMENTED",
  "HARDENED",
  "ACCEPTED",
];
const STARTING_STATES = STATUS_MATRIX.flatMap((status) =>
  MATURITY_MATRIX.map((maturity) => ({ status, maturity })),
);

describe("S1B2a complete status and maturity matrix", () => {
  it.each(STARTING_STATES)(
    "handles $status + $maturity without widening the initial boundary",
    ({ status, maturity }) => {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTarget(setup);
        setup.close();
        setSubtaskState(databasePath, TARGET, status, maturity);
        const before = applicationSnapshot(databasePath);

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        const checkpoint = makeImplementationCheckpoint(
          `icp_matrix_${status.toLowerCase()}_${maturity.toLowerCase()}`,
          TARGET,
        );
        if (status === "IN_PROGRESS" && maturity === "NOT_STARTED") {
          expect(complete(storage, checkpoint)).toEqual({
            subtask: {
              ...makeSubtask(TARGET, "bt_hardening", "IN_PROGRESS"),
              status: "QA_DEBUG",
              maturity: "IMPLEMENTED",
            },
            checkpoint,
          });
          expect(storage.listSubtaskImplementationCheckpoints(TARGET)).toEqual([
            checkpoint,
          ]);
        } else {
          expectSanitized(
            () => complete(storage, checkpoint),
            "CONFLICT",
          );
          expect(applicationSnapshot(databasePath)).toEqual(before);
          expect(storage.getProjectById(makeProject("prj_hardening").id)).toEqual(
            makeProject("prj_hardening", "hardening"),
          );
        }
        storage.close();
      });
    },
  );
});

describe("S1B2a public input canonicalization", () => {
  it("stores canonical text and timestamps produced by the domain contract", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(storage);
      const rawCheckpoint = {
        ...makeImplementationCheckpoint("icp_canonicalized", TARGET),
        actorReference: "\u00a0actor e\u0301\u00a0",
        sourceReference: "\r\nsource://実装🚀\t",
        summary: "  completed 🚀  ",
        occurredAt: "2026-08-11T09:30:00+09:00",
      };
      const expected = SubtaskImplementationCheckpointSchema.parse(rawCheckpoint);

      expect(
        storage.completeSubtaskImplementation({
          subtaskId: TARGET,
          checkpoint: rawCheckpoint as SubtaskImplementationCheckpoint,
        }),
      ).toMatchObject({ checkpoint: expected });
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          sqlite
            .prepare(
              "SELECT actor_reference, source_reference, summary, occurred_at FROM subtask_implementation_checkpoints WHERE id = ?",
            )
            .get(expected.id),
        ).toEqual({
          actor_reference: expected.actorReference,
          source_reference: expected.sourceReference,
          summary: expected.summary,
          occurred_at: expected.occurredAt,
        });
      } finally {
        sqlite.close();
      }
    });
  });

  it("rejects materially varied noncanonical input without state leakage", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(storage);
      const base = makeImplementationCheckpoint("icp_invalid_input", TARGET);
      const invalidInputs: readonly unknown[] = [
        { subtaskId: ` ${TARGET}`, checkpoint: base },
        { subtaskId: TARGET, checkpoint: { ...base, id: ` ${base.id}` } },
        { subtaskId: TARGET, checkpoint: { ...base, subtaskId: ` ${TARGET}` } },
        { subtaskId: TARGET, checkpoint: { ...base, repositoryCommitSha: "A".repeat(40) } },
        { subtaskId: TARGET, checkpoint: { ...base, repositoryCommitSha: `${"a".repeat(20)}\0${"a".repeat(19)}` } },
        { subtaskId: TARGET, checkpoint: { ...base, actorReference: "🚀".repeat(129) } },
        { subtaskId: TARGET, checkpoint: { ...base, sourceReference: `${"🚀".repeat(1_024)}x` } },
        { subtaskId: TARGET, checkpoint: { ...base, summary: `${"🚀".repeat(500)}x` } },
        { subtaskId: TARGET, checkpoint: { ...base, actorType: "AGENT" } },
        { subtaskId: TARGET, checkpoint: { ...base, sourceReference: "\r\n\t" } },
        { subtaskId: TARGET, checkpoint: { ...base, occurredAt: "2026-08-11T00:00:00" } },
        { subtaskId: TARGET, checkpoint: base, unexpected: true },
      ];
      const before = applicationSnapshot(databasePath);
      for (const input of invalidInputs) {
        expectSanitized(
          () =>
            storage.completeSubtaskImplementation(
              input as CompleteSubtaskImplementationInput,
            ),
          "INVALID_INPUT",
        );
        expect(applicationSnapshot(databasePath)).toEqual(before);
      }
      expect(storage.getSubtaskById(TARGET)).toEqual(
        makeSubtask(TARGET, "bt_hardening", "IN_PROGRESS"),
      );
      storage.close();
    });
  });
});

interface CorruptionCase {
  readonly label: string;
  readonly read: "EXACT" | "LIST";
  readonly corrupt: (sqlite: DatabaseSync, checkpointId: string) => void;
}

const STORED_CORRUPTIONS: readonly CorruptionCase[] = [
  {
    label: "noncanonical checkpoint ID",
    read: "LIST",
    corrupt: (sqlite, checkpointId) =>
      void sqlite
        .prepare("UPDATE subtask_implementation_checkpoints SET id = ? WHERE id = ?")
        .run(` ${checkpointId}`, checkpointId),
  },
  {
    label: "malformed referenced Subtask ID",
    read: "EXACT",
    corrupt: (sqlite, checkpointId) =>
      void sqlite
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET subtask_id = 'bad' WHERE id = ?",
        )
        .run(checkpointId),
  },
  ...[
    ["malformed SHA", "INVALID"],
    ["uppercase SHA", "A".repeat(40)],
    ["whitespace-bearing SHA", ` ${"a".repeat(40)}`],
  ].map(([label, value]) => ({
    label: label!,
    read: "EXACT" as const,
    corrupt: (sqlite: DatabaseSync, checkpointId: string) =>
      void sqlite
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET repository_commit_sha = ? WHERE id = ?",
        )
        .run(value!, checkpointId),
  })),
  {
    label: "malformed actor type",
    read: "EXACT",
    corrupt: (sqlite, checkpointId) =>
      void sqlite
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET actor_type = 'AGENT' WHERE id = ?",
        )
        .run(checkpointId),
  },
  ...[
    ["padded actor reference", "actor_reference", " actor "],
    ["padded source reference", "source_reference", " source "],
    ["padded summary", "summary", " summary "],
    ["oversized UTF-16 actor reference", "actor_reference", "🚀".repeat(129)],
    ["oversized UTF-16 source reference", "source_reference", "🚀".repeat(1_025)],
    ["oversized UTF-16 summary", "summary", "🚀".repeat(501)],
  ].map(([label, column, value]) => ({
    label: label!,
    read: "EXACT" as const,
    corrupt: (sqlite: DatabaseSync, checkpointId: string) =>
      void sqlite
        .prepare(
          `UPDATE subtask_implementation_checkpoints SET ${column} = ? WHERE id = ?`,
        )
        .run(value!, checkpointId),
  })),
  ...[
    ["malformed occurred_at", "occurred_at", "not-a-time"],
    ["noncanonical occurred_at", "occurred_at", "2026-08-09T00:00:00Z"],
    ["malformed created_at", "created_at", "not-a-time"],
    ["noncanonical created_at", "created_at", "2026-08-09T00:00:00Z"],
  ].map(([label, column, value]) => ({
    label: label!,
    read: "EXACT" as const,
    corrupt: (sqlite: DatabaseSync, checkpointId: string) =>
      void sqlite
        .prepare(
          `UPDATE subtask_implementation_checkpoints SET ${column} = ? WHERE id = ?`,
        )
        .run(value!, checkpointId),
  })),
  {
    label: "noncanonical owning Subtask",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE subtasks SET title = ' padded ' WHERE id = ?")
        .run(TARGET),
  },
  {
    label: "noncanonical Subtask timestamp",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE subtasks SET created_at = '2026-08-09T00:00:00Z' WHERE id = ?")
        .run(TARGET),
  },
  {
    label: "noncanonical owning Big Task",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE big_tasks SET title = ' padded ' WHERE id = 'bt_hardening'")
        .run(),
  },
  {
    label: "noncanonical Big Task timestamp",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE big_tasks SET updated_at = '2026-08-09T00:00:00Z' WHERE id = 'bt_hardening'")
        .run(),
  },
  {
    label: "noncanonical owning Project",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE projects SET name = ' padded ' WHERE id = 'prj_hardening'")
        .run(),
  },
  {
    label: "noncanonical Project timestamp",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE projects SET updated_at = '2026-08-09T00:00:00Z' WHERE id = 'prj_hardening'")
        .run(),
  },
  {
    label: "broken Project ownership hierarchy",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE big_tasks SET project_id = 'prj_missing' WHERE id = 'bt_hardening'")
        .run(),
  },
  {
    label: "broken Big Task ownership hierarchy",
    read: "EXACT",
    corrupt: (sqlite) =>
      void sqlite
        .prepare("UPDATE subtasks SET big_task_id = 'bt_missing' WHERE id = ?")
        .run(TARGET),
  },
];

describe("S1B2a stored-evidence corruption and isolation", () => {
  it.each(STORED_CORRUPTIONS)(
    "fails closed for $label without read side effects",
    ({ read, corrupt }) => {
      withTemporaryDatabasePath((databasePath) => {
        const checkpoint = makeImplementationCheckpoint(
          "icp_corruption_target",
          TARGET,
        );
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTarget(setup);
        setup.createProject(makeProject("prj_clean", "clean"));
        setup.completeSubtaskImplementation({ subtaskId: TARGET, checkpoint });
        setup.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec(
          "PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON",
        );
        corrupt(sqlite, checkpoint.id);
        sqlite.close();
        const before = applicationSnapshot(databasePath);

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expectSanitized(
          () =>
            read === "EXACT"
              ? storage.getSubtaskImplementationCheckpointById(checkpoint.id)
              : storage.listSubtaskImplementationCheckpoints(TARGET),
          "MALFORMED_STORED_DATA",
        );
        expect(storage.getProjectById(makeProject("prj_clean").id)).toEqual(
          makeProject("prj_clean", "clean"),
        );
        storage.close();
        expect(applicationSnapshot(databasePath)).toEqual(before);
      });
    },
  );

  it("isolates corrupted evidence in an unrelated Project from target reads and completion", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(storage);
      storage.createProject(makeProject("prj_foreign", "foreign"));
      storage.createBigTask(makeBigTask("bt_foreign", "prj_foreign"));
      storage.createSubtask(makeSubtask("st_foreign", "bt_foreign", "IN_PROGRESS"));
      const foreign = makeImplementationCheckpoint(
        "icp_foreign_corrupt",
        "st_foreign",
      );
      storage.completeSubtaskImplementation({
        subtaskId: "st_foreign" as SubtaskId,
        checkpoint: foreign,
      });
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite
        .prepare(
          "UPDATE subtask_implementation_checkpoints SET repository_commit_sha = 'INVALID' WHERE id = ?",
        )
        .run(foreign.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      const target = makeImplementationCheckpoint("icp_isolated_target", TARGET);
      expect(complete(reopened, target)).toMatchObject({ checkpoint: target });
      expect(reopened.getSubtaskImplementationCheckpointById(target.id)).toEqual(
        target,
      );
      expect(reopened.listSubtaskImplementationCheckpoints(TARGET)).toEqual([
        target,
      ]);
      expectSanitized(
        () => reopened.getSubtaskImplementationCheckpointById(foreign.id),
        "MALFORMED_STORED_DATA",
      );
      reopened.close();
    });
  });
});

describe("S1B2a cross-row state and evidence consistency", () => {
  it("rejects checkpoint evidence attached to NOT_STARTED maturity on both read surfaces", () => {
    withTemporaryDatabasePath((databasePath) => {
      const checkpoint = makeImplementationCheckpoint(
        "icp_impossible_initial",
        TARGET,
      );
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      setup.close();
      const sqlite = new DatabaseSync(databasePath);
      insertCheckpoint(sqlite, checkpoint);
      sqlite.close();
      const before = applicationSnapshot(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectSanitized(
        () => storage.getSubtaskImplementationCheckpointById(checkpoint.id),
        "MALFORMED_STORED_DATA",
      );
      expectSanitized(
        () => storage.listSubtaskImplementationCheckpoints(TARGET),
        "MALFORMED_STORED_DATA",
      );
      storage.close();
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  it("does not infer missing historical evidence from QA_DEBUG + IMPLEMENTED state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      setup.close();
      setSubtaskState(databasePath, TARGET, "QA_DEBUG", "IMPLEMENTED");

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(storage.listSubtaskImplementationCheckpoints(TARGET)).toEqual([]);
      storage.close();
    });
  });
});

describe("S1B2a checkpoint ordering, scale, and read-only behavior", () => {
  it("returns exact deterministic ordering at independent 257 and 1,024 row scale points", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      setup.createProject(makeProject("prj_scale", "scale"));
      setup.createBigTask(makeBigTask("bt_scale", "prj_scale"));
      for (const size of [257, 1_024]) {
        setup.createSubtask(
          makeSubtask(`st_scale_${size}`, "bt_scale", "QA_DEBUG"),
        );
      }
      setup.createSubtask(makeSubtask("st_scale_unrelated", "bt_scale", "QA_DEBUG"));
      setup.close();

      const expectedByTarget = new Map<string, SubtaskImplementationCheckpoint[]>();
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("BEGIN");
      try {
        sqlite.prepare("UPDATE subtasks SET maturity = 'IMPLEMENTED'").run();
        for (const size of [257, 1_024]) {
          const subtaskId = `st_scale_${size}`;
          const checkpoints = Array.from({ length: size }, (_, index) =>
            makeImplementationCheckpoint(
              `icp_scale_${size}_${index.toString().padStart(5, "0")}`,
              subtaskId,
              {
                occurredAt: new Date(
                  new Date(FIXED_TIME).getTime() + (index % 11),
                ).toISOString(),
              },
            ),
          );
          for (const checkpoint of [...checkpoints].reverse()) {
            insertCheckpoint(sqlite, checkpoint);
          }
          expectedByTarget.set(
            subtaskId,
            [...checkpoints].sort(
              (left, right) =>
                (left.occurredAt < right.occurredAt
                  ? -1
                  : left.occurredAt > right.occurredAt
                    ? 1
                    : 0) ||
                (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
            ),
          );
        }
        insertCheckpoint(
          sqlite,
          makeImplementationCheckpoint(
            "icp_scale_unrelated",
            "st_scale_unrelated",
          ),
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

      const before = applicationSnapshot(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      for (const size of [257, 1_024]) {
        const subtaskId = `st_scale_${size}` as SubtaskId;
        const listed = storage.listSubtaskImplementationCheckpoints(subtaskId);
        expect(listed).toHaveLength(size);
        expect(listed).toEqual(expectedByTarget.get(subtaskId));
        expect(listed).not.toContainEqual(
          expect.objectContaining({ id: "icp_scale_unrelated" }),
        );
      }
      storage.close();
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  it("keeps exact, missing, malformed, and reopen reads side-effect free", () => {
    withTemporaryDatabasePath((databasePath) => {
      const checkpoint = makeImplementationCheckpoint("icp_read_only", TARGET);
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      complete(setup, checkpoint);
      setup.close();
      const before = applicationSnapshot(databasePath);

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(storage.getSubtaskImplementationCheckpointById(checkpoint.id)).toEqual(
          checkpoint,
        );
        expect(
          storage.getSubtaskImplementationCheckpointById(
            "icp_missing" as SubtaskImplementationCheckpoint["id"],
          ),
        ).toBeNull();
        expect(storage.listSubtaskImplementationCheckpoints(TARGET)).toEqual([
          checkpoint,
        ]);
        storage.close();
        expect(applicationSnapshot(databasePath)).toEqual(before);
      }
    });
  });
});

const seedAtomicityScope = (databasePath: string): void => {
  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  seedTarget(storage);
  const scope = ContextScopeSchema.parse({
    scopeType: "SUBTASK",
    projectId: "prj_hardening",
    bigTaskId: "bt_hardening",
    subtaskId: TARGET,
  });
  storage.createContextItem(makeContextItem("ctx_atomicity", scope));
  storage.createContextDigest(makeContextDigest("dgt_atomicity", scope));
  storage.appendAuditEvent(makeAuditEvent("aud_atomicity", scope));
  storage.close();
};

describe("S1B2a standalone transaction failure boundaries", () => {
  it("mutates only the target lifecycle row and one checkpoint on success", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedAtomicityScope(databasePath);
      const before = applicationSnapshot(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const checkpoint = makeImplementationCheckpoint(
        "icp_exact_success_diff",
        TARGET,
      );
      complete(storage, checkpoint);
      storage.close();
      const after = applicationSnapshot(databasePath);

      for (const table of APPLICATION_TABLES.filter(
        (name) => name !== "subtasks" && name !== "subtask_implementation_checkpoints",
      )) {
        expect(after[table]).toEqual(before[table]);
      }
      expect(after.subtask_implementation_checkpoints).toHaveLength(1);
      expect(after.subtasks).toHaveLength(1);
      expect(after.subtasks?.[0]).toMatchObject({
        ...(before.subtasks?.[0] ?? {}),
        status: "QA_DEBUG",
        maturity: "IMPLEMENTED",
        created_at: before.subtasks?.[0]?.created_at,
        updated_at: "2026-08-09T00:00:00.001Z",
      });
      expect(after.audit_events).toEqual(before.audit_events);
    });
  });

  it.each([
    ["Subtask timestamp", "UPDATE subtasks SET updated_at = '2026-08-09T00:00:00Z' WHERE id = 'st_hardening_target'"],
    ["Big Task content", "UPDATE big_tasks SET title = ' padded ' WHERE id = 'bt_hardening'"],
    ["Project timestamp", "UPDATE projects SET created_at = 'not-a-time' WHERE id = 'prj_hardening'"],
    ["broken hierarchy", "UPDATE big_tasks SET project_id = 'prj_missing' WHERE id = 'bt_hardening'"],
  ] as const)("fails atomically before insertion for malformed relevant %s", (_label, sql) => {
    withTemporaryDatabasePath((databasePath) => {
      seedAtomicityScope(databasePath);
      const corrupt = new DatabaseSync(databasePath);
      corrupt.exec("PRAGMA foreign_keys = OFF");
      corrupt.prepare(sql).run();
      corrupt.close();
      const before = applicationSnapshot(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectSanitized(() => complete(storage), "MALFORMED_STORED_DATA");
      storage.close();
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  it.each([
    {
      label: "checkpoint insert",
      install: (sqlite: DatabaseSync) =>
        sqlite.exec(
          `CREATE TRIGGER fail_checkpoint_insert
           BEFORE INSERT ON subtask_implementation_checkpoints
           BEGIN SELECT RAISE(ABORT, 'private insert failure'); END`,
        ),
      code: "TRANSACTION_FAILED",
    },
    {
      label: "compare-and-swap update",
      install: (sqlite: DatabaseSync) =>
        sqlite.exec(
          `CREATE TRIGGER force_stale_completion
           AFTER INSERT ON subtask_implementation_checkpoints
           BEGIN
             UPDATE subtasks SET updated_at = '2026-08-09T00:00:00.001Z'
             WHERE id = NEW.subtask_id;
           END`,
        ),
      code: "CONFLICT",
    },
    {
      label: "read-back reconstruction",
      install: (sqlite: DatabaseSync) =>
        sqlite.exec(
          `CREATE TRIGGER corrupt_completion_readback
           AFTER UPDATE OF status ON subtasks
           BEGIN
             UPDATE subtask_implementation_checkpoints SET summary = ' padded '
             WHERE subtask_id = NEW.id;
           END`,
        ),
      code: "MALFORMED_STORED_DATA",
    },
  ])("rolls back every application table after $label failure", ({ install, code }) => {
    withTemporaryDatabasePath((databasePath) => {
      seedAtomicityScope(databasePath);
      const sqlite = new DatabaseSync(databasePath);
      install(sqlite);
      sqlite.close();
      const before = applicationSnapshot(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectSanitized(() => complete(storage), code);
      expect(storage.getProjectById(makeProject("prj_hardening").id)).not.toBeNull();
      storage.close();
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  it("rolls back completely when the storage clock fails", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedAtomicityScope(databasePath);
      const before = applicationSnapshot(databasePath);
      const storage = openTaskDatabase({
        databasePath,
        clock: () => {
          throw new Error("private clock failure");
        },
      });
      expectSanitized(() => complete(storage), "TRANSACTION_FAILED");
      expect(storage.getProjectById(makeProject("prj_hardening").id)).not.toBeNull();
      storage.close();
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  it("rolls back completely and recovers after an injected commit failure", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedAtomicityScope(databasePath);
      const before = applicationSnapshot(databasePath);
      const prototype = DatabaseSync.prototype as unknown as {
        exec: (sql: string) => void;
      };
      const originalExec = prototype.exec;
      let injected = false;
      prototype.exec = function (sql: string): void {
        if (!injected && sql === "COMMIT") {
          injected = true;
          throw new Error("private commit failure");
        }
        Reflect.apply(originalExec, this, [sql]);
      };
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectSanitized(() => complete(storage), "TRANSACTION_FAILED");
        expect(injected).toBe(true);
      } finally {
        prototype.exec = originalExec;
      }
      expect(storage.getProjectById(makeProject("prj_hardening").id)).not.toBeNull();
      storage.close();
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });
});

describe("S1B2a concurrent completion", () => {
  it(
    "keeps exactly one winner for contending stale callers and isolates another target",
    () => {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTarget(setup);
        setup.createSubtask(
          makeSubtask("st_hardening_other", "bt_hardening", "IN_PROGRESS"),
        );
        setup.close();

        const first = openTaskDatabase({ databasePath, clock: fixedClock });
        const stale = openTaskDatabase({ databasePath, clock: fixedClock });
        const winner = makeImplementationCheckpoint("icp_race_winner", TARGET);
        const loser = makeImplementationCheckpoint("icp_race_loser", TARGET);
        first.runInTransaction((transaction) => {
          expect(complete(transaction, winner)).toMatchObject({ checkpoint: winner });
          const contention = expectSanitized(() => complete(stale, loser));
          expect(["STORAGE_OPERATION_FAILED", "TRANSACTION_FAILED"]).toContain(
            contention.code,
          );
        });

        expectSanitized(() => complete(stale, loser), "CONFLICT");
        expectSanitized(() => complete(stale, winner), "CONFLICT");
        const other = makeImplementationCheckpoint(
          "icp_race_other",
          "st_hardening_other",
        );
        expect(
          stale.completeSubtaskImplementation({
            subtaskId: "st_hardening_other" as SubtaskId,
            checkpoint: other,
          }),
        ).toMatchObject({ checkpoint: other });
        first.close();
        stale.close();

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(reopened.listSubtaskImplementationCheckpoints(TARGET)).toEqual([
          winner,
        ]);
        expect(
          reopened.listSubtaskImplementationCheckpoints(
            "st_hardening_other" as SubtaskId,
          ),
        ).toEqual([other]);
        reopened.close();
      });
    },
    10_000,
  );
});

describe("S1B2a caller-owned transaction and savepoint ownership", () => {
  it("supports commit, caller rollback, caught failure, uncaught failure, and repeated calls", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      for (const suffix of ["rollback", "continue_a", "continue_b", "uncaught"]) {
        setup.createSubtask(
          makeSubtask(`st_${suffix}`, "bt_hardening", "IN_PROGRESS"),
        );
      }
      setup.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.runInTransaction((transaction) => {
        transaction.createProject(makeProject("prj_outer_before", "outer-before"));
        complete(
          transaction,
          makeImplementationCheckpoint("icp_outer_success", TARGET),
        );
        transaction.createProject(makeProject("prj_outer_after", "outer-after"));
      });
      expect(storage.getProjectById(makeProject("prj_outer_before").id)).not.toBeNull();
      expect(storage.getProjectById(makeProject("prj_outer_after").id)).not.toBeNull();

      expectSanitized(
        () =>
          storage.runInTransaction((transaction) => {
            transaction.completeSubtaskImplementation({
              subtaskId: "st_rollback" as SubtaskId,
              checkpoint: makeImplementationCheckpoint(
                "icp_outer_rollback",
                "st_rollback",
              ),
            });
            transaction.createProject(
              makeProject("prj_outer_rolled_back", "outer-rolled-back"),
            );
            throw new Error("private caller rollback");
          }),
        "TRANSACTION_FAILED",
      );
      expect(storage.getProjectById(makeProject("prj_outer_rolled_back").id)).toBeNull();
      expect(
        storage.listSubtaskImplementationCheckpoints("st_rollback" as SubtaskId),
      ).toEqual([]);

      storage.runInTransaction((transaction) => {
        transaction.createProject(makeProject("prj_caught_before", "caught-before"));
        expectSanitized(
          () =>
            transaction.completeSubtaskImplementation({
              subtaskId: "st_continue_a" as SubtaskId,
              checkpoint: makeImplementationCheckpoint(
                "icp_caught_mismatch",
                "st_wrong",
              ),
            }),
          "CONFLICT",
        );
        for (const suffix of ["continue_a", "continue_b"] as const) {
          transaction.completeSubtaskImplementation({
            subtaskId: `st_${suffix}` as SubtaskId,
            checkpoint: makeImplementationCheckpoint(
              `icp_${suffix}`,
              `st_${suffix}`,
            ),
          });
        }
      });
      expect(storage.getProjectById(makeProject("prj_caught_before").id)).not.toBeNull();
      expect(
        storage.listSubtaskImplementationCheckpoints("st_continue_a" as SubtaskId),
      ).toHaveLength(1);
      expect(
        storage.listSubtaskImplementationCheckpoints("st_continue_b" as SubtaskId),
      ).toHaveLength(1);

      expectSanitized(
        () =>
          storage.runInTransaction((transaction) => {
            transaction.createProject(
              makeProject("prj_uncaught_before", "uncaught-before"),
            );
            transaction.completeSubtaskImplementation({
              subtaskId: "st_uncaught" as SubtaskId,
              checkpoint: makeImplementationCheckpoint(
                "icp_uncaught_mismatch",
                "st_wrong",
              ),
            });
          }),
        "CONFLICT",
      );
      expect(storage.getProjectById(makeProject("prj_uncaught_before").id)).toBeNull();
      expect(
        storage.listSubtaskImplementationCheckpoints("st_uncaught" as SubtaskId),
      ).toEqual([]);
      storage.close();
    });
  });

  it("reuses caller-owned read transactions without committing or rolling them back", () => {
    withTemporaryDatabasePath((databasePath) => {
      const checkpoint = makeImplementationCheckpoint("icp_outer_read", TARGET);
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      complete(setup, checkpoint);
      setup.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectSanitized(
        () =>
          storage.runInTransaction((transaction) => {
            transaction.createProject(makeProject("prj_read_rollback", "read-rollback"));
            expect(
              transaction.getSubtaskImplementationCheckpointById(checkpoint.id),
            ).toEqual(checkpoint);
            expect(transaction.listSubtaskImplementationCheckpoints(TARGET)).toEqual([
              checkpoint,
            ]);
            throw new Error("private outer read rollback");
          }),
        "TRANSACTION_FAILED",
      );
      expect(storage.getProjectById(makeProject("prj_read_rollback").id)).toBeNull();
      expect(storage.getSubtaskImplementationCheckpointById(checkpoint.id)).toEqual(
        checkpoint,
      );
      storage.close();
    });
  });
});

describe("S1B2a timestamp hardening", () => {
  it.each([
    ["forward", "2026-08-10T00:00:00.000Z"],
    ["equal", FIXED_TIME],
    ["backward", "2026-08-08T00:00:00.000Z"],
    ["near upper practical boundary", "9999-12-31T23:59:59.998Z"],
  ] as const)("preserves created_at and strictly advances updated_at for %s time", (_label, clockTime) => {
    withTemporaryDatabasePath((databasePath) => {
      const initialClock = () => new Date(clockTime);
      const setup = openTaskDatabase({ databasePath, clock: initialClock });
      seedTarget(setup);
      setup.close();
      const before = new DatabaseSync(databasePath, { readOnly: true });
      const previous = before
        .prepare("SELECT created_at, updated_at FROM subtasks WHERE id = ?")
        .get(TARGET) as { created_at: string; updated_at: string };
      before.close();

      const storage = openTaskDatabase({ databasePath, clock: initialClock });
      complete(storage);
      storage.close();
      const afterDb = new DatabaseSync(databasePath, { readOnly: true });
      const after = afterDb
        .prepare("SELECT created_at, updated_at FROM subtasks WHERE id = ?")
        .get(TARGET) as { created_at: string; updated_at: string };
      afterDb.close();
      expect(after.created_at).toBe(previous.created_at);
      expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
        new Date(previous.updated_at).getTime(),
      );
    });
  });

  it("keeps caller occurred_at distinct from closely spaced storage timestamps", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(storage);
      storage.createSubtask(
        makeSubtask("st_close_time", "bt_hardening", "IN_PROGRESS"),
      );
      const first = makeImplementationCheckpoint("icp_close_a", TARGET, {
        occurredAt: "2000-01-01T00:00:00.000Z",
      });
      const second = makeImplementationCheckpoint(
        "icp_close_b",
        "st_close_time",
        { occurredAt: "2099-12-31T23:59:59.999Z" },
      );
      complete(storage, first);
      storage.completeSubtaskImplementation({
        subtaskId: "st_close_time" as SubtaskId,
        checkpoint: second,
      });
      expect(storage.getSubtaskImplementationCheckpointById(first.id)?.occurredAt).toBe(
        first.occurredAt,
      );
      expect(storage.getSubtaskImplementationCheckpointById(second.id)?.occurredAt).toBe(
        second.occurredAt,
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const rows = sqlite
          .prepare(
            "SELECT id, created_at, updated_at FROM subtasks WHERE id IN (?, ?) ORDER BY id",
          )
        .all(TARGET, "st_close_time") as unknown as readonly {
          id: string;
          created_at: string;
          updated_at: string;
        }[];
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.created_at).toBe(FIXED_TIME);
          expect(row.updated_at).toBe("2026-08-09T00:00:00.001Z");
        }
      } finally {
        sqlite.close();
      }
    });
  });
});

describe("S1B2a migration and reopen hardening", () => {
  it("preserves a varied accepted predecessor database and activates completion once", () => {
    withTemporaryDatabasePath((databasePath) => {
      const migrationsFolder = join(dirname(databasePath), "pre-s1b2a-hardening");
      mkdirSync(migrationsFolder);
      for (const migration of [
        acceptedS0B1Migration,
        acceptedS0B2aMigration,
        acceptedS0B2bMigration,
        acceptedS1aMigration,
      ]) {
        cpSync(migration, join(migrationsFolder, basename(migration)), {
          recursive: true,
        });
      }

      const predecessor = openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder,
      });
      const statuses: readonly SubtaskStatus[] = [
        "TODO",
        "IN_PROGRESS",
        "QA_DEBUG",
        "DONE",
        "DROPPED",
        "ARCHIVED",
      ];
      const projects = Array.from({ length: 3 }, (_, projectIndex) =>
        makeProject(`prj_migration_h_${projectIndex}`, `migration-h-${projectIndex}`),
      );
      const bigTasks = projects.flatMap((project, projectIndex) =>
        Array.from({ length: 2 }, (_, bigTaskIndex) =>
          makeBigTask(
            `bt_migration_h_${projectIndex}_${bigTaskIndex}`,
            project.id,
            bigTaskIndex === 0 ? "IN_PROGRESS" : "DONE",
          ),
        ),
      );
      projects.forEach((project) => predecessor.createProject(project));
      bigTasks.forEach((bigTask) => predecessor.createBigTask(bigTask));
      const subtasks = bigTasks.flatMap((bigTask, bigTaskIndex) =>
        Array.from({ length: 5 }, (_, subtaskIndex) =>
          makeSubtask(
            `st_migration_h_${bigTaskIndex}_${subtaskIndex}`,
            bigTask.id,
            bigTaskIndex === 0 && subtaskIndex === 0
              ? "IN_PROGRESS"
              : statuses[(bigTaskIndex + subtaskIndex) % statuses.length],
          ),
        ),
      );
      subtasks.forEach((subtask) => predecessor.createSubtask(subtask));
      for (let bigTaskIndex = 0; bigTaskIndex < bigTasks.length; bigTaskIndex += 1) {
        const group = subtasks.filter(
          ({ bigTaskId }) => bigTaskId === bigTasks[bigTaskIndex]!.id,
        );
        predecessor.replaceDependenciesForBigTask(bigTasks[bigTaskIndex]!.id, [
          makeDependency(
            group[0]!.id,
            group[1]!.id,
            "BLOCKING",
            bigTaskIndex % 2 === 0 ? "HARDENED" : "ACCEPTED",
            `阻塞 migration ${bigTaskIndex} 🚀`,
          ),
          makeDependency(
            group[2]!.id,
            group[3]!.id,
            "INFORMATIONAL",
            "NONE",
            `情報 migration ${bigTaskIndex} e\u0301`,
          ),
        ]);
      }
      for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
        const project = projects[projectIndex]!;
        const bigTask = bigTasks[projectIndex * 2]!;
        const subtask = subtasks.find(({ bigTaskId }) => bigTaskId === bigTask.id)!;
        const scope = {
          scopeType: "SUBTASK" as const,
          projectId: project.id,
          bigTaskId: bigTask.id,
          subtaskId: subtask.id,
        };
        const prior = makeContextItem(`ctx_migration_prior_${projectIndex}`, scope, {
          title: `Prior 日本語 ${projectIndex}`,
        });
        predecessor.createContextItem(prior);
        predecessor.supersedeContextItem(
          makeContextItem(`ctx_migration_tip_${projectIndex}`, scope, {
            supersedesContextItemId: prior.id,
            body: `Replacement résumé 🚀 ${projectIndex}`,
          }),
        );
        predecessor.createContextDigest(
          makeContextDigest(`dgt_migration_${projectIndex}`, scope, {
            body: `Digest 审计 🚀 ${projectIndex}`,
          }),
        );
        predecessor.appendAuditEvent(
          makeAuditEvent(`aud_migration_${projectIndex}`, scope, {
            summary: `Audit e\u0301vidence ${projectIndex}`,
          }),
        );
      }
      predecessor.close();

      const raw = new DatabaseSync(databasePath);
      const maturities: readonly SubtaskMaturity[] = [
        "NOT_STARTED",
        "IMPLEMENTED",
        "HARDENED",
        "ACCEPTED",
      ];
      const maturityUpdate = raw.prepare(
        "UPDATE subtasks SET maturity = ? WHERE id = ?",
      );
      subtasks.forEach((subtask, index) =>
        maturityUpdate.run(
          index === 0 ? "NOT_STARTED" : maturities[index % maturities.length]!,
          subtask.id,
        ),
      );
      raw.close();

      const predecessorTables = APPLICATION_TABLES.filter(
        (table) => table !== "subtask_implementation_checkpoints",
      );
      const snapshotTables = (tables: readonly string[]) => {
        const sqlite = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return Object.fromEntries(
            tables.map((table) => [
              table,
              sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
            ]),
          );
        } finally {
          sqlite.close();
        }
      };
      const beforeMigration = snapshotTables(predecessorTables);

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(snapshotTables(predecessorTables)).toEqual(beforeMigration);
      expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      const target = subtasks[0]!;
      expect(migrated.listSubtaskImplementationCheckpoints(target.id)).toEqual([]);
      const countBefore = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        (
          countBefore
            .prepare(
              "SELECT count(*) AS count FROM subtask_implementation_checkpoints",
            )
            .get() as { count: number }
        ).count,
      ).toBe(0);
      countBefore.close();

      const checkpoint = makeImplementationCheckpoint(
        "icp_after_hardened_migration",
        target.id,
      );
      expect(
        migrated.completeSubtaskImplementation({
          subtaskId: target.id,
          checkpoint,
        }),
      ).toMatchObject({ checkpoint });
      migrated.close();

      const schema = new DatabaseSync(databasePath);
      schema.exec("PRAGMA foreign_keys = ON");
      const indexes = schema
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'subtask_implementation_checkpoints' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toEqual([
        "sqlite_autoindex_subtask_implementation_checkpoints_1",
        "subtask_implementation_checkpoints_subtask_index",
        "subtask_implementation_checkpoints_subtask_order_index",
      ]);
      const tableSql = (
        schema
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'subtask_implementation_checkpoints'",
          )
          .get() as { sql: string }
      ).sql;
      expect(tableSql).toContain("repository_commit_sha");
      expect(tableSql).toContain("FOREIGN KEY");
      expect(tableSql).toContain("CHECK");
      expect(() =>
        schema
          .prepare(
            `INSERT INTO subtask_implementation_checkpoints
              (id, subtask_id, repository_commit_sha, actor_type, actor_reference,
               source_reference, summary, occurred_at, created_at)
             VALUES ('icp_bad_fk', 'st_missing', ?, 'CODEX', NULL,
                     'migration', 'bad fk', ?, ?)`,
          )
          .run("a".repeat(40), FIXED_TIME, FIXED_TIME),
      ).toThrow();
      schema.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(reopened.getSubtaskImplementationCheckpointById(checkpoint.id)).toEqual(
          checkpoint,
        );
        expect(reopened.listSubtaskImplementationCheckpoints(target.id)).toEqual([
          checkpoint,
        ]);
        expect(reopened.listProjects()).toHaveLength(3);
        reopened.close();
        const verify = new DatabaseSync(databasePath, { readOnly: true });
        expect(
          (
            verify
              .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
              .get() as { count: number }
          ).count,
        ).toBe(13);
        verify.close();
      }
    });
  });
});
