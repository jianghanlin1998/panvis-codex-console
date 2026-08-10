import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ContextScopeSchema } from "@codex-task-console/domain";
import type { ContextScope } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeBigTask,
  makeContextDigest,
  makeProject,
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

describe("Context Digest storage", () => {
  it("creates and retrieves one Digest at each exact scope without leakage", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const digests = [
        makeContextDigest("dgt_project", projectScope()),
        makeContextDigest("dgt_big_task", bigTaskScope()),
        makeContextDigest("dgt_subtask", subtaskScope()),
      ];
      for (const digest of digests) {
        expect(storage.createContextDigest(digest)).toEqual(digest);
        expect(storage.getContextDigestById(digest.id)).toEqual(digest);
        expect(storage.getContextDigestByScope(digest.scope)).toEqual(digest);
      }
    });
  });

  it("rejects duplicate IDs and duplicate exact scopes with sanitized conflicts", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const digest = makeContextDigest();
      storage.createContextDigest(digest);

      for (const duplicate of [
        digest,
        makeContextDigest("dgt_other", digest.scope),
      ]) {
        const error = captureTaskStorageError(() => storage.createContextDigest(duplicate));
        expect(error).toMatchObject({ code: "CONFLICT" });
        expect(error.message).not.toMatch(/UNIQUE|constraint|context_digests|SQLite|SQL/i);
      }
    });
  });

  it("replaces only body and provenance at the same stable ID and exact scope", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const original = makeContextDigest();
      const replacement = makeContextDigest(original.id, original.scope, {
        body: "Replacement derived context.",
        effectiveAt: "2026-08-10T09:00:00+09:00",
        sourceReference: "digest-source#replacement",
      });
      storage.createContextDigest(original);

      expect(storage.replaceContextDigest(replacement)).toEqual({
        ...replacement,
        provenance: {
          ...replacement.provenance,
          effectiveAt: "2026-08-10T00:00:00.000Z",
        },
      });
      expect(storage.getContextDigestByScope(original.scope)).toEqual(
        storage.getContextDigestById(original.id),
      );
    });
  });

  it("preserves created_at and changes updated_at during replacement", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = "2026-08-09T00:00:00.000Z";
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      createHierarchy(storage);
      const digest = makeContextDigest();
      storage.createContextDigest(digest);
      currentTime = "2026-08-10T00:00:00.000Z";
      storage.replaceContextDigest(
        makeContextDigest(digest.id, digest.scope, { body: "Updated digest." }),
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          sqlite
            .prepare("SELECT created_at, updated_at FROM context_digests WHERE id = ?")
            .get(digest.id),
        ).toEqual({
          created_at: "2026-08-09T00:00:00.000Z",
          updated_at: "2026-08-10T00:00:00.000Z",
        });
      } finally {
        sqlite.close();
      }
    });
  });

  it("rejects replacement scope movement and leaves the current Digest unchanged", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const digest = makeContextDigest("dgt_stable", bigTaskScope());
      storage.createContextDigest(digest);

      expect(
        captureTaskStorageError(() =>
          storage.replaceContextDigest(
            makeContextDigest(digest.id, projectScope(), { body: "Moved digest." }),
          ),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextDigestById(digest.id)).toEqual(digest);
      expect(storage.getContextDigestByScope(projectScope())).toBeNull();
    });
  });

  it("rejects invalid caller hierarchies for create and exact-scope reads", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      const invalidScope = bigTaskScope("prj_b", "bt_a");

      expect(
        captureTaskStorageError(() =>
          storage.createContextDigest(makeContextDigest("dgt_wrong", invalidScope)),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
      expect(
        captureTaskStorageError(() => storage.getContextDigestByScope(invalidScope)),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });

  it("preserves file close and reopen parity", () => {
    withTemporaryDatabasePath((databasePath) => {
      const digest = makeContextDigest();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.createContextDigest(digest);
      storage.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getContextDigestById(digest.id)).toEqual(digest);
        expect(reopened.getContextDigestByScope(digest.scope)).toEqual(digest);
      } finally {
        reopened.close();
      }
    });
  });

  it("does not mutate caller input and exposes no public hard-delete", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const digest = makeContextDigest("dgt_frozen");
      const input = Object.freeze({
        ...digest,
        scope: Object.freeze({ ...digest.scope }),
        provenance: Object.freeze({ ...digest.provenance }),
      });
      const snapshot = JSON.stringify(input);

      storage.createContextDigest(input);
      expect(JSON.stringify(input)).toBe(snapshot);
      const publicStorage = storage as unknown as Record<string, unknown>;
      expect(publicStorage.deleteContextDigest).toBeUndefined();
      expect(publicStorage.updateContextDigest).toBeUndefined();
    });
  });

  it("enforces one current Digest per exact scope in SQLite", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      const digest = makeContextDigest();
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        expect(() =>
          sqlite
            .prepare(
              `INSERT INTO context_digests
               SELECT ?, project_id, big_task_id, subtask_id, body, source_type,
                      source_reference, effective_at, created_at, updated_at
               FROM context_digests WHERE id = ?`,
            )
            .run("dgt_duplicate_scope", digest.id),
        ).toThrow();
      } finally {
        sqlite.close();
      }
    });
  });

  it("rolls back a replacement when SQLite rejects the update", () => {
    withTemporaryDatabasePath((databasePath) => {
      const digest = makeContextDigest();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        `CREATE TRIGGER reject_digest_update BEFORE UPDATE ON context_digests
         BEGIN SELECT RAISE(ABORT, 'private trigger detail'); END`,
      );
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const error = captureTaskStorageError(() =>
          reopened.replaceContextDigest(
            makeContextDigest(digest.id, digest.scope, { body: "Rejected update." }),
          ),
        );
        expect(error).toMatchObject({ code: "TRANSACTION_FAILED" });
        expect(error.message).not.toMatch(/private trigger detail|trigger|context_digests/i);
        expect(reopened.getContextDigestById(digest.id)).toEqual(digest);
      } finally {
        reopened.close();
      }
    });
  });
});

describe("Context Digest stored-data integrity", () => {
  it("fails closed for a structurally malformed stored row", () => {
    withTemporaryDatabasePath((databasePath) => {
      const digest = makeContextDigest();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE context_digests SET body = '' WHERE id = ?").run(digest.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          captureTaskStorageError(() => reopened.getContextDigestById(digest.id)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed for a stored Project and Big Task hierarchy mismatch", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      const digest = makeContextDigest("dgt_mismatch", bigTaskScope("prj_a", "bt_a"));
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_digests SET project_id = ? WHERE id = ?")
        .run("prj_b", digest.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const error = captureTaskStorageError(() =>
          reopened.getContextDigestById(digest.id),
        );
        expect(error).toMatchObject({ code: "MALFORMED_STORED_DATA" });
        expect(error.message).not.toMatch(/dgt_mismatch|prj_[ab]|bt_a|context_digests|SQL/i);
      } finally {
        reopened.close();
      }
    });
  });

  it.each([
    ["body", "  noncanonical digest  "],
    ["source_reference", "  source#digest  "],
    ["effective_at", "2026-08-09T09:00:00.000+09:00"],
  ] as const)("fails closed for noncanonical stored %s", (column, value) => {
    withTemporaryDatabasePath((databasePath) => {
      const digest = makeContextDigest(`dgt_noncanonical_${column}`);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(`UPDATE context_digests SET ${column} = ? WHERE id = ?`).run(
        value,
        digest.id,
      );
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          captureTaskStorageError(() => reopened.getContextDigestById(digest.id)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
        expect(
          captureTaskStorageError(() => reopened.getContextDigestByScope(digest.scope)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
      } finally {
        reopened.close();
      }
    });
  });
});
