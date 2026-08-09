import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ContextItemIdSchema, ContextScopeSchema } from "@codex-task-console/domain";
import type { ContextScope, ContextStatus } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
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

describe("atomic Context Item supersession", () => {
  it("supersedes one ACTIVE item while preserving its historical evidence", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior", bigTaskScope(), {
        title: "Original title",
        body: "Original body",
      });
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
        title: "Replacement title",
      });

      expect(storage.supersedeContextItem(replacement)).toEqual(replacement);
      expect(storage.getContextItemById(replacement.id)).toEqual(replacement);
      expect(storage.getContextItemById(prior.id)).toEqual({
        ...prior,
        status: "SUPERSEDED",
      });
      expect(storage.getContextItemById(prior.id)).toMatchObject({
        title: "Original title",
        body: "Original body",
        authority: prior.authority,
        provenance: prior.provenance,
      });
    });
  });

  it("updates only the prior status and updated_at timestamp", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = "2026-08-09T00:00:00.000Z";
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      currentTime = "2026-08-09T01:00:00.000Z";
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });
      storage.supersedeContextItem(replacement);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const priorRow = sqlite
          .prepare(
            "SELECT status, title, body, source_reference, effective_at, created_at, updated_at FROM context_items WHERE id = ?",
          )
          .get(prior.id);
        expect(priorRow).toEqual({
          status: "SUPERSEDED",
          title: prior.title,
          body: prior.body,
          source_reference: prior.provenance.sourceReference,
          effective_at: prior.provenance.effectiveAt,
          created_at: "2026-08-09T00:00:00.000Z",
          updated_at: "2026-08-09T01:00:00.000Z",
        });
      } finally {
        sqlite.close();
      }
    });
  });

  it("requires an ACTIVE replacement with an explicit prior pointer", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      const proposedReplacement = makeContextItem("ctx_proposed", bigTaskScope(), {
        status: "PROPOSED",
        supersedesContextItemId: prior.id,
      });
      const missingPointer = makeContextItem("ctx_missing_pointer");

      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(proposedReplacement)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(missingPointer)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextItemById(prior.id)?.status).toBe("ACTIVE");
    });
  });

  it("rejects a missing prior item", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: ContextItemIdSchema.parse("ctx_missing"),
      });
      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it("rejects self-supersession", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const replacement = makeContextItem("ctx_self", bigTaskScope(), {
        supersedesContextItemId: ContextItemIdSchema.parse("ctx_self"),
      });
      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it.each([
    ["Project", projectScope("prj_a"), projectScope("prj_b")],
    ["Big Task", bigTaskScope("prj_a", "bt_a"), bigTaskScope("prj_a", "bt_other")],
    [
      "Subtask",
      subtaskScope("prj_a", "bt_a", "st_a"),
      subtaskScope("prj_a", "bt_other", "st_other"),
    ],
  ] as const)("rejects cross-%s supersession", (_label, priorScope, replacementScope) => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      storage.createBigTask(makeBigTask("bt_other", "prj_a"));
      storage.createSubtask(makeSubtask("st_a", "bt_a"));
      storage.createSubtask(makeSubtask("st_other", "bt_other"));
      const prior = makeContextItem("ctx_prior", priorScope);
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", replacementScope, {
        supersedesContextItemId: prior.id,
      });

      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextItemById(prior.id)?.status).toBe("ACTIVE");
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it.each(["PROPOSED", "REJECTED", "RESOLVED", "SUPERSEDED"] as const)(
    "does not supersede a %s prior item",
    (status: ContextStatus) => {
      withMemoryStorage((storage) => {
        createHierarchy(storage);
        const prior = makeContextItem("ctx_prior", bigTaskScope(), { status });
        storage.createContextItem(prior);
        const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
          supersedesContextItemId: prior.id,
        });

        expect(
          captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
        ).toMatchObject({ code: "CONFLICT" });
        expect(storage.getContextItemById(prior.id)?.status).toBe(status);
        expect(storage.getContextItemById(replacement.id)).toBeNull();
      });
    },
  );

  it("prevents a prior item from branching to two replacements", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });
      storage.supersedeContextItem(replacement);
      const branch = makeContextItem("ctx_branch", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });

      expect(captureTaskStorageError(() => storage.supersedeContextItem(branch))).toMatchObject({
        code: "CONFLICT",
      });
      expect(storage.getContextItemById(branch.id)).toBeNull();
      expect(storage.listContextItemsByScope(bigTaskScope()).map(({ id }) => id)).toEqual([
        "ctx_prior",
        "ctx_replacement",
      ]);
    });
  });

  it("rolls back both supersession mutations when the transaction fails", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });

      expect(
        captureTaskStorageError(() =>
          storage.runInTransaction((transaction) => {
            transaction.supersedeContextItem(replacement);
            throw new Error("private transaction failure");
          }),
        ),
      ).toMatchObject({ code: "TRANSACTION_FAILED" });
      expect(storage.getContextItemById(prior.id)).toEqual(prior);
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it("preserves an A to B to C supersession chain", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const a = makeContextItem("ctx_a");
      storage.createContextItem(a);
      const b = makeContextItem("ctx_b", bigTaskScope(), {
        supersedesContextItemId: a.id,
      });
      storage.supersedeContextItem(b);
      const c = makeContextItem("ctx_c", bigTaskScope(), {
        supersedesContextItemId: b.id,
      });
      storage.supersedeContextItem(c);

      expect(storage.getContextItemById(a.id)).toEqual({ ...a, status: "SUPERSEDED" });
      expect(storage.getContextItemById(b.id)).toEqual({ ...b, status: "SUPERSEDED" });
      expect(storage.getContextItemById(c.id)).toEqual(c);
    });
  });
});
