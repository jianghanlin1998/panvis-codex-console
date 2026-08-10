import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ContextItemIdSchema,
  ContextScopeSchema,
} from "@codex-task-console/domain";
import type { ContextItem, ContextScope } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeContextItem,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

type ProjectScope = Extract<ContextScope, { scopeType: "PROJECT" }>;
type SubtaskScope = Extract<ContextScope, { scopeType: "SUBTASK" }>;

const projectScope = (suffix: string): ProjectScope =>
  ContextScopeSchema.parse({
    scopeType: "PROJECT",
    projectId: `prj_context_regression_${suffix}`,
  }) as ProjectScope;

const subtaskScope = (suffix: string): SubtaskScope =>
  ContextScopeSchema.parse({
    scopeType: "SUBTASK",
    projectId: `prj_context_regression_${suffix}`,
    bigTaskId: `bt_context_regression_${suffix}`,
    subtaskId: `st_context_regression_${suffix}`,
  }) as SubtaskScope;

const createHierarchy = (storage: TaskStorage, scope: ContextScope): void => {
  storage.createProject(
    makeProject(scope.projectId, scope.projectId.replaceAll("_", "-")),
  );
  if (scope.scopeType === "PROJECT") {
    return;
  }
  storage.createBigTask(makeBigTask(scope.bigTaskId, scope.projectId));
  if (scope.scopeType === "SUBTASK") {
    storage.createSubtask(makeSubtask(scope.subtaskId, scope.bigTaskId));
  }
};

const expectMalformed = (operation: () => unknown): void => {
  const error = captureTaskStorageError(operation);
  expect(error).toMatchObject({ code: "MALFORMED_STORED_DATA" });
  expect(error.message).not.toMatch(
    /SQLite|SQL|context_items|supersedes_context_item_id|\/Users\//i,
  );
};

const createTwoNodeChain = (
  storage: TaskStorage,
  prefix: string,
  scope: ContextScope,
): readonly [ContextItem, ContextItem] => {
  const root = makeContextItem(`${prefix}_root`, scope);
  storage.createContextItem(root);
  const tip = makeContextItem(`${prefix}_tip`, scope, {
    supersedesContextItemId: root.id,
  });
  storage.supersedeContextItem(tip);
  return [root, tip];
};

describe("S0B2a safety regression protection after shared-scope refactoring", () => {
  it("keeps F1 hierarchy mismatch closed with unrelated-scope isolation", () => {
    withTemporaryDatabasePath((databasePath) => {
      const corruptScope = subtaskScope("f1_a");
      const foreignScope = subtaskScope("f1_b");
      const validScope = projectScope("f1_valid");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage, corruptScope);
      createHierarchy(storage, foreignScope);
      createHierarchy(storage, validScope);
      const corrupt = makeContextItem("ctx_regression_f1_corrupt", corruptScope);
      const valid = makeContextItem("ctx_regression_f1_valid", validScope);
      storage.createContextItem(corrupt);
      storage.createContextItem(valid);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET subtask_id = ? WHERE id = ?")
        .run(foreignScope.subtaskId, corrupt.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => reopened.getContextItemById(corrupt.id));
        expect(reopened.getContextItemById(valid.id)).toEqual(valid);
        expect(reopened.listContextItemsByScope(validScope)).toEqual([valid]);
      } finally {
        reopened.close();
      }
    });
  });

  it.each([
    [
      "missing predecessor",
      (sqlite: DatabaseSync, root: ContextItem) => {
        sqlite.exec("PRAGMA foreign_keys = OFF");
        sqlite.prepare("DELETE FROM context_items WHERE id = ?").run(root.id);
      },
    ],
    [
      "status-invalid predecessor",
      (sqlite: DatabaseSync, root: ContextItem) => {
        sqlite
          .prepare("UPDATE context_items SET status = 'RESOLVED' WHERE id = ?")
          .run(root.id);
      },
    ],
    [
      "noncanonical predecessor evidence",
      (sqlite: DatabaseSync, root: ContextItem) => {
        sqlite
          .prepare("UPDATE context_items SET source_reference = ? WHERE id = ?")
          .run(" padded predecessor ", root.id);
      },
    ],
  ] as const)("keeps F2 closed for %s history", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope(`f2_${_label.replaceAll(" ", "_")}`);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage, scope);
      const [root, tip] = createTwoNodeChain(storage, `ctx_regression_${scope.projectId}`, scope);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      corrupt(sqlite, root);
      sqlite.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectMalformed(() => reopened.getContextItemById(tip.id));
          expectMalformed(() => reopened.listContextItemsByScope(scope));
        } finally {
          reopened.close();
        }
      }
    });
  });

  it("keeps F2 cross-scope history closed", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scopeA = projectScope("f2_cross_a");
      const scopeB = projectScope("f2_cross_b");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage, scopeA);
      createHierarchy(storage, scopeB);
      const [, tip] = createTwoNodeChain(storage, "ctx_regression_cross", scopeA);
      const foreign = makeContextItem("ctx_regression_cross_foreign", scopeB, {
        status: "SUPERSEDED",
      });
      const unrelated = makeContextItem("ctx_regression_cross_unrelated", scopeB);
      storage.createContextItem(foreign);
      storage.createContextItem(unrelated);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare(
          "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
        )
        .run(foreign.id, tip.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => reopened.getContextItemById(tip.id));
        expectMalformed(() => reopened.listContextItemsByScope(scopeA));
        expect(reopened.getContextItemById(unrelated.id)).toEqual(unrelated);
      } finally {
        reopened.close();
      }
    });
  });

  it("keeps F2 cycle detection closed from both entry points", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope("f2_cycle");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage, scope);
      const a = makeContextItem("ctx_regression_cycle_a", scope, {
        status: "SUPERSEDED",
      });
      const b = makeContextItem("ctx_regression_cycle_b", scope, {
        status: "SUPERSEDED",
      });
      storage.createContextItem(a);
      storage.createContextItem(b);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      const pointer = sqlite.prepare(
        "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
      );
      pointer.run(b.id, a.id);
      pointer.run(a.id, b.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => reopened.getContextItemById(a.id));
        expectMalformed(() => reopened.getContextItemById(b.id));
        expectMalformed(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
    });
  });

  it("keeps F3 branch detection closed from predecessor and successor entry points", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("f3_branch");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage, scope);
      const [root, tip] = createTwoNodeChain(storage, "ctx_regression_branch", scope);
      storage.close();

      const branchId = ContextItemIdSchema.parse("ctx_regression_branch_sibling");
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("DROP INDEX context_items_supersedes_unique");
      sqlite
        .prepare(
          `INSERT INTO context_items
           SELECT ?, project_id, big_task_id, subtask_id, kind, status, authority,
                  title, body, source_type, source_reference, effective_at,
                  supersedes_context_item_id, created_at, updated_at
           FROM context_items WHERE id = ?`,
        )
        .run(branchId, tip.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        for (const id of [root.id, tip.id, branchId]) {
          expectMalformed(() => reopened.getContextItemById(id));
        }
        expectMalformed(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
    });
  });

  it("keeps the linked ACTIVE-tip invariant closed", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope("active_tip");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage, scope);
      const [root, tip] = createTwoNodeChain(storage, "ctx_regression_tip", scope);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET status = 'SUPERSEDED' WHERE id = ?")
        .run(tip.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => reopened.getContextItemById(root.id));
        expectMalformed(() => reopened.getContextItemById(tip.id));
        expectMalformed(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
    });
  });

  it("keeps canonical Context evidence validation closed", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("canonical");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage, scope);
      const item = makeContextItem("ctx_regression_canonical", scope, {
        body: "Canonical 证据 🚀",
      });
      storage.createContextItem(item);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare(
          "UPDATE context_items SET body = ?, created_at = ? WHERE id = ?",
        )
        .run(
          " padded evidence ",
          "2026-08-09T09:00:00.000+09:00",
          item.id,
        );
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformed(() => reopened.getContextItemById(item.id));
        expectMalformed(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
    });
  });
});
