import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ContextItemSchema,
  ContextScopeSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  ContextAuthority,
  ContextItem,
  ContextKind,
  ContextScope,
  ContextStatus,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type {
  ActiveContextItemSnapshot,
  AllowedRawContextItemSnapshot,
  TaskStorage,
} from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeContextItem,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const TARGET_PROJECT = "prj_active";
const TARGET_BIG_TASK = "bt_active";
const TARGET_SUBTASK = SubtaskIdSchema.parse("st_active");
const SIBLING_SUBTASK = SubtaskIdSchema.parse("st_active_sibling");
const OTHER_BIG_TASK = "bt_active_other";
const OTHER_SUBTASK = SubtaskIdSchema.parse("st_active_other");
const FOREIGN_PROJECT = "prj_active_foreign";
const FOREIGN_BIG_TASK = "bt_active_foreign";
const FOREIGN_SUBTASK = SubtaskIdSchema.parse("st_active_foreign");

const STATUSES = [
  "PROPOSED",
  "ACTIVE",
  "SUPERSEDED",
  "REJECTED",
  "RESOLVED",
] as const satisfies readonly ContextStatus[];

const NON_ACTIVE_STATUSES = [
  "PROPOSED",
  "SUPERSEDED",
  "REJECTED",
  "RESOLVED",
] as const satisfies readonly ContextStatus[];

const projectScope = (projectId = TARGET_PROJECT): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "PROJECT", projectId });

const bigTaskScope = (
  projectId = TARGET_PROJECT,
  bigTaskId = TARGET_BIG_TASK,
): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "BIG_TASK", projectId, bigTaskId });

const subtaskScope = (
  projectId = TARGET_PROJECT,
  bigTaskId = TARGET_BIG_TASK,
  subtaskId: SubtaskId = TARGET_SUBTASK,
): ContextScope =>
  ContextScopeSchema.parse({
    scopeType: "SUBTASK",
    projectId,
    bigTaskId,
    subtaskId,
  });

const allowedScopes = (): readonly ContextScope[] => [
  projectScope(),
  bigTaskScope(),
  subtaskScope(),
];

const seedTopology = (storage: TaskStorage): void => {
  storage.createProject(makeProject(TARGET_PROJECT, "active"));
  storage.createBigTask(makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK));
  storage.createSubtask(makeSubtask(SIBLING_SUBTASK, TARGET_BIG_TASK));
  storage.createBigTask(makeBigTask(OTHER_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(OTHER_SUBTASK, OTHER_BIG_TASK));

  storage.createProject(makeProject(FOREIGN_PROJECT, "active-foreign"));
  storage.createBigTask(makeBigTask(FOREIGN_BIG_TASK, FOREIGN_PROJECT));
  storage.createSubtask(makeSubtask(FOREIGN_SUBTASK, FOREIGN_BIG_TASK));
};

const readActive = (
  storage: TaskStorage,
  subtaskId: SubtaskId = TARGET_SUBTASK,
): ActiveContextItemSnapshot =>
  storage.readActiveContextItemsForSubtask(subtaskId);

const readRaw = (storage: TaskStorage): AllowedRawContextItemSnapshot =>
  storage.readAllowedRawContextItemsForSubtask(TARGET_SUBTASK);

const itemIds = (
  snapshot: ActiveContextItemSnapshot | AllowedRawContextItemSnapshot,
): readonly (readonly string[])[] =>
  snapshot.buckets.map(({ contextItems }) =>
    contextItems.map(({ id }) => id),
  );

const expectMalformed = (operation: () => unknown): void => {
  expect(captureTaskStorageError(operation)).toMatchObject({
    code: "MALFORMED_STORED_DATA",
    message: "Stored task data is malformed.",
  });
};

const mutate = (
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

const applicationRows = (databasePath: string): string => {
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
    return JSON.stringify(
      tables.map((table) => ({
        table,
        rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      })),
    );
  } finally {
    sqlite.close();
  }
};

const createActiveItem = (
  id: string,
  scope: ContextScope,
  kind: ContextKind,
  authority: ContextAuthority,
  effectiveAt: string,
  body: string,
): ContextItem => {
  const base = makeContextItem(id, scope, { effectiveAt, body });
  return ContextItemSchema.parse({ ...base, kind, authority });
};

describe("S2B2 active Context Item public contract", () => {
  it("keeps every valid status in S2B1 raw output and includes only ACTIVE in S2B2", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      for (const [scopeIndex, scope] of allowedScopes().entries()) {
        for (const status of STATUSES) {
          storage.createContextItem(
            makeContextItem(
              `ctx_status_${scopeIndex}_${status.toLowerCase()}`,
              scope,
              { status },
            ),
          );
        }
      }

      const raw = readRaw(storage);
      const active = readActive(storage);
      expect(raw.buckets.map(({ contextItems }) =>
        contextItems.map(({ status }) => status).sort(),
      )).toEqual(allowedScopes().map(() => [...STATUSES].sort()));
      expect(itemIds(active)).toEqual([
        ["ctx_status_0_active"],
        ["ctx_status_1_active"],
        ["ctx_status_2_active"],
      ]);
      expect(active.allowedContextSet).toEqual(raw.allowedContextSet);
      expect(active.buckets.map(({ scope }) => scope)).toEqual(
        raw.buckets.map(({ scope }) => scope),
      );
    });
  });

  it("includes only the target Project, parent Big Task, and target Subtask", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const matrix = [
        [makeContextItem("ctx_scope_project", projectScope()), true],
        [makeContextItem("ctx_scope_big_task", bigTaskScope()), true],
        [makeContextItem("ctx_scope_subtask", subtaskScope()), true],
        [
          makeContextItem(
            "ctx_scope_sibling",
            subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
          ),
          false,
        ],
        [
          makeContextItem(
            "ctx_scope_other_big_task",
            bigTaskScope(TARGET_PROJECT, OTHER_BIG_TASK),
          ),
          false,
        ],
        [
          makeContextItem(
            "ctx_scope_other_subtask",
            subtaskScope(TARGET_PROJECT, OTHER_BIG_TASK, OTHER_SUBTASK),
          ),
          false,
        ],
        [makeContextItem("ctx_scope_foreign_project", projectScope(FOREIGN_PROJECT)), false],
        [
          makeContextItem(
            "ctx_scope_foreign_big_task",
            bigTaskScope(FOREIGN_PROJECT, FOREIGN_BIG_TASK),
          ),
          false,
        ],
        [
          makeContextItem(
            "ctx_scope_foreign_subtask",
            subtaskScope(FOREIGN_PROJECT, FOREIGN_BIG_TASK, FOREIGN_SUBTASK),
          ),
          false,
        ],
      ] as const;
      matrix.forEach(([item]) => storage.createContextItem(item));

      const returned = new Set(
        readActive(storage).buckets.flatMap(({ contextItems }) =>
          contextItems.map(({ id }) => id),
        ),
      );
      for (const [item, included] of matrix) {
        expect(returned.has(item.id)).toBe(included);
      }
    });
  });

  it("returns every ACTIVE item without kind, authority, recency, or semantic ranking", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const activeItems = [
        createActiveItem(
          "ctx_multi_candidate",
          bigTaskScope(),
          "OPEN_QUESTION",
          "CODEX_CANDIDATE",
          "2026-08-09T02:00:00.000Z",
          "The rollout should stop.",
        ),
        createActiveItem(
          "ctx_multi_human",
          bigTaskScope(),
          "DECISION",
          "HUMAN",
          "2026-08-09T01:00:00.000Z",
          "The rollout should continue.",
        ),
        createActiveItem(
          "ctx_multi_system",
          bigTaskScope(),
          "CONSTRAINT",
          "SYSTEM",
          "2026-08-09T03:00:00.000Z",
          "The rollout remains undecided.",
        ),
      ];
      activeItems.forEach((item) => storage.createContextItem(item));

      expect(itemIds(readActive(storage))[1]).toEqual([
        "ctx_multi_human",
        "ctx_multi_candidate",
        "ctx_multi_system",
      ]);
    });
  });

  it("preserves bucket order and effectiveAt then ID order after randomized insertion", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      for (const [scopeIndex, scope] of allowedScopes().entries()) {
        [
          makeContextItem(`ctx_order_${scopeIndex}_z`, scope, {
            effectiveAt: "2026-08-11T00:00:00.000Z",
          }),
          makeContextItem(`ctx_order_${scopeIndex}_b`, scope, {
            effectiveAt: "2026-08-10T00:00:00.000Z",
          }),
          makeContextItem(`ctx_order_${scopeIndex}_excluded`, scope, {
            status: "PROPOSED",
            effectiveAt: "2026-08-08T00:00:00.000Z",
          }),
          makeContextItem(`ctx_order_${scopeIndex}_a`, scope, {
            effectiveAt: "2026-08-10T00:00:00.000Z",
          }),
        ].forEach((item) => storage.createContextItem(item));
      }

      const snapshot = readActive(storage);
      expect(snapshot.buckets.map(({ scope }) => scope.scopeType)).toEqual([
        "PROJECT",
        "BIG_TASK",
        "SUBTASK",
      ]);
      expect(itemIds(snapshot)).toEqual([
        ["ctx_order_0_a", "ctx_order_0_b", "ctx_order_0_z"],
        ["ctx_order_1_a", "ctx_order_1_b", "ctx_order_1_z"],
        ["ctx_order_2_a", "ctx_order_2_b", "ctx_order_2_z"],
      ]);
    });
  });

  const asymmetricCases = [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ] as const;

  it.each(asymmetricCases)(
    "always returns three buckets for Project=%s BigTask=%s Subtask=%s",
    (hasProject, hasBigTask, hasSubtask) => {
      withMemoryStorage((storage) => {
        seedTopology(storage);
        const presence = [hasProject, hasBigTask, hasSubtask];
        allowedScopes().forEach((scope, index) => {
          if (presence[index]) {
            storage.createContextItem(
              makeContextItem(`ctx_asymmetric_${index}`, scope),
            );
          }
        });

        const snapshot = readActive(storage);
        expect(snapshot.buckets).toHaveLength(3);
        expect(snapshot.buckets.map(({ scope }) => scope.scopeType)).toEqual([
          "PROJECT",
          "BIG_TASK",
          "SUBTASK",
        ]);
        expect(itemIds(snapshot)).toEqual(
          presence.map((present, index) =>
            present ? [`ctx_asymmetric_${index}`] : [],
          ),
        );
      });
    },
  );

  it("uses canonical Subtask input and sanitized missing-target failures", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      expect(
        captureTaskStorageError(() =>
          storage.readActiveContextItemsForSubtask(
            " st_active " as SubtaskId,
          ),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(
        captureTaskStorageError(() =>
          storage.readActiveContextItemsForSubtask(
            SubtaskIdSchema.parse("st_active_missing"),
          ),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });
});

describe("S2B2 validates the complete S2B1 snapshot before filtering", () => {
  const corruptionCases = allowedScopes().flatMap((scope) =>
    NON_ACTIVE_STATUSES.map((status) => ({ scope, status })),
  );

  it.each(corruptionCases)(
    "fails closed for malformed excluded $status evidence at $scope.scopeType scope",
    ({ scope, status }) => {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTopology(setup);
        const item = makeContextItem(
          `ctx_corrupt_${scope.scopeType.toLowerCase()}_${status.toLowerCase()}`,
          scope,
          { status },
        );
        setup.createContextItem(item);
        setup.close();
        mutate(
          databasePath,
          "UPDATE context_items SET title = ? WHERE id = ?",
          ` ${item.title} `,
          item.id,
        );

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectMalformed(() => readActive(storage));
        } finally {
          storage.close();
        }
      });
    },
  );

  it("rejects target-normalizing scope alias corruption on non-ACTIVE evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const item = makeContextItem("ctx_active_alias", projectScope(), {
        status: "REJECTED",
      });
      setup.createContextItem(item);
      setup.close();
      mutate(
        databasePath,
        "UPDATE context_items SET project_id = ? WHERE id = ?",
        `\u00a0${TARGET_PROJECT}\u00a0`,
        item.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => readActive(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("rejects a linked-successor alias discovered from excluded allowed evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const prior = makeContextItem("ctx_active_link_prior", projectScope());
      const sibling = makeContextItem(
        "ctx_active_link_sibling",
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
      );
      setup.createContextItem(prior);
      setup.createContextItem(sibling);
      setup.close();
      mutate(
        databasePath,
        "UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?",
        prior.id,
      );
      mutate(
        databasePath,
        "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
        `\u00a0${prior.id}\u00a0`,
        sibling.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => readActive(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("isolates malformed sibling, unrelated Big Task, and foreign evidence", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const allowed = allowedScopes().map((scope, index) =>
        makeContextItem(`ctx_isolation_allowed_${index}`, scope),
      );
      allowed.forEach((item) => setup.createContextItem(item));
      const unrelated = [
        makeContextItem(
          "ctx_isolation_sibling",
          subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
          { status: "PROPOSED" },
        ),
        makeContextItem(
          "ctx_isolation_other",
          bigTaskScope(TARGET_PROJECT, OTHER_BIG_TASK),
          { status: "SUPERSEDED" },
        ),
        makeContextItem(
          "ctx_isolation_foreign",
          projectScope(FOREIGN_PROJECT),
          { status: "RESOLVED" },
        ),
      ];
      unrelated.forEach((item) => setup.createContextItem(item));
      setup.close();
      unrelated.forEach((item) => {
        mutate(
          databasePath,
          "UPDATE context_items SET title = ? WHERE id = ?",
          ` ${item.title} `,
          item.id,
        );
      });

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(readActive(storage))).toEqual([
          [allowed[0]!.id],
          [allowed[1]!.id],
          [allowed[2]!.id],
        ]);
      } finally {
        storage.close();
      }
    });
  });

  it("does not add an ACTIVE SQL predicate ahead of raw validation", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      storage.createContextItem(
        makeContextItem("ctx_sql_active", projectScope()),
      );
      storage.createContextItem(
        makeContextItem("ctx_sql_resolved", projectScope(), {
          status: "RESOLVED",
        }),
      );

      const prototype = StatementSync.prototype as unknown as {
        all: (...parameters: unknown[]) => unknown[];
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalAll = prototype.all;
      const originalGet = prototype.get;
      const contextSql: string[] = [];
      prototype.all = function (...parameters: unknown[]): unknown[] {
        const result = Reflect.apply(originalAll, this, parameters) as unknown[];
        if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
          contextSql.push(this.sourceSQL);
        }
        return result;
      };
      prototype.get = function (...parameters: unknown[]): unknown {
        const result = Reflect.apply(originalGet, this, parameters);
        if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
          contextSql.push(this.sourceSQL);
        }
        return result;
      };

      try {
        expect(itemIds(readActive(storage))[0]).toEqual(["ctx_sql_active"]);
      } finally {
        prototype.all = originalAll;
        prototype.get = originalGet;
      }
      expect(contextSql.length).toBeGreaterThan(0);
      expect(
        contextSql.some((statement) =>
          /where[\s\S]*\bstatus\b/i.test(statement),
        ),
      ).toBe(false);
    });
  });
});

describe("S2B2 supersession and snapshot semantics", () => {
  it("returns only the ACTIVE tips of valid two-node and longer raw chains", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const a = makeContextItem("ctx_chain_a", projectScope());
      storage.createContextItem(a);
      const b = makeContextItem("ctx_chain_b", projectScope(), {
        effectiveAt: "2026-08-10T00:00:00.000Z",
        supersedesContextItemId: a.id,
      });
      storage.supersedeContextItem(b);

      const longA = makeContextItem("ctx_long_a", subtaskScope());
      storage.createContextItem(longA);
      const longB = makeContextItem("ctx_long_b", subtaskScope(), {
        effectiveAt: "2026-08-10T01:00:00.000Z",
        supersedesContextItemId: longA.id,
      });
      storage.supersedeContextItem(longB);
      const longC = makeContextItem("ctx_long_c", subtaskScope(), {
        effectiveAt: "2026-08-10T02:00:00.000Z",
        supersedesContextItemId: longB.id,
      });
      storage.supersedeContextItem(longC);

      expect(itemIds(readRaw(storage))).toEqual([
        [a.id, b.id],
        [],
        [longA.id, longB.id, longC.id],
      ]);
      expect(itemIds(readActive(storage))).toEqual([
        [b.id],
        [],
        [longC.id],
      ]);
    });
  });

  it("observes a complete OLD or complete NEW multi-scope status transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const oldProject = makeContextItem("ctx_snapshot_old_project", projectScope());
      const newProject = makeContextItem("ctx_snapshot_new_project", projectScope(), {
        status: "PROPOSED",
      });
      const oldSubtask = makeContextItem("ctx_snapshot_old_subtask", subtaskScope());
      const newSubtask = makeContextItem("ctx_snapshot_new_subtask", subtaskScope(), {
        status: "PROPOSED",
      });
      [oldProject, newProject, oldSubtask, newSubtask].forEach((item) =>
        setup.createContextItem(item),
      );
      setup.close();
      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare("UPDATE context_items SET status = 'RESOLVED' WHERE id IN (?, ?)")
        .run(oldProject.id, oldSubtask.id);
      writer
        .prepare("UPDATE context_items SET status = 'ACTIVE' WHERE id IN (?, ?)")
        .run(newProject.id, newSubtask.id);

      const prototype = StatementSync.prototype as unknown as {
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalGet = prototype.get;
      let committed = false;
      prototype.get = function (...parameters: unknown[]): unknown {
        const result = Reflect.apply(originalGet, this, parameters);
        if (!committed && /from\s+"?subtasks"?/i.test(this.sourceSQL)) {
          writer.exec("COMMIT");
          committed = true;
        }
        return result;
      };

      let oldSnapshot: ActiveContextItemSnapshot;
      try {
        oldSnapshot = readActive(reader);
      } finally {
        prototype.get = originalGet;
      }
      try {
        expect(committed).toBe(true);
        expect(itemIds(oldSnapshot)).toEqual([
          [oldProject.id],
          [],
          [oldSubtask.id],
        ]);
        expect(itemIds(readActive(reader))).toEqual([
          [newProject.id],
          [],
          [newSubtask.id],
        ]);
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

describe("S2B2 caller transaction and read-only behavior", () => {
  it("reuses outer transactions and leaves successful commit or rollback to the caller", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const committed = makeContextItem("ctx_outer_committed", projectScope());
      storage.runInTransaction((transaction) => {
        transaction.createContextItem(committed);
        expect(itemIds(readActive(transaction))[0]).toEqual([committed.id]);
      });
      expect(storage.getContextItemById(committed.id)).toEqual(committed);

      const rolledBack = makeContextItem("ctx_outer_rolled_back", subtaskScope());
      expect(
        captureTaskStorageError(() =>
          storage.runInTransaction((transaction) => {
            transaction.createContextItem(rolledBack);
            expect(itemIds(readActive(transaction))[2]).toEqual([
              rolledBack.id,
            ]);
            throw new Error("caller rollback");
          }),
        ),
      ).toMatchObject({ code: "TRANSACTION_FAILED" });
      expect(storage.getContextItemById(rolledBack.id)).toBeNull();
    });
  });

  it("leaves a caught failure under caller control and an uncaught failure to outer rollback", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const corrupt = makeContextItem("ctx_outer_corrupt", projectScope(), {
        status: "REJECTED",
      });
      setup.createContextItem(corrupt);
      setup.close();
      mutate(
        databasePath,
        "UPDATE context_items SET title = ? WHERE id = ?",
        ` ${corrupt.title} `,
        corrupt.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const survives = makeContextItem(
        "ctx_outer_survives",
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
      );
      const rolledBack = makeContextItem(
        "ctx_outer_failure_rollback",
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
      );
      try {
        storage.runInTransaction((transaction) => {
          transaction.createContextItem(survives);
          expectMalformed(() => readActive(transaction));
        });
        expect(storage.getContextItemById(survives.id)).toEqual(survives);

        expectMalformed(() =>
          storage.runInTransaction((transaction) => {
            transaction.createContextItem(rolledBack);
            readActive(transaction);
          }),
        );
        expect(storage.getContextItemById(rolledBack.id)).toBeNull();
      } finally {
        storage.close();
      }
    });
  });

  it("leaves all application rows and Audit Events unchanged across every read path", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const item = makeContextItem("ctx_read_only_active", projectScope());
      setup.createContextItem(item);
      setup.close();
      const before = applicationRows(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      readActive(storage);
      readActive(storage);
      readActive(storage, SIBLING_SUBTASK);
      storage.runInTransaction((transaction) => {
        readActive(transaction);
      });
      storage.close();
      expect(applicationRows(databasePath)).toBe(before);

      mutate(
        databasePath,
        "UPDATE context_items SET title = ? WHERE id = ?",
        ` ${item.title} `,
        item.id,
      );
      const corruptedBefore = applicationRows(databasePath);
      const malformed = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => readActive(malformed));
      } finally {
        malformed.close();
      }
      expect(applicationRows(databasePath)).toBe(corruptedBefore);
    });
  });
});

const MUTATION_REVIEW = [
  ["add SQL WHERE ACTIVE before validation", "non-ACTIVE corruption matrix + SQL trace"],
  ["include PROPOSED", "five-status matrix"],
  ["include SUPERSEDED", "five-status matrix + chain tips"],
  ["include REJECTED", "five-status matrix"],
  ["include RESOLVED", "five-status matrix"],
  ["exclude ACTIVE", "five-status matrix"],
  ["include sibling ACTIVE", "scope matrix"],
  ["include other Big Task ACTIVE", "scope matrix"],
  ["include other Big Task Subtask ACTIVE", "scope matrix"],
  ["include foreign Project ACTIVE", "scope matrix"],
  ["include foreign Big Task ACTIVE", "scope matrix"],
  ["include foreign Subtask ACTIVE", "scope matrix"],
  ["retain only one ACTIVE item", "multi-ACTIVE regression"],
  ["latest ACTIVE wins", "multi-ACTIVE ordering regression"],
  ["HUMAN authority wins", "multi-authority regression"],
  ["kind precedence wins", "multi-kind regression"],
  ["semantic text conflict chooses winner", "contradictory-body regression"],
  ["swap bucket order", "bucket-order assertions"],
  ["omit empty Project bucket", "eight asymmetric cases"],
  ["omit empty Big Task bucket", "eight asymmetric cases"],
  ["omit empty Subtask bucket", "eight asymmetric cases"],
  ["remove effectiveAt ordering", "random insertion ordering"],
  ["remove ID tie break", "tied-time ordering"],
  ["hide malformed PROPOSED", "non-ACTIVE corruption matrix"],
  ["hide malformed SUPERSEDED", "non-ACTIVE corruption matrix"],
  ["hide malformed REJECTED", "non-ACTIVE corruption matrix"],
  ["hide malformed RESOLVED", "non-ACTIVE corruption matrix"],
  ["bypass target alias detection", "non-ACTIVE alias regression"],
  ["bypass linked-successor alias detection", "linked alias regression"],
  ["globally poison on sibling corruption", "unrelated isolation"],
  ["return superseded chain root", "two-node chain regression"],
  ["return superseded chain middle", "long-chain regression"],
  ["read one bucket outside snapshot", "multi-scope status transaction"],
  ["start nested read transaction", "outer transaction reuse"],
  ["commit caller transaction from read", "caller commit/rollback regression"],
  ["roll back caller after caught failure", "caught-failure regression"],
  ["write a status during read", "application-row comparison"],
  ["update a timestamp during read", "application-row comparison"],
  ["append an Audit Event during read", "application-row comparison"],
  ["change S2B1 raw status behavior", "raw five-status regression"],
] as const;

describe("S2B2 mutation review", () => {
  it("maps at least thirty plausible mutations with no material survivor", () => {
    expect(MUTATION_REVIEW).toHaveLength(40);
    expect(new Set(MUTATION_REVIEW.map(([mutation]) => mutation)).size).toBe(40);
    expect(MUTATION_REVIEW.filter(([, guard]) => guard.length === 0)).toEqual([]);
  });
});
