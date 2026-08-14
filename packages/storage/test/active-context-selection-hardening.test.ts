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
  ContextSourceType,
  ContextStatus,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type {
  ActiveContextItemSnapshot,
  AllowedRawContextItemSnapshot,
  TaskStorage,
  TaskStorageError,
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

const TARGET_PROJECT = "prj_s2b2_hardening";
const TARGET_BIG_TASK = "bt_s2b2_hardening";
const TARGET_SUBTASK = SubtaskIdSchema.parse("st_s2b2_hardening");
const SIBLING_SUBTASK = SubtaskIdSchema.parse("st_s2b2_hardening_sibling");
const OTHER_BIG_TASK = "bt_s2b2_hardening_other";
const OTHER_SUBTASK = SubtaskIdSchema.parse("st_s2b2_hardening_other");
const FOREIGN_PROJECT = "prj_s2b2_hardening_foreign";
const FOREIGN_BIG_TASK = "bt_s2b2_hardening_foreign";
const FOREIGN_SUBTASK = SubtaskIdSchema.parse("st_s2b2_hardening_foreign");

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

const KINDS = [
  "DECISION",
  "REQUIREMENT",
  "CONSTRAINT",
  "ENGINEERING_FACT",
  "OPEN_QUESTION",
  "RISK",
] as const satisfies readonly ContextKind[];

const AUTHORITIES = [
  "HUMAN",
  "REPO_EVIDENCE",
  "CODEX_CANDIDATE",
  "SYSTEM",
] as const satisfies readonly ContextAuthority[];

const SOURCE_TYPES = [
  "CHAT_MESSAGE",
  "REPO",
  "HANDOFF",
  "IMPORT",
  "MANUAL",
  "SYSTEM",
] as const satisfies readonly ContextSourceType[];

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
  ContextScopeSchema.parse({ scopeType: "SUBTASK", projectId, bigTaskId, subtaskId });

const allowedScopes = (): readonly ContextScope[] => [
  projectScope(),
  bigTaskScope(),
  subtaskScope(),
];

const seedTopology = (storage: TaskStorage): void => {
  storage.createProject(makeProject(TARGET_PROJECT, "s2b2-hardening"));
  storage.createBigTask(makeBigTask(TARGET_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(TARGET_SUBTASK, TARGET_BIG_TASK));
  storage.createSubtask(makeSubtask(SIBLING_SUBTASK, TARGET_BIG_TASK));
  storage.createBigTask(makeBigTask(OTHER_BIG_TASK, TARGET_PROJECT));
  storage.createSubtask(makeSubtask(OTHER_SUBTASK, OTHER_BIG_TASK));

  storage.createProject(makeProject(FOREIGN_PROJECT, "s2b2-hardening-foreign"));
  storage.createBigTask(makeBigTask(FOREIGN_BIG_TASK, FOREIGN_PROJECT));
  storage.createSubtask(makeSubtask(FOREIGN_SUBTASK, FOREIGN_BIG_TASK));
};

const readRaw = (
  storage: TaskStorage,
  subtaskId: SubtaskId = TARGET_SUBTASK,
): AllowedRawContextItemSnapshot =>
  storage.readAllowedRawContextItemsForSubtask(subtaskId);

const readActive = (
  storage: TaskStorage,
  subtaskId: SubtaskId = TARGET_SUBTASK,
): ActiveContextItemSnapshot =>
  storage.readActiveContextItemsForSubtask(subtaskId);

const itemIds = (
  snapshot: ActiveContextItemSnapshot | AllowedRawContextItemSnapshot,
): readonly (readonly string[])[] =>
  snapshot.buckets.map(({ contextItems }) => contextItems.map(({ id }) => id));

const activeProjection = (raw: AllowedRawContextItemSnapshot) => {
  const [projectBucket, bigTaskBucket, subtaskBucket] = raw.buckets;
  return {
    allowedContextSet: raw.allowedContextSet,
    buckets: [projectBucket, bigTaskBucket, subtaskBucket].map(({ scope, contextItems }) => ({
      scope,
      contextItems: contextItems.filter(({ status }) => status === "ACTIVE"),
    })),
  };
};

const expectSanitized = (error: TaskStorageError): void => {
  expect(error.message).not.toMatch(
    /SQLite|\bSQL\b|context_items|project_id|big_task_id|subtask_id|supersedes_context_item_id|constraint|\/Users\/|\/private\/|Zod|parser|stack|private malformed/i,
  );
};

const expectMalformed = (operation: () => unknown): TaskStorageError => {
  const error = captureTaskStorageError(operation);
  expect(error).toMatchObject({
    code: "MALFORMED_STORED_DATA",
    message: "Stored task data is malformed.",
  });
  expectSanitized(error);
  return error;
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

const variedItem = (
  id: string,
  scope: ContextScope,
  status: ContextStatus,
  variation: number,
  effectiveAt: string,
): ContextItem => {
  const base = makeContextItem(id, scope, {
    status,
    effectiveAt,
    title: `Varied title ${variation}`,
    body: `Varied body ${variation}.`,
  });
  return ContextItemSchema.parse({
    ...base,
    kind: KINDS[variation % KINDS.length],
    authority: AUTHORITIES[variation % AUTHORITIES.length],
    provenance: {
      ...base.provenance,
      sourceType: SOURCE_TYPES[variation % SOURCE_TYPES.length],
      sourceReference: `source-${variation}#evidence`,
    },
  });
};

const createChain = (
  storage: TaskStorage,
  scope: ContextScope,
  prefix: string,
  length: number,
): readonly ContextItem[] => {
  const chain: ContextItem[] = [];
  let current = makeContextItem(`${prefix}_0`, scope);
  storage.createContextItem(current);
  chain.push(current);
  for (let index = 1; index < length; index += 1) {
    current = makeContextItem(`${prefix}_${index}`, scope, {
      effectiveAt: `2026-08-12T00:${index.toString().padStart(2, "0")}:00.000Z`,
      supersedesContextItemId: current.id,
    });
    storage.supersedeContextItem(current);
    chain.push(current);
  }
  return chain;
};

describe("S2B2 hardening raw-to-active oracle and semantic neutrality", () => {
  it("matches an independent ACTIVE projection across 24 fresh deterministic topologies", () => {
    for (let caseIndex = 0; caseIndex < 24; caseIndex += 1) {
      withMemoryStorage((storage) => {
        seedTopology(storage);
        allowedScopes().forEach((scope, scopeIndex) => {
          const itemCount = 3 + ((caseIndex + scopeIndex) % 5);
          const items = Array.from({ length: itemCount }, (_, itemIndex) => {
            const variation = caseIndex * 31 + scopeIndex * 7 + itemIndex;
            const status = STATUSES[(caseIndex * 3 + scopeIndex * 2 + itemIndex) % STATUSES.length]!;
            return variedItem(
              `ctx_meta_${caseIndex}_${scopeIndex}_${itemIndex}`,
              scope,
              status,
              variation,
              `2026-08-${(10 + ((variation * 3) % 4)).toString().padStart(2, "0")}T${(variation % 24).toString().padStart(2, "0")}:${((variation * 7) % 60).toString().padStart(2, "0")}:00.000Z`,
            );
          });
          items.reverse().forEach((item) => storage.createContextItem(item));
        });

        const raw = readRaw(storage);
        const active = readActive(storage);
        const expected = activeProjection(raw);
        expect(active).toEqual(expected);
        expect(active.allowedContextSet).toEqual(raw.allowedContextSet);
        expect(active.buckets).toHaveLength(3);
        expect(active.buckets.map(({ scope }) => scope)).toEqual(
          raw.buckets.map(({ scope }) => scope),
        );
        active.buckets.forEach(({ contextItems }) => {
          expect(contextItems.every(({ status }) => status === "ACTIVE")).toBe(true);
        });
      });
    }
  });

  it("covers all five statuses several times at every allowed scope and preserves all ACTIVE positions", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      const statusOrders = [
        ["ACTIVE", "PROPOSED", "SUPERSEDED", "REJECTED", "RESOLVED"],
        ["PROPOSED", "SUPERSEDED", "ACTIVE", "REJECTED", "RESOLVED"],
        ["PROPOSED", "SUPERSEDED", "REJECTED", "RESOLVED", "ACTIVE"],
      ] as const satisfies readonly (readonly ContextStatus[])[];

      allowedScopes().forEach((scope, scopeIndex) => {
        statusOrders[scopeIndex]!.forEach((status, orderIndex) => {
          for (let repetition = 0; repetition < 3; repetition += 1) {
            storage.createContextItem(
              makeContextItem(
                `ctx_cross_${scopeIndex}_${status.toLowerCase()}_${repetition}`,
                scope,
                {
                  status,
                  effectiveAt: `2026-08-12T${(orderIndex * 3 + repetition).toString().padStart(2, "0")}:00:00.000Z`,
                },
              ),
            );
          }
        });
      });

      const raw = readRaw(storage);
      const active = readActive(storage);
      raw.buckets.forEach(({ contextItems }) => {
        expect(contextItems).toHaveLength(15);
        for (const status of STATUSES) {
          expect(contextItems.filter((item) => item.status === status)).toHaveLength(3);
        }
      });
      active.buckets.forEach(({ contextItems }) => {
        expect(contextItems).toHaveLength(3);
        expect(contextItems.every(({ status }) => status === "ACTIVE")).toBe(true);
      });
      expect(active).toEqual(activeProjection(raw));
    });
  });

  it("keeps every contradictory ACTIVE item and ignores non-ordering semantic mutations", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const items = Array.from({ length: 12 }, (_, index) =>
        variedItem(
          `ctx_neutral_${index.toString().padStart(2, "0")}`,
          bigTaskScope(),
          "ACTIVE",
          index,
          `2026-08-12T${Math.floor(index / 3).toString().padStart(2, "0")}:00:00.000Z`,
        ),
      );
      const contradictory = [
        ContextItemSchema.parse({ ...items[0], body: "Use approach A." }),
        ContextItemSchema.parse({ ...items[1], body: "Do not use approach A." }),
      ];
      [contradictory[0]!, contradictory[1]!, ...items.slice(2)].reverse().forEach((item) =>
        setup.createContextItem(item),
      );
      setup.createContextItem(
        makeContextItem("ctx_neutral_excluded", bigTaskScope(), {
          status: "RESOLVED",
          effectiveAt: "2026-08-11T23:59:00.000Z",
        }),
      );
      const before = itemIds(readActive(setup))[1]!;
      expect(before).toHaveLength(12);
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        const update = sqlite.prepare(`
          UPDATE context_items
          SET kind = ?, authority = ?, title = ?, body = ?, source_type = ?, source_reference = ?
          WHERE id = ?
        `);
        items.forEach((item, index) => {
          update.run(
            KINDS[(index + 3) % KINDS.length]!,
            AUTHORITIES[(index + 2) % AUTHORITIES.length]!,
            `Changed neutral title ${index}`,
            index % 2 === 0 ? "Contradiction remains A." : "Contradiction remains not A.",
            SOURCE_TYPES[(index + 4) % SOURCE_TYPES.length]!,
            `changed-source-${index}#neutral`,
            item.id,
          );
        });
      } finally {
        sqlite.close();
      }

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(readActive(reopened))[1]).toEqual(before);
        expect(readActive(reopened).buckets[1].contextItems).toHaveLength(12);
      } finally {
        reopened.close();
      }
    });
  });

  it("preserves raw ordering when Unicode IDs and non-ACTIVE rows are interleaved", () => {
    withMemoryStorage((storage) => {
      seedTopology(storage);
      [
        makeContextItem("ctx_order_中", subtaskScope()),
        makeContextItem("ctx_order_Ω", subtaskScope(), { status: "REJECTED" }),
        makeContextItem("ctx_order_ß", subtaskScope()),
        makeContextItem("ctx_order_a", subtaskScope(), { status: "PROPOSED" }),
        makeContextItem("ctx_order_α", subtaskScope()),
      ].reverse().forEach((item) => storage.createContextItem(item));

      const raw = readRaw(storage);
      const active = readActive(storage);
      expect(itemIds(active)[2]).toEqual(
        raw.buckets[2].contextItems
          .filter(({ status }) => status === "ACTIVE")
          .map(({ id }) => id),
      );
      expect(active).toEqual(activeProjection(raw));
    });
  });
});

const ROW_CORRUPTION_CASES = [
  [0, "PROPOSED", "id", (item: ContextItem) => `\u00a0${item.id}\u00a0`],
  [0, "SUPERSEDED", "body", (item: ContextItem) => `\u2002${item.body}\u2009`],
  [0, "REJECTED", "source_reference", (item: ContextItem) => `\u205f${item.provenance.sourceReference}`],
  [0, "RESOLVED", "effective_at", () => "2026-08-12T00:00:00+00:00"],
  [1, "PROPOSED", "kind", () => "DIRECTIVE"],
  [1, "SUPERSEDED", "authority", () => "MAINTAINER"],
  [1, "REJECTED", "source_type", () => "PRIVATE_NOTE"],
  [1, "RESOLVED", "status", () => "CURRENT"],
  [2, "PROPOSED", "title", (item: ContextItem) => `${item.title}\u3000`],
  [2, "SUPERSEDED", "created_at", () => "2026-08-12T08:00:00+08:00"],
  [2, "REJECTED", "updated_at", () => "invalid-updated-time"],
  [2, "RESOLVED", "supersedes_context_item_id", () => "ctx_missing_hardening_predecessor"],
] as const satisfies readonly (readonly [
  0 | 1 | 2,
  ContextStatus,
  string,
  (item: ContextItem) => string,
])[];

describe("S2B2 hardening validation before filtering", () => {
  it.each(ROW_CORRUPTION_CASES)(
    "fails raw and active closed for %s/%s malformed non-ACTIVE evidence in %s",
    (scopeIndex, status, column, replacement) => {
      withTemporaryDatabasePath((databasePath) => {
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTopology(setup);
        const item = makeContextItem(
          `ctx_row_corrupt_${scopeIndex}_${status.toLowerCase()}`,
          allowedScopes()[scopeIndex]!,
          { status },
        );
        setup.createContextItem(item);
        setup.close();
        mutate(
          databasePath,
          `UPDATE context_items SET ${column} = ? WHERE id = ?`,
          replacement(item),
          item.id,
        );

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectMalformed(() => readRaw(storage));
          expectMalformed(() => readActive(storage));
        } finally {
          storage.close();
        }
      });
    },
  );

  const aliasCases = [
    [0, "PROPOSED", "project_id", TARGET_PROJECT, `\t\u00a0${TARGET_PROJECT}\u2003\r\n`],
    [1, "SUPERSEDED", "big_task_id", TARGET_BIG_TASK, `\ufeff\u1680${TARGET_BIG_TASK}\u2029`],
    [2, "RESOLVED", "subtask_id", TARGET_SUBTASK, `\u2007${TARGET_SUBTASK}\u205f\u3000`],
  ] as const;

  it.each(aliasCases)(
    "fails closed for mixed-whitespace non-ACTIVE target alias %s/%s",
    (scopeIndex, status, column, target, alias) => {
      withTemporaryDatabasePath((databasePath) => {
        expect(alias.trim()).toBe(target);
        const setup = openTaskDatabase({ databasePath, clock: fixedClock });
        seedTopology(setup);
        const item = makeContextItem(
          `ctx_mixed_alias_${scopeIndex}`,
          allowedScopes()[scopeIndex]!,
          { status },
        );
        setup.createContextItem(item);
        setup.close();
        mutate(
          databasePath,
          `UPDATE context_items SET ${column} = ? WHERE id = ?`,
          alias,
          item.id,
        );

        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectMalformed(() => readRaw(storage));
          expectMalformed(() => readActive(storage));
        } finally {
          storage.close();
        }
      });
    },
  );

  it("treats U+200B and interior whitespace as non-equivalent isolated controls", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const allowed = makeContextItem("ctx_alias_control_allowed", projectScope());
      setup.createContextItem(allowed);
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        sqlite.exec("PRAGMA foreign_keys = OFF");
        insertRawContextItem(
          sqlite,
          makeContextItem("ctx_alias_control_zwsp", projectScope(), { status: "REJECTED" }),
          { projectId: `${TARGET_PROJECT}\u200b` },
        );
        insertRawContextItem(
          sqlite,
          makeContextItem("ctx_alias_control_interior", projectScope(), { status: "RESOLVED" }),
          { projectId: "prj_s2b2 hardening" },
        );
      } finally {
        sqlite.close();
      }

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(readRaw(storage))).toEqual([[allowed.id], [], []]);
        expect(itemIds(readActive(storage))).toEqual([[allowed.id], [], []]);
      } finally {
        storage.close();
      }
    });
  });

  const historyCases = [
    "missing node",
    "branch",
    "cycle",
    "cross-scope successor",
    "aliased successor",
    "aliased second successor",
    "malformed predecessor",
  ] as const;

  it.each(historyCases)("validates %s history before ACTIVE filtering", (historyCase) => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const chain = createChain(
        setup,
        projectScope(),
        `ctx_history_hard_${historyCase.replaceAll(" ", "_")}`,
        historyCase === "aliased second successor" ? 3 : 2,
      );
      const foreign = makeContextItem(
        `ctx_history_hard_foreign_${historyCase.replaceAll(" ", "_")}`,
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
      );
      setup.createContextItem(foreign);
      setup.close();

      const [root, tip, third] = chain;
      switch (historyCase) {
        case "missing node":
          mutate(databasePath, "DELETE FROM context_items WHERE id = ?", root!.id);
          break;
        case "branch": {
          const sqlite = new DatabaseSync(databasePath);
          try {
            sqlite.exec("PRAGMA foreign_keys = OFF; DROP INDEX context_items_supersedes_unique");
            sqlite
              .prepare(`
                INSERT INTO context_items
                SELECT ?, project_id, big_task_id, subtask_id, kind, status, authority,
                       title, body, source_type, source_reference, effective_at,
                       supersedes_context_item_id, created_at, updated_at
                FROM context_items WHERE id = ?
              `)
              .run(`${tip!.id}_branch`, tip!.id);
          } finally {
            sqlite.close();
          }
          break;
        }
        case "cycle":
          mutate(
            databasePath,
            "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            tip!.id,
            root!.id,
          );
          mutate(
            databasePath,
            "UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?",
            tip!.id,
          );
          break;
        case "cross-scope successor":
          mutate(databasePath, "DELETE FROM context_items WHERE id = ?", tip!.id);
          mutate(
            databasePath,
            "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            root!.id,
            foreign.id,
          );
          break;
        case "aliased successor":
          mutate(databasePath, "DELETE FROM context_items WHERE id = ?", tip!.id);
          mutate(
            databasePath,
            "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            `\u2003${root!.id}\ufeff`,
            foreign.id,
          );
          break;
        case "aliased second successor":
          mutate(
            databasePath,
            "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            `\u00a0${tip!.id}\u00a0`,
            third!.id,
          );
          break;
        case "malformed predecessor":
          mutate(
            databasePath,
            "UPDATE context_items SET source_reference = ? WHERE id = ?",
            `\u202f${root!.provenance.sourceReference}`,
            root!.id,
          );
          break;
      }

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => readRaw(storage));
        expectMalformed(() => readActive(storage));
      } finally {
        storage.close();
      }
    });
  });

  it("isolates an unrelated malformed non-ACTIVE history chain", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const allowed = makeContextItem("ctx_history_isolated_allowed", subtaskScope());
      setup.createContextItem(allowed);
      const siblingChain = createChain(
        setup,
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
        "ctx_history_isolated_sibling",
        3,
      );
      setup.close();
      mutate(
        databasePath,
        "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
        siblingChain[2]!.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(readRaw(storage))).toEqual([[], [], [allowed.id]]);
        expect(itemIds(readActive(storage))).toEqual([[], [], [allowed.id]]);
        expectMalformed(() => readActive(storage, SIBLING_SUBTASK));
      } finally {
        storage.close();
      }
    });
  });
});

describe("S2B2 hardening scope, snapshot, transaction, and read-only invariants", () => {
  it("keeps the exact three scopes despite sibling, foreign, other-Big-Task, and dependency context", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const included = allowedScopes().map((scope, index) =>
        makeContextItem(`ctx_scope_hard_included_${index}`, scope),
      );
      const excluded = [
        makeContextItem(
          "ctx_scope_hard_sibling",
          subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
        ),
        makeContextItem(
          "ctx_scope_hard_other_big",
          bigTaskScope(TARGET_PROJECT, OTHER_BIG_TASK),
        ),
        makeContextItem(
          "ctx_scope_hard_other_subtask",
          subtaskScope(TARGET_PROJECT, OTHER_BIG_TASK, OTHER_SUBTASK),
        ),
        makeContextItem("ctx_scope_hard_foreign_project", projectScope(FOREIGN_PROJECT)),
        makeContextItem(
          "ctx_scope_hard_foreign_big",
          bigTaskScope(FOREIGN_PROJECT, FOREIGN_BIG_TASK),
        ),
        makeContextItem(
          "ctx_scope_hard_foreign_subtask",
          subtaskScope(FOREIGN_PROJECT, FOREIGN_BIG_TASK, FOREIGN_SUBTASK),
        ),
      ];
      [...included, ...excluded].forEach((item) => setup.createContextItem(item));
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        sqlite.prepare(`
          INSERT INTO task_dependencies (
            upstream_subtask_id, downstream_subtask_id, dependency_type,
            required_gate, reason, created_at
          ) VALUES (?, ?, 'BLOCKING', 'ACCEPTED', 'Cross-Big-Task hardening control.', ?)
        `).run(OTHER_SUBTASK, TARGET_SUBTASK, FIXED_TIME);
      } finally {
        sqlite.close();
      }

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const snapshot = readActive(storage);
        expect(snapshot.buckets.map(({ scope }) => scope.scopeType)).toEqual([
          "PROJECT",
          "BIG_TASK",
          "SUBTASK",
        ]);
        expect(itemIds(snapshot)).toEqual([
          [included[0]!.id],
          [included[1]!.id],
          [included[2]!.id],
        ]);
        expect(snapshot.buckets.flatMap(({ contextItems }) => contextItems)).not.toEqual(
          expect.arrayContaining(excluded),
        );
      } finally {
        storage.close();
      }
    });
  });

  it("maps an all-three-scope status commit to complete OLD then complete NEW active views", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const oldItems = allowedScopes().map((scope, index) =>
        makeContextItem(`ctx_snapshot_a_old_${index}`, scope),
      );
      const newItems = allowedScopes().map((scope, index) =>
        makeContextItem(`ctx_snapshot_a_new_${index}`, scope, { status: "PROPOSED" }),
      );
      [...oldItems, ...newItems].forEach((item) => setup.createContextItem(item));
      setup.close();

      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare("UPDATE context_items SET status = 'RESOLVED' WHERE id IN (?, ?, ?)")
        .run(...oldItems.map(({ id }) => id));
      writer
        .prepare("UPDATE context_items SET status = 'ACTIVE' WHERE id IN (?, ?, ?)")
        .run(...newItems.map(({ id }) => id));

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
        expect(itemIds(oldSnapshot)).toEqual(oldItems.map(({ id }) => [id]));
        expect(itemIds(readActive(reader))).toEqual(newItems.map(({ id }) => [id]));
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("maps status, insertion, and supersession changes to one committed raw state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const oldProject = makeContextItem("ctx_snapshot_b_old_project", projectScope());
      const newProject = makeContextItem("ctx_snapshot_b_new_project", projectScope(), {
        status: "PROPOSED",
      });
      const existingBig = makeContextItem("ctx_snapshot_b_existing_big", bigTaskScope());
      const root = makeContextItem("ctx_snapshot_b_root", subtaskScope());
      [oldProject, newProject, existingBig, root].forEach((item) =>
        setup.createContextItem(item),
      );
      setup.close();

      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const insertedBig = makeContextItem("ctx_snapshot_b_inserted_big", bigTaskScope(), {
        effectiveAt: "2026-08-13T01:00:00.000Z",
      });
      const tip = makeContextItem("ctx_snapshot_b_tip", subtaskScope(), {
        effectiveAt: "2026-08-13T02:00:00.000Z",
        supersedesContextItemId: root.id,
      });
      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare("UPDATE context_items SET status = 'RESOLVED' WHERE id = ?")
        .run(oldProject.id);
      writer
        .prepare("UPDATE context_items SET status = 'ACTIVE' WHERE id = ?")
        .run(newProject.id);
      insertRawContextItem(writer, insertedBig);
      writer
        .prepare("UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?")
        .run(root.id);
      insertRawContextItem(writer, tip);

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
        expect(itemIds(oldSnapshot)).toEqual([
          [oldProject.id],
          [existingBig.id],
          [root.id],
        ]);
        expect(itemIds(readActive(reader))).toEqual([
          [newProject.id],
          [existingBig.id, insertedBig.id],
          [tip.id],
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

  it("sees NEW when commit precedes snapshot establishment", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const oldItem = makeContextItem("ctx_snapshot_c_old", projectScope());
      const newItem = makeContextItem("ctx_snapshot_c_new", projectScope(), {
        status: "PROPOSED",
      });
      setup.createContextItem(oldItem);
      setup.createContextItem(newItem);
      setup.close();

      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare("UPDATE context_items SET status = 'RESOLVED' WHERE id = ?")
        .run(oldItem.id);
      writer
        .prepare("UPDATE context_items SET status = 'ACTIVE' WHERE id = ?")
        .run(newItem.id);
      writer.exec("COMMIT");
      writer.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(readActive(reader))).toEqual([[newItem.id], [], []]);
      } finally {
        reader.close();
      }
    });
  });

  it("keeps caller ownership after a caught failure and leaves the connection usable", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const corrupt = makeContextItem("ctx_transaction_corrupt", projectScope(), {
        status: "REJECTED",
      });
      setup.createContextItem(corrupt);
      setup.close();
      mutate(
        databasePath,
        "UPDATE context_items SET body = ? WHERE id = ?",
        ` ${corrupt.body} `,
        corrupt.id,
      );

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const beforeFailure = makeContextItem(
        "ctx_transaction_before_failure",
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
      );
      const afterFailure = makeContextItem(
        "ctx_transaction_after_failure",
        subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
      );
      try {
        storage.runInTransaction((transaction) => {
          transaction.createContextItem(beforeFailure);
          expectMalformed(() => readActive(transaction));
          expect(
            transaction.getProjectById(
              makeProject(TARGET_PROJECT, "s2b2-hardening").id,
            ),
          ).not.toBeNull();
          transaction.createContextItem(afterFailure);
        });
        expect(storage.getContextItemById(beforeFailure.id)).toEqual(beforeFailure);
        expect(storage.getContextItemById(afterFailure.id)).toEqual(afterFailure);

        const rolledBack = makeContextItem(
          "ctx_transaction_later_rollback",
          subtaskScope(TARGET_PROJECT, TARGET_BIG_TASK, SIBLING_SUBTASK),
        );
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

  it("leaves every application table byte-for-byte unchanged across all read paths", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      const active = makeContextItem("ctx_read_only_hard_active", projectScope());
      const excluded = makeContextItem("ctx_read_only_hard_excluded", bigTaskScope(), {
        status: "RESOLVED",
      });
      setup.createContextItem(active);
      setup.createContextItem(excluded);
      setup.close();
      const cleanBefore = applicationRows(databasePath);

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      readActive(storage);
      readActive(storage);
      readActive(storage, SIBLING_SUBTASK);
      storage.runInTransaction((transaction) => {
        readActive(transaction);
      });
      storage.close();
      expect(applicationRows(databasePath)).toBe(cleanBefore);

      const unrelated = makeContextItem(
        "ctx_read_only_hard_foreign",
        projectScope(FOREIGN_PROJECT),
        { status: "PROPOSED" },
      );
      const writer = openTaskDatabase({ databasePath, clock: fixedClock });
      writer.createContextItem(unrelated);
      writer.close();
      mutate(
        databasePath,
        "UPDATE context_items SET title = ? WHERE id = ?",
        ` ${unrelated.title} `,
        unrelated.id,
      );
      const corruptedBefore = applicationRows(databasePath);
      const isolated = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(itemIds(readActive(isolated))).toEqual([[active.id], [], []]);
        expectMalformed(() => readActive(isolated, FOREIGN_SUBTASK));
      } finally {
        isolated.close();
      }
      expect(applicationRows(databasePath)).toBe(corruptedBefore);
    });
  });
});

describe("S2B2 hardening scale and S2B1 preservation", () => {
  it("projects 37 ACTIVE rows from 1,540 allowed rows and excludes 3,509 other rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      seedTopology(setup);
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("BEGIN");
      const insert = sqlite.prepare(`
        INSERT INTO context_items (
          id, project_id, big_task_id, subtask_id, kind, status, authority,
          title, body, source_type, source_reference, effective_at,
          supersedes_context_item_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ENGINEERING_FACT', ?, 'REPO_EVIDENCE',
          'Scale hardening title', 'Scale hardening body.', 'REPO',
          'scale-hardening#evidence', ?, NULL, ?, ?)
      `);
      const expectedActiveIds: string[] = [];
      try {
        for (let index = 0; index < 1_503; index += 1) {
          const scopeIndex = index % 3;
          const scope = allowedScopes()[scopeIndex]!;
          insert.run(
            `ctx_scale_nonactive_${index.toString().padStart(4, "0")}`,
            scope.projectId,
            scope.scopeType === "PROJECT" ? null : scope.bigTaskId,
            scope.scopeType === "SUBTASK" ? scope.subtaskId : null,
            NON_ACTIVE_STATUSES[index % NON_ACTIVE_STATUSES.length]!,
            "2026-08-13T00:00:00.000Z",
            FIXED_TIME,
            FIXED_TIME,
          );
        }
        for (let index = 0; index < 37; index += 1) {
          const scope = allowedScopes()[index % 3]!;
          const id = `ctx_scale_active_${index.toString().padStart(3, "0")}`;
          expectedActiveIds.push(id);
          insert.run(
            id,
            scope.projectId,
            scope.scopeType === "PROJECT" ? null : scope.bigTaskId,
            scope.scopeType === "SUBTASK" ? scope.subtaskId : null,
            "ACTIVE",
            "2026-08-13T01:00:00.000Z",
            FIXED_TIME,
            FIXED_TIME,
          );
        }
        for (let index = 0; index < 3_509; index += 1) {
          const placement = index % 3;
          insert.run(
            `ctx_scale_excluded_${index.toString().padStart(4, "0")}`,
            placement === 2 ? FOREIGN_PROJECT : TARGET_PROJECT,
            placement === 0 ? TARGET_BIG_TASK : placement === 1 ? OTHER_BIG_TASK : null,
            placement === 0 ? SIBLING_SUBTASK : null,
            "ACTIVE",
            "2026-08-13T02:00:00.000Z",
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

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const raw = readRaw(storage);
        const active = readActive(storage);
        expect(raw.buckets.flatMap(({ contextItems }) => contextItems)).toHaveLength(1_540);
        expect(active.buckets.flatMap(({ contextItems }) => contextItems)).toHaveLength(37);
        expect(active).toEqual(activeProjection(raw));
        const returned = active.buckets.flatMap(({ contextItems }) =>
          contextItems.map(({ id }) => id),
        );
        expect(new Set(returned)).toEqual(new Set(expectedActiveIds));
        expect(returned.some((id) => id.startsWith("ctx_scale_excluded_"))).toBe(false);
      } finally {
        storage.close();
      }
    });
  });
});

const corruptedItemError = (
  status: ContextStatus,
  column: string,
  replacement: string,
): TaskStorageError =>
  withTemporaryDatabasePath((databasePath) => {
    const setup = openTaskDatabase({ databasePath, clock: fixedClock });
    seedTopology(setup);
    const item = makeContextItem("ctx_sanitization_item", projectScope(), { status });
    setup.createContextItem(item);
    setup.close();
    mutate(
      databasePath,
      `UPDATE context_items SET ${column} = ? WHERE id = ?`,
      replacement,
      item.id,
    );
    const storage = openTaskDatabase({ databasePath, clock: fixedClock });
    try {
      return captureTaskStorageError(() => readActive(storage));
    } finally {
      storage.close();
    }
  });

const hierarchyError = (
  sql: string,
  replacement: string,
  id: string,
): TaskStorageError =>
  withTemporaryDatabasePath((databasePath) => {
    const setup = openTaskDatabase({ databasePath, clock: fixedClock });
    seedTopology(setup);
    setup.close();
    mutate(databasePath, sql, replacement, id);
    const storage = openTaskDatabase({ databasePath, clock: fixedClock });
    try {
      return captureTaskStorageError(() => readActive(storage));
    } finally {
      storage.close();
    }
  });

const aliasError = (
  scopeIndex: 0 | 1 | 2,
  column: string,
  alias: string,
): TaskStorageError =>
  withTemporaryDatabasePath((databasePath) => {
    const setup = openTaskDatabase({ databasePath, clock: fixedClock });
    seedTopology(setup);
    const item = makeContextItem(
      `ctx_sanitization_alias_${scopeIndex}`,
      allowedScopes()[scopeIndex]!,
      { status: NON_ACTIVE_STATUSES[scopeIndex]! },
    );
    setup.createContextItem(item);
    setup.close();
    mutate(
      databasePath,
      `UPDATE context_items SET ${column} = ? WHERE id = ?`,
      alias,
      item.id,
    );
    const storage = openTaskDatabase({ databasePath, clock: fixedClock });
    try {
      return captureTaskStorageError(() => readActive(storage));
    } finally {
      storage.close();
    }
  });

const linkedHistoryError = (
  mode: "MISSING" | "TERMINAL" | "CYCLE",
): TaskStorageError =>
  withTemporaryDatabasePath((databasePath) => {
    const setup = openTaskDatabase({ databasePath, clock: fixedClock });
    seedTopology(setup);
    const [root, tip] = createChain(
      setup,
      subtaskScope(),
      `ctx_sanitization_history_${mode.toLowerCase()}`,
      2,
    );
    setup.close();
    if (mode === "MISSING") {
      mutate(databasePath, "DELETE FROM context_items WHERE id = ?", root!.id);
    } else if (mode === "TERMINAL") {
      mutate(
        databasePath,
        "UPDATE context_items SET status = 'REJECTED' WHERE id = ?",
        tip!.id,
      );
    } else {
      mutate(
        databasePath,
        "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
        tip!.id,
        root!.id,
      );
      mutate(
        databasePath,
        "UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?",
        tip!.id,
      );
    }
    const storage = openTaskDatabase({ databasePath, clock: fixedClock });
    try {
      return captureTaskStorageError(() => readActive(storage));
    } finally {
      storage.close();
    }
  });

const MUTATION_REVIEW = [
  ["query ACTIVE rows before raw validation", "row corruption matrix + SQL trace", "FAIL_OPEN"],
  ["filter status before scope alias checks", "mixed alias matrix", "FAIL_OPEN"],
  ["filter status before history validation", "history matrix", "FAIL_OPEN"],
  ["include PROPOSED", "five-status cross-product", "FAIL_OPEN"],
  ["include SUPERSEDED", "five-status cross-product", "FAIL_OPEN"],
  ["include REJECTED", "five-status cross-product", "FAIL_OPEN"],
  ["include RESOLVED", "five-status cross-product", "FAIL_OPEN"],
  ["return first ACTIVE only", "twelve-ACTIVE semantic-neutrality test", "FAIL_OPEN"],
  ["return latest ACTIVE only", "effective-time variation", "FAIL_OPEN"],
  ["return highest authority only", "four-authority variation", "FAIL_OPEN"],
  ["return HUMAN authority only", "authority mutation control", "FAIL_OPEN"],
  ["prefer DECISION kind", "six-kind variation", "FAIL_OPEN"],
  ["prefer repository source", "six-source variation", "FAIL_OPEN"],
  ["collapse duplicate-looking text", "semantic mutation control", "FAIL_OPEN"],
  ["discard contradictory ACTIVE body", "explicit contradiction controls", "FAIL_OPEN"],
  ["omit Project bucket", "three-bucket assertions", "FAIL_OPEN"],
  ["omit Big Task bucket", "three-bucket assertions", "FAIL_OPEN"],
  ["omit Subtask bucket", "three-bucket assertions", "FAIL_OPEN"],
  ["remove empty buckets", "existing eight-way asymmetric matrix", "FAIL_OPEN"],
  ["leak sibling ACTIVE", "scope topology", "FAIL_OPEN"],
  ["leak other Big Task ACTIVE", "scope topology", "FAIL_OPEN"],
  ["leak foreign Project ACTIVE", "scope topology", "FAIL_OPEN"],
  ["leak dependency upstream ACTIVE", "dependency non-expansion", "FAIL_OPEN"],
  ["ignore malformed excluded ID", "row corruption matrix", "FAIL_OPEN"],
  ["ignore malformed excluded text", "row corruption matrix", "FAIL_OPEN"],
  ["ignore malformed excluded effectiveAt", "row corruption matrix", "FAIL_OPEN"],
  ["ignore malformed excluded enum", "row corruption matrix", "FAIL_OPEN"],
  ["ignore malformed excluded timestamps", "row corruption matrix", "FAIL_OPEN"],
  ["ignore missing predecessor", "history matrix", "FAIL_OPEN"],
  ["accept branching history", "history matrix", "FAIL_OPEN"],
  ["accept cyclic history", "history matrix", "FAIL_OPEN"],
  ["accept cross-scope successor", "history matrix", "FAIL_OPEN"],
  ["accept aliased successor", "history matrix", "FAIL_OPEN"],
  ["accept aliased second successor", "history matrix", "FAIL_OPEN"],
  ["normalize malformed predecessor", "history matrix", "FAIL_OPEN"],
  ["miss mixed target whitespace alias", "mixed alias matrix", "FAIL_OPEN"],
  ["globally poison on U+200B control", "non-equivalent isolation", "FAIL_OPEN"],
  ["globally poison on interior whitespace", "non-equivalent isolation", "FAIL_OPEN"],
  ["mutate S2B1 to ACTIVE-only", "raw-to-active oracle", "FAIL_OPEN"],
  ["return active result from two snapshots", "three-scope concurrency", "FAIL_OPEN"],
  ["read history outside the snapshot", "supersession concurrency", "FAIL_OPEN"],
  ["commit caller transaction", "outer transaction test", "FAIL_OPEN"],
  ["roll back caller after caught failure", "caught failure usability", "FAIL_OPEN"],
  ["reverse effectiveAt order", "raw relative-order oracle", "OTHER"],
  ["remove ID tie break", "Unicode and tied-time ordering", "OTHER"],
  ["post-filter re-sort by semantics", "semantic mutation order", "OTHER"],
  ["swap bucket order", "scope tuple assertions", "OTHER"],
  ["start a nested read transaction", "caller transaction reuse", "OTHER"],
  ["leave owned read transaction open", "subsequent writer/reader controls", "OTHER"],
  ["write status during read", "byte-for-byte table snapshot", "OTHER"],
  ["write updated_at during read", "byte-for-byte table snapshot", "OTHER"],
  ["append Audit Event during read", "byte-for-byte table snapshot", "OTHER"],
  ["materialize active cache", "repeated read table snapshot", "OTHER"],
  ["translate missing target to empty", "sanitization matrix", "OTHER"],
  ["leak raw SQLite diagnostic", "thirty-case sanitization", "OTHER"],
  ["leak filesystem path", "thirty-case sanitization", "OTHER"],
  ["leak malformed private value", "thirty-case sanitization", "OTHER"],
  ["change raw bucket ordering", "raw-to-active full equality", "OTHER"],
  ["materialize excluded scale rows in result", "3,509-row exclusion", "OTHER"],
  ["change public snapshot shapes", "full snapshot equality", "OTHER"],
] as const;

const SOURCE_TO_TEST_MAPPING = [
  ["canonical Subtask input", "invalid-input sanitization cases"],
  ["missing target classification", "four missing-target cases"],
  ["shared private raw helper", "source inspection + raw/active parity"],
  ["deferred snapshot entry", "three concurrency boundaries"],
  ["stored Subtask validation", "hierarchy sanitization"],
  ["stored Big Task validation", "hierarchy sanitization"],
  ["stored Project validation", "hierarchy sanitization"],
  ["S2A ACL establishment", "AllowedContextSet oracle equality"],
  ["Project exact scope", "scope topology"],
  ["Big Task exact scope", "scope topology"],
  ["Subtask exact scope", "scope topology"],
  ["dependency non-expansion", "cross-Big-Task dependency control"],
  ["Project alias predicate", "mixed whitespace alias"],
  ["Big Task alias predicate", "mixed whitespace alias"],
  ["Subtask alias predicate", "mixed whitespace alias"],
  ["alias non-equivalence", "U+200B and interior controls"],
  ["Context Item ID canonicality", "excluded-row corruption"],
  ["Context Item title canonicality", "excluded-row corruption"],
  ["Context Item body canonicality", "excluded-row corruption"],
  ["source reference canonicality", "excluded-row corruption"],
  ["effectiveAt canonicality", "excluded-row corruption"],
  ["status enum validation", "excluded-row corruption"],
  ["kind enum validation", "excluded-row corruption"],
  ["authority enum validation", "excluded-row corruption"],
  ["source type enum validation", "excluded-row corruption"],
  ["created_at canonicality", "excluded-row corruption"],
  ["updated_at canonicality", "excluded-row corruption"],
  ["predecessor lookup", "missing-node history"],
  ["successor uniqueness", "branch history"],
  ["cycle detection", "cycle history"],
  ["same-scope history", "cross-scope successor"],
  ["canonical successor pointer", "aliased successor cases"],
  ["predecessor parsing", "malformed predecessor"],
  ["terminal ACTIVE invariant", "linked terminal sanitization"],
  ["complete raw snapshot", "24-case metamorphic oracle"],
  ["ACTIVE status projection", "five-status cross-product"],
  ["all ACTIVE preservation", "twelve-item neutrality test"],
  ["semantic neutrality", "field mutations + contradictions"],
  ["effectiveAt ascending", "raw retained-order comparison"],
  ["ID ascending tie break", "Unicode tied-time comparison"],
  ["three-bucket preservation", "full snapshot equality"],
  ["empty-bucket preservation", "existing asymmetric matrix"],
  ["snapshot OLD mapping", "commit-after-establishment cases"],
  ["snapshot NEW mapping", "commit-before-establishment case"],
  ["caller transaction reuse", "caught failure and later writes"],
  ["caller rollback ownership", "uncaught failure rollback"],
  ["read transaction cleanup", "subsequent reads and writes"],
  ["read-only application rows", "byte-for-byte table snapshots"],
  ["Audit Event non-emission", "audit_events table snapshot"],
  ["S2B1 all-status preservation", "cross-product raw assertions"],
  ["S2B1 corruption preservation", "raw and active paired failures"],
  ["S2B1 isolation preservation", "unrelated history and aliases"],
  ["scale filtering correctness", "1,540 allowed / 3,509 excluded"],
  ["public error sanitization", "thirty failing cases"],
] as const;

describe("S2B2 hardening assurance manifests and error sanitization", () => {
  it("sanitizes at least thirty distinct active-read failures", () => {
    const errors: TaskStorageError[] = [];
    withMemoryStorage((storage) => {
      seedTopology(storage);
      for (const invalid of [
        "",
        " ",
        "st_",
        "wrong_prefix",
        "\u200bst_private",
        {} as unknown,
      ]) {
        errors.push(
          captureTaskStorageError(() =>
            readActive(storage, invalid as SubtaskId),
          ),
        );
      }
      for (const missing of [
        "st_missing_alpha",
        "st_missing_beta",
        "st_missing_gamma",
        "st_missing_delta",
      ]) {
        errors.push(
          captureTaskStorageError(() =>
            readActive(storage, SubtaskIdSchema.parse(missing)),
          ),
        );
      }
    });

    errors.push(
      hierarchyError(
        "UPDATE subtasks SET big_task_id = ? WHERE id = ?",
        ` ${TARGET_BIG_TASK} `,
        TARGET_SUBTASK,
      ),
      hierarchyError(
        "UPDATE big_tasks SET project_id = ? WHERE id = ?",
        `\u00a0${TARGET_PROJECT}\u00a0`,
        TARGET_BIG_TASK,
      ),
      hierarchyError(
        "UPDATE projects SET id = ? WHERE id = ?",
        `\ufeff${TARGET_PROJECT}`,
        TARGET_PROJECT,
      ),
    );

    for (const [column, replacement] of [
      ["id", " ctx_sanitization_item "],
      ["title", " malformed active title "],
      ["body", "\u2003malformed active body"],
      ["effective_at", "2026-08-13T00:00:00+00:00"],
      ["kind", "PRIVATE_FACT"],
    ] as const) {
      errors.push(corruptedItemError("ACTIVE", column, replacement));
    }

    const nonActiveFailures = [
      ["PROPOSED", "authority", "OWNER"],
      ["SUPERSEDED", "source_type", "TRANSCRIPT"],
      ["REJECTED", "source_reference", " padded private source "],
      ["RESOLVED", "created_at", "not-created-time"],
      ["PROPOSED", "updated_at", "2026-08-13T08:00:00+08:00"],
    ] as const satisfies readonly (readonly [ContextStatus, string, string])[];
    for (const [status, column, replacement] of nonActiveFailures) {
      errors.push(corruptedItemError(status, column, replacement));
    }

    errors.push(
      aliasError(0, "project_id", `\t${TARGET_PROJECT}\u3000`),
      aliasError(1, "big_task_id", `\u1680${TARGET_BIG_TASK}\ufeff`),
      aliasError(2, "subtask_id", `\u202f${TARGET_SUBTASK}\u205f`),
      linkedHistoryError("MISSING"),
      linkedHistoryError("TERMINAL"),
      linkedHistoryError("CYCLE"),
    );

    withMemoryStorage((storage) => {
      seedTopology(storage);
      const prototype = DatabaseSync.prototype as unknown as {
        exec: (sql: string) => void;
      };
      const originalExec = prototype.exec;
      let injected = false;
      prototype.exec = function (sql: string): void {
        if (!injected && sql === "BEGIN") {
          injected = true;
          throw new Error(
            "SQLITE_PRIVATE context_items /private/tmp/secret.sqlite private malformed value",
          );
        }
        Reflect.apply(originalExec, this, [sql]);
      };
      try {
        errors.push(captureTaskStorageError(() => readActive(storage)));
      } finally {
        prototype.exec = originalExec;
      }
    });

    expect(errors).toHaveLength(30);
    expect(errors.slice(0, 6).every(({ code }) => code === "INVALID_INPUT")).toBe(true);
    expect(errors.slice(6, 10).every(({ code }) => code === "PARENT_NOT_FOUND")).toBe(true);
    expect(errors.at(-1)?.code).toBe("TRANSACTION_FAILED");
    errors.forEach(expectSanitized);
  });

  it("maps at least fifty mutations including thirty fail-open or semantic-creep hypotheses", () => {
    expect(MUTATION_REVIEW).toHaveLength(60);
    expect(new Set(MUTATION_REVIEW.map(([mutation]) => mutation)).size).toBe(60);
    expect(MUTATION_REVIEW.filter(([, guard]) => guard.length === 0)).toEqual([]);
    expect(MUTATION_REVIEW.filter(([, , category]) => category === "FAIL_OPEN").length).toBeGreaterThanOrEqual(30);
  });

  it("maps at least thirty-five safety-critical source conditions without a gap", () => {
    expect(SOURCE_TO_TEST_MAPPING).toHaveLength(54);
    expect(new Set(SOURCE_TO_TEST_MAPPING.map(([condition]) => condition)).size).toBe(54);
    expect(SOURCE_TO_TEST_MAPPING.filter(([, evidence]) => evidence.length === 0)).toEqual([]);
  });
});
