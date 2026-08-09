import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ContextScopeSchema } from "@codex-task-console/domain";
import type { ContextItem, ContextScope } from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";
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
