import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ContextItemSchema,
  ContextScopeSchema,
  BigTaskIdSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  ContextAuthority,
  ContextItem,
  ContextKind,
  ContextScope,
  ContextSourceType,
  ContextStatus,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { AllowedRawContextItemSnapshot, TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeContextItem,
  makeDependency,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const TARGET_PROJECT = "prj_allowed";
const TARGET_BIG_TASK = "bt_allowed";
const TARGET_SUBTASK = SubtaskIdSchema.parse("st_allowed");
const SIBLING_SUBTASK = "st_sibling";
const OTHER_BIG_TASK = "bt_other";
const OTHER_BIG_TASK_SUBTASK = "st_other_big_task";
const FOREIGN_PROJECT = "prj_foreign";
const FOREIGN_BIG_TASK = "bt_foreign";
const FOREIGN_SUBTASK = "st_foreign";

const projectScope = (projectId = TARGET_PROJECT): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "PROJECT", projectId });

const bigTaskScope = (
  projectId = TARGET_PROJECT,
  bigTaskId = TARGET_BIG_TASK,
): ContextScope => ContextScopeSchema.parse({ scopeType: "BIG_TASK", projectId, bigTaskId });

const subtaskScope = (
  projectId = TARGET_PROJECT,
  bigTaskId = TARGET_BIG_TASK,
  subtaskId: string = TARGET_SUBTASK,
): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "SUBTASK", projectId, bigTaskId, subtaskId });

const seedTopology = (storage: TaskStorage): void => {
  storage.createProject(makeProject(TARGET_PROJECT, "allowed"));
  storage.createBigTask(makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK));
  storage.createSubtask(makeSubtask(SIBLING_SUBTASK, TARGET_BIG_TASK));
  storage.createBigTask(makeBigTask(OTHER_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(OTHER_BIG_TASK_SUBTASK, OTHER_BIG_TASK));

  storage.createProject(makeProject(FOREIGN_PROJECT, "foreign"));
  storage.createBigTask(makeBigTask(FOREIGN_BIG_TASK, FOREIGN_PROJECT));
  storage.createSubtask(makeSubtask(FOREIGN_SUBTASK, FOREIGN_BIG_TASK));
};

const expectedAllowedScopes = (): readonly ContextScope[] => [
  projectScope(),
  bigTaskScope(),
  subtaskScope(),
];

const read = (storage: TaskStorage): AllowedRawContextItemSnapshot =>
  storage.readAllowedRawContextItemsForSubtask(TARGET_SUBTASK);

const itemIds = (snapshot: AllowedRawContextItemSnapshot): readonly (readonly string[])[] =>
  snapshot.buckets.map(({ contextItems }) => contextItems.map(({ id }) => id));

const expectMalformed = (operation: () => unknown): void => {
  expect(captureTaskStorageError(operation)).toMatchObject({
    code: "MALFORMED_STORED_DATA",
    message: "Stored task data is malformed.",
  });
};

const allApplicationRows = (databasePath: string): string => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = [
      "projects",
      "big_tasks",
      "subtasks",
      "task_dependencies",
      "subtask_implementation_checkpoints",
      "context_items",
      "context_digests",
      "audit_events",
    ];
    return JSON.stringify({
      schema: sqlite
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
      tables: tables.map((table) => ({
        table,
        rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      })),
    });
  } finally {
    sqlite.close();
  }
};

const mutateContextRow = (
  databasePath: string,
  sql: string,
  ...parameters: readonly (string | null)[]
): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
    sqlite.prepare(sql).run(...parameters);
  } finally {
    sqlite.close();
  }
};

const createLinkedPair = (
  storage: TaskStorage,
  scope: ContextScope,
  prefix: string,
): readonly ContextItem[] => {
  const prior = makeContextItem(`${prefix}_prior`, scope);
  const successor = makeContextItem(`${prefix}_successor`, scope, {
    effectiveAt: "2026-08-10T00:00:00.000Z",
    supersedesContextItemId: prior.id,
  });
  storage.createContextItem(prior);
  storage.supersedeContextItem(successor);
  return [{ ...prior, status: "SUPERSEDED" }, successor];
};

describe("S2B1 allowed raw Context Item contract", () => {
  it("derives the accepted ACL before returning only the independent three-scope matrix", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const matrix = [
        [makeContextItem("ctx_allowed_project", projectScope()), true],
        [makeContextItem("ctx_allowed_big_task", bigTaskScope()), true],
        [makeContextItem("ctx_allowed_subtask", subtaskScope()), true],
        [
          makeContextItem(
            "ctx_excluded_sibling",
            subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
          ),
          false,
        ],
        [
          makeContextItem(
            "ctx_excluded_other_big_task",
            bigTaskScope(TARGET_PROJECT, OTHER_BIG_TASK),
          ),
          false,
        ],
        [
          makeContextItem(
            "ctx_excluded_other_big_task_subtask",
            subtaskScope(TARGET_PROJECT, OTHER_BIG_TASK, OTHER_BIG_TASK_SUBTASK),
          ),
          false,
        ],
        [makeContextItem("ctx_excluded_foreign_project", projectScope(FOREIGN_PROJECT)), false],
        [
          makeContextItem(
            "ctx_excluded_foreign_big_task",
            bigTaskScope(FOREIGN_PROJECT, FOREIGN_BIG_TASK),
          ),
          false,
        ],
        [
          makeContextItem(
            "ctx_excluded_foreign_subtask",
            subtaskScope(FOREIGN_PROJECT, FOREIGN_BIG_TASK, FOREIGN_SUBTASK),
          ),
          false,
        ],
      ] as const;
      matrix.forEach(([item]) => storage.createContextItem(item));
      storage.replaceDependenciesForBigTask(BigTaskIdSchema.parse(TARGET_BIG_TASK), [
        makeDependency(SIBLING_SUBTASK, TARGET_SUBTASK, "BLOCKING", "ACCEPTED"),
      ]);

      const snapshot = read(storage);
      expect(snapshot.allowedContextSet).toEqual({
        target: {
          projectId: TARGET_PROJECT,
          bigTaskId: TARGET_BIG_TASK,
          subtaskId: TARGET_SUBTASK,
        },
        allowedRawScopes: expectedAllowedScopes(),
      });
      expect(snapshot.buckets.map(({ scope }) => scope)).toEqual(expectedAllowedScopes());
      expect(itemIds(snapshot)).toEqual([
        ["ctx_allowed_project"],
        ["ctx_allowed_big_task"],
        ["ctx_allowed_subtask"],
      ]);
      const returned = new Set(snapshot.buckets.flatMap(({ contextItems }) => contextItems.map(({ id }) => id)));
      for (const [item, included] of matrix) {
        expect(returned.has(item.id)).toBe(included);
      }
    });
  });

  it("returns all statuses and representative semantics without current-context selection", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const statuses: readonly ContextStatus[] = [
        "PROPOSED",
        "ACTIVE",
        "SUPERSEDED",
        "REJECTED",
        "RESOLVED",
      ];
      const kinds: readonly ContextKind[] = [
        "DECISION",
        "REQUIREMENT",
        "CONSTRAINT",
        "ENGINEERING_FACT",
        "OPEN_QUESTION",
        "RISK",
      ];
      const authorities: readonly ContextAuthority[] = [
        "HUMAN",
        "REPO_EVIDENCE",
        "CODEX_CANDIDATE",
        "SYSTEM",
      ];
      const sourceTypes: readonly ContextSourceType[] = [
        "CHAT_MESSAGE",
        "REPO",
        "HANDOFF",
        "IMPORT",
        "MANUAL",
        "SYSTEM",
      ];

      expectedAllowedScopes().forEach((scope, scopeIndex) => {
        statuses.forEach((status, index) => {
          const base = makeContextItem(`ctx_raw_${scopeIndex}_${index}`, scope, { status });
          storage.createContextItem(
            ContextItemSchema.parse({
              ...base,
              kind: kinds[(scopeIndex + index) % kinds.length],
              authority: authorities[(scopeIndex + index) % authorities.length],
              provenance: {
                ...base.provenance,
                sourceType: sourceTypes[(scopeIndex + index) % sourceTypes.length],
              },
            }),
          );
        });
      });

      for (const { contextItems } of read(storage).buckets) {
        expect(contextItems.map(({ status }) => status).sort()).toEqual([...statuses].sort());
      }
    });
  });

  it("keeps ACL bucket order and orders each exact bucket by effectiveAt then ID", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      for (const [scopeIndex, scope] of expectedAllowedScopes().entries()) {
        [
          makeContextItem(`ctx_${scopeIndex}_z`, scope, {
            effectiveAt: "2026-08-11T00:00:00.000Z",
          }),
          makeContextItem(`ctx_${scopeIndex}_中`, scope, {
            effectiveAt: "2026-08-10T00:00:00.000Z",
          }),
          makeContextItem(`ctx_${scopeIndex}_b`, scope, {
            effectiveAt: "2026-08-10T00:00:00.000Z",
          }),
          makeContextItem(`ctx_${scopeIndex}_a`, scope, {
            effectiveAt: "2026-08-10T00:00:00.000Z",
          }),
        ].forEach((item) => storage.createContextItem(item));
      }

      const snapshot = read(storage);
      expect(snapshot.buckets.map(({ scope }) => scope.scopeType)).toEqual([
        "PROJECT",
        "BIG_TASK",
        "SUBTASK",
      ]);
      expect(itemIds(snapshot)).toEqual([
        ["ctx_0_a", "ctx_0_b", "ctx_0_中", "ctx_0_z"],
        ["ctx_1_a", "ctx_1_b", "ctx_1_中", "ctx_1_z"],
        ["ctx_2_a", "ctx_2_b", "ctx_2_中", "ctx_2_z"],
      ]);
    });
  });

  it("uses sanitized canonical input and missing-target failures", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      expect(
        captureTaskStorageError(() =>
          storage.readAllowedRawContextItemsForSubtask(" st_allowed " as SubtaskId),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(
        captureTaskStorageError(() =>
          storage.readAllowedRawContextItemsForSubtask(
            SubtaskIdSchema.parse("st_missing"),
          ),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });
});

describe("S2B1 corruption blast radius", () => {
  const relevantScopes = [projectScope(), bigTaskScope(), subtaskScope()] as const;

  it.each(relevantScopes)("fails closed for noncanonical compact evidence at $scopeType", (scope) => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const item = makeContextItem(`ctx_relevant_${scope.scopeType.toLowerCase()}`, scope);
      setup.createContextItem(item);
      setup.close();
      mutateContextRow(databasePath, "UPDATE context_items SET title = ? WHERE id = ?", ` ${item.title} `, item.id);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => read(storage));
      } finally {
        storage.close();
      }
    });
  });

  it.each([
    ["noncanonical ID", "UPDATE context_items SET id = ? WHERE id = ?", " ctx_corrupt ", "ctx_corrupt"],
    [
      "noncanonical effectiveAt",
      "UPDATE context_items SET effective_at = ? WHERE id = ?",
      "2026-08-09T00:00:00+00:00",
      "ctx_corrupt",
    ],
  ] as const)("fails closed for relevant %s", (_label, sql, replacement, id) => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      setup.createContextItem(makeContextItem(id, projectScope()));
      setup.close();
      mutateContextRow(databasePath, sql, replacement, id);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => read(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("fails closed for a malformed target hierarchy", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      setup.close();
      mutateContextRow(
        databasePath,
        "UPDATE big_tasks SET project_id = ? WHERE id = ?",
        ` ${FOREIGN_PROJECT} `,
        TARGET_BIG_TASK,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => read(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("fails closed for relevant broken linked history", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const [, successor] = createLinkedPair(setup, subtaskScope(), "ctx_relevant_chain");
      setup.close();
      mutateContextRow(
        databasePath,
        "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
        successor!.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => read(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("fails closed for a linked relevant scope hierarchy mismatch", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const [, successor] = createLinkedPair(setup, projectScope(), "ctx_scope_mismatch");
      setup.close();
      mutateContextRow(
        databasePath,
        "UPDATE context_items SET big_task_id = ? WHERE id = ?",
        TARGET_BIG_TASK,
        successor!.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => read(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("isolates malformed sibling, unrelated Big Task, and foreign Project evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const allowed = expectedAllowedScopes().map((scope, index) =>
        makeContextItem(`ctx_clean_${index}`, scope),
      );
      allowed.forEach((item) => setup.createContextItem(item));
      const unrelated = [
        makeContextItem(
          "ctx_bad_sibling",
          subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
        ),
        makeContextItem(
          "ctx_bad_other_big_task",
          bigTaskScope(TARGET_PROJECT, OTHER_BIG_TASK),
        ),
        makeContextItem("ctx_bad_foreign", projectScope(FOREIGN_PROJECT)),
      ];
      unrelated.forEach((item) => setup.createContextItem(item));
      const [, brokenSuccessor] = createLinkedPair(
        setup,
        subtaskScope(FOREIGN_PROJECT, FOREIGN_BIG_TASK, FOREIGN_SUBTASK),
        "ctx_bad_foreign_chain",
      );
      setup.close();

      for (const item of unrelated) {
        mutateContextRow(
          databasePath,
          "UPDATE context_items SET effective_at = ? WHERE id = ?",
          "2026-08-09T00:00:00+00:00",
          item.id,
        );
      }
      mutateContextRow(
        databasePath,
        "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
        brokenSuccessor!.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(read(storage))).toEqual([
          [allowed[0]!.id],
          [allowed[1]!.id],
          [allowed[2]!.id],
        ]);
      } finally {
        storage.close();
      }
    });
  });
});

describe("S2B1 coherent snapshot and transaction ownership", () => {
  it("returns one complete old state and then one complete new committed state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const projectItem = makeContextItem("ctx_snapshot_project", projectScope(), { body: "OLD project" });
      const subtaskItem = makeContextItem("ctx_snapshot_subtask", subtaskScope(), { body: "OLD subtask" });
      setup.createContextItem(projectItem);
      setup.createContextItem(subtaskItem);
      setup.close();
      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE context_items SET body = ? WHERE id = ?").run("NEW project", projectItem.id);
      writer.prepare("UPDATE context_items SET body = ? WHERE id = ?").run("NEW subtask", subtaskItem.id);

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
      let oldSnapshot: AllowedRawContextItemSnapshot;
      try {
        oldSnapshot = read(reader);
      } finally {
        prototype.get = originalGet;
      }
      try {
        expect(commits).toBe(1);
        expect(oldSnapshot.buckets[0].contextItems[0]?.body).toBe("OLD project");
        expect(oldSnapshot.buckets[2].contextItems[0]?.body).toBe("OLD subtask");
        const newSnapshot = read(reader);
        expect(newSnapshot.buckets[0].contextItems[0]?.body).toBe("NEW project");
        expect(newSnapshot.buckets[2].contextItems[0]?.body).toBe("NEW subtask");
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("keeps valid supersession and another allowed-scope change in one snapshot", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const prior = makeContextItem("ctx_snapshot_prior", projectScope());
      const subtaskItem = makeContextItem("ctx_snapshot_other_scope", subtaskScope(), { body: "OLD" });
      setup.createContextItem(prior);
      setup.createContextItem(subtaskItem);
      setup.close();
      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?").run(prior.id);
      writer.prepare(`
        INSERT INTO context_items (
          id, project_id, big_task_id, subtask_id, kind, status, authority,
          title, body, source_type, source_reference, effective_at,
          supersedes_context_item_id, created_at, updated_at
        ) SELECT ?, project_id, big_task_id, subtask_id, kind, 'ACTIVE', authority,
          ?, ?, source_type, ?, ?, id, created_at, updated_at
        FROM context_items WHERE id = ?
      `).run(
        "ctx_snapshot_successor",
        "Context successor",
        "NEW project conclusion",
        "repository#ctx_snapshot_successor",
        "2026-08-10T00:00:00.000Z",
        prior.id,
      );
      writer.prepare("UPDATE context_items SET body = ? WHERE id = ?").run("NEW", subtaskItem.id);

      const prototype = StatementSync.prototype as unknown as {
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalGet = prototype.get;
      prototype.get = function (...parameters: unknown[]): unknown {
        const result = Reflect.apply(originalGet, this, parameters);
        if (writer.isTransaction && /from\s+"?subtasks"?/i.test(this.sourceSQL)) {
          writer.exec("COMMIT");
        }
        return result;
      };
      let oldSnapshot: AllowedRawContextItemSnapshot;
      try {
        oldSnapshot = read(reader);
      } finally {
        prototype.get = originalGet;
      }
      try {
        expect(itemIds(oldSnapshot)).toEqual([[prior.id], [], [subtaskItem.id]]);
        expect(oldSnapshot.buckets[2].contextItems[0]?.body).toBe("OLD");
        const next = read(reader);
        expect(itemIds(next)).toEqual([
          [prior.id, "ctx_snapshot_successor"],
          [],
          [subtaskItem.id],
        ]);
        expect(next.buckets[0].contextItems.map(({ status }) => status)).toEqual([
          "SUPERSEDED",
          "ACTIVE",
        ]);
        expect(next.buckets[2].contextItems[0]?.body).toBe("NEW");
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("reuses an outer transaction, sees local state, and leaves commit or rollback to its caller", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const committed = makeContextItem("ctx_transaction_committed", projectScope());
      storage.runInTransaction((transaction) => {
        transaction.createContextItem(committed);
        expect(itemIds(read(transaction))[0]).toEqual([committed.id]);
      });
      expect(storage.getContextItemById(committed.id)).toEqual(committed);

      const rolledBack = makeContextItem("ctx_transaction_rolled_back", subtaskScope());
      expect(
        captureTaskStorageError(() =>
          storage.runInTransaction((transaction) => {
            transaction.createContextItem(rolledBack);
            expect(itemIds(read(transaction))[2]).toEqual([rolledBack.id]);
            throw new Error("private caller rollback");
          }),
        ),
      ).toMatchObject({ code: "TRANSACTION_FAILED" });
      expect(storage.getContextItemById(rolledBack.id)).toBeNull();
    });
  });

  it("does not independently roll back a caught read failure inside the caller transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const corrupt = makeContextItem("ctx_transaction_corrupt", projectScope());
      setup.createContextItem(corrupt);
      setup.close();
      mutateContextRow(databasePath, "UPDATE context_items SET title = ? WHERE id = ?", ` ${corrupt.title} `, corrupt.id);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const survives = makeContextItem(
        "ctx_transaction_survives",
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
      );
      try {
        storage.runInTransaction((transaction) => {
          transaction.createContextItem(survives);
          expectMalformed(() => read(transaction));
        });
        expect(storage.getContextItemById(survives.id)).toEqual(survives);

        const rolledBack = makeContextItem(
          "ctx_transaction_uncaught_rollback",
          subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
        );
        expectMalformed(() =>
          storage.runInTransaction((transaction) => {
            transaction.createContextItem(rolledBack);
            read(transaction);
          }),
        );
        expect(storage.getContextItemById(rolledBack.id)).toBeNull();
      } finally {
        storage.close();
      }
    });
  });
});

describe("S2B1 read-only, reopen, and source isolation", () => {
  it("leaves every application table unchanged across success, empty, repeated, and failure reads", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      setup.createContextItem(makeContextItem("ctx_read_only", projectScope()));
      setup.close();
      const before = allApplicationRows(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      read(storage);
      read(storage);
      storage.readAllowedRawContextItemsForSubtask(SubtaskIdSchema.parse(SIBLING_SUBTASK));
      storage.close();
      expect(allApplicationRows(databasePath)).toBe(before);

      mutateContextRow(databasePath, "UPDATE context_items SET title = ? WHERE id = ?", " Context ctx_read_only ", "ctx_read_only");
      const corruptedBefore = allApplicationRows(databasePath);
      const malformed = openTaskDatabase({ databasePath, clock: fixedClock });
      expectMalformed(() => read(malformed));
      malformed.close();
      expect(allApplicationRows(databasePath)).toBe(corruptedBefore);
    });
  });

  it("preserves exact output and corruption classification across repeated reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      expectedAllowedScopes().forEach((scope, index) =>
        setup.createContextItem(makeContextItem(`ctx_reopen_${index}`, scope)),
      );
      setup.createContextItem(
        makeContextItem(
          "ctx_reopen_unrelated",
          subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
        ),
      );
      setup.close();

      let expected: AllowedRawContextItemSnapshot | undefined;
      for (let index = 0; index < 3; index += 1) {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        const current = read(storage);
        expected ??= current;
        expect(current).toEqual(expected);
        storage.close();
      }
      mutateContextRow(
        databasePath,
        "UPDATE context_items SET effective_at = ? WHERE id = ?",
        "2026-08-09T00:00:00+00:00",
        "ctx_reopen_unrelated",
      );
      for (let index = 0; index < 2; index += 1) {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(read(storage)).toEqual(expected);
        storage.close();
      }
    });
  });

  it("queries exact scopes rather than materializing hundreds of excluded rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      expectedAllowedScopes().forEach((scope, index) =>
        setup.createContextItem(makeContextItem(`ctx_scale_allowed_${index}`, scope)),
      );
      setup.runInTransaction((transaction) => {
        for (let index = 0; index < 600; index += 1) {
          transaction.createContextItem(
            makeContextItem(
              `ctx_scale_excluded_${index.toString().padStart(4, "0")}`,
              subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
            ),
          );
        }
      });
      setup.close();

      const prototype = StatementSync.prototype as unknown as {
        all: (...parameters: unknown[]) => unknown[];
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalAll = prototype.all;
      const originalGet = prototype.get;
      const contextQueries: string[] = [];
      let contextRowsRead = 0;
      prototype.all = function (...parameters: unknown[]): unknown[] {
        const rows = Reflect.apply(originalAll, this, parameters) as unknown[];
        if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
          contextQueries.push(this.sourceSQL);
          contextRowsRead += rows.length;
        }
        return rows;
      };
      prototype.get = function (...parameters: unknown[]): unknown {
        const row = Reflect.apply(originalGet, this, parameters);
        if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
          contextQueries.push(this.sourceSQL);
          contextRowsRead += row === undefined ? 0 : 1;
        }
        return row;
      };

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      let snapshot: AllowedRawContextItemSnapshot;
      try {
        snapshot = read(storage);
      } finally {
        prototype.all = originalAll;
        prototype.get = originalGet;
        storage.close();
      }
      expect(itemIds(snapshot)).toEqual([
        ["ctx_scale_allowed_0"],
        ["ctx_scale_allowed_1"],
        ["ctx_scale_allowed_2"],
      ]);
      expect(contextQueries.length).toBeGreaterThanOrEqual(3);
      expect(contextQueries.every((sql) => /where/i.test(sql))).toBe(true);
      expect(contextRowsRead).toBeLessThan(20);

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const plans = [
          sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM context_items WHERE project_id = ? AND big_task_id IS NULL AND subtask_id IS NULL ORDER BY effective_at, id").all(TARGET_PROJECT),
          sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM context_items WHERE project_id = ? AND big_task_id = ? AND subtask_id IS NULL ORDER BY effective_at, id").all(TARGET_PROJECT, TARGET_BIG_TASK),
          sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM context_items WHERE project_id = ? AND big_task_id = ? AND subtask_id = ? ORDER BY effective_at, id").all(TARGET_PROJECT, TARGET_BIG_TASK, TARGET_SUBTASK),
        ].flat() as unknown as readonly { readonly detail: string }[];
        expect(plans.some(({ detail }) => /context_items_(project|big_task|subtask)_id_index/i.test(detail))).toBe(true);
      } finally {
        sqlite.close();
      }
    });
  });
});
