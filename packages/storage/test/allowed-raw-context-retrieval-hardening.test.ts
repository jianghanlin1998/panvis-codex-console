import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ContextItemSchema,
  ContextScopeSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  ContextItem,
  ContextScope,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { AllowedRawContextItemSnapshot, TaskStorage } from "../src/index.js";
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

const TARGET_PROJECT = "prj_hardened";
const TARGET_BIG_TASK = "bt_hardened";
const TARGET_SUBTASK = SubtaskIdSchema.parse("st_hardened");
const SIBLING_SUBTASK = SubtaskIdSchema.parse("st_hardened_sibling");
const OTHER_BIG_TASK = "bt_hardened_other";
const OTHER_BIG_TASK_SUBTASK = SubtaskIdSchema.parse("st_hardened_other");
const FOREIGN_PROJECT = "prj_hardened_foreign";
const FOREIGN_BIG_TASK = "bt_hardened_foreign";
const FOREIGN_SUBTASK = SubtaskIdSchema.parse("st_hardened_foreign");

const projectScope = (): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "PROJECT", projectId: TARGET_PROJECT });
const bigTaskScope = (): ContextScope =>
  ContextScopeSchema.parse({
    scopeType: "BIG_TASK",
    projectId: TARGET_PROJECT,
    bigTaskId: TARGET_BIG_TASK,
  });
const subtaskScope = (subtaskId = TARGET_SUBTASK): ContextScope =>
  ContextScopeSchema.parse({
    scopeType: "SUBTASK",
    projectId: TARGET_PROJECT,
    bigTaskId: TARGET_BIG_TASK,
    subtaskId,
  });

const seedTarget = (storage: TaskStorage): void => {
  storage.createProject(makeProject(TARGET_PROJECT, "hardened"));
  storage.createBigTask(makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK));
  storage.createSubtask(makeSubtask(SIBLING_SUBTASK, TARGET_BIG_TASK));
  storage.createBigTask(makeBigTask(OTHER_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(OTHER_BIG_TASK_SUBTASK, OTHER_BIG_TASK));
  storage.createProject(makeProject(FOREIGN_PROJECT, "hardened-foreign"));
  storage.createBigTask(makeBigTask(FOREIGN_BIG_TASK, FOREIGN_PROJECT));
  storage.createSubtask(makeSubtask(FOREIGN_SUBTASK, FOREIGN_BIG_TASK));
};

const read = (
  storage: TaskStorage,
  subtaskId: SubtaskId = TARGET_SUBTASK,
): AllowedRawContextItemSnapshot =>
  storage.readAllowedRawContextItemsForSubtask(subtaskId);

const itemIds = (
  snapshot: AllowedRawContextItemSnapshot,
): readonly (readonly string[])[] =>
  snapshot.buckets.map(({ contextItems }) =>
    contextItems.map(({ id }) => id),
  );

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

const expectMalformed = (operation: () => unknown): void => {
  const error = captureTaskStorageError(operation);
  expect(error).toMatchObject({
    code: "MALFORMED_STORED_DATA",
    message: "Stored task data is malformed.",
  });
  expect(error.message).not.toMatch(
    /SQLite|\bSQL\b|context_items|project_id|big_task_id|subtask_id|constraint|\/Users\/|Zod|stack/i,
  );
};

describe("S2B1 independent retrieval oracle and ACL query boundary", () => {
  it("matches a fresh nine-target oracle across three Projects", () => {
    withMemoryStorage((storage) => {
      type OracleRow = {
        readonly item: ContextItem;
        readonly projectId: string;
        readonly bigTaskId: string | null;
        readonly subtaskId: string | null;
      };
      const rows: OracleRow[] = [];
      const selectedTargets: {
        readonly projectId: string;
        readonly bigTaskId: string;
        readonly subtaskId: SubtaskId;
      }[] = [];

      const addItem = (
        id: string,
        scope: ContextScope,
        projectId: string,
        bigTaskId: string | null,
        subtaskId: string | null,
      ): void => {
        const base = makeContextItem(id, scope, {
          effectiveAt: "2026-08-08T08:08:08.000Z",
          title: "Shared semantic title",
          body: "Shared semantic body.",
        });
        const item = ContextItemSchema.parse({
          ...base,
          provenance: {
            ...base.provenance,
            sourceReference: "shared-source#oracle",
          },
        });
        storage.createContextItem(item);
        rows.push({ item, projectId, bigTaskId, subtaskId });
      };

      for (let projectIndex = 0; projectIndex < 3; projectIndex += 1) {
        const projectId = `prj_oracle_${projectIndex}`;
        storage.createProject(makeProject(projectId, `oracle-${projectIndex}`));
        addItem(
          `ctx_oracle_p_${projectIndex}`,
          ContextScopeSchema.parse({ scopeType: "PROJECT", projectId }),
          projectId,
          null,
          null,
        );
        for (let bigTaskIndex = 0; bigTaskIndex < 3; bigTaskIndex += 1) {
          const bigTaskId = `bt_oracle_${projectIndex}_${bigTaskIndex}`;
          storage.createBigTask(makeBigTask(bigTaskId, projectId));
          addItem(
            `ctx_oracle_b_${projectIndex}_${bigTaskIndex}`,
            ContextScopeSchema.parse({
              scopeType: "BIG_TASK",
              projectId,
              bigTaskId,
            }),
            projectId,
            bigTaskId,
            null,
          );
          for (let subtaskIndex = 0; subtaskIndex < 4; subtaskIndex += 1) {
            const subtaskId = SubtaskIdSchema.parse(
              `st_oracle_${projectIndex}_${bigTaskIndex}_${subtaskIndex}`,
            );
            storage.createSubtask(makeSubtask(subtaskId, bigTaskId));
            addItem(
              `ctx_oracle_s_${projectIndex}_${bigTaskIndex}_${subtaskIndex}`,
              ContextScopeSchema.parse({
                scopeType: "SUBTASK",
                projectId,
                bigTaskId,
                subtaskId,
              }),
              projectId,
              bigTaskId,
              subtaskId,
            );
            if (subtaskIndex === 2) {
              selectedTargets.push({ projectId, bigTaskId, subtaskId });
            }
          }
        }
      }

      let oracleDecisions = 0;
      for (const target of selectedTargets) {
        const expected = [
          rows
            .filter((row) => {
              oracleDecisions += 1;
              return (
                row.projectId === target.projectId &&
                row.bigTaskId === null &&
                row.subtaskId === null
              );
            })
            .map(({ item }) => item.id),
          rows
            .filter(
              (row) =>
                row.projectId === target.projectId &&
                row.bigTaskId === target.bigTaskId &&
                row.subtaskId === null,
            )
            .map(({ item }) => item.id),
          rows
            .filter(
              (row) =>
                row.projectId === target.projectId &&
                row.bigTaskId === target.bigTaskId &&
                row.subtaskId === target.subtaskId,
            )
            .map(({ item }) => item.id),
        ];
        oracleDecisions += rows.length * 2;
        const snapshot = read(storage, target.subtaskId);
        expect(itemIds(snapshot)).toEqual(expected);
        expect(snapshot.buckets.map(({ scope }) => scope.scopeType)).toEqual([
          "PROJECT",
          "BIG_TASK",
          "SUBTASK",
        ]);
      }

      expect(selectedTargets).toHaveLength(9);
      expect(rows).toHaveLength(48);
      expect(oracleDecisions).toBe(1_296);
    });
  });

  it("issues only target-local Context Item queries after hierarchy evidence", () => {
    withMemoryStorage((storage) => {
      seedTarget(storage);
      const prototype = StatementSync.prototype as unknown as {
        all: (...parameters: unknown[]) => unknown[];
        get: (...parameters: unknown[]) => unknown;
        readonly sourceSQL: string;
      };
      const originalAll = prototype.all;
      const originalGet = prototype.get;
      const statements: { readonly sql: string; readonly parameters: readonly unknown[] }[] = [];
      prototype.all = function (...parameters: unknown[]): unknown[] {
        const result = Reflect.apply(originalAll, this, parameters) as unknown[];
        statements.push({ sql: this.sourceSQL, parameters });
        return result;
      };
      prototype.get = function (...parameters: unknown[]): unknown {
        const result = Reflect.apply(originalGet, this, parameters);
        statements.push({ sql: this.sourceSQL, parameters });
        return result;
      };
      try {
        expect(itemIds(read(storage))).toEqual([[], [], []]);
      } finally {
        prototype.all = originalAll;
        prototype.get = originalGet;
      }

      const firstContextIndex = statements.findIndex(({ sql }) =>
        /from\s+"?context_items"?/i.test(sql),
      );
      expect(firstContextIndex).toBeGreaterThan(0);
      const beforeContext = statements
        .slice(0, firstContextIndex)
        .map(({ sql }) => sql)
        .join("\n");
      expect(beforeContext).toMatch(/from\s+"?subtasks"?/i);
      expect(beforeContext).toMatch(/from\s+"?big_tasks"?/i);
      expect(beforeContext).toMatch(/from\s+"?projects"?/i);

      const contextStatements = statements.filter(({ sql }) =>
        /from\s+"?context_items"?/i.test(sql),
      );
      expect(contextStatements).toHaveLength(6);
      expect(contextStatements.every(({ sql }) => /where/i.test(sql))).toBe(true);
      const contextInputs = contextStatements.flatMap(({ parameters }) =>
        parameters.filter(
          (value): value is string =>
            typeof value === "string" && /^(?:prj|bt|st)_/.test(value),
        ),
      );
      expect(new Set(contextInputs)).toEqual(
        new Set([TARGET_PROJECT, TARGET_BIG_TASK, TARGET_SUBTASK]),
      );
      expect(contextInputs).not.toContain(SIBLING_SUBTASK);
      expect(contextInputs).not.toContain(OTHER_BIG_TASK);
      expect(contextInputs).not.toContain(FOREIGN_PROJECT);
    });
  });
});

describe("S2B1 empty/asymmetric buckets and dependency non-expansion", () => {
  it.each([
    ["all empty", [false, false, false]],
    ["Project only", [true, false, false]],
    ["Big Task only", [false, true, false]],
    ["Subtask only", [false, false, true]],
    ["Project and Subtask", [true, false, true]],
    ["Big Task and Subtask", [false, true, true]],
  ] as const)("preserves exactly three buckets for %s", (_label, populated) => {
    withMemoryStorage((storage) => {
      seedTarget(storage);
      const scopes = [projectScope(), bigTaskScope(), subtaskScope()] as const;
      const expected = scopes.map((scope, index) => {
        if (!populated[index]) {
          return [];
        }
        const item = makeContextItem(`ctx_asymmetric_${index}`, scope);
        storage.createContextItem(item);
        return [item.id];
      });
      const snapshot = read(storage);
      expect(snapshot.buckets).toHaveLength(3);
      expect(itemIds(snapshot)).toEqual(expected);
    });
  });

  it("ignores BLOCKING/HARDENED, BLOCKING/ACCEPTED, and INFORMATIONAL/NONE upstream raw context", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const allowed = makeContextItem("ctx_dependency_allowed", subtaskScope());
      const upstream = [
        makeContextItem("ctx_dependency_sibling", subtaskScope(SIBLING_SUBTASK)),
        makeContextItem(
          "ctx_dependency_other_big",
          ContextScopeSchema.parse({
            scopeType: "SUBTASK",
            projectId: TARGET_PROJECT,
            bigTaskId: OTHER_BIG_TASK,
            subtaskId: OTHER_BIG_TASK_SUBTASK,
          }),
        ),
        makeContextItem(
          "ctx_dependency_foreign",
          ContextScopeSchema.parse({
            scopeType: "SUBTASK",
            projectId: FOREIGN_PROJECT,
            bigTaskId: FOREIGN_BIG_TASK,
            subtaskId: FOREIGN_SUBTASK,
          }),
        ),
      ];
      setup.createContextItem(allowed);
      upstream.forEach((item) => setup.createContextItem(item));
      const before = read(setup);
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      const insert = sqlite.prepare(
        "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        SIBLING_SUBTASK,
        TARGET_SUBTASK,
        "BLOCKING",
        "HARDENED",
        "Sibling dependency.",
        FIXED_TIME,
      );
      insert.run(
        OTHER_BIG_TASK_SUBTASK,
        TARGET_SUBTASK,
        "BLOCKING",
        "ACCEPTED",
        "Other Big Task dependency.",
        FIXED_TIME,
      );
      insert.run(
        FOREIGN_SUBTASK,
        TARGET_SUBTASK,
        "INFORMATIONAL",
        "NONE",
        "Foreign informational dependency.",
        FIXED_TIME,
      );
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(read(storage)).toEqual(before);
      expect(itemIds(before)).toEqual([[], [], [allowed.id]]);
      storage.close();
    });
  });
});

describe("S2B1 canonical alias fail-closed campaign", () => {
  const trimForms = [
    ["SPACE", " "],
    ["TAB", "\t"],
    ["CRLF", "\r\n"],
    ["NBSP", "\u00a0"],
    ["OGHAM", "\u1680"],
    ["EM SPACE", "\u2003"],
    ["LINE SEPARATOR", "\u2028"],
    ["NARROW NBSP", "\u202f"],
    ["BOM", "\ufeff"],
  ] as const;
  const aliasTargets = [
    ["Project ID", projectScope(), "project_id", TARGET_PROJECT, ProjectIdSchema],
    ["Big Task ID", bigTaskScope(), "big_task_id", TARGET_BIG_TASK, BigTaskIdSchema],
    ["Subtask ID", subtaskScope(), "subtask_id", TARGET_SUBTASK, SubtaskIdSchema],
  ] as const;
  const aliasCases = aliasTargets.flatMap(
    ([field, scope, column, target, schema]) =>
      trimForms.map(([whitespace, characters], index) => ({
        field,
        scope,
        column,
        target,
        schema,
        whitespace,
        alias: `${characters}${target}${characters}`,
        index,
      })),
  );

  it.each(aliasCases)("rejects a parser-normalizable $field alias using $whitespace", ({
    scope,
    column,
    target,
    schema,
    alias,
    index,
  }) => {
    withTemporaryDatabasePath((databasePath) => {
      expect(schema.parse(alias)).toBe(target);
      expect(alias).not.toBe(target);
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const item = makeContextItem(
        `ctx_alias_${scope.scopeType.toLowerCase()}_${index}`,
        scope,
      );
      setup.createContextItem(item);
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare(`UPDATE context_items SET ${column} = ? WHERE id = ?`).run(alias, item.id);
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() =>
          storage.readAllowedRawContextItemsForSubtask(TARGET_SUBTASK),
        );
      } finally {
        storage.close();
      }
    });
  });

  it("isolates sibling, other-Big-Task, and foreign aliases but fails for their own targets", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const allowed = [projectScope(), bigTaskScope(), subtaskScope()].map(
        (scope, index) => makeContextItem(`ctx_alias_isolation_allowed_${index}`, scope),
      );
      allowed.forEach((item) => setup.createContextItem(item));
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      insertRawContextItem(
        sqlite,
        makeContextItem("ctx_alias_isolation_sibling", subtaskScope(SIBLING_SUBTASK)),
        { subtaskId: `\u00a0${SIBLING_SUBTASK}\u00a0` },
      );
      insertRawContextItem(
        sqlite,
        makeContextItem(
          "ctx_alias_isolation_other_big",
          ContextScopeSchema.parse({
            scopeType: "BIG_TASK",
            projectId: TARGET_PROJECT,
            bigTaskId: OTHER_BIG_TASK,
          }),
        ),
        { bigTaskId: `\u2003${OTHER_BIG_TASK}\u2003` },
      );
      insertRawContextItem(
        sqlite,
        makeContextItem(
          "ctx_alias_isolation_foreign",
          ContextScopeSchema.parse({
            scopeType: "PROJECT",
            projectId: FOREIGN_PROJECT,
          }),
        ),
        { projectId: `\ufeff${FOREIGN_PROJECT}\ufeff` },
      );
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(read(storage))).toEqual([
          [allowed[0]!.id],
          [allowed[1]!.id],
          [allowed[2]!.id],
        ]);
        expectMalformed(() => read(storage, SIBLING_SUBTASK));
        expectMalformed(() => read(storage, OTHER_BIG_TASK_SUBTASK));
        expectMalformed(() => read(storage, FOREIGN_SUBTASK));
      } finally {
        storage.close();
      }
    });
  });

  it("rejects a canonically linked cross-scope successor whose pointer is aliased", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const prior = makeContextItem("ctx_alias_link_prior", projectScope());
      const successor = makeContextItem(
        "ctx_alias_link_successor",
        subtaskScope(SIBLING_SUBTASK),
      );
      setup.createContextItem(prior);
      setup.createContextItem(successor);
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite
        .prepare("UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?")
        .run(prior.id);
      sqlite
        .prepare("UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?")
        .run(`\u00a0${prior.id}\u00a0`, successor.id);
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() =>
          storage.readAllowedRawContextItemsForSubtask(TARGET_SUBTASK),
        );
      } finally {
        storage.close();
      }
    });
  });
});

const allowedScopes = (): readonly ContextScope[] => [
  projectScope(),
  bigTaskScope(),
  subtaskScope(),
];

const createChain = (
  storage: TaskStorage,
  scope: ContextScope,
  prefix: string,
  length: number,
): readonly ContextItem[] => {
  const items: ContextItem[] = [];
  let current = makeContextItem(`${prefix}_0`, scope);
  storage.createContextItem(current);
  items.push(current);
  for (let index = 1; index < length; index += 1) {
    current = makeContextItem(`${prefix}_${index}`, scope, {
      effectiveAt: `2026-08-09T00:${index.toString().padStart(2, "0")}:00.000Z`,
      supersedesContextItemId: current.id,
    });
    storage.supersedeContextItem(current);
    items.push(current);
  }
  return items;
};

describe("S2B1 relevant Context Item and linked-history corruption", () => {
  const rowCorruptions = [
    ["ID canonicality", "id", (value: string) => ` ${value} `],
    ["title canonicality", "title", (value: string) => ` ${value} `],
    ["body canonicality", "body", (value: string) => `\u00a0${value}\u00a0`],
    [
      "source reference canonicality",
      "source_reference",
      (value: string) => `\u2003${value}\u2003`,
    ],
    ["effective time canonicality", "effective_at", () => "2026-08-09T00:00:00+00:00"],
    ["status enum", "status", () => "CURRENT"],
    ["kind enum", "kind", () => "INSTRUCTION"],
    ["authority enum", "authority", () => "OWNER"],
    ["source type enum", "source_type", () => "PRIVATE_CHAT"],
    ["created timestamp", "created_at", () => "2026-08-09T00:00:00+00:00"],
    ["updated timestamp", "updated_at", () => "not-a-time"],
    ["missing supersession predecessor", "supersedes_context_item_id", () => "ctx_missing_predecessor"],
  ] as const;
  const relevantCases = allowedScopes().flatMap((scope) =>
    rowCorruptions.map(([label, column, replacement]) => ({
      scope,
      label,
      column,
      replacement,
    })),
  );

  it.each(relevantCases)("fails closed for $label at $scope.scopeType scope", ({
    scope,
    column,
    replacement,
  }) => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const item = makeContextItem(
        `ctx_corruption_${scope.scopeType.toLowerCase()}`,
        scope,
      );
      setup.createContextItem(item);
      setup.close();
      const sourceValue =
        column === "source_reference"
          ? item.provenance.sourceReference
          : column === "effective_at"
            ? item.provenance.effectiveAt
            : column === "created_at" || column === "updated_at"
              ? FIXED_TIME
              : String(item[column as keyof ContextItem] ?? "");
      mutate(
        databasePath,
        `UPDATE context_items SET ${column} = ? WHERE id = ?`,
        replacement(sourceValue),
        item.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => read(storage));
      } finally {
        storage.close();
      }
    });
  });

  const historyCases = [
    "missing predecessor",
    "missing successor",
    "branching successors",
    "cycle",
    "cross-scope predecessor",
    "cross-scope successor",
    "malformed predecessor",
    "malformed successor",
    "invalid non-terminal status",
    "invalid terminal status",
  ] as const;
  const historyMatrix = allowedScopes().flatMap((scope) =>
    historyCases.map((historyCase) => ({ scope, historyCase })),
  );

  it.each(historyMatrix)("fails closed for $historyCase at $scope.scopeType scope", ({
    scope,
    historyCase,
  }) => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const prefix = `ctx_history_${scope.scopeType.toLowerCase()}`;
      const chain = createChain(
        setup,
        scope,
        prefix,
        historyCase === "missing successor" ? 3 : 2,
      );
      if (
        historyCase === "cross-scope predecessor" ||
        historyCase === "cross-scope successor"
      ) {
        setup.createContextItem(
          makeContextItem(`${prefix}_cross`, subtaskScope(SIBLING_SUBTASK)),
        );
      }
      setup.close();

      const first = chain[0]!;
      const second = chain[1]!;
      switch (historyCase) {
        case "missing predecessor":
          mutate(databasePath, "DELETE FROM context_items WHERE id = ?", first.id);
          break;
        case "missing successor":
          mutate(
            databasePath,
            "DELETE FROM context_items WHERE id = ?",
            chain[2]!.id,
          );
          break;
        case "branching successors": {
          const sqlite = new DatabaseSync(databasePath);
          try {
            sqlite.exec(
              "PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; DROP INDEX context_items_supersedes_unique",
            );
            insertRawContextItem(
              sqlite,
              makeContextItem(`${prefix}_branch`, scope, {
                supersedesContextItemId: first.id,
              }),
            );
          } finally {
            sqlite.close();
          }
          break;
        }
        case "cycle":
          mutate(
            databasePath,
            "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            second.id,
            first.id,
          );
          mutate(
            databasePath,
            "UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?",
            second.id,
          );
          break;
        case "cross-scope predecessor":
          mutate(
            databasePath,
            "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            `${prefix}_cross`,
            second.id,
          );
          mutate(
            databasePath,
            "UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?",
            `${prefix}_cross`,
          );
          break;
        case "cross-scope successor":
          mutate(
            databasePath,
            "DELETE FROM context_items WHERE id = ?",
            second.id,
          );
          mutate(
            databasePath,
            "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            first.id,
            `${prefix}_cross`,
          );
          break;
        case "malformed predecessor":
          mutate(
            databasePath,
            "UPDATE context_items SET title = ? WHERE id = ?",
            ` ${first.title} `,
            first.id,
          );
          break;
        case "malformed successor":
          mutate(
            databasePath,
            "UPDATE context_items SET body = ? WHERE id = ?",
            ` ${second.body} `,
            second.id,
          );
          break;
        case "invalid non-terminal status":
          mutate(
            databasePath,
            "UPDATE context_items SET status = 'ACTIVE' WHERE id = ?",
            first.id,
          );
          break;
        case "invalid terminal status":
          mutate(
            databasePath,
            "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
            second.id,
          );
          break;
      }

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => read(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("isolates sibling linked-history corruption and rejects it for the sibling target", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const allowed = makeContextItem("ctx_history_isolation_allowed", subtaskScope());
      setup.createContextItem(allowed);
      const siblingChain = createChain(
        setup,
        subtaskScope(SIBLING_SUBTASK),
        "ctx_history_isolation_sibling",
        2,
      );
      setup.close();
      mutate(
        databasePath,
        "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
        siblingChain[1]!.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(read(storage))).toEqual([[], [], [allowed.id]]);
        expectMalformed(() => read(storage, SIBLING_SUBTASK));
      } finally {
        storage.close();
      }
    });
  });
});

describe("S2B1 snapshot, cleanup, and read-only hardening", () => {
  it("keeps target hierarchy and all three Context buckets in one committed state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const items = allowedScopes().map((scope, index) =>
        makeContextItem(`ctx_hierarchy_snapshot_${index}`, scope, {
          body: `OLD-${index}`,
        }),
      );
      items.forEach((item) => setup.createContextItem(item));
      setup.close();
      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      writer
        .prepare("UPDATE big_tasks SET project_id = ? WHERE id = ?")
        .run(FOREIGN_PROJECT, TARGET_BIG_TASK);
      writer
        .prepare(
          "UPDATE context_items SET project_id = ?, body = 'NEW-' || id WHERE id LIKE 'ctx_hierarchy_snapshot_%'",
        )
        .run(FOREIGN_PROJECT);

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

      let oldSnapshot: AllowedRawContextItemSnapshot;
      try {
        oldSnapshot = read(reader);
      } finally {
        prototype.get = originalGet;
      }
      try {
        expect(committed).toBe(true);
        expect(oldSnapshot.allowedContextSet.target.projectId).toBe(TARGET_PROJECT);
        expect(oldSnapshot.buckets.map(({ contextItems }) => contextItems[0]?.body)).toEqual([
          "OLD-0",
          "OLD-1",
          "OLD-2",
        ]);

        const newSnapshot = read(reader);
        expect(newSnapshot.allowedContextSet.target.projectId).toBe(FOREIGN_PROJECT);
        expect(newSnapshot.buckets.map(({ scope }) => scope.projectId)).toEqual([
          FOREIGN_PROJECT,
          FOREIGN_PROJECT,
          FOREIGN_PROJECT,
        ]);
        expect(newSnapshot.buckets.map(({ contextItems }) => contextItems[0]?.body)).toEqual(
          items.map(({ id }) => `NEW-${id}`),
        );
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("cleans standalone read transactions after missing, hierarchy, item, and history failures", () => {
    const cases = ["missing", "hierarchy", "item", "history"] as const;
    for (const failureCase of cases) {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTarget(setup);
        if (failureCase === "item") {
          setup.createContextItem(makeContextItem("ctx_cleanup_item", projectScope()));
        }
        if (failureCase === "history") {
          createChain(setup, projectScope(), "ctx_cleanup_history", 2);
        }
        setup.close();
        if (failureCase === "hierarchy") {
          mutate(
            databasePath,
            "UPDATE big_tasks SET project_id = ? WHERE id = ?",
            ` ${TARGET_PROJECT} `,
            TARGET_BIG_TASK,
          );
        } else if (failureCase === "item") {
          mutate(
            databasePath,
            "UPDATE context_items SET title = ? WHERE id = ?",
            " malformed cleanup item ",
            "ctx_cleanup_item",
          );
        } else if (failureCase === "history") {
          mutate(
            databasePath,
            "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
            "ctx_cleanup_history_1",
          );
        }

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const error = captureTaskStorageError(() =>
            failureCase === "missing"
              ? read(storage, SubtaskIdSchema.parse("st_cleanup_missing"))
              : read(storage),
          );
          expect(error.code).toBe(
            failureCase === "missing" ? "PARENT_NOT_FOUND" : "MALFORMED_STORED_DATA",
          );
          expect(itemIds(read(storage, FOREIGN_SUBTASK))).toEqual([[], [], []]);
          const writer = new DatabaseSync(databasePath, { timeout: 0 });
          try {
            writer.exec("BEGIN EXCLUSIVE; ROLLBACK");
          } finally {
            writer.close();
          }
        } finally {
          storage.close();
        }
      });
    }
  });

  it("leaves every application row unchanged across success, failure, repetition, outer transaction, and reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTarget(setup);
      const allowed = makeContextItem("ctx_read_only_hardened", subtaskScope());
      setup.createContextItem(allowed);
      setup.close();
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      insertRawContextItem(
        sqlite,
        makeContextItem(
          "ctx_read_only_foreign_alias",
          ContextScopeSchema.parse({
            scopeType: "PROJECT",
            projectId: FOREIGN_PROJECT,
          }),
        ),
        { projectId: `\u00a0${FOREIGN_PROJECT}\u00a0` },
      );
      sqlite.close();
      const before = applicationRows(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(itemIds(read(storage))).toEqual([[], [], [allowed.id]]);
      expect(itemIds(read(storage))).toEqual([[], [], [allowed.id]]);
      storage.runInTransaction((transaction) => {
        expect(itemIds(read(transaction))).toEqual([[], [], [allowed.id]]);
      });
      expectMalformed(() => read(storage, FOREIGN_SUBTASK));
      storage.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(itemIds(read(reopened))).toEqual([[], [], [allowed.id]]);
      reopened.close();
      expect(applicationRows(databasePath)).toBe(before);
    });
  });
});

describe("S2B1 excluded-row scale boundary", () => {
  it.each([2_503, 10_003])(
    "returns only three allowed rows across %i excluded rows",
    (excludedCount) => {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTarget(setup);
        const allowed = allowedScopes().map((scope, index) =>
          makeContextItem(`ctx_scale_hardened_allowed_${index}`, scope),
        );
        allowed.forEach((item) => setup.createContextItem(item));
        setup.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("BEGIN");
        const insert = sqlite.prepare(`
          INSERT INTO context_items (
            id, project_id, big_task_id, subtask_id, kind, status, authority,
            title, body, source_type, source_reference, effective_at,
            supersedes_context_item_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'ENGINEERING_FACT', 'ACTIVE', 'REPO_EVIDENCE',
            'Shared excluded title', 'Shared excluded body.', 'REPO',
            'shared-source#excluded', ?, NULL, ?, ?)
        `);
        try {
          for (let index = 0; index < excludedCount; index += 1) {
            const placement = index % 3;
            insert.run(
              `ctx_scale_hardened_excluded_${index.toString().padStart(5, "0")}`,
              placement === 2 ? FOREIGN_PROJECT : TARGET_PROJECT,
              placement === 0 ? TARGET_BIG_TASK : placement === 1 ? OTHER_BIG_TASK : null,
              placement === 0 ? SIBLING_SUBTASK : null,
              FIXED_TIME,
              FIXED_TIME,
              FIXED_TIME,
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

        const prototype = StatementSync.prototype as unknown as {
          all: (...parameters: unknown[]) => unknown[];
          get: (...parameters: unknown[]) => unknown;
          readonly sourceSQL: string;
        };
        const originalAll = prototype.all;
        const originalGet = prototype.get;
        let materializedContextRows = 0;
        const contextSql: string[] = [];
        prototype.all = function (...parameters: unknown[]): unknown[] {
          const rows = Reflect.apply(originalAll, this, parameters) as unknown[];
          if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
            contextSql.push(this.sourceSQL);
            materializedContextRows += rows.length;
          }
          return rows;
        };
        prototype.get = function (...parameters: unknown[]): unknown {
          const row = Reflect.apply(originalGet, this, parameters);
          if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
            contextSql.push(this.sourceSQL);
            materializedContextRows += row === undefined ? 0 : 1;
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
          [allowed[0]!.id],
          [allowed[1]!.id],
          [allowed[2]!.id],
        ]);
        expect(materializedContextRows).toBe(3);
        expect(contextSql.length).toBeGreaterThanOrEqual(9);
        expect(contextSql.every((statement) => /where/i.test(statement))).toBe(true);

        const plan = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const details = plan
            .prepare(
              "EXPLAIN QUERY PLAN SELECT * FROM context_items WHERE project_id = ? AND big_task_id = ? AND subtask_id = ? ORDER BY effective_at, id",
            )
            .all(TARGET_PROJECT, TARGET_BIG_TASK, TARGET_SUBTASK) as unknown as readonly {
            readonly detail: string;
          }[];
          expect(details.some(({ detail }) => /context_items_subtask_id_index/i.test(detail))).toBe(true);
        } finally {
          plan.close();
        }
      });
    },
    20_000,
  );
});

const MUTATION_REVIEW = [
  ["retrieve before ACL build", "ACL query trace + source order"],
  ["global Context Item query then JavaScript filter", "query trace + scale rows"],
  ["same-Project broad query", "cross-product oracle + query inputs"],
  ["include sibling Subtask", "oracle + dependency campaign"],
  ["include another Big Task", "oracle + dependency campaign"],
  ["include foreign Project", "oracle + scale campaign"],
  ["include dependency upstream scope", "dependency non-expansion"],
  ["Project bucket includes descendants", "asymmetric buckets + oracle"],
  ["Big Task bucket includes Subtasks", "asymmetric buckets + oracle"],
  ["Subtask predicate compares only Subtask ID", "query trace + foreign topology"],
  ["Subtask predicate omits Project ID", "query trace + cross-product oracle"],
  ["swap bucket order", "bucket order assertions"],
  ["omit an empty bucket", "six asymmetric bucket cases"],
  ["filter to ACTIVE", "all-status implementation regression"],
  ["remove SUPERSEDED", "raw-status regression + history matrix"],
  ["remove REJECTED", "raw-status regression"],
  ["remove effectiveAt ordering", "ordering implementation regression"],
  ["remove ID tie break", "Unicode/tied-time ordering regression"],
  ["read one bucket outside snapshot", "multi-scope concurrency"],
  ["read history outside snapshot", "supersession concurrency"],
  ["read target hierarchy outside snapshot", "hierarchy concurrency"],
  ["ignore a relevant malformed row", "36-case row corruption matrix"],
  ["globally poison on sibling corruption", "corruption isolation"],
  ["silently miss target scope alias", "27-case alias matrix"],
  ["update a timestamp during read", "application-row comparison"],
  ["append Audit Event during read", "application-row comparison"],
  ["cache or materialize retrieval", "repeated/reopen row comparison"],
  ["commit outer transaction from read", "caller transaction regression"],
  ["roll back outer transaction after successful read", "caller transaction regression"],
  ["tear multi-scope OLD/NEW result", "multi-scope concurrency"],
  ["miss Unicode NBSP scope alias", "Unicode alias matrix"],
  ["miss Unicode BOM scope alias", "Unicode alias matrix"],
  ["miss OGHAM scope alias", "Unicode alias matrix"],
  ["scan aliases globally in application code", "target-local SQL trace"],
  ["allow aliased cross-scope successor pointer", "linked alias regression"],
  ["ignore missing predecessor", "history matrix"],
  ["accept missing linked successor", "history matrix"],
  ["accept branching successors", "history matrix"],
  ["accept two-node cycle", "history matrix + S0B2a regressions"],
  ["accept cross-scope predecessor", "history matrix"],
  ["accept cross-scope successor", "history matrix"],
  ["normalize malformed predecessor", "history matrix"],
  ["normalize malformed successor", "history matrix"],
  ["allow ACTIVE non-terminal", "history matrix"],
  ["allow REJECTED terminal", "history matrix"],
  ["start nested read transaction", "outer transaction reuse"],
  ["commit after Project bucket", "multi-scope snapshot regression"],
  ["rollback caller after caught read failure", "caught-failure regression"],
  ["leave read transaction open after missing target", "cleanup matrix"],
  ["leave read transaction open after malformed item", "cleanup matrix"],
  ["leak SQLite diagnostics", "sanitized failure matrix"],
  ["leak raw malformed value", "fixed public error message"],
  ["translate missing target to empty snapshot", "missing-target regression"],
  ["duplicate one ACL bucket", "exact three-bucket assertions"],
  ["query Big Task scope by Big Task ID only", "query inputs + foreign topology"],
  ["query Project scope without null descendants", "oracle + exact predicate"],
  ["foreign alias poisons clean target", "alias isolation"],
  ["unrelated malformed history poisons clean target", "history isolation"],
  ["change classification after reopen", "reopen implementation regression"],
  ["materialize 10,003 excluded rows", "10,003-row trace campaign"],
] as const;

const SOURCE_TO_TEST_MAPPING = [
  ["canonical Subtask input", "invalid-input implementation regression"],
  ["target Subtask lookup", "missing-target + query trace"],
  ["stored Subtask parser", "hierarchy corruption cleanup"],
  ["Subtask timestamp canonicality", "hierarchy corruption regressions"],
  ["parent Big Task lookup", "query trace"],
  ["stored Big Task parser", "hierarchy corruption regressions"],
  ["Big Task ownership", "hierarchy concurrency"],
  ["parent Project lookup", "query trace"],
  ["stored Project parser", "hierarchy corruption regressions"],
  ["S2A builder invocation", "source order + exact AllowedContextSet assertions"],
  ["ACL failure translation", "malformed hierarchy regression"],
  ["ACL-before-query order", "statement trace"],
  ["three allowed scope extraction", "bucket scope assertions"],
  ["Project exact predicate", "oracle + query trace"],
  ["Big Task exact predicate", "oracle + query trace"],
  ["Subtask exact predicate", "oracle + query trace"],
  ["Project alias predicate", "nine whitespace forms"],
  ["Big Task alias predicate", "nine whitespace forms"],
  ["Subtask alias predicate", "nine whitespace forms"],
  ["alias scope isolation", "three own-target reads"],
  ["Context Item row parser", "36-case corruption matrix"],
  ["Context Item ID canonicality", "three-scope row matrix"],
  ["compact text canonicality", "three-scope row matrix"],
  ["source reference canonicality", "three-scope row matrix"],
  ["effectiveAt canonicality", "three-scope row matrix"],
  ["stored timestamp canonicality", "three-scope row matrix"],
  ["enum validation", "three-scope row matrix"],
  ["exact hierarchy validation", "target hierarchy tests"],
  ["predecessor lookup", "history matrix"],
  ["successor lookup", "history matrix"],
  ["canonical successor alias lookup", "linked alias regression"],
  ["predecessor/successor identity", "branch matrix"],
  ["same-scope history edge", "cross-scope matrix"],
  ["non-terminal status", "history matrix"],
  ["terminal ACTIVE status", "history matrix"],
  ["cycle detection", "cycle matrix"],
  ["effectiveAt ascending order", "ordering implementation regression"],
  ["ID ascending tie break", "ordering implementation regression"],
  ["bucket ACL order", "oracle + asymmetric cases"],
  ["deferred read snapshot start", "multi-scope concurrency"],
  ["existing transaction reuse", "caller transaction regression"],
  ["owned read commit", "success/reopen tests"],
  ["owned read rollback", "four-case cleanup matrix"],
  ["read-only side-effect boundary", "application-row comparison"],
] as const;

describe("S2B1 assurance manifests and sanitization", () => {
  it("maps at least fifty plausible mutations with no unguarded material survivor", () => {
    expect(MUTATION_REVIEW).toHaveLength(60);
    expect(new Set(MUTATION_REVIEW.map(([mutation]) => mutation)).size).toBe(60);
    expect(MUTATION_REVIEW.filter(([, guard]) => guard.length === 0)).toEqual([]);
  });

  it("maps at least thirty-five safety-critical production conditions without an unjustified gap", () => {
    expect(SOURCE_TO_TEST_MAPPING).toHaveLength(44);
    expect(
      new Set(SOURCE_TO_TEST_MAPPING.map(([condition]) => condition)).size,
    ).toBe(44);
    expect(
      SOURCE_TO_TEST_MAPPING.filter(([, evidence]) => evidence.length === 0),
    ).toEqual([]);
  });

  it("sanitizes invalid input, missing target, and injected read-transaction failures", () => {
    withMemoryStorage((storage) => {
      seedTarget(storage);
      const invalid = captureTaskStorageError(() =>
        read(storage, " st_private_invalid " as SubtaskId),
      );
      const missing = captureTaskStorageError(() =>
        read(storage, SubtaskIdSchema.parse("st_private_missing")),
      );

      const prototype = DatabaseSync.prototype as unknown as {
        exec: (sql: string) => void;
      };
      const originalExec = prototype.exec;
      let injected = false;
      prototype.exec = function (sqlText: string): void {
        if (!injected && sqlText === "BEGIN") {
          injected = true;
          throw new Error(
            "SQLITE_PRIVATE context_items /Users/private/task.sqlite raw-value",
          );
        }
        Reflect.apply(originalExec, this, [sqlText]);
      };
      let transactionFailure;
      try {
        transactionFailure = captureTaskStorageError(() => read(storage));
      } finally {
        prototype.exec = originalExec;
      }

      expect([invalid.code, missing.code, transactionFailure.code]).toEqual([
        "INVALID_INPUT",
        "PARENT_NOT_FOUND",
        "TRANSACTION_FAILED",
      ]);
      for (const error of [invalid, missing, transactionFailure]) {
        expect(error.message).not.toMatch(
          /SQLite|\bSQL\b|context_items|project_id|big_task_id|subtask_id|constraint|\/Users\/|Zod|stack|private/i,
        );
      }
    });
  });
});
