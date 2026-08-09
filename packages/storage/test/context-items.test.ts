import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ContextScopeSchema } from "@codex-task-console/domain";
import type { ContextItem, ContextScope } from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeBigTask,
  makeContextItem,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const projectScope = (projectId = "prj_console"): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "PROJECT", projectId });

const bigTaskScope = (
  projectId = "prj_console",
  bigTaskId = "bt_v1",
): ContextScope => ContextScopeSchema.parse({ scopeType: "BIG_TASK", projectId, bigTaskId });

const subtaskScope = (
  projectId = "prj_console",
  bigTaskId = "bt_v1",
  subtaskId = "st_a",
): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "SUBTASK", projectId, bigTaskId, subtaskId });

const expectValidReadParity = (
  scope: ContextScope,
  setup: (storage: TaskStorage) => void,
): void => {
  const item = makeContextItem(`ctx_parity_${scope.scopeType.toLowerCase()}`, scope);
  let memoryResult: readonly ContextItem[] = [];
  withMemoryStorage((storage) => {
    setup(storage);
    storage.createContextItem(item);
    memoryResult = storage.listContextItemsByScope(scope);
  });

  withTemporaryDatabasePath((databasePath) => {
    const storage = openTaskDatabase({ databasePath, clock: fixedClock });
    setup(storage);
    storage.createContextItem(item);
    expect(storage.listContextItemsByScope(scope)).toEqual(memoryResult);
    storage.close();

    const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
    try {
      expect(reopened.listContextItemsByScope(scope)).toEqual(memoryResult);
    } finally {
      reopened.close();
    }
  });
};

describe("Context Item creation", () => {
  it("round-trips Project, Big Task, and Subtask scoped items", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const projectItem = makeContextItem("ctx_project", projectScope());
      const bigTaskItem = makeContextItem("ctx_big_task", bigTaskScope());
      const subtaskItem = makeContextItem("ctx_subtask", subtaskScope());

      for (const item of [projectItem, bigTaskItem, subtaskItem]) {
        expect(storage.createContextItem(item)).toEqual(item);
        expect(storage.getContextItemById(item.id)).toEqual(item);
      }
    });
  });

  it("rejects a missing Project", () => {
    withMemoryStorage((storage) => {
      const item = makeContextItem("ctx_missing_project", projectScope("prj_missing"));
      expect(captureTaskStorageError(() => storage.createContextItem(item))).toMatchObject({
        code: "PARENT_NOT_FOUND",
      });
      expect(storage.getContextItemById(item.id)).toBeNull();
    });
  });

  it("rejects a missing Big Task", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      const item = makeContextItem(
        "ctx_missing_big_task",
        bigTaskScope("prj_console", "bt_missing"),
      );
      expect(captureTaskStorageError(() => storage.createContextItem(item))).toMatchObject({
        code: "PARENT_NOT_FOUND",
      });
    });
  });

  it("rejects a missing Subtask", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      const item = makeContextItem(
        "ctx_missing_subtask",
        subtaskScope("prj_console", "bt_v1", "st_missing"),
      );
      expect(captureTaskStorageError(() => storage.createContextItem(item))).toMatchObject({
        code: "PARENT_NOT_FOUND",
      });
    });
  });

  it("rejects a Big Task under the wrong Project", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      const item = makeContextItem("ctx_wrong_project", bigTaskScope("prj_b", "bt_a"));

      expect(captureTaskStorageError(() => storage.createContextItem(item))).toMatchObject({
        code: "PARENT_NOT_FOUND",
      });
    });
  });

  it("rejects a Subtask under the wrong Big Task", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask("bt_a"));
      storage.createBigTask(makeBigTask("bt_b"));
      storage.createSubtask(makeSubtask("st_a", "bt_a"));
      const item = makeContextItem(
        "ctx_wrong_big_task",
        subtaskScope("prj_console", "bt_b", "st_a"),
      );

      expect(captureTaskStorageError(() => storage.createContextItem(item))).toMatchObject({
        code: "PARENT_NOT_FOUND",
      });
    });
  });

  it("rejects a valid Subtask hierarchy claimed under the wrong Project", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      storage.createSubtask(makeSubtask("st_a", "bt_a"));
      const item = makeContextItem(
        "ctx_wrong_subtask_project",
        subtaskScope("prj_b", "bt_a", "st_a"),
      );

      expect(captureTaskStorageError(() => storage.createContextItem(item))).toMatchObject({
        code: "PARENT_NOT_FOUND",
      });
    });
  });

  it("rejects malformed domain input before writing", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const valid = makeContextItem();
      const invalid = { ...valid, status: "CURRENT" } as unknown as ContextItem;
      expect(captureTaskStorageError(() => storage.createContextItem(invalid))).toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(storage.listContextItemsByScope(bigTaskScope())).toEqual([]);
    });
  });

  it("rejects direct creation with a supersession pointer", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });

      expect(
        captureTaskStorageError(() => storage.createContextItem(replacement)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it("does not mutate caller-owned Context Item input", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const provenance = Object.freeze({ ...makeContextItem().provenance });
      const input = Object.freeze({ ...makeContextItem("ctx_frozen"), provenance });
      const snapshot = JSON.stringify(input);

      storage.createContextItem(input);
      expect(JSON.stringify(input)).toBe(snapshot);
      expect(input.provenance).toBe(provenance);
    });
  });
});

describe("exact Context Scope retrieval", () => {
  it("prevents ancestor, descendant, Big Task, and sibling Subtask leakage", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask("bt_a"));
      storage.createBigTask(makeBigTask("bt_b"));
      storage.createSubtask(makeSubtask("st_a", "bt_a"));
      storage.createSubtask(makeSubtask("st_b", "bt_a"));
      storage.createSubtask(makeSubtask("st_other", "bt_b"));

      const items = [
        makeContextItem("ctx_project", projectScope()),
        makeContextItem("ctx_big_a", bigTaskScope("prj_console", "bt_a")),
        makeContextItem("ctx_big_b", bigTaskScope("prj_console", "bt_b")),
        makeContextItem("ctx_sub_a", subtaskScope("prj_console", "bt_a", "st_a")),
        makeContextItem("ctx_sub_b", subtaskScope("prj_console", "bt_a", "st_b")),
        makeContextItem(
          "ctx_sub_other",
          subtaskScope("prj_console", "bt_b", "st_other"),
        ),
      ];
      items.forEach((item) => storage.createContextItem(item));

      expect(storage.listContextItemsByScope(projectScope()).map(({ id }) => id)).toEqual([
        "ctx_project",
      ]);
      expect(
        storage
          .listContextItemsByScope(bigTaskScope("prj_console", "bt_a"))
          .map(({ id }) => id),
      ).toEqual(["ctx_big_a"]);
      expect(
        storage
          .listContextItemsByScope(bigTaskScope("prj_console", "bt_b"))
          .map(({ id }) => id),
      ).toEqual(["ctx_big_b"]);
      expect(
        storage
          .listContextItemsByScope(subtaskScope("prj_console", "bt_a", "st_a"))
          .map(({ id }) => id),
      ).toEqual(["ctx_sub_a"]);
      expect(
        storage
          .listContextItemsByScope(subtaskScope("prj_console", "bt_a", "st_b"))
          .map(({ id }) => id),
      ).toEqual(["ctx_sub_b"]);
    });
  });

  it("orders by effectiveAt and then Context Item ID", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const items = [
        makeContextItem("ctx_z", bigTaskScope(), {
          effectiveAt: "2026-08-09T01:00:00.000Z",
        }),
        makeContextItem("ctx_b", bigTaskScope(), {
          effectiveAt: "2026-08-08T01:00:00.000Z",
        }),
        makeContextItem("ctx_a", bigTaskScope(), {
          effectiveAt: "2026-08-08T01:00:00.000Z",
        }),
      ];
      items.forEach((item) => storage.createContextItem(item));

      expect(storage.listContextItemsByScope(bigTaskScope()).map(({ id }) => id)).toEqual([
        "ctx_a",
        "ctx_b",
        "ctx_z",
      ]);
    });
  });

  it("preserves valid Project read parity in memory, on file, and after reopen", () => {
    expectValidReadParity(projectScope("prj_parity"), (storage) => {
      storage.createProject(makeProject("prj_parity", "project-parity"));
    });
  });

  it("preserves valid Big Task read parity in memory, on file, and after reopen", () => {
    expectValidReadParity(bigTaskScope("prj_parity", "bt_parity"), (storage) => {
      storage.createProject(makeProject("prj_parity", "project-parity"));
      storage.createBigTask(makeBigTask("bt_parity", "prj_parity"));
    });
  });

  it("preserves valid Subtask read parity in memory, on file, and after reopen", () => {
    expectValidReadParity(
      subtaskScope("prj_parity", "bt_parity", "st_parity"),
      (storage) => {
        storage.createProject(makeProject("prj_parity", "project-parity"));
        storage.createBigTask(makeBigTask("bt_parity", "prj_parity"));
        storage.createSubtask(makeSubtask("st_parity", "bt_parity"));
      },
    );
  });
});

describe("Context Item hierarchy read integrity", () => {
  it("fails closed after a stored Context Item Project and Big Task relationship is corrupted", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject("prj_rel_a", "project-rel-a"));
      storage.createProject(makeProject("prj_rel_b", "project-rel-b"));
      storage.createBigTask(makeBigTask("bt_rel_a", "prj_rel_a"));
      const item = makeContextItem(
        "ctx_rel_project_big",
        bigTaskScope("prj_rel_a", "bt_rel_a"),
      );
      storage.createContextItem(item);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET project_id = ? WHERE id = ?")
        .run("prj_rel_b", item.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const storedError = captureTaskStorageError(() =>
          reopened.getContextItemById(item.id),
        );
        expect(storedError).toMatchObject({
          code: "MALFORMED_STORED_DATA",
          message: "Stored task data is malformed.",
        });
        expect(storedError.message).not.toMatch(
          /ctx_rel_project_big|prj_rel_[ab]|bt_rel_a|SQLite|SQL|context_items|project_id|\/Users\//i,
        );

        const callerError = captureTaskStorageError(() =>
          reopened.listContextItemsByScope(bigTaskScope("prj_rel_b", "bt_rel_a")),
        );
        expect(callerError).toMatchObject({ code: "PARENT_NOT_FOUND" });
        expect(callerError.message).not.toMatch(
          /ctx_rel_project_big|prj_rel_[ab]|bt_rel_a|SQLite|SQL|context_items|project_id|\/Users\//i,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed after a stored Context Item Subtask and Big Task relationship is corrupted", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask("bt_rel_a"));
      storage.createBigTask(makeBigTask("bt_rel_b"));
      storage.createSubtask(makeSubtask("st_rel_a", "bt_rel_a"));
      storage.createSubtask(makeSubtask("st_rel_b", "bt_rel_b"));
      const item = makeContextItem(
        "ctx_rel_big_subtask",
        subtaskScope("prj_console", "bt_rel_a", "st_rel_a"),
      );
      storage.createContextItem(item);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET subtask_id = ? WHERE id = ?")
        .run("st_rel_b", item.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          captureTaskStorageError(() => reopened.getContextItemById(item.id)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed when a stored Big Task parent is moved to another Project", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject("prj_parent_a", "project-parent-a"));
      storage.createProject(makeProject("prj_parent_b", "project-parent-b"));
      storage.createBigTask(makeBigTask("bt_parent", "prj_parent_a"));
      const item = makeContextItem(
        "ctx_parent_big_task",
        bigTaskScope("prj_parent_a", "bt_parent"),
      );
      storage.createContextItem(item);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE big_tasks SET project_id = ? WHERE id = ?")
        .run("prj_parent_b", "bt_parent");
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          captureTaskStorageError(() => reopened.getContextItemById(item.id)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed when a stored Subtask parent is moved to another Big Task", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask("bt_parent_a"));
      storage.createBigTask(makeBigTask("bt_parent_b"));
      storage.createSubtask(makeSubtask("st_parent", "bt_parent_a"));
      const item = makeContextItem(
        "ctx_parent_subtask",
        subtaskScope("prj_console", "bt_parent_a", "st_parent"),
      );
      storage.createContextItem(item);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE subtasks SET big_task_id = ? WHERE id = ?")
        .run("bt_parent_b", "st_parent");
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          captureTaskStorageError(() => reopened.getContextItemById(item.id)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
      } finally {
        reopened.close();
      }
    });
  });

  it("rejects an exact Big Task scope claimed under the wrong Project", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_scope_a", "project-scope-a"));
      storage.createProject(makeProject("prj_scope_b", "project-scope-b"));
      storage.createBigTask(makeBigTask("bt_scope_a", "prj_scope_a"));

      expect(
        captureTaskStorageError(() =>
          storage.listContextItemsByScope(bigTaskScope("prj_scope_b", "bt_scope_a")),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });

  it("rejects an exact Project scope that does not exist", () => {
    withMemoryStorage((storage) => {
      expect(
        captureTaskStorageError(() =>
          storage.listContextItemsByScope(projectScope("prj_missing")),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });

  it("rejects an exact Subtask scope claimed under the wrong Big Task", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask("bt_scope_a"));
      storage.createBigTask(makeBigTask("bt_scope_b"));
      storage.createSubtask(makeSubtask("st_scope_b", "bt_scope_b"));

      expect(
        captureTaskStorageError(() =>
          storage.listContextItemsByScope(
            subtaskScope("prj_console", "bt_scope_a", "st_scope_b"),
          ),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });

  it("rejects an internally valid Subtask hierarchy claimed under another Project", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_scope_a", "project-scope-a"));
      storage.createProject(makeProject("prj_scope_b", "project-scope-b"));
      storage.createBigTask(makeBigTask("bt_scope_a", "prj_scope_a"));
      storage.createSubtask(makeSubtask("st_scope_a", "bt_scope_a"));

      expect(
        captureTaskStorageError(() =>
          storage.listContextItemsByScope(
            subtaskScope("prj_scope_b", "bt_scope_a", "st_scope_a"),
          ),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });

  it("does not mutate caller-owned exact scope input", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const scope = Object.freeze(bigTaskScope());
      const snapshot = JSON.stringify(scope);

      storage.listContextItemsByScope(scope);

      expect(JSON.stringify(scope)).toBe(snapshot);
    });
  });

  it("isolates unrelated valid exact scopes from stored hierarchy corruption", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject("prj_valid", "project-valid"));
      const validItem = makeContextItem("ctx_valid", projectScope("prj_valid"));
      storage.createContextItem(validItem);

      storage.createProject(makeProject("prj_corrupt", "project-corrupt"));
      storage.createBigTask(makeBigTask("bt_corrupt_a", "prj_corrupt"));
      storage.createBigTask(makeBigTask("bt_corrupt_b", "prj_corrupt"));
      storage.createSubtask(makeSubtask("st_corrupt_a", "bt_corrupt_a"));
      storage.createSubtask(makeSubtask("st_corrupt_b", "bt_corrupt_b"));
      const corruptItem = makeContextItem(
        "ctx_corrupt",
        subtaskScope("prj_corrupt", "bt_corrupt_a", "st_corrupt_a"),
      );
      storage.createContextItem(corruptItem);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET subtask_id = ? WHERE id = ?")
        .run("st_corrupt_b", corruptItem.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.listContextItemsByScope(projectScope("prj_valid"))).toEqual([
          validItem,
        ]);
        expect(
          captureTaskStorageError(() => reopened.getContextItemById(corruptItem.id)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
        expect(
          captureTaskStorageError(() =>
            reopened.listContextItemsByScope(
              subtaskScope("prj_corrupt", "bt_corrupt_a", "st_corrupt_b"),
            ),
          ),
        ).toMatchObject({ code: "PARENT_NOT_FOUND" });
      } finally {
        reopened.close();
      }
    });
  });
});

describe("stored Context Item safety", () => {
  it("returns a sanitized error for malformed stored Context Item data", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      const item = makeContextItem();
      storage.createContextItem(item);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET effective_at = ? WHERE id = ?")
        .run("private-malformed-date", item.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const error = captureTaskStorageError(() => reopened.getContextItemById(item.id));
        expect(error).toBeInstanceOf(TaskStorageError);
        expect(error.code).toBe("MALFORMED_STORED_DATA");
        expect(error.message).not.toMatch(/private-malformed-date|SQLite|SQL|effective_at/i);
      } finally {
        reopened.close();
      }
    });
  });

  it("returns sanitized conflicts rather than raw database errors", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const item = makeContextItem();
      storage.createContextItem(item);
      const error = captureTaskStorageError(() => storage.createContextItem(item));
      expect(error).toMatchObject({ code: "CONFLICT" });
      expect(error.message).not.toMatch(/UNIQUE|constraint|context_items|SQLite/i);
    });
  });

  it("exposes no public Context Item update or deletion API", () => {
    withMemoryStorage((storage) => {
      const publicStorage = storage as unknown as Record<string, unknown>;
      expect(publicStorage.updateContextItem).toBeUndefined();
      expect(publicStorage.deleteContextItem).toBeUndefined();
    });
  });

  it("enforces Context Item checks, uniqueness, and RESTRICT relationships in SQLite", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior", subtaskScope());
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", subtaskScope(), {
        supersedesContextItemId: prior.id,
      });
      storage.supersedeContextItem(replacement);
      const other = makeContextItem("ctx_other", subtaskScope());
      storage.createContextItem(other);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        sqlite.exec("PRAGMA foreign_keys = ON");
        expect(() =>
          sqlite.prepare("UPDATE context_items SET status = ? WHERE id = ?").run(
            "CURRENT",
            other.id,
          ),
        ).toThrow();
        expect(() =>
          sqlite.prepare("UPDATE context_items SET big_task_id = NULL WHERE id = ?").run(
            other.id,
          ),
        ).toThrow();
        expect(() =>
          sqlite
            .prepare("UPDATE context_items SET supersedes_context_item_id = id WHERE id = ?")
            .run(other.id),
        ).toThrow();
        expect(() =>
          sqlite
            .prepare(
              "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
            )
            .run(prior.id, other.id),
        ).toThrow();
        expect(() =>
          sqlite.prepare("DELETE FROM projects WHERE id = ?").run("prj_console"),
        ).toThrow();
        expect(() => sqlite.prepare("DELETE FROM big_tasks WHERE id = ?").run("bt_v1")).toThrow();
        expect(() => sqlite.prepare("DELETE FROM subtasks WHERE id = ?").run("st_a")).toThrow();
        expect(() =>
          sqlite.prepare("DELETE FROM context_items WHERE id = ?").run(prior.id),
        ).toThrow();
      } finally {
        sqlite.close();
      }
    });
  });
});
