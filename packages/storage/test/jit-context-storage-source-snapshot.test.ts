import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ContextScopeSchema,
  JitContextPacketProfileKindSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  ContextScope,
  JitContextPacketProfileKind,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type {
  JitContextStorageSourceSnapshot,
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

const TARGET_PROJECT = "prj_jit_snapshot";
const TARGET_BIG_TASK = "bt_jit_snapshot";
const TARGET_SUBTASK = SubtaskIdSchema.parse("st_jit_snapshot");
const SIBLING_SUBTASK = SubtaskIdSchema.parse("st_jit_snapshot_sibling");

type StandardSnapshot = Extract<
  JitContextStorageSourceSnapshot,
  { readonly profile: "STANDARD_SUBTASK_EXECUTION" }
>;

const projectScope = (): ContextScope =>
  ContextScopeSchema.parse({
    scopeType: "PROJECT",
    projectId: TARGET_PROJECT,
  });

const bigTaskScope = (): ContextScope =>
  ContextScopeSchema.parse({
    scopeType: "BIG_TASK",
    projectId: TARGET_PROJECT,
    bigTaskId: TARGET_BIG_TASK,
  });

const subtaskScope = (subtaskId: SubtaskId = TARGET_SUBTASK): ContextScope =>
  ContextScopeSchema.parse({
    scopeType: "SUBTASK",
    projectId: TARGET_PROJECT,
    bigTaskId: TARGET_BIG_TASK,
    subtaskId,
  });

const allowedScopes = (): readonly ContextScope[] => [
  projectScope(),
  bigTaskScope(),
  subtaskScope(),
];

const seedHierarchy = (storage: TaskStorage): void => {
  storage.createProject(makeProject(TARGET_PROJECT, "jit-snapshot"));
  storage.createBigTask(makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK));
  storage.createSubtask(makeSubtask(SIBLING_SUBTASK, TARGET_BIG_TASK));
};

const readStandard = (storage: TaskStorage): StandardSnapshot => {
  const snapshot = storage.readJitContextSourceSnapshotForSubtask(
    TARGET_SUBTASK,
    "STANDARD_SUBTASK_EXECUTION",
  );
  if (snapshot.profile !== "STANDARD_SUBTASK_EXECUTION") {
    throw new Error("Expected a Standard storage source snapshot.");
  }
  return snapshot;
};

const mutateDatabase = (
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
    return JSON.stringify(
      [
        "projects",
        "big_tasks",
        "subtasks",
        "task_dependencies",
        "subtask_implementation_checkpoints",
        "context_items",
        "context_digests",
        "audit_events",
      ].map((table) => ({
        table,
        rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      })),
    );
  } finally {
    sqlite.close();
  }
};

const expectDeeplyFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const nestedValue of Object.values(value)) {
    expectDeeplyFrozen(nestedValue);
  }
};

const collectPropertyNames = (value: unknown, names = new Set<string>()): Set<string> => {
  if (typeof value !== "object" || value === null) {
    return names;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    names.add(key);
    collectPropertyNames(nestedValue, names);
  }
  return names;
};

const captureContextItemQueries = <T>(operation: () => T): {
  readonly result: T;
  readonly queries: readonly string[];
} => {
  const prototype = StatementSync.prototype as unknown as {
    get: (...parameters: unknown[]) => unknown;
    all: (...parameters: unknown[]) => unknown[];
    readonly sourceSQL: string;
  };
  const originalGet = prototype.get;
  const originalAll = prototype.all;
  const queries: string[] = [];
  prototype.get = function (...parameters: unknown[]): unknown {
    if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
      queries.push(this.sourceSQL);
    }
    return Reflect.apply(originalGet, this, parameters);
  };
  prototype.all = function (...parameters: unknown[]): unknown[] {
    if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
      queries.push(this.sourceSQL);
    }
    return Reflect.apply(originalAll, this, parameters) as unknown[];
  };
  try {
    return { result: operation(), queries };
  } finally {
    prototype.get = originalGet;
    prototype.all = originalAll;
  }
};

describe("profile-aware JIT storage source public contract", () => {
  it("reuses exactly the accepted profile vocabulary and rejects unknown profiles", () => {
    expect(JitContextPacketProfileKindSchema.options).toEqual([
      "STANDARD_SUBTASK_EXECUTION",
      "FRESH_INDEPENDENT_QA",
      "FOCUSED_RE_QA",
    ]);

    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      expect(
        captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            TARGET_SUBTASK,
            "UNKNOWN" as JitContextPacketProfileKind,
          ),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
    });
  });

  it("returns canonical hierarchy, accepted ACL, and exact S2B2 ACTIVE semantics", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const statuses = [
        "PROPOSED",
        "SUPERSEDED",
        "REJECTED",
        "RESOLVED",
      ] as const;
      for (const [scopeIndex, scope] of allowedScopes().entries()) {
        [
          makeContextItem(`ctx_jit_${scopeIndex}_late`, scope, {
            effectiveAt: "2026-08-11T00:00:00.000Z",
            body: "Earlier-looking wording must not affect ordering.",
          }),
          makeContextItem(`ctx_jit_${scopeIndex}_b`, scope, {
            effectiveAt: "2026-08-10T00:00:00.000Z",
            body: "Conflicting conclusion B remains ACTIVE.",
          }),
          makeContextItem(`ctx_jit_${scopeIndex}_a`, scope, {
            effectiveAt: "2026-08-10T00:00:00.000Z",
            body: "Conflicting conclusion A remains ACTIVE.",
          }),
          ...statuses.map((status) =>
            makeContextItem(
              `ctx_jit_${scopeIndex}_${status.toLowerCase()}`,
              scope,
              { status },
            ),
          ),
        ].forEach((item) => storage.createContextItem(item));
      }

      const acceptedRaw = storage.readAllowedRawContextItemsForSubtask(TARGET_SUBTASK);
      const accepted = storage.readActiveContextItemsForSubtask(TARGET_SUBTASK);
      const snapshot = readStandard(storage);
      expect(snapshot).toMatchObject({
        profile: "STANDARD_SUBTASK_EXECUTION",
        project: makeProject(TARGET_PROJECT, "jit-snapshot"),
        bigTask: makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT),
        subtask: makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK),
      });
      expect(snapshot.allowedContextSet).toEqual(acceptedRaw.allowedContextSet);
      expect(snapshot.allowedContextSet).toEqual(accepted.allowedContextSet);
      expect(snapshot.activeContext).toEqual({
        project: accepted.buckets[0].contextItems,
        bigTask: accepted.buckets[1].contextItems,
        subtask: accepted.buckets[2].contextItems,
      });
      expect(
        Object.values(snapshot.activeContext).map((items) =>
          items.map(({ id }) => id),
        ),
      ).toEqual(
        allowedScopes().map((_scope, scopeIndex) => [
          `ctx_jit_${scopeIndex}_a`,
          `ctx_jit_${scopeIndex}_b`,
          `ctx_jit_${scopeIndex}_late`,
        ]),
      );
      expect(Object.keys(snapshot)).toEqual([
        "profile",
        "project",
        "bigTask",
        "subtask",
        "allowedContextSet",
        "activeContext",
      ]);
    });
  });

  it("returns task-only QA unions and issues zero Context Item queries", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      allowedScopes().forEach((scope, index) =>
        storage.createContextItem(makeContextItem(`ctx_qa_excluded_${index}`, scope)),
      );

      for (const profile of [
        "FRESH_INDEPENDENT_QA",
        "FOCUSED_RE_QA",
      ] as const) {
        const { result, queries } = captureContextItemQueries(() =>
          storage.readJitContextSourceSnapshotForSubtask(TARGET_SUBTASK, profile),
        );
        expect(queries).toEqual([]);
        expect(Object.keys(result)).toEqual([
          "profile",
          "project",
          "bigTask",
          "subtask",
        ]);
        expect(result).toEqual({
          profile,
          project: makeProject(TARGET_PROJECT, "jit-snapshot"),
          bigTask: makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT),
          subtask: makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK),
        });
        const propertyNames = collectPropertyNames(result);
        for (const prohibited of [
          "allowedContextSet",
          "activeContext",
          "contextItems",
          "canonicalProjectRules",
          "repositoryRuntimeEvidence",
          "lockedInvariants",
          "qaInstructions",
          "boundedRetestTargets",
          "acceptedPromotedContext",
          "promotedContext",
          "contextDigest",
          "rawHistory",
          "tokenBudget",
          "providerData",
        ]) {
          expect(propertyNames.has(prohibited)).toBe(false);
        }
      }
    });
  });

  it("uses the explicit profile without lifecycle inference", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      setup.createProject(makeProject(TARGET_PROJECT, "jit-snapshot"));
      setup.createBigTask(makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT));
      setup.createSubtask(makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK, "DONE"));
      setup.close();
      mutateDatabase(
        databasePath,
        "UPDATE subtasks SET maturity = 'ACCEPTED' WHERE id = ?",
        TARGET_SUBTASK,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(readStandard(storage)).toMatchObject({
          profile: "STANDARD_SUBTASK_EXECUTION",
          subtask: { status: "DONE", maturity: "ACCEPTED" },
        });
        const qa = storage.readJitContextSourceSnapshotForSubtask(
          TARGET_SUBTASK,
          "FRESH_INDEPENDENT_QA",
        );
        expect(qa).toMatchObject({
          profile: "FRESH_INDEPENDENT_QA",
          subtask: { status: "DONE", maturity: "ACCEPTED" },
        });
        expect("activeContext" in qa).toBe(false);
      } finally {
        storage.close();
      }
    });
  });

  it("requires a canonical request ID and preserves missing-target errors", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      expect(
        captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            " st_jit_snapshot " as SubtaskId,
            "STANDARD_SUBTASK_EXECUTION",
          ),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(
        captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            SubtaskIdSchema.parse("st_jit_snapshot_missing"),
            "FRESH_INDEPENDENT_QA",
          ),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });
});

describe("QA retrieval isolation and malformed-data boundaries", () => {
  it.each(["scope alias", "broken linked history"] as const)(
    "does not query relevant malformed Context Item evidence for QA: %s",
    (corruption) => {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(setup);
        if (corruption === "scope alias") {
          setup.createContextItem(makeContextItem("ctx_jit_corrupt_alias", projectScope()));
        } else {
          const prior = makeContextItem("ctx_jit_corrupt_prior", subtaskScope());
          setup.createContextItem(prior);
          setup.supersedeContextItem(
            makeContextItem("ctx_jit_corrupt_successor", subtaskScope(), {
              effectiveAt: "2026-08-10T00:00:00.000Z",
              supersedesContextItemId: prior.id,
            }),
          );
        }
        setup.close();

        if (corruption === "scope alias") {
          mutateDatabase(
            databasePath,
            "UPDATE context_items SET project_id = ? WHERE id = ?",
            ` ${TARGET_PROJECT} `,
            "ctx_jit_corrupt_alias",
          );
        } else {
          mutateDatabase(
            databasePath,
            "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
            "ctx_jit_corrupt_successor",
          );
        }
        const corruptedBefore = applicationRows(databasePath);

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const acceptedError = captureTaskStorageError(() =>
            storage.readActiveContextItemsForSubtask(TARGET_SUBTASK),
          );
          const standardError = captureTaskStorageError(() => readStandard(storage));
          expect(standardError).toMatchObject({
            code: "MALFORMED_STORED_DATA",
            message: "Stored task data is malformed.",
          });
          expect(standardError).toMatchObject({
            code: acceptedError.code,
            message: acceptedError.message,
          });

          for (const profile of [
            "FRESH_INDEPENDENT_QA",
            "FOCUSED_RE_QA",
          ] as const) {
            const { result, queries } = captureContextItemQueries(() =>
              storage.readJitContextSourceSnapshotForSubtask(
                TARGET_SUBTASK,
                profile,
              ),
            );
            expect(queries).toEqual([]);
            expect(result.profile).toBe(profile);
            expect(Object.keys(result)).toEqual([
              "profile",
              "project",
              "bigTask",
              "subtask",
            ]);
          }
        } finally {
          storage.close();
        }
        expect(applicationRows(databasePath)).toBe(corruptedBefore);
      });
    },
  );

  it("isolates malformed sibling Context Items for every profile", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(setup);
      const allowed = makeContextItem("ctx_jit_allowed", projectScope());
      const sibling = makeContextItem(
        "ctx_jit_sibling_corrupt",
        subtaskScope(SIBLING_SUBTASK),
      );
      setup.createContextItem(allowed);
      setup.createContextItem(sibling);
      setup.close();
      mutateDatabase(
        databasePath,
        "UPDATE context_items SET title = ? WHERE id = ?",
        ` ${sibling.title} `,
        sibling.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(readStandard(storage).activeContext.project).toEqual([allowed]);
        expect(
          storage.readJitContextSourceSnapshotForSubtask(
            TARGET_SUBTASK,
            "FRESH_INDEPENDENT_QA",
          ).profile,
        ).toBe("FRESH_INDEPENDENT_QA");
        expect(
          captureTaskStorageError(() =>
            storage.readActiveContextItemsForSubtask(SIBLING_SUBTASK),
          ),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
      } finally {
        storage.close();
      }
    });
  });
});

describe("task hierarchy fail-closed parity", () => {
  const corruptions = [
    {
      label: "missing Big Task",
      sql: "DELETE FROM big_tasks WHERE id = ?",
      parameters: [TARGET_BIG_TASK],
      expectedCode: "MALFORMED_STORED_DATA",
    },
    {
      label: "missing Project",
      sql: "DELETE FROM projects WHERE id = ?",
      parameters: [TARGET_PROJECT],
      expectedCode: "MALFORMED_STORED_DATA",
    },
    {
      label: "noncanonical Project ID",
      sql: "UPDATE projects SET id = ? WHERE id = ?",
      parameters: [` ${TARGET_PROJECT} `, TARGET_PROJECT],
      expectedCode: "MALFORMED_STORED_DATA",
    },
    {
      label: "noncanonical Big Task ID",
      sql: "UPDATE big_tasks SET id = ? WHERE id = ?",
      parameters: [` ${TARGET_BIG_TASK} `, TARGET_BIG_TASK],
      expectedCode: "MALFORMED_STORED_DATA",
    },
    {
      label: "noncanonical target Subtask ID",
      sql: "UPDATE subtasks SET id = ? WHERE id = ?",
      parameters: [` ${TARGET_SUBTASK} `, TARGET_SUBTASK],
      expectedCode: "PARENT_NOT_FOUND",
    },
    {
      label: "noncanonical Big Task parent relation",
      sql: "UPDATE big_tasks SET project_id = ? WHERE id = ?",
      parameters: [` ${TARGET_PROJECT} `, TARGET_BIG_TASK],
      expectedCode: "MALFORMED_STORED_DATA",
    },
  ] as const;

  it.each(corruptions)("preserves accepted behavior for $label", (corruption) => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(setup);
      setup.close();
      mutateDatabase(databasePath, corruption.sql, ...corruption.parameters);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const acceptedError = captureTaskStorageError(() =>
          storage.readAllowedRawContextItemsForSubtask(TARGET_SUBTASK),
        );
        const standardError = captureTaskStorageError(() => readStandard(storage));
        const qaError = captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            TARGET_SUBTASK,
            "FRESH_INDEPENDENT_QA",
          ),
        );
        expect(acceptedError.code).toBe(corruption.expectedCode);
        expect(standardError).toMatchObject({
          code: acceptedError.code,
          message: acceptedError.message,
        });
        expect(qaError).toMatchObject({
          code: acceptedError.code,
          message: acceptedError.message,
        });
      } finally {
        storage.close();
      }
    });
  });
});

describe("coherent snapshot, transaction ownership, and read-only behavior", () => {
  it("owns exactly one read boundary and observes one coherent hierarchy/context state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const oldProject = makeProject(TARGET_PROJECT, "jit-snapshot");
      const oldBigTask = makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT);
      const oldSubtask = makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK);
      const oldItem = makeContextItem("ctx_jit_coherent_old", projectScope());
      const newItem = makeContextItem("ctx_jit_coherent_new", projectScope(), {
        status: "PROPOSED",
      });
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      setup.createProject(oldProject);
      setup.createBigTask(oldBigTask);
      setup.createSubtask(oldSubtask);
      setup.createContextItem(oldItem);
      setup.createContextItem(newItem);
      setup.close();
      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE projects SET name = ? WHERE id = ?").run(
        "NEW Project",
        TARGET_PROJECT,
      );
      writer.prepare("UPDATE big_tasks SET title = ? WHERE id = ?").run(
        "NEW Big Task",
        TARGET_BIG_TASK,
      );
      writer.prepare("UPDATE subtasks SET title = ? WHERE id = ?").run(
        "NEW Subtask",
        TARGET_SUBTASK,
      );
      writer.prepare("UPDATE context_items SET status = 'RESOLVED' WHERE id = ?").run(
        oldItem.id,
      );
      writer.prepare("UPDATE context_items SET status = 'ACTIVE' WHERE id = ?").run(
        newItem.id,
      );

      const statementPrototype = StatementSync.prototype as unknown as {
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalGet = statementPrototype.get;
      let writerCommitted = false;
      statementPrototype.get = function (...parameters: unknown[]): unknown {
        const result = Reflect.apply(originalGet, this, parameters);
        if (!writerCommitted && /from\s+"?subtasks"?/i.test(this.sourceSQL)) {
          writer.exec("COMMIT");
          writerCommitted = true;
        }
        return result;
      };

      const databasePrototype = DatabaseSync.prototype as unknown as {
        exec: (sql: string) => void;
      };
      const originalExec = databasePrototype.exec;
      const transactionStatements: string[] = [];
      databasePrototype.exec = function (sql: string): void {
        if (
          this !== writer &&
          (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
        ) {
          transactionStatements.push(sql);
        }
        Reflect.apply(originalExec, this, [sql]);
      };

      let oldSnapshot: StandardSnapshot;
      try {
        oldSnapshot = readStandard(reader);
      } finally {
        statementPrototype.get = originalGet;
        databasePrototype.exec = originalExec;
      }
      try {
        expect(writerCommitted).toBe(true);
        expect(transactionStatements).toEqual(["BEGIN", "COMMIT"]);
        expect(oldSnapshot.project.name).toBe(oldProject.name);
        expect(oldSnapshot.bigTask.title).toBe(oldBigTask.title);
        expect(oldSnapshot.subtask.title).toBe(oldSubtask.title);
        expect(oldSnapshot.activeContext.project.map(({ id }) => id)).toEqual([
          oldItem.id,
        ]);

        const newSnapshot = readStandard(reader);
        expect(newSnapshot.project.name).toBe("NEW Project");
        expect(newSnapshot.bigTask.title).toBe("NEW Big Task");
        expect(newSnapshot.subtask.title).toBe("NEW Subtask");
        expect(newSnapshot.activeContext.project.map(({ id }) => id)).toEqual([
          newItem.id,
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

  it("reuses caller-owned transactions without commit or rollback ownership", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const committed = makeContextItem("ctx_jit_outer_commit", projectScope());
      storage.runInTransaction((transaction) => {
        transaction.createContextItem(committed);
        expect(
          readStandard(transaction).activeContext.project.map(({ id }) => id),
        ).toEqual([committed.id]);
      });
      expect(storage.getContextItemById(committed.id)).toEqual(committed);

      const rolledBack = makeContextItem("ctx_jit_outer_rollback", subtaskScope());
      expect(
        captureTaskStorageError(() =>
          storage.runInTransaction((transaction) => {
            transaction.createContextItem(rolledBack);
            expect(
              readStandard(transaction).activeContext.subtask.map(({ id }) => id),
            ).toEqual([rolledBack.id]);
            throw new Error("caller owns rollback");
          }),
        ),
      ).toMatchObject({ code: "TRANSACTION_FAILED" });
      expect(storage.getContextItemById(rolledBack.id)).toBeNull();
    });
  });

  it("leaves a caught read failure inside a caller transaction under caller control", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(setup);
      const corrupt = makeContextItem("ctx_jit_outer_corrupt", projectScope());
      setup.createContextItem(corrupt);
      setup.close();
      mutateDatabase(
        databasePath,
        "UPDATE context_items SET title = ? WHERE id = ?",
        ` ${corrupt.title} `,
        corrupt.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const survives = makeContextItem(
        "ctx_jit_outer_failure_survives",
        subtaskScope(SIBLING_SUBTASK),
      );
      try {
        storage.runInTransaction((transaction) => {
          transaction.createContextItem(survives);
          expect(
            captureTaskStorageError(() => readStandard(transaction)),
          ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
        });
        expect(storage.getContextItemById(survives.id)).toEqual(survives);
      } finally {
        storage.close();
      }
    });
  });

  it("performs zero application writes across Standard, QA, and error reads", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(setup);
      setup.createContextItem(makeContextItem("ctx_jit_read_only", projectScope()));
      setup.createContextItem(
        makeContextItem("ctx_jit_read_only_rejected", subtaskScope(), {
          status: "REJECTED",
        }),
      );
      setup.close();
      const before = applicationRows(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        readStandard(storage);
        storage.readJitContextSourceSnapshotForSubtask(
          TARGET_SUBTASK,
          "FRESH_INDEPENDENT_QA",
        );
        storage.readJitContextSourceSnapshotForSubtask(
          TARGET_SUBTASK,
          "FOCUSED_RE_QA",
        );
        captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            TARGET_SUBTASK,
            "UNKNOWN" as JitContextPacketProfileKind,
          ),
        );
      } finally {
        storage.close();
      }
      expect(applicationRows(databasePath)).toBe(before);
    });
  });
});

describe("storage-origin trust distinction and mutation safety", () => {
  it("deep-freezes direct results while equal-shaped caller data remains only data", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const storedContextItem = makeContextItem("ctx_jit_frozen", projectScope());
      storage.createContextItem(storedContextItem);
      const snapshot = readStandard(storage);
      const fabricated = structuredClone(snapshot) as JitContextStorageSourceSnapshot;

      expect(fabricated).toEqual(snapshot);
      expect(Object.isFrozen(fabricated)).toBe(false);
      expectDeeplyFrozen(snapshot);
      expect(() => {
        (snapshot.project as { name: string }).name = "Caller mutation";
      }).toThrow(TypeError);
      expect(() => {
        (snapshot.activeContext.project as unknown[]).push({});
      }).toThrow(TypeError);
      expect(storage.getProjectById(snapshot.project.id)?.name).toBe(
        makeProject(TARGET_PROJECT, "jit-snapshot").name,
      );
      expect(storage.getContextItemById(storedContextItem.id)?.body).toBe(
        storedContextItem.body,
      );
      expect(
        [
          "trusted",
          "verified",
          "authorized",
          "storageAuthenticated",
          "capability",
          "signature",
        ].filter((marker) => collectPropertyNames(snapshot).has(marker)),
      ).toEqual([]);
    });
  });

  it("contains no deferred operational source or final-packet fields", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage);
      const serialized = JSON.stringify(readStandard(storage));
      expect(serialized).not.toMatch(
        /canonicalProjectRules|repositoryRuntimeEvidence|lockedInvariants|qaInstructions|boundedRetestTargets|acceptedPromotedContext|promotedContext|contextDigest|rawHistory|priorHandoff|tokenBudget|providerSerialization|jitContextPacket/i,
      );
    });
  });
});
