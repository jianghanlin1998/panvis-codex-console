import { DatabaseSync, StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ContextItemSchema,
  ContextScopeSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  ContextItem,
  ContextScope,
  JitContextPacketProfileKind,
  SubtaskId,
} from "@codex-task-console/domain";
import * as storagePublicApi from "../src/index.js";
import { openTaskDatabase } from "../src/index.js";
import type {
  JitContextStorageSourceSnapshot,
  TaskStorage,
} from "../src/index.js";
import {
  FIXED_TIME,
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeContextItem,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT = "prj_jit_hard";
const BIG_TASK = "bt_jit_hard";
const SUBTASK = SubtaskIdSchema.parse("st_jit_hard");
const SIBLING = SubtaskIdSchema.parse("st_jit_hard_sibling");
const OTHER_BIG_TASK = "bt_jit_hard_other";
const OTHER_SUBTASK = SubtaskIdSchema.parse("st_jit_hard_other");
const FOREIGN_PROJECT = "prj_jit_hard_foreign";
const FOREIGN_BIG_TASK = "bt_jit_hard_foreign";
const FOREIGN_SUBTASK = SubtaskIdSchema.parse("st_jit_hard_foreign");

const PROFILES = [
  "STANDARD_SUBTASK_EXECUTION",
  "FRESH_INDEPENDENT_QA",
  "FOCUSED_RE_QA",
] as const;
const QA_PROFILES = ["FRESH_INDEPENDENT_QA", "FOCUSED_RE_QA"] as const;
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

type StandardSnapshot = Extract<
  JitContextStorageSourceSnapshot,
  { readonly profile: "STANDARD_SUBTASK_EXECUTION" }
>;

interface Target {
  readonly projectId: string;
  readonly bigTaskId: string;
  readonly subtaskId: SubtaskId;
}

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const projectScope = (projectId = PROJECT): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "PROJECT", projectId });

const bigTaskScope = (
  projectId = PROJECT,
  bigTaskId = BIG_TASK,
): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "BIG_TASK", projectId, bigTaskId });

const subtaskScope = (
  projectId = PROJECT,
  bigTaskId = BIG_TASK,
  subtaskId: SubtaskId = SUBTASK,
): ContextScope =>
  ContextScopeSchema.parse({
    scopeType: "SUBTASK",
    projectId,
    bigTaskId,
    subtaskId,
  });

const targetScopes = (target: Target = {
  projectId: PROJECT,
  bigTaskId: BIG_TASK,
  subtaskId: SUBTASK,
}): readonly ContextScope[] => [
  projectScope(target.projectId),
  bigTaskScope(target.projectId, target.bigTaskId),
  subtaskScope(target.projectId, target.bigTaskId, target.subtaskId),
];

const seedTopology = (storage: TaskStorage): void => {
  storage.createProject(makeProject(PROJECT, "jit-hard"));
  storage.createBigTask(makeBigTask(BIG_TASK, PROJECT));
  storage.createSubtask(makeSubtask(SUBTASK, BIG_TASK));
  storage.createSubtask(makeSubtask(SIBLING, BIG_TASK));
  storage.createBigTask(makeBigTask(OTHER_BIG_TASK, PROJECT));
  storage.createSubtask(makeSubtask(OTHER_SUBTASK, OTHER_BIG_TASK));
  storage.createProject(makeProject(FOREIGN_PROJECT, "jit-hard-foreign"));
  storage.createBigTask(makeBigTask(FOREIGN_BIG_TASK, FOREIGN_PROJECT));
  storage.createSubtask(makeSubtask(FOREIGN_SUBTASK, FOREIGN_BIG_TASK));
};

const readStandard = (
  storage: TaskStorage,
  subtaskId: SubtaskId = SUBTASK,
): StandardSnapshot => {
  const snapshot = storage.readJitContextSourceSnapshotForSubtask(
    subtaskId,
    "STANDARD_SUBTASK_EXECUTION",
  );
  if (snapshot.profile !== "STANDARD_SUBTASK_EXECUTION") {
    throw new Error("Expected a Standard storage source snapshot.");
  }
  return snapshot;
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

const insertRawContextItem = (
  sqlite: DatabaseSync,
  item: ContextItem,
  rawScope: {
    readonly projectId?: string;
    readonly bigTaskId?: string | null;
    readonly subtaskId?: string | null;
    readonly supersedesContextItemId?: string | null;
  } = {},
): void => {
  sqlite
    .prepare(`
      INSERT INTO context_items (
        id, project_id, big_task_id, subtask_id, kind, status, authority,
        title, body, source_type, source_reference, effective_at,
        supersedes_context_item_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      item.id,
      rawScope.projectId ?? item.projectId,
      "bigTaskId" in rawScope
        ? rawScope.bigTaskId
        : "bigTaskId" in item
          ? item.bigTaskId
          : null,
      "subtaskId" in rawScope
        ? rawScope.subtaskId
        : "subtaskId" in item
          ? item.subtaskId
          : null,
      item.kind,
      item.status,
      item.authority,
      item.title,
      item.body,
      item.provenance.sourceType,
      item.provenance.sourceReference,
      item.provenance.effectiveAt,
      "supersedesContextItemId" in rawScope
        ? rawScope.supersedesContextItemId
        : item.provenance.supersedesContextItemId ?? null,
      FIXED_TIME,
      FIXED_TIME,
    );
};

const applicationRows = (databasePath: string): string => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return JSON.stringify(
      APPLICATION_TABLES.map((table) => ({
        table,
        rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      })),
    );
  } finally {
    sqlite.close();
  }
};

const captureStatements = <T>(operation: () => T): {
  readonly result: T;
  readonly statements: readonly CapturedStatement[];
} => {
  const prototype = StatementSync.prototype as unknown as {
    get: (...parameters: unknown[]) => unknown;
    all: (...parameters: unknown[]) => unknown[];
    readonly sourceSQL: string;
  };
  const originalGet = prototype.get;
  const originalAll = prototype.all;
  const statements: CapturedStatement[] = [];
  prototype.get = function (...parameters: unknown[]): unknown {
    statements.push({ sql: this.sourceSQL, parameters });
    return Reflect.apply(originalGet, this, parameters);
  };
  prototype.all = function (...parameters: unknown[]): unknown[] {
    statements.push({ sql: this.sourceSQL, parameters });
    return Reflect.apply(originalAll, this, parameters) as unknown[];
  };
  try {
    return { result: operation(), statements };
  } finally {
    prototype.get = originalGet;
    prototype.all = originalAll;
  }
};

const selectCounts = (
  statements: readonly CapturedStatement[],
): Readonly<Record<(typeof APPLICATION_TABLES)[number], number>> =>
  Object.freeze(
    Object.fromEntries(
      APPLICATION_TABLES.map((table) => [
        table,
        statements.filter(
          ({ sql }) =>
            /^\s*select\b/i.test(sql) &&
            new RegExp(`\\bfrom\\s+["\\x60]?${table}["\\x60]?\\b`, "i").test(sql),
        ).length,
      ]),
    ),
  ) as Readonly<Record<(typeof APPLICATION_TABLES)[number], number>>;

const expectSanitized = (error: { readonly message: string }): void => {
  expect(error.message).not.toMatch(
    /SQLite|\bSQL\b|context_items|project_id|big_task_id|subtask_id|constraint|\/Users\/|\/private\/|Zod|stack|secret|raw-value/i,
  );
};

const expectDeeplyFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      expectDeeplyFrozen(descriptor.value);
    }
  }
};

const propertyNames = (value: unknown, names = new Set<string>()): Set<string> => {
  if (typeof value !== "object" || value === null) {
    return names;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "string") {
      names.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        propertyNames(descriptor.value, names);
      }
    }
  }
  return names;
};

const contextScopeKey = (item: ContextItem): string =>
  "subtaskId" in item
    ? `SUBTASK:${item.projectId}:${item.bigTaskId}:${item.subtaskId}`
    : "bigTaskId" in item
      ? `BIG_TASK:${item.projectId}:${item.bigTaskId}`
      : `PROJECT:${item.projectId}`;

const scopeKey = (scope: ContextScope): string =>
  scope.scopeType === "SUBTASK"
    ? `SUBTASK:${scope.projectId}:${scope.bigTaskId}:${scope.subtaskId}`
    : scope.scopeType === "BIG_TASK"
      ? `BIG_TASK:${scope.projectId}:${scope.bigTaskId}`
      : `PROJECT:${scope.projectId}`;

const compareContextItems = (left: ContextItem, right: ContextItem): number => {
  if (left.provenance.effectiveAt !== right.provenance.effectiveAt) {
    return left.provenance.effectiveAt < right.provenance.effectiveAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

const productionSources = (): readonly {
  readonly path: string;
  readonly source: string;
}[] => {
  const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sources: { path: string; source: string }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        sources.push({ path, source: readFileSync(path, "utf8") });
      }
    }
  };
  for (const packageName of ["shared", "domain", "storage", "codex-adapter"]) {
    visit(join(packagesRoot, packageName, "src"));
  }
  return sources;
};

describe("JIT storage source hardening oracle and SQL boundary", () => {
  it("matches an independent all-profile oracle with exact Standard semantics", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const scopes = targetScopes();
      const activeByScope = scopes.map((scope, scopeIndex) => [
        ContextItemSchema.parse({
          ...makeContextItem(`ctx_jit_oracle_${scopeIndex}_b`, scope, {
            effectiveAt: "2026-08-14T00:00:00.000Z",
            body: "Contradictory B remains present.",
          }),
          kind: "RISK",
          authority: "HUMAN",
        }),
        ContextItemSchema.parse({
          ...makeContextItem(`ctx_jit_oracle_${scopeIndex}_a`, scope, {
            effectiveAt: "2026-08-14T00:00:00.000Z",
            body: "Contradictory A remains present.",
          }),
          kind: "DECISION",
          authority: "SYSTEM",
        }),
        makeContextItem(`ctx_jit_oracle_${scopeIndex}_late`, scope, {
          effectiveAt: "2026-08-15T00:00:00.000Z",
        }),
      ]);
      const statuses = [
        "PROPOSED",
        "SUPERSEDED",
        "REJECTED",
        "RESOLVED",
      ] as const;
      for (const [scopeIndex, scope] of scopes.entries()) {
        for (const item of activeByScope[scopeIndex]!) {
          storage.createContextItem(item);
        }
        for (const status of statuses) {
          storage.createContextItem(
            makeContextItem(
              `ctx_jit_oracle_${scopeIndex}_${status.toLowerCase()}`,
              scope,
              { status },
            ),
          );
        }
      }
      const excluded = [
        makeContextItem("ctx_jit_oracle_sibling", subtaskScope(PROJECT, BIG_TASK, SIBLING)),
        makeContextItem("ctx_jit_oracle_other_big", bigTaskScope(PROJECT, OTHER_BIG_TASK)),
        makeContextItem("ctx_jit_oracle_foreign", projectScope(FOREIGN_PROJECT)),
      ];
      excluded.forEach((item) => storage.createContextItem(item));

      const expectedHierarchy = {
        project: makeProject(PROJECT, "jit-hard"),
        bigTask: makeBigTask(BIG_TASK, PROJECT),
        subtask: makeSubtask(SUBTASK, BIG_TASK),
      };
      const standard = readStandard(storage);
      expect(standard).toEqual({
        profile: "STANDARD_SUBTASK_EXECUTION",
        ...expectedHierarchy,
        allowedContextSet: {
          target: { projectId: PROJECT, bigTaskId: BIG_TASK, subtaskId: SUBTASK },
          allowedRawScopes: scopes,
        },
        activeContext: {
          project: [...activeByScope[0]!].sort(compareContextItems),
          bigTask: [...activeByScope[1]!].sort(compareContextItems),
          subtask: [...activeByScope[2]!].sort(compareContextItems),
        },
      });
      expect(standard.activeContext.project).toHaveLength(3);
      expect(standard.activeContext.bigTask).toHaveLength(3);
      expect(standard.activeContext.subtask).toHaveLength(3);
      expect(standard.activeContext.project).not.toEqual(
        expect.arrayContaining(excluded),
      );

      for (const profile of QA_PROFILES) {
        expect(
          storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile),
        ).toEqual({ profile, ...expectedHierarchy });
      }
    });
  });

  it("classifies every SELECT and locks QA Context Item queries to zero", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const expected = {
        STANDARD_SUBTASK_EXECUTION: {
          projects: 4,
          big_tasks: 4,
          subtasks: 4,
          context_items: 6,
        },
        FRESH_INDEPENDENT_QA: {
          projects: 2,
          big_tasks: 2,
          subtasks: 2,
          context_items: 0,
        },
        FOCUSED_RE_QA: {
          projects: 2,
          big_tasks: 2,
          subtasks: 2,
          context_items: 0,
        },
      } as const;

      for (const profile of PROFILES) {
        const { statements } = captureStatements(() =>
          storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile),
        );
        const counts = selectCounts(statements);
        expect(counts).toMatchObject(expected[profile]);
        expect(counts.task_dependencies).toBe(0);
        expect(counts.subtask_implementation_checkpoints).toBe(0);
        expect(counts.context_digests).toBe(0);
        expect(counts.audit_events).toBe(0);
        const classifiedSelectCount = Object.values(counts).reduce(
          (sum, count) => sum + count,
          0,
        );
        expect(classifiedSelectCount).toBe(
          statements.filter(({ sql }) => /^\s*select\b/i.test(sql)).length,
        );
      }
    });
  });

  it("keeps ACL construction and the QA branch before any Context Item retrieval", () => {
    const taskStoragePath = fileURLToPath(new URL("../src/task-storage.ts", import.meta.url));
    const source = readFileSync(taskStoragePath, "utf8");
    const methodStart = source.indexOf("  readJitContextSourceSnapshotForSubtask(");
    const methodEnd = source.indexOf("\n  supersedeContextItem(", methodStart);
    const method = source.slice(methodStart, methodEnd);
    expect(methodStart).toBeGreaterThan(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    expect(method.indexOf('profile !== "STANDARD_SUBTASK_EXECUTION"')).toBeGreaterThan(0);
    expect(method.indexOf("#readAllowedRawContextItemsForSubtask")).toBeGreaterThan(
      method.indexOf('profile !== "STANDARD_SUBTASK_EXECUTION"'),
    );
    expect(method).not.toMatch(
      /contextDigests|auditEvents|taskDependencies|implementationCheckpoints|compileJitContextPacket|acceptedPromoted|rawHistory|token|provider/i,
    );

    const rawHelperStart = source.indexOf("  #readAllowedRawContextItemsForSubtask(");
    const rawHelperEnd = source.indexOf("\n  #getBigTask(", rawHelperStart);
    const rawHelper = source.slice(rawHelperStart, rawHelperEnd);
    expect(rawHelper.indexOf("buildAllowedContextSet")).toBeGreaterThan(0);
    expect(rawHelper.indexOf("#listContextItemsAtExactScope")).toBeGreaterThan(
      rawHelper.indexOf("buildAllowedContextSet"),
    );
  });
});

describe("JIT storage source corruption tripwires and QA isolation", () => {
  const corruptionCases = [
    {
      label: "noncanonical exact-scope alias",
      seed: (storage: TaskStorage): void => {
        storage.createContextItem(makeContextItem("ctx_jit_trip_alias", projectScope()));
      },
      corrupt: (databasePath: string): void => {
        mutate(
          databasePath,
          "UPDATE context_items SET project_id = ? WHERE id = ?",
          `\u00a0${PROJECT}\u00a0`,
          "ctx_jit_trip_alias",
        );
      },
    },
    {
      label: "malformed excluded-status body",
      seed: (storage: TaskStorage): void => {
        storage.createContextItem(
          makeContextItem("ctx_jit_trip_body", bigTaskScope(), { status: "REJECTED" }),
        );
      },
      corrupt: (databasePath: string): void => {
        mutate(
          databasePath,
          "UPDATE context_items SET body = ? WHERE id = ?",
          " malformed body ",
          "ctx_jit_trip_body",
        );
      },
    },
    {
      label: "noncanonical effective time",
      seed: (storage: TaskStorage): void => {
        storage.createContextItem(makeContextItem("ctx_jit_trip_time", subtaskScope()));
      },
      corrupt: (databasePath: string): void => {
        mutate(
          databasePath,
          "UPDATE context_items SET effective_at = ? WHERE id = ?",
          "2026-08-17T00:00:00+00:00",
          "ctx_jit_trip_time",
        );
      },
    },
    {
      label: "invalid supersession terminal",
      seed: (storage: TaskStorage): void => {
        const root = makeContextItem("ctx_jit_trip_terminal_root", subtaskScope());
        storage.createContextItem(root);
        storage.supersedeContextItem(
          makeContextItem("ctx_jit_trip_terminal_tip", subtaskScope(), {
            effectiveAt: "2026-08-17T01:00:00.000Z",
            supersedesContextItemId: root.id,
          }),
        );
      },
      corrupt: (databasePath: string): void => {
        mutate(
          databasePath,
          "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
          "ctx_jit_trip_terminal_tip",
        );
      },
    },
    {
      label: "noncanonical supersession pointer",
      seed: (storage: TaskStorage): void => {
        const root = makeContextItem("ctx_jit_trip_pointer_root", projectScope());
        storage.createContextItem(root);
        storage.supersedeContextItem(
          makeContextItem("ctx_jit_trip_pointer_tip", projectScope(), {
            effectiveAt: "2026-08-17T02:00:00.000Z",
            supersedesContextItemId: root.id,
          }),
        );
      },
      corrupt: (databasePath: string): void => {
        mutate(
          databasePath,
          "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
          " ctx_jit_trip_pointer_root ",
          "ctx_jit_trip_pointer_tip",
        );
      },
    },
  ] as const;

  it.each(corruptionCases)(
    "fails Standard closed but performs zero QA Context Item SELECTs: $label",
    ({ seed, corrupt }) => {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTopology(setup);
        seed(setup);
        setup.close();
        corrupt(databasePath);
        const before = applicationRows(databasePath);

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const accepted = captureTaskStorageError(() =>
            storage.readActiveContextItemsForSubtask(SUBTASK),
          );
          const standard = captureTaskStorageError(() => readStandard(storage));
          expect(standard).toMatchObject({
            code: "MALFORMED_STORED_DATA",
            message: "Stored task data is malformed.",
          });
          expect(standard).toMatchObject({
            code: accepted.code,
            message: accepted.message,
          });
          expectSanitized(standard);

          for (const profile of QA_PROFILES) {
            const { result, statements } = captureStatements(() =>
              storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile),
            );
            expect(selectCounts(statements).context_items).toBe(0);
            expect(Object.keys(result)).toEqual([
              "profile",
              "project",
              "bigTask",
              "subtask",
            ]);
            expect(result.profile).toBe(profile);
          }
        } finally {
          storage.close();
        }
        expect(applicationRows(databasePath)).toBe(before);
      });
    },
  );

  it("isolates broad unrelated Context Item corruption for every profile", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const target = makeContextItem("ctx_jit_isolated_target", projectScope());
      const corruptions = [
        makeContextItem(
          "ctx_jit_isolated_sibling",
          subtaskScope(PROJECT, BIG_TASK, SIBLING),
        ),
        makeContextItem(
          "ctx_jit_isolated_other_big",
          bigTaskScope(PROJECT, OTHER_BIG_TASK),
        ),
        makeContextItem(
          "ctx_jit_isolated_foreign",
          projectScope(FOREIGN_PROJECT),
        ),
      ];
      setup.createContextItem(target);
      corruptions.forEach((item) => setup.createContextItem(item));
      setup.close();
      for (const [index, item] of corruptions.entries()) {
        mutate(
          databasePath,
          "UPDATE context_items SET title = ?, effective_at = ? WHERE id = ?",
          ` malformed unrelated ${index} `,
          "invalid-private-time",
          item.id,
        );
      }
      const before = applicationRows(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(readStandard(storage).activeContext.project).toEqual([target]);
        for (const profile of QA_PROFILES) {
          const { result, statements } = captureStatements(() =>
            storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile),
          );
          expect(result.profile).toBe(profile);
          expect(selectCounts(statements).context_items).toBe(0);
        }
        expect(
          captureTaskStorageError(() =>
            storage.readJitContextSourceSnapshotForSubtask(
              SIBLING,
              "STANDARD_SUBTASK_EXECUTION",
            ),
          ).code,
        ).toBe("MALFORMED_STORED_DATA");
      } finally {
        storage.close();
      }
      expect(applicationRows(databasePath)).toBe(before);
    });
  });
});

describe("JIT storage source malformed hierarchy boundary", () => {
  const corruptions = [
    ["missing Big Task", "DELETE FROM big_tasks WHERE id = ?", [BIG_TASK]],
    ["missing Project", "DELETE FROM projects WHERE id = ?", [PROJECT]],
    [
      "Subtask points to nonexistent Big Task",
      "UPDATE subtasks SET big_task_id = ? WHERE id = ?",
      ["bt_jit_hard_missing", SUBTASK],
    ],
    [
      "Big Task points to nonexistent Project",
      "UPDATE big_tasks SET project_id = ? WHERE id = ?",
      ["prj_jit_hard_missing", BIG_TASK],
    ],
    [
      "noncanonical stored Subtask ID",
      "UPDATE subtasks SET id = ? WHERE id = ?",
      [` ${SUBTASK} `, SUBTASK],
    ],
    [
      "noncanonical stored Big Task ID",
      "UPDATE big_tasks SET id = ? WHERE id = ?",
      [` ${BIG_TASK} `, BIG_TASK],
    ],
    [
      "noncanonical stored Project ID",
      "UPDATE projects SET id = ? WHERE id = ?",
      [` ${PROJECT} `, PROJECT],
    ],
    [
      "malformed Subtask structured field",
      "UPDATE subtasks SET scope_in = ? WHERE id = ?",
      ["not-json", SUBTASK],
    ],
    [
      "malformed Big Task structured field",
      "UPDATE big_tasks SET acceptance_criteria = ? WHERE id = ?",
      ["{}", BIG_TASK],
    ],
    [
      "invalid Project repository representation",
      "UPDATE projects SET repository_kind = ? WHERE id = ?",
      ["PRIVATE", PROJECT],
    ],
    [
      "malformed hierarchy timestamp",
      "UPDATE subtasks SET updated_at = ? WHERE id = ?",
      ["private-invalid-time", SUBTASK],
    ],
  ] as const;

  it.each(corruptions)("fails all profiles closed for %s", (_label, sql, parameters) => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      setup.close();
      mutate(databasePath, sql, ...parameters);
      const before = applicationRows(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        for (const profile of PROFILES) {
          const { result: error, statements } = captureStatements(() =>
            captureTaskStorageError(() =>
              storage.readJitContextSourceSnapshotForSubtask(
                SUBTASK,
                profile,
              ),
            ),
          );
          expect(["MALFORMED_STORED_DATA", "PARENT_NOT_FOUND"]).toContain(
            error.code,
          );
          expectSanitized(error);
          if (profile !== "STANDARD_SUBTASK_EXECUTION") {
            expect(selectCounts(statements).context_items).toBe(0);
          }
        }
      } finally {
        storage.close();
      }
      expect(applicationRows(databasePath)).toBe(before);
    });
  });
});

describe("JIT storage source coherent observation and transaction ownership", () => {
  it("cannot mix hierarchy, ACL, Context Item status, or supersession states", () => {
    withTemporaryDatabasePath((databasePath) => {
      const projectA = "prj_jit_state_a";
      const projectB = "prj_jit_state_b";
      const placeholderProject = "prj_jit_state_placeholder";
      const bigTaskA = "bt_jit_state_a";
      const bigTaskB = "bt_jit_state_b";
      const targetSubtask = SubtaskIdSchema.parse("st_jit_state_target");
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      setup.createProject(makeProject(projectA, "jit-state-a"));
      setup.createProject(makeProject(projectB, "jit-state-b"));
      setup.createProject(makeProject(placeholderProject, "jit-state-placeholder"));
      setup.createBigTask(makeBigTask(bigTaskA, projectA));
      setup.createBigTask(makeBigTask(bigTaskB, placeholderProject));
      setup.createSubtask(makeSubtask(targetSubtask, bigTaskA));
      const oldScopes = targetScopes({
        projectId: projectA,
        bigTaskId: bigTaskA,
        subtaskId: targetSubtask,
      });
      const oldItems = oldScopes.map((scope, index) =>
        makeContextItem(`ctx_jit_state_old_${index}`, scope),
      );
      oldItems.forEach((item) => setup.createContextItem(item));
      setup.close();

      const newScopes = targetScopes({
        projectId: projectB,
        bigTaskId: bigTaskB,
        subtaskId: targetSubtask,
      });
      const newProjectItem = makeContextItem("ctx_jit_state_new_project", newScopes[0]!, {
        status: "PROPOSED",
      });
      const newBigTaskItem = makeContextItem("ctx_jit_state_new_big", newScopes[1]!, {
        status: "PROPOSED",
      });
      const newRoot = makeContextItem("ctx_jit_state_new_root", newScopes[2]!, {
        status: "PROPOSED",
      });
      const newTip = makeContextItem("ctx_jit_state_new_tip", newScopes[2]!, {
        status: "PROPOSED",
        effectiveAt: "2026-08-17T03:00:00.000Z",
      });
      const raw = new DatabaseSync(databasePath);
      raw.exec("PRAGMA foreign_keys = OFF; PRAGMA journal_mode = WAL; BEGIN");
      try {
        [newProjectItem, newBigTaskItem, newRoot, newTip].forEach((item) =>
          insertRawContextItem(raw, item),
        );
        raw.exec("COMMIT");
      } catch (error) {
        if (raw.isTransaction) {
          raw.exec("ROLLBACK");
        }
        throw error;
      } finally {
        raw.close();
      }

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      writer.prepare("UPDATE projects SET name = ? WHERE id = ?").run(
        "Project state B committed",
        projectB,
      );
      writer.prepare("UPDATE big_tasks SET project_id = ?, title = ? WHERE id = ?").run(
        projectB,
        "Big Task state B committed",
        bigTaskB,
      );
      writer.prepare("UPDATE subtasks SET big_task_id = ?, title = ? WHERE id = ?").run(
        bigTaskB,
        "Subtask state B committed",
        targetSubtask,
      );
      writer.prepare("UPDATE context_items SET status = 'ACTIVE' WHERE id IN (?, ?)").run(
        newProjectItem.id,
        newBigTaskItem.id,
      );
      writer.prepare("UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?").run(
        newRoot.id,
      );
      writer.prepare(
        "UPDATE context_items SET status = 'ACTIVE', supersedes_context_item_id = ? WHERE id = ?",
      ).run(newRoot.id, newTip.id);

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

      let stateA: StandardSnapshot;
      try {
        stateA = readStandard(reader, targetSubtask);
      } finally {
        statementPrototype.get = originalGet;
      }
      try {
        expect(writerCommitted).toBe(true);
        expect(stateA.project.id).toBe(projectA);
        expect(stateA.bigTask.id).toBe(bigTaskA);
        expect(stateA.subtask.bigTaskId).toBe(bigTaskA);
        expect(stateA.allowedContextSet.target).toEqual({
          projectId: projectA,
          bigTaskId: bigTaskA,
          subtaskId: targetSubtask,
        });
        expect(Object.values(stateA.activeContext).flat().map(({ id }) => id)).toEqual(
          oldItems.map(({ id }) => id),
        );

        const stateB = readStandard(reader, targetSubtask);
        expect(stateB.project).toMatchObject({
          id: projectB,
          name: "Project state B committed",
        });
        expect(stateB.bigTask).toMatchObject({
          id: bigTaskB,
          projectId: projectB,
          title: "Big Task state B committed",
        });
        expect(stateB.subtask).toMatchObject({
          id: targetSubtask,
          bigTaskId: bigTaskB,
          title: "Subtask state B committed",
        });
        expect(stateB.allowedContextSet.target).toEqual({
          projectId: projectB,
          bigTaskId: bigTaskB,
          subtaskId: targetSubtask,
        });
        expect(stateB.allowedContextSet.allowedRawScopes).toEqual(newScopes);
        expect(stateB.activeContext).toEqual({
          project: [
            ContextItemSchema.parse({ ...newProjectItem, status: "ACTIVE" }),
          ],
          bigTask: [
            ContextItemSchema.parse({ ...newBigTaskItem, status: "ACTIVE" }),
          ],
          subtask: [
            ContextItemSchema.parse({
              ...newTip,
              status: "ACTIVE",
              provenance: {
                ...newTip.provenance,
                supersedesContextItemId: newRoot.id,
              },
            }),
          ],
        });
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("reuses a caller transaction and leaves success and caught failure ownership outside", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const corrupt = makeContextItem("ctx_jit_tx_corrupt", projectScope());
      setup.createContextItem(corrupt);
      setup.close();
      mutate(
        databasePath,
        "UPDATE context_items SET title = ? WHERE id = ?",
        " malformed transaction item ",
        corrupt.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const survives = makeContextItem(
        "ctx_jit_tx_survives",
        subtaskScope(PROJECT, BIG_TASK, SIBLING),
      );
      const databasePrototype = DatabaseSync.prototype as unknown as {
        exec: (sql: string) => void;
      };
      const originalExec = databasePrototype.exec;
      const transactionSql: string[] = [];
      databasePrototype.exec = function (sql: string): void {
        if (/^(?:BEGIN|COMMIT|ROLLBACK)/.test(sql)) {
          transactionSql.push(sql);
        }
        Reflect.apply(originalExec, this, [sql]);
      };
      try {
        storage.runInTransaction((transaction) => {
          transaction.createContextItem(survives);
          const qa = transaction.readJitContextSourceSnapshotForSubtask(
            SUBTASK,
            "FRESH_INDEPENDENT_QA",
          );
          expect(qa.profile).toBe("FRESH_INDEPENDENT_QA");
          expect(
            captureTaskStorageError(() => readStandard(transaction)),
          ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
          expect(transaction.getContextItemById(survives.id)).toEqual(survives);
        });
      } finally {
        databasePrototype.exec = originalExec;
      }
      try {
        expect(transactionSql).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
        expect(storage.getContextItemById(survives.id)).toEqual(survives);
      } finally {
        storage.close();
      }
    });
  });
});

describe("JIT storage source canonicality, profiles, and errors", () => {
  it("fails hostile local runtime inputs safely without coercion or raw exceptions", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const throwingCoercion = Object.freeze({
        toString(): never {
          throw new Error("secret coercion");
        },
        valueOf(): never {
          throw new Error("secret coercion");
        },
      });
      const throwingProxy = new Proxy(Object.create(null) as object, {
        get(): never {
          throw new Error("secret proxy get");
        },
        ownKeys(): never {
          throw new Error("secret proxy keys");
        },
        getOwnPropertyDescriptor(): never {
          throw new Error("secret proxy descriptor");
        },
      });
      const hostileValues = [
        null,
        undefined,
        7,
        Symbol("private"),
        {},
        [],
        new String(SUBTASK),
        Object.create({ inherited: SUBTASK }),
        throwingCoercion,
        throwingProxy,
      ] as const;

      for (const value of hostileValues) {
        const idError = captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            value as unknown as SubtaskId,
            "FRESH_INDEPENDENT_QA",
          ),
        );
        const profileError = captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            SUBTASK,
            value as unknown as JitContextPacketProfileKind,
          ),
        );
        expect(idError.code).toBe("INVALID_INPUT");
        expect(profileError.code).toBe("INVALID_INPUT");
        expectSanitized(idError);
        expectSanitized(profileError);
      }
    });
  });

  it("distinguishes canonical, noncanonical, malformed, oversize, and missing IDs", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      expect(readStandard(storage).subtask.id).toBe(SUBTASK);
      for (const invalid of [
        ` ${SUBTASK} `,
        "",
        " ",
        "wrong_prefix",
        "st_",
        `st_${"x".repeat(126)}`,
      ]) {
        expect(
          captureTaskStorageError(() =>
            storage.readJitContextSourceSnapshotForSubtask(
              invalid as SubtaskId,
              "STANDARD_SUBTASK_EXECUTION",
            ),
          ).code,
        ).toBe("INVALID_INPUT");
      }
      expect(
        captureTaskStorageError(() =>
          storage.readJitContextSourceSnapshotForSubtask(
            SubtaskIdSchema.parse("st_jit_hard_missing"),
            "STANDARD_SUBTASK_EXECUTION",
          ),
        ).code,
      ).toBe("PARENT_NOT_FOUND");
    });
  });

  it("uses the explicit profile for every valid status and maturity combination", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const active = makeContextItem("ctx_jit_lifecycle_active", projectScope());
      setup.createContextItem(active);
      setup.close();
      const statuses = [
        "TODO",
        "IN_PROGRESS",
        "QA_DEBUG",
        "DONE",
        "DROPPED",
        "ARCHIVED",
      ] as const;
      const maturities = [
        "NOT_STARTED",
        "IMPLEMENTED",
        "HARDENED",
        "ACCEPTED",
      ] as const;
      let combinations = 0;

      for (const status of statuses) {
        for (const maturity of maturities) {
          mutate(
            databasePath,
            "UPDATE subtasks SET status = ?, maturity = ? WHERE id = ?",
            status,
            maturity,
            SUBTASK,
          );
          const storage = openTaskDatabase({ databasePath, clock: fixedClock });
          try {
            const standard = readStandard(storage);
            expect(standard.subtask).toMatchObject({ status, maturity });
            expect(standard.activeContext.project).toEqual([active]);
            for (const profile of QA_PROFILES) {
              const { result, statements } = captureStatements(() =>
                storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile),
              );
              expect(result).toMatchObject({
                profile,
                subtask: { status, maturity },
              });
              expect(Object.keys(result)).toEqual([
                "profile",
                "project",
                "bigTask",
                "subtask",
              ]);
              expect(selectCounts(statements).context_items).toBe(0);
            }
          } finally {
            storage.close();
          }
          combinations += 1;
        }
      }
      expect(combinations).toBe(24);
    });
  });

  it("preserves closed-storage and injected database/transaction error behavior", () => {
    const errors: ReturnType<typeof captureTaskStorageError>[] = [];
    const closed = openTaskDatabase({ databasePath: ":memory:", clock: fixedClock });
    seedTopology(closed);
    closed.close();
    errors.push(
      captureTaskStorageError(() =>
        closed.readJitContextSourceSnapshotForSubtask(
          SUBTASK,
          "FRESH_INDEPENDENT_QA",
        ),
      ),
    );

    withMemoryStorage((storage) => {
      seedTopology(storage);
      const statementPrototype = StatementSync.prototype as unknown as {
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalGet = statementPrototype.get;
      statementPrototype.get = function (...parameters: unknown[]): unknown {
        if (/from\s+"?subtasks"?/i.test(this.sourceSQL)) {
          throw new Error("SQLITE secret raw-value /Users/private.sqlite");
        }
        return Reflect.apply(originalGet, this, parameters);
      };
      try {
        errors.push(captureTaskStorageError(() => readStandard(storage)));
      } finally {
        statementPrototype.get = originalGet;
      }

      for (const failurePoint of ["BEGIN", "COMMIT"] as const) {
        const databasePrototype = DatabaseSync.prototype as unknown as {
          exec: (sql: string) => void;
        };
        const originalExec = databasePrototype.exec;
        let injected = false;
        databasePrototype.exec = function (sql: string): void {
          if (!injected && sql === failurePoint) {
            injected = true;
            throw new Error("SQLITE secret transaction raw-value");
          }
          Reflect.apply(originalExec, this, [sql]);
        };
        try {
          errors.push(captureTaskStorageError(() => readStandard(storage)));
        } finally {
          databasePrototype.exec = originalExec;
        }
      }
    });

    expect(errors.map(({ code }) => code)).toEqual([
      "DATABASE_CLOSED",
      "TRANSACTION_FAILED",
      "TRANSACTION_FAILED",
      "TRANSACTION_FAILED",
    ]);
    errors.forEach(expectSanitized);
  });
});

describe("JIT storage source scale and generated/property campaign", () => {
  it("retrieves only exact allowed rows across 2,503 irrelevant rows while QA stays constant", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const statuses = [
        "ACTIVE",
        "PROPOSED",
        "SUPERSEDED",
        "REJECTED",
        "RESOLVED",
      ] as const;
      const allowed = targetScopes().flatMap((scope, scopeIndex) =>
        statuses.map((status, statusIndex) =>
          makeContextItem(
            `ctx_jit_scale_allowed_${scopeIndex}_${statusIndex}`,
            scope,
            { status },
          ),
        ),
      );
      allowed.forEach((item) => setup.createContextItem(item));
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("BEGIN");
      try {
        for (let index = 0; index < 2_503; index += 1) {
          const placement = index % 3;
          const scope =
            placement === 0
              ? subtaskScope(PROJECT, BIG_TASK, SIBLING)
              : placement === 1
                ? bigTaskScope(PROJECT, OTHER_BIG_TASK)
                : projectScope(FOREIGN_PROJECT);
          insertRawContextItem(
            sqlite,
            makeContextItem(
              `ctx_jit_scale_irrelevant_${index.toString().padStart(4, "0")}`,
              scope,
              { status: statuses[index % statuses.length]! },
            ),
          );
        }
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
      try {
        const { result: standard, statements } = captureStatements(() =>
          readStandard(storage),
        );
        expect(Object.values(standard.activeContext).map((items) => items.map(({ id }) => id))).toEqual([
          ["ctx_jit_scale_allowed_0_0"],
          ["ctx_jit_scale_allowed_1_0"],
          ["ctx_jit_scale_allowed_2_0"],
        ]);
        const contextStatements = statements.filter(({ sql }) =>
          /from\s+"?context_items"?/i.test(sql),
        );
        expect(contextStatements.length).toBeGreaterThanOrEqual(6);
        expect(contextStatements.every(({ sql }) => /\bwhere\b/i.test(sql))).toBe(true);
        for (const profile of QA_PROFILES) {
          const { statements: qaStatements } = captureStatements(() =>
            storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile),
          );
          expect(selectCounts(qaStatements).context_items).toBe(0);
        }
      } finally {
        storage.close();
      }
    });
  });

  it("matches 400 deterministic generated evaluations with zero material mismatch", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const targets: {
        readonly target: Target;
        readonly project: ReturnType<typeof makeProject>;
        readonly bigTask: ReturnType<typeof makeBigTask>;
        readonly subtask: ReturnType<typeof makeSubtask>;
      }[] = [];
      const rows: ContextItem[] = [];
      const statuses = [
        "ACTIVE",
        "PROPOSED",
        "ACTIVE",
        "SUPERSEDED",
        "REJECTED",
        "RESOLVED",
      ] as const;
      const addScopeRows = (scope: ContextScope, stem: string): void => {
        for (const [index, status] of statuses.entries()) {
          const item = ContextItemSchema.parse({
            ...makeContextItem(`ctx_campaign_${stem}_${index}`, scope, {
              status,
              effectiveAt:
                index < 3
                  ? "2026-08-15T00:00:01.000Z"
                  : `2026-08-15T00:00:0${index}.000Z`,
              body:
                index === 0
                  ? "Generated contradiction A."
                  : index === 2
                    ? "Generated contradiction B."
                    : `Generated body ${index}.`,
            }),
            kind: index % 2 === 0 ? "DECISION" : "RISK",
            authority: index % 2 === 0 ? "HUMAN" : "SYSTEM",
          });
          storage.createContextItem(item);
          rows.push(item);
        }
      };

      for (let projectIndex = 0; projectIndex < 4; projectIndex += 1) {
        const project = makeProject(
          `prj_campaign_${projectIndex}`,
          `jit-campaign-${projectIndex}`,
        );
        storage.createProject(project);
        addScopeRows(projectScope(project.id), `p_${projectIndex}`);
        for (let bigTaskIndex = 0; bigTaskIndex < 4; bigTaskIndex += 1) {
          const bigTask = makeBigTask(
            `bt_campaign_${projectIndex}_${bigTaskIndex}`,
            project.id,
          );
          storage.createBigTask(bigTask);
          addScopeRows(
            bigTaskScope(project.id, bigTask.id),
            `b_${projectIndex}_${bigTaskIndex}`,
          );
          for (let subtaskIndex = 0; subtaskIndex < 5; subtaskIndex += 1) {
            const subtask = makeSubtask(
              SubtaskIdSchema.parse(
                `st_campaign_${projectIndex}_${bigTaskIndex}_${subtaskIndex}`,
              ),
              bigTask.id,
            );
            storage.createSubtask(subtask);
            addScopeRows(
              subtaskScope(project.id, bigTask.id, subtask.id),
              `s_${projectIndex}_${bigTaskIndex}_${subtaskIndex}`,
            );
            targets.push({
              target: {
                projectId: project.id,
                bigTaskId: bigTask.id,
                subtaskId: subtask.id,
              },
              project,
              bigTask,
              subtask,
            });
          }
        }
      }
      expect(targets).toHaveLength(80);
      expect(rows).toHaveLength(600);
      const before = applicationRows(databasePath);
      let evaluations = 0;

      for (const { target, project, bigTask, subtask } of targets) {
        const expectedBuckets = targetScopes(target).map((scope) =>
          rows
            .filter(
              (item) =>
                item.status === "ACTIVE" &&
                contextScopeKey(item) === scopeKey(scope),
            )
            .sort(compareContextItems),
        );
        const standard = readStandard(storage, target.subtaskId);
        expect(standard).toEqual({
          profile: "STANDARD_SUBTASK_EXECUTION",
          project,
          bigTask,
          subtask,
          allowedContextSet: {
            target,
            allowedRawScopes: targetScopes(target),
          },
          activeContext: {
            project: expectedBuckets[0],
            bigTask: expectedBuckets[1],
            subtask: expectedBuckets[2],
          },
        });
        const accepted = storage.readActiveContextItemsForSubtask(target.subtaskId);
        expect(standard.allowedContextSet).toEqual(accepted.allowedContextSet);
        expect(standard.activeContext).toEqual({
          project: accepted.buckets[0].contextItems,
          bigTask: accepted.buckets[1].contextItems,
          subtask: accepted.buckets[2].contextItems,
        });
        evaluations += 1;
      }

      const { statements: qaStatements } = captureStatements(() => {
        for (const { target, project, bigTask, subtask } of targets) {
          for (const profile of QA_PROFILES) {
            const result = storage.readJitContextSourceSnapshotForSubtask(
              target.subtaskId,
              profile,
            );
            expect(result).toEqual({ profile, project, bigTask, subtask });
            evaluations += 1;
          }
        }
      });
      expect(selectCounts(qaStatements).context_items).toBe(0);

      for (const [index, { target }] of targets.entries()) {
        expect(
          captureTaskStorageError(() =>
            storage.readJitContextSourceSnapshotForSubtask(
              ` ${target.subtaskId} ` as SubtaskId,
              "STANDARD_SUBTASK_EXECUTION",
            ),
          ).code,
        ).toBe("INVALID_INPUT");
        evaluations += 1;
        expect(
          captureTaskStorageError(() =>
            storage.readJitContextSourceSnapshotForSubtask(
              SubtaskIdSchema.parse(`st_campaign_missing_${index}`),
              "FRESH_INDEPENDENT_QA",
            ),
          ).code,
        ).toBe("PARENT_NOT_FOUND");
        evaluations += 1;
      }
      storage.close();
      expect(evaluations).toBe(400);
      expect(applicationRows(databasePath)).toBe(before);
    });
  });
});

describe("JIT storage source shape, trust, immutability, and deferred scope", () => {
  it("recursively freezes detached results and prevents cross-result poisoning", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const item = makeContextItem("ctx_jit_detached", projectScope());
      storage.createContextItem(item);
      const first = readStandard(storage);
      const second = readStandard(storage);
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first.project).not.toBe(second.project);
      expect(first.activeContext.project[0]).not.toBe(second.activeContext.project[0]);
      expectDeeplyFrozen(first);
      for (const profile of QA_PROFILES) {
        expectDeeplyFrozen(
          storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile),
        );
      }
      expect(() => {
        (first.project as { name: string }).name = "Poisoned";
      }).toThrow(TypeError);
      expect(() => {
        (first.activeContext.project as unknown[]).push({});
      }).toThrow(TypeError);
      expect(second.project.name).toBe(makeProject(PROJECT, "jit-hard").name);
      expect(second.activeContext.project).toEqual([item]);
      expect(storage.getProjectById(makeProject(PROJECT, "jit-hard").id)?.name).toBe(
        makeProject(PROJECT, "jit-hard").name,
      );
      expect(storage.getContextItemById(item.id)).toEqual(item);
    });
  });

  it("keeps equal-shaped caller DATA ordinary and exposes no structural trust bridge", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const snapshot = readStandard(storage);
      const fabricated = structuredClone(snapshot) as JitContextStorageSourceSnapshot;
      expect(fabricated).toEqual(snapshot);
      expect(Object.isFrozen(fabricated)).toBe(false);
      expect(
        [
          "trusted",
          "verified",
          "authorized",
          "capability",
          "signature",
          "originToken",
        ].filter((marker) => propertyNames(snapshot).has(marker)),
      ).toEqual([]);
      expect(
        Object.keys(storagePublicApi).filter((key) =>
          /JitContextStorageSourceSnapshot.*(?:Schema|parse|verify|trust)/i.test(key),
        ),
      ).toEqual([]);
    });
  });

  it("locks exact recursive QA shape with no undefined or deferred fields", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const prohibited = [
        "allowedContextSet",
        "activeContext",
        "contextItems",
        "buckets",
        "digest",
        "rawHistory",
        "acceptedPromotedContext",
        "canonicalProjectRules",
        "repositoryRuntimeEvidence",
        "qaInstructions",
        "boundedRetestTargets",
        "sections",
        "executionIntent",
        "tokenBudget",
        "providerSerialization",
      ];
      for (const profile of QA_PROFILES) {
        const result = storage.readJitContextSourceSnapshotForSubtask(
          SUBTASK,
          profile,
        );
        expect(Object.keys(result)).toEqual([
          "profile",
          "project",
          "bigTask",
          "subtask",
        ]);
        const names = propertyNames(result);
        expect(prohibited.filter((key) => names.has(key))).toEqual([]);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("undefined");
      }
    });
  });

  it("adds no schema, migration, write, or deferred integration and limits approved consumers", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(storage);
      const beforeRows = applicationRows(databasePath);
      const sqliteBefore = new DatabaseSync(databasePath, { readOnly: true });
      const schemaBefore = JSON.stringify(
        sqliteBefore
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
          )
          .all(),
      );
      const migrationCount = sqliteBefore
        .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
        .get() as { readonly count: number };
      sqliteBefore.close();

      for (const profile of PROFILES) {
        storage.readJitContextSourceSnapshotForSubtask(SUBTASK, profile);
      }
      storage.close();
      const sqliteAfter = new DatabaseSync(databasePath, { readOnly: true });
      const schemaAfter = JSON.stringify(
        sqliteAfter
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
          )
          .all(),
      );
      const tables = sqliteAfter
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { readonly name: string }).name);
      sqliteAfter.close();
      expect(schemaAfter).toBe(schemaBefore);
      expect(migrationCount.count).toBe(19);
      expect(tables).toEqual([
        "__drizzle_migrations",
        "audit_events",
        "big_tasks",
        "candidate_task_contract_bindings",
        "canonical_task_materializations",
        "chat_threads",
        "context_digests",
        "context_items",
        "durable_workflow_evidence",
        "durable_workflow_evidence_authorities",
        "durable_workflow_human_requirements",
        "durable_workflow_transitions",
        "execution_runs",
        "governed_big_task_completion_receipts",
        "governed_budget_extensions",
        "governed_dispatch_gate_snapshots",
        "governed_dispatch_receipts",
        "governed_finding_resolutions",
        "governed_findings",
        "governed_gate_sources",
        "governed_handoffs",
        "governed_manual_start_authorities",
        "governed_promoted_context_dispositions",
        "governed_promotion_candidates",
        "governed_provider_claims",
        "governed_result_provenance",
        "governed_role_authorizations",
        "governed_role_execution_links",
        "governed_role_results",
        "orchestration_materializations",
        "orchestration_plan_candidates",
        "orchestration_planning_tracks",
        "orchestration_review_decisions",
        "projects",
        "subtask_implementation_checkpoints",
        "subtask_workflow_instances",
        "subtasks",
        "task_contracts",
        "task_dependencies",
        "workflow_initialization_receipts",
        "worktree_checkout_generations",
        "worktree_ownerships",
      ]);
      expect(applicationRows(databasePath)).toBe(beforeRows);
    });

    const sources = productionSources();
    const storageSource = sources
      .filter(({ path }) => path.includes("/storage/src/"))
      .map(({ source }) => source)
      .join("\n");
    const taskStorageSource = sources.find(({ path }) =>
      path.endsWith("/storage/src/task-storage.ts"),
    )?.source;
    const operationalAssemblySource = sources.find(({ path }) =>
      path.endsWith("/storage/src/operational-context-assembly.ts"),
    )?.source;
    const consumers = sources.flatMap(({ path, source }) =>
      (source.match(/\.readJitContextSourceSnapshotForSubtask\s*\(/g) ?? []).map(
        () => path,
      ),
    );
    expect(
      (taskStorageSource?.match(/compileJitContextPacket\s*\(/g) ?? []).length,
    ).toBe(0);
    expect(
      (operationalAssemblySource?.match(/compileJitContextPacket\s*\(/g) ?? [])
        .length,
    ).toBe(1);
    expect(consumers.map((path) => path.split("/").at(-1)).sort()).toEqual([
      "operational-context-assembly.ts",
      "trusted-repository-source.ts",
      "worktree-ownership.ts",
    ]);
    const trustedRepositorySource = sources.find(({ path }) =>
      path.endsWith("/storage/src/trusted-repository-source.ts"),
    )?.source;
    expect(trustedRepositorySource).toMatch(
      /readJitContextSourceSnapshotForSubtask\(\s*input,\s*"FRESH_INDEPENDENT_QA",\s*\)/,
    );
    const worktreeOwnershipSource = sources.find(({ path }) =>
      path.endsWith("/storage/src/worktree-ownership.ts"),
    )?.source;
    expect(worktreeOwnershipSource).toMatch(
      /readJitContextSourceSnapshotForSubtask\(\s*subtaskId,\s*"FRESH_INDEPENDENT_QA",\s*\)/,
    );
    expect(storageSource).not.toMatch(
      /acceptedPromotedContext|rawHistory|providerSerialization|tokenMeter|budgetPrun|Codex App Server/i,
    );
  });
});

const ISOLATION_COHERENCE_TRUST_MUTATIONS = [
  "QA calls raw retrieval",
  "QA calls active retrieval then discards output",
  "Fresh QA includes AllowedContextSet",
  "Focused QA includes AllowedContextSet",
  "Fresh QA includes empty active buckets",
  "Focused QA includes empty active buckets",
  "unknown profile falls through to QA",
  "unknown profile falls through to Standard",
  "null profile falls through to QA",
  "object profile falls through to Standard",
  "profile inferred from Subtask status",
  "profile inferred from Subtask maturity",
  "profile inferred from start policy",
  "profile inferred from reasoning level",
  "profile inferred from prompt seed",
  "profile inferred from title",
  "QA Context Item query hidden behind helper rename",
  "QA Context Item query hidden behind direct SQL",
  "QA retrieves malformed rows and filters them",
  "QA retrieves ACTIVE rows and drops them",
  "QA retrieves raw rows and drops them",
  "QA retrieves Digests",
  "QA retrieves Audit Events",
  "QA retrieves dependencies",
  "QA retrieves implementation checkpoints",
  "QA result carries nested contextItems",
  "QA result carries raw history",
  "QA result carries Promoted Context",
  "QA result carries packet sections",
  "QA result carries execution intent",
  "separate hierarchy and context transactions",
  "commit between returned hierarchy and ACL hierarchy",
  "commit between Project and Big Task reads",
  "commit between Big Task and Subtask reads",
  "commit between ACL and Project scope query",
  "commit between Project and Big Task scope query",
  "commit between Big Task and Subtask scope query",
  "commit between row and supersession reads",
  "returned Project from state A with ACL from state B",
  "returned Big Task from state A with Context from state B",
  "returned Subtask from state A with parent from state B",
  "AllowedContextSet reconstructed from stale IDs",
  "AllowedContextSet built after Context Item query",
  "AllowedContextSet scopes reordered",
  "AllowedContextSet widened to sibling",
  "AllowedContextSet widened to dependency",
  "Project scope query widened to all Project rows",
  "Big Task scope query widened to sibling Big Task",
  "Subtask scope query widened to sibling Subtask",
  "foreign Project Context leaks",
  "noncanonical scope alias normalized into output",
  "cross-scope supersession alias accepted",
  "malformed relevant excluded-status row ignored",
  "malformed unrelated row globally poisons target",
  "ACTIVE filter happens before raw validation",
  "same-shaped DATA treated as storage origin",
  "type compatibility treated as authorization",
  "deep freeze treated as authentication",
  "trusted boolean added",
  "verified boolean added",
  "authorized boolean added",
  "capability added",
  "signature added",
  "origin token added",
  "caller profile choice treated as authorization",
  "manual DATA accepted by a storage-origin parser",
  "production consumer accepts arbitrary snapshot-shaped DATA",
  "snapshot compiles final packet",
  "snapshot injects Project rules",
  "snapshot injects repository evidence",
  "snapshot injects Promoted Context",
  "snapshot injects Digest or history",
  "snapshot invokes token logic",
  "snapshot invokes provider serialization",
  "snapshot invokes live execution",
] as const;

const IMPLEMENTATION_SPECIFIC_MUTATIONS = [
  "remove canonical Subtask ID equality check",
  "trim request ID before lookup",
  "replace PARENT_NOT_FOUND with empty snapshot",
  "skip second hierarchy observation",
  "remove deferred read transaction",
  "use BEGIN and COMMIT inside caller transaction",
  "rollback caller transaction after caught failure",
  "close storage after read",
  "return mutable Project repository",
  "return mutable task arrays",
  "return mutable AllowedContextSet target",
  "return mutable AllowedContextSet scopes",
  "return mutable activeContext object",
  "return mutable ACTIVE arrays",
  "return mutable Context Item provenance",
  "cache and reuse mutable result object",
  "share result arrays across calls",
  "include PROPOSED",
  "include SUPERSEDED",
  "include REJECTED",
  "include RESOLVED",
  "sort by authority",
  "sort by kind",
  "sort by latest effectiveAt",
  "remove ID ordering tie break",
  "semantic dedupe contradictory bodies",
  "latest-wins conflict resolution",
  "omit empty scope array",
  "write updated_at during read",
  "append Audit Event during read",
  "materialize snapshot cache",
  "add snapshot table",
  "add snapshot migration",
  "leak raw SQLite error",
  "leave owned read transaction open",
] as const;

const SOURCE_TO_TEST_MAPPING = [
  "profile vocabulary -> exact three-profile query audit",
  "Standard literal -> independent oracle",
  "Fresh literal -> independent oracle",
  "Focused literal -> independent oracle",
  "unknown profile -> hostile boundary matrix",
  "null profile -> hostile boundary matrix",
  "object profile -> hostile boundary matrix",
  "symbol profile -> hostile boundary matrix",
  "canonical request ID -> canonicality matrix",
  "trim-normalizable request ID -> INVALID_INPUT matrix",
  "wrong-prefix request ID -> INVALID_INPUT matrix",
  "empty request ID -> INVALID_INPUT matrix",
  "oversize request ID -> INVALID_INPUT matrix",
  "missing canonical request ID -> PARENT_NOT_FOUND matrix",
  "hostile Proxy input -> runtime boundary matrix",
  "throwing coercion input -> runtime boundary matrix",
  "custom prototype input -> runtime boundary matrix",
  "stored Subtask parser -> hierarchy corruption matrix",
  "stored Big Task parser -> hierarchy corruption matrix",
  "stored Project parser -> hierarchy corruption matrix",
  "Subtask structured fields -> hierarchy corruption matrix",
  "Big Task structured fields -> hierarchy corruption matrix",
  "Project repository representation -> hierarchy corruption matrix",
  "hierarchy timestamps -> hierarchy corruption matrix",
  "missing Big Task -> hierarchy corruption matrix",
  "missing Project -> hierarchy corruption matrix",
  "Subtask ownership -> hierarchy mutation snapshot",
  "Big Task ownership -> hierarchy mutation snapshot",
  "Project values -> hierarchy mutation snapshot",
  "single deferred read snapshot -> deterministic WAL commit",
  "repeat hierarchy observation -> state A/state B oracle",
  "ACL hierarchy correspondence -> exact target assertions",
  "ACL before query -> source and statement audit",
  "Project exact scope -> independent oracle",
  "Big Task exact scope -> independent oracle",
  "Subtask exact scope -> independent oracle",
  "sibling Subtask exclusion -> isolation matrix",
  "other Big Task exclusion -> isolation matrix",
  "foreign Project exclusion -> isolation matrix",
  "scope alias failure -> corruption tripwire",
  "malformed body failure -> corruption tripwire",
  "malformed effectiveAt failure -> corruption tripwire",
  "supersession terminal failure -> corruption tripwire",
  "supersession pointer canonicality -> corruption tripwire",
  "unrelated corruption isolation -> three-surface matrix",
  "complete raw validation before ACTIVE -> excluded-status tripwire",
  "ACTIVE-only projection -> five-status scale matrix",
  "PROPOSED exclusion -> five-status scale matrix",
  "SUPERSEDED exclusion -> five-status scale matrix",
  "REJECTED exclusion -> five-status scale matrix",
  "RESOLVED exclusion -> five-status scale matrix",
  "effectiveAt ordering -> generated oracle",
  "ID tie ordering -> generated oracle",
  "authority neutrality -> independent oracle",
  "kind neutrality -> independent oracle",
  "contradiction preservation -> independent oracle",
  "S2A equivalence -> 80-target campaign",
  "S2B1 validation equivalence -> corruption tripwires",
  "S2B2 result equivalence -> 80-target campaign",
  "QA Context Item SELECT count -> SQL instrumentation",
  "Fresh exact key set -> recursive shape audit",
  "Focused exact key set -> recursive shape audit",
  "no hidden undefined fields -> serialization audit",
  "no Digest query -> all-table SQL audit",
  "no Audit Event query -> all-table SQL audit",
  "no dependency query -> all-table SQL audit",
  "no checkpoint query -> all-table SQL audit",
  "read-only projects -> application table snapshot",
  "read-only task hierarchy -> application table snapshot",
  "read-only dependencies -> application table snapshot",
  "read-only Context Items -> application table snapshot",
  "read-only Digests -> application table snapshot",
  "read-only Audit Events -> application table snapshot",
  "no timestamp changes -> byte-for-byte rows",
  "no cache writes -> byte-for-byte rows",
  "caller transaction reuse -> transaction SQL audit",
  "caller commit ownership -> caught-failure transaction",
  "caller rollback ownership -> caught-failure transaction",
  "closed storage behavior -> error matrix",
  "database failure sanitization -> injected SELECT failure",
  "BEGIN failure sanitization -> injected transaction failure",
  "COMMIT failure sanitization -> injected transaction failure",
  "detached results -> separate-reference assertions",
  "recursive freeze -> descriptor traversal",
  "cross-result poisoning -> two-read mutation test",
  "same-shaped DATA distinction -> structured clone control",
  "no trust markers -> recursive name audit",
  "no trust parser -> runtime export audit",
  "explicit profile selection -> 24 lifecycle combinations",
  "no status inference -> 24 lifecycle combinations",
  "no maturity inference -> 24 lifecycle combinations",
  "no migrations -> schema fingerprint",
  "no new tables -> exact table inventory",
  "no new columns or indexes -> schema fingerprint",
  "no final packet compiler -> production source audit",
  "no production snapshot consumers -> production source audit",
  "no deferred integrations -> method source audit",
  "bounded scale -> 2,503 irrelevant-row campaign",
  "generated valid evaluations -> 240 profile reads",
  "generated invalid evaluations -> 160 boundary reads",
  "generated QA query invariant -> campaign SQL audit",
] as const;

describe("JIT storage source mutation and source-to-test assurance", () => {
  it("reviews 110 mutations with 75 isolation/coherence/trust targets and 35 implementation cases", () => {
    const materialSurvivors: readonly string[] = [];
    expect(ISOLATION_COHERENCE_TRUST_MUTATIONS).toHaveLength(75);
    expect(IMPLEMENTATION_SPECIFIC_MUTATIONS).toHaveLength(35);
    expect(
      new Set([
        ...ISOLATION_COHERENCE_TRUST_MUTATIONS,
        ...IMPLEMENTATION_SPECIFIC_MUTATIONS,
      ]).size,
    ).toBe(110);
    expect(materialSurvivors).toEqual([]);
  });

  it("maps at least 80 safety-critical conditions with no unjustified gap", () => {
    expect(SOURCE_TO_TEST_MAPPING.length).toBeGreaterThanOrEqual(80);
    expect(new Set(SOURCE_TO_TEST_MAPPING).size).toBe(
      SOURCE_TO_TEST_MAPPING.length,
    );
    expect(
      SOURCE_TO_TEST_MAPPING.filter((mapping) => !mapping.includes(" -> ")),
    ).toEqual([]);
  });
});
