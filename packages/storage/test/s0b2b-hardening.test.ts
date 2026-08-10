import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  AuditEventSchema,
  ContextDigestIdSchema,
  ContextScopeSchema,
} from "@codex-task-console/domain";
import type {
  AuditEvent,
  ContextDigest,
  ContextScope,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

type ProjectScope = Extract<ContextScope, { scopeType: "PROJECT" }>;
type BigTaskScope = Extract<ContextScope, { scopeType: "BIG_TASK" }>;
type SubtaskScope = Extract<ContextScope, { scopeType: "SUBTASK" }>;

const projectScope = (suffix: string): ProjectScope =>
  ContextScopeSchema.parse({
    scopeType: "PROJECT",
    projectId: `prj_${suffix}`,
  }) as ProjectScope;

const bigTaskScope = (suffix: string): BigTaskScope =>
  ContextScopeSchema.parse({
    scopeType: "BIG_TASK",
    projectId: `prj_${suffix}`,
    bigTaskId: `bt_${suffix}`,
  }) as BigTaskScope;

const subtaskScope = (suffix: string): SubtaskScope =>
  ContextScopeSchema.parse({
    scopeType: "SUBTASK",
    projectId: `prj_${suffix}`,
    bigTaskId: `bt_${suffix}`,
    subtaskId: `st_${suffix}`,
  }) as SubtaskScope;

const createScopeHierarchy = (storage: TaskStorage, scope: ContextScope): void => {
  storage.createProject(
    makeProject(scope.projectId, `slug-${scope.projectId.replaceAll("_", "-")}`),
  );
  if (scope.scopeType === "PROJECT") {
    return;
  }
  storage.createBigTask(makeBigTask(scope.bigTaskId, scope.projectId));
  if (scope.scopeType === "SUBTASK") {
    storage.createSubtask(makeSubtask(scope.subtaskId, scope.bigTaskId));
  }
};

const expectCode = (operation: () => unknown, code: string): void => {
  const error = captureTaskStorageError(operation);
  expect(error.code).toBe(code);
  expect(error.message).not.toMatch(
    /SQLite|SQL|constraint|context_digests|audit_events|project_id|big_task_id|subtask_id|index|trigger|\/Users\//i,
  );
};

type DurableRows = readonly Readonly<Record<string, unknown>>[];

const snapshotTable = (databasePath: string, table: "context_digests" | "audit_events"): DurableRows => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as DurableRows;
  } finally {
    sqlite.close();
  }
};

const reopen = (databasePath: string): TaskStorage =>
  openTaskDatabase({ databasePath, clock: fixedClock });

const scopeIndexName = (scope: ContextScope): string => {
  switch (scope.scopeType) {
    case "PROJECT":
      return "context_digests_project_scope_unique";
    case "BIG_TASK":
      return "context_digests_big_task_scope_unique";
    case "SUBTASK":
      return "context_digests_subtask_scope_unique";
  }
};

const injectDuplicateDigest = (
  databasePath: string,
  scope: ContextScope,
  sourceId: string,
  duplicateId: string,
): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec(`DROP INDEX ${scopeIndexName(scope)}`);
    sqlite
      .prepare(
        `INSERT INTO context_digests
         SELECT ?, project_id, big_task_id, subtask_id, body, source_type,
                source_reference, effective_at, created_at, updated_at
         FROM context_digests WHERE id = ?`,
      )
      .run(duplicateId, sourceId);
  } finally {
    sqlite.close();
  }
};

describe("S0B2b direct SQLite constraint hardening", () => {
  it("challenges the complete Digest constraint and partial-uniqueness matrix", () => {
    withTemporaryDatabasePath((databasePath) => {
      const project = projectScope("sqlite_digest");
      const bigTask = bigTaskScope("sqlite_digest");
      const subtask = subtaskScope("sqlite_digest");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, subtask);
      storage.createBigTask(makeBigTask("bt_sqlite_digest_other", project.projectId));
      storage.createSubtask(
        makeSubtask("st_sqlite_digest_other", bigTask.bigTaskId),
      );
      const control = makeContextDigest("dgt_sqlite_control", project);
      storage.createContextDigest(control);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      try {
        expect(
          (sqlite.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
            .foreign_keys,
        ).toBe(1);

        const insert = sqlite.prepare(
          `INSERT INTO context_digests
           (id, project_id, big_task_id, subtask_id, body, source_type,
            source_reference, effective_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const valid = [
          "body",
          "SYSTEM",
          "source",
          "2026-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
        ] as const;
        const run = (
          id: string,
          projectId: string,
          bigTaskId: string | null,
          subtaskId: string | null,
          values: readonly string[] = valid,
        ) => insert.run(id, projectId, bigTaskId, subtaskId, ...values);

        const before = (
          sqlite.prepare("SELECT count(*) AS count FROM context_digests").get() as {
            count: number;
          }
        ).count;
        const invalidRows = [
          ["dgt_fk_project", "prj_missing", null, null, valid],
          [
            "dgt_fk_big",
            project.projectId,
            "bt_missing",
            null,
            valid,
          ],
          [
            "dgt_fk_subtask",
            project.projectId,
            bigTask.bigTaskId,
            "st_missing",
            valid,
          ],
          [
            "dgt_shape",
            project.projectId,
            null,
            subtask.subtaskId,
            valid,
          ],
          [
            "dgt_source_type",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
            ["body", "PROVIDER", ...valid.slice(2)],
          ],
          [
            "dgt_empty_body",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
            ["", ...valid.slice(1)],
          ],
          [
            "dgt_space_body",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
            ["   ", ...valid.slice(1)],
          ],
          [
            "dgt_long_body",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
            ["x".repeat(8_001), ...valid.slice(1)],
          ],
          [
            "dgt_empty_source",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
            [valid[0], valid[1], "", ...valid.slice(3)],
          ],
          [
            "dgt_space_source",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
            [valid[0], valid[1], "   ", ...valid.slice(3)],
          ],
          [
            "dgt_long_source",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
            [valid[0], valid[1], "x".repeat(2_049), ...valid.slice(3)],
          ],
        ] as const;
        for (const row of invalidRows) {
          expect(() => run(row[0], row[1], row[2], row[3], row[4])).toThrow();
        }
        expect(() =>
          run(
            control.id,
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
          ),
        ).toThrow();
        expect(
          (
            sqlite.prepare("SELECT count(*) AS count FROM context_digests").get() as {
              count: number;
            }
          ).count,
        ).toBe(before);

        run(
          "dgt_sqlite_big",
          project.projectId,
          bigTask.bigTaskId,
          null,
        );
        run(
          "dgt_sqlite_sub",
          project.projectId,
          bigTask.bigTaskId,
          subtask.subtaskId,
        );
        run(
          "dgt_sqlite_other_big",
          project.projectId,
          "bt_sqlite_digest_other",
          null,
        );
        run(
          "dgt_sqlite_other_sub",
          project.projectId,
          bigTask.bigTaskId,
          "st_sqlite_digest_other",
        );
        expect(() =>
          run("dgt_project_duplicate", project.projectId, null, null),
        ).toThrow();
        expect(() =>
          run(
            "dgt_big_duplicate",
            project.projectId,
            bigTask.bigTaskId,
            null,
          ),
        ).toThrow();
        expect(() =>
          run(
            "dgt_sub_duplicate",
            project.projectId,
            bigTask.bigTaskId,
            subtask.subtaskId,
          ),
        ).toThrow();

        expect(
          (
            sqlite
              .prepare("SELECT count(*) AS count FROM context_digests")
              .get() as { count: number }
          ).count,
        ).toBe(5);
      } finally {
        sqlite.close();
      }
    });
  });

  it("challenges the complete Audit constraint matrix", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("sqlite_audit");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      try {
        const insert = sqlite.prepare(
          `INSERT INTO audit_events
           (id, project_id, big_task_id, subtask_id, event_type, actor_type,
            actor_reference, summary, subject_reference, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const valid = [
          "TASK_REVIEWED",
          "SYSTEM",
          "actor",
          "summary",
          "subject",
          "2026-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
        ] as const;
        const run = (
          id: string,
          projectId: string,
          bigTaskId: string | null,
          subtaskId: string | null,
          values: readonly (string | null)[] = valid,
        ) => insert.run(id, projectId, bigTaskId, subtaskId, ...values);

        run("aud_valid_project", scope.projectId, null, null);
        run("aud_valid_big", scope.projectId, scope.bigTaskId, null);
        run("aud_valid_sub", scope.projectId, scope.bigTaskId, scope.subtaskId);
        run("aud_valid_optional_null", scope.projectId, null, null, [
          valid[0],
          valid[1],
          null,
          valid[3],
          null,
          valid[5],
          valid[6],
        ]);

        const invalidRows = [
          ["aud_fk_project", "prj_missing", null, null, valid],
          ["aud_fk_big", scope.projectId, "bt_missing", null, valid],
          [
            "aud_fk_sub",
            scope.projectId,
            scope.bigTaskId,
            "st_missing",
            valid,
          ],
          ["aud_shape", scope.projectId, null, scope.subtaskId, valid],
          [
            "aud_event_lower",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            ["task_reviewed", ...valid.slice(1)],
          ],
          [
            "aud_event_punctuation",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            ["TASK-REVIEWED", ...valid.slice(1)],
          ],
          [
            "aud_event_digit",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            ["1_TASK", ...valid.slice(1)],
          ],
          [
            "aud_event_long",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [`A${"1".repeat(64)}`, ...valid.slice(1)],
          ],
          [
            "aud_actor",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [valid[0], "PROVIDER", ...valid.slice(2)],
          ],
          [
            "aud_actor_empty",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [valid[0], valid[1], "", ...valid.slice(3)],
          ],
          [
            "aud_actor_long",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [valid[0], valid[1], "x".repeat(257), ...valid.slice(3)],
          ],
          [
            "aud_summary_empty",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [valid[0], valid[1], valid[2], "", ...valid.slice(4)],
          ],
          [
            "aud_summary_long",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [valid[0], valid[1], valid[2], "x".repeat(1_001), ...valid.slice(4)],
          ],
          [
            "aud_subject_empty",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [valid[0], valid[1], valid[2], valid[3], "", ...valid.slice(5)],
          ],
          [
            "aud_subject_long",
            scope.projectId,
            scope.bigTaskId,
            scope.subtaskId,
            [
              valid[0],
              valid[1],
              valid[2],
              valid[3],
              "x".repeat(513),
              ...valid.slice(5),
            ],
          ],
        ] as const;
        const before = (
          sqlite.prepare("SELECT count(*) AS count FROM audit_events").get() as {
            count: number;
          }
        ).count;
        for (const row of invalidRows) {
          expect(() => run(row[0], row[1], row[2], row[3], row[4])).toThrow();
        }
        expect(() =>
          run("aud_valid_project", scope.projectId, null, null),
        ).toThrow();
        expect(
          (
            sqlite.prepare("SELECT count(*) AS count FROM audit_events").get() as {
              count: number;
            }
          ).count,
        ).toBe(before);
      } finally {
        sqlite.close();
      }
    });
  });
});

describe("S0B2b Digest one-current fail-closed hardening", () => {
  it.each([
    ["PROJECT", projectScope("duplicate_project")],
    ["BIG_TASK", bigTaskScope("duplicate_big")],
    ["SUBTASK", subtaskScope("duplicate_sub")],
  ] as const)(
    "rejects every public %s entry point for duplicate exact-scope state",
    (_label, scope) => {
      withTemporaryDatabasePath((databasePath) => {
        const storage = reopen(databasePath);
        createScopeHierarchy(storage, scope);
        const unrelatedScope = projectScope(`valid_${scope.scopeType.toLowerCase()}`);
        createScopeHierarchy(storage, unrelatedScope);
        const original = makeContextDigest(
          `dgt_duplicate_${scope.scopeType.toLowerCase()}_a`,
          scope,
        );
        const duplicateId = ContextDigestIdSchema.parse(
          `dgt_duplicate_${scope.scopeType.toLowerCase()}_b`,
        );
        const unrelated = makeContextDigest(
          `dgt_valid_${scope.scopeType.toLowerCase()}`,
          unrelatedScope,
        );
        storage.createContextDigest(original);
        storage.createContextDigest(unrelated);
        storage.close();

        injectDuplicateDigest(databasePath, scope, original.id, duplicateId);
        const corruptedRows = snapshotTable(databasePath, "context_digests");

        for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
          const reopened = reopen(databasePath);
          try {
            expectCode(
              () => reopened.getContextDigestByScope(scope),
              "MALFORMED_STORED_DATA",
            );
            expectCode(
              () => reopened.getContextDigestById(original.id),
              "MALFORMED_STORED_DATA",
            );
            expectCode(
              () => reopened.getContextDigestById(duplicateId),
              "MALFORMED_STORED_DATA",
            );
            expectCode(
              () =>
                reopened.createContextDigest(
                  makeContextDigest(
                    `dgt_duplicate_${scope.scopeType.toLowerCase()}_new`,
                    scope,
                  ),
                ),
              "MALFORMED_STORED_DATA",
            );
            expectCode(
              () => reopened.createContextDigest(original),
              "MALFORMED_STORED_DATA",
            );
            expectCode(
              () =>
                reopened.replaceContextDigest(
                  makeContextDigest(original.id, scope, { body: "replacement" }),
                ),
              "MALFORMED_STORED_DATA",
            );
            expectCode(
              () =>
                reopened.replaceContextDigest(
                  makeContextDigest(duplicateId, scope, { body: "replacement" }),
                ),
              "MALFORMED_STORED_DATA",
            );
            expect(reopened.getContextDigestById(unrelated.id)).toEqual(unrelated);
            expect(reopened.getContextDigestByScope(unrelatedScope)).toEqual(
              unrelated,
            );
          } finally {
            reopened.close();
          }
        }

        expect(snapshotTable(databasePath, "context_digests")).toEqual(corruptedRows);
      });
    },
  );
});

describe("S0B2b Digest hierarchy and canonical-storage hardening", () => {
  it.each([
    [
      "Digest Big Task belongs to another Project",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE context_digests SET project_id = ? WHERE id = ?")
          .run("prj_hierarchy_b", "dgt_hierarchy");
      },
    ],
    [
      "Digest Subtask belongs to another Big Task",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE context_digests SET subtask_id = ? WHERE id = ?")
          .run("st_hierarchy_b", "dgt_hierarchy");
      },
    ],
    [
      "Digest Subtask hierarchy crosses Project",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE context_digests SET project_id = ? WHERE id = ?")
          .run("prj_hierarchy_b", "dgt_hierarchy");
      },
    ],
    [
      "stored Big Task parent moved after creation",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE big_tasks SET project_id = ? WHERE id = ?")
          .run("prj_hierarchy_b", "bt_hierarchy_a");
      },
    ],
    [
      "stored Subtask parent moved after creation",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE subtasks SET big_task_id = ? WHERE id = ?")
          .run("bt_hierarchy_b", "st_hierarchy_a");
      },
    ],
  ] as const)("fails closed after %s", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("hierarchy_a");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      createScopeHierarchy(storage, subtaskScope("hierarchy_b"));
      const digest = makeContextDigest("dgt_hierarchy", scope);
      const valid = makeContextDigest(
        "dgt_hierarchy_valid",
        projectScope("hierarchy_valid"),
      );
      createScopeHierarchy(storage, valid.scope);
      storage.createContextDigest(digest);
      storage.createContextDigest(valid);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      corrupt(sqlite);
      sqlite.close();
      const corruptedRows = snapshotTable(databasePath, "context_digests");

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = reopen(databasePath);
        try {
          expectCode(
            () => reopened.getContextDigestById(digest.id),
            "MALFORMED_STORED_DATA",
          );
          const scopeResult = (() => {
            try {
              return reopened.getContextDigestByScope(scope);
            } catch (error) {
              return error;
            }
          })();
          if (scopeResult instanceof Error) {
            expect(scopeResult).toMatchObject({
              code: expect.stringMatching(/^(MALFORMED_STORED_DATA|PARENT_NOT_FOUND)$/),
            });
          } else {
            expect(scopeResult).toBeNull();
          }
          expect(reopened.getContextDigestById(valid.id)).toEqual(valid);
          expect(reopened.getContextDigestByScope(valid.scope)).toEqual(valid);
          expectCode(
            () =>
              reopened.replaceContextDigest(
                makeContextDigest(digest.id, scope, { body: "rejected" }),
              ),
            "MALFORMED_STORED_DATA",
          );
        } finally {
          reopened.close();
        }
      }
      expect(snapshotTable(databasePath, "context_digests")).toEqual(corruptedRows);
    });
  });

  it("fails closed for a stored Subtask-without-Big-Task scope shape", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("shape_corruption");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_shape_corruption", scope);
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite
        .prepare("UPDATE context_digests SET big_task_id = NULL WHERE id = ?")
        .run(digest.id);
      sqlite.close();

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () => reopened.getContextDigestById(digest.id),
          "MALFORMED_STORED_DATA",
        );
      } finally {
        reopened.close();
      }
    });
  });

  it.each([
    ["padded body", "body", " padded body "],
    ["tab-only body", "body", "\t\n"],
    ["padded source reference", "source_reference", " padded-source "],
    ["tab/newline source reference", "source_reference", "\tsource\n"],
    [
      "noncanonical effectiveAt",
      "effective_at",
      "2026-08-10T09:00:00.000+09:00",
    ],
    [
      "noncanonical created_at",
      "created_at",
      "2026-08-10T09:00:00.000+09:00",
    ],
    [
      "noncanonical updated_at",
      "updated_at",
      "2026-08-10T09:00:00.000+09:00",
    ],
    ["UTF-16/code-point body mismatch", "body", "🚀".repeat(4_001)],
    [
      "UTF-16/code-point source mismatch",
      "source_reference",
      "🚀".repeat(1_025),
    ],
  ] as const)("rejects %s through ID and exact-scope reads", (_label, column, value) => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = bigTaskScope(`canonical_${column}`);
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest(`dgt_canonical_${column}`, scope);
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(`UPDATE context_digests SET ${column} = ? WHERE id = ?`).run(
        value,
        digest.id,
      );
      sqlite.close();
      const corruptedRows = snapshotTable(databasePath, "context_digests");

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () => reopened.getContextDigestById(digest.id),
          "MALFORMED_STORED_DATA",
        );
        expectCode(
          () => reopened.getContextDigestByScope(scope),
          "MALFORMED_STORED_DATA",
        );
      } finally {
        reopened.close();
      }
      expect(snapshotTable(databasePath, "context_digests")).toEqual(corruptedRows);
    });
  });

  it("rejects a padded stored Digest ID through exact-scope retrieval", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope("padded_digest_id");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_padded_id", scope);
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_digests SET id = ? WHERE id = ?")
        .run(` ${digest.id} `, digest.id);
      sqlite.close();

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () => reopened.getContextDigestByScope(scope),
          "MALFORMED_STORED_DATA",
        );
        expect(reopened.getContextDigestById(digest.id)).toBeNull();
      } finally {
        reopened.close();
      }
    });
  });

  it("rejects invalid caller hierarchy without mutating durable state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = reopen(databasePath);
      storage.createProject(makeProject("prj_caller_a", "caller-a"));
      storage.createProject(makeProject("prj_caller_b", "caller-b"));
      storage.createBigTask(makeBigTask("bt_caller_a", "prj_caller_a"));
      storage.close();
      const before = snapshotTable(databasePath, "context_digests");

      const reopened = reopen(databasePath);
      try {
        const invalidScope = ContextScopeSchema.parse({
          scopeType: "BIG_TASK",
          projectId: "prj_caller_b",
          bigTaskId: "bt_caller_a",
        });
        expectCode(
          () => reopened.getContextDigestByScope(invalidScope),
          "PARENT_NOT_FOUND",
        );
        expectCode(
          () =>
            reopened.createContextDigest(
              makeContextDigest("dgt_invalid_caller", invalidScope),
            ),
          "PARENT_NOT_FOUND",
        );
      } finally {
        reopened.close();
      }
      expect(snapshotTable(databasePath, "context_digests")).toEqual(before);
    });
  });
});

describe("S0B2b Digest replacement and atomicity hardening", () => {
  it.each([
    ["PROJECT", projectScope("replace_project")],
    ["BIG_TASK", bigTaskScope("replace_big")],
    ["SUBTASK", subtaskScope("replace_sub")],
  ] as const)("preserves identity, scope, and created_at for repeated %s replacement", (_label, scope) => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = "2026-08-10T00:00:00.000Z";
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      createScopeHierarchy(storage, scope);
      const original = makeContextDigest(`dgt_replace_${scope.scopeType}`, scope, {
        body: "Original 日本語 digest.",
      });
      const inputSnapshot = structuredClone(original);
      storage.createContextDigest(original);

      for (let index = 1; index <= 3; index += 1) {
        currentTime = `2026-08-10T0${index}:00:00.000Z`;
        const replacement = makeContextDigest(original.id, scope, {
          body: `Replacement ${index} 审计 🚀`,
          sourceReference: `replacement#${index}`,
          effectiveAt: `2026-08-10T0${index}:00:00.000Z`,
        });
        const replacementSnapshot = structuredClone(replacement);
        expect(storage.replaceContextDigest(replacement)).toEqual(replacement);
        expect(replacement).toEqual(replacementSnapshot);
      }
      expect(original).toEqual(inputSnapshot);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = sqlite
          .prepare(
            "SELECT id, project_id, big_task_id, subtask_id, created_at, updated_at FROM context_digests",
          )
          .get();
        expect(row).toMatchObject({
          id: original.id,
          project_id: scope.projectId,
          big_task_id: scope.scopeType === "PROJECT" ? null : scope.bigTaskId,
          subtask_id: scope.scopeType === "SUBTASK" ? scope.subtaskId : null,
          created_at: "2026-08-10T00:00:00.000Z",
          updated_at: "2026-08-10T03:00:00.000Z",
        });
        expect(
          (
            sqlite.prepare("SELECT count(*) AS count FROM context_digests").get() as {
              count: number;
            }
          ).count,
        ).toBe(1);
      } finally {
        sqlite.close();
      }

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = reopen(databasePath);
        try {
          expect(reopened.getContextDigestById(original.id)).toMatchObject({
            id: original.id,
            scope,
            body: "Replacement 3 审计 🚀",
          });
        } finally {
          reopened.close();
        }
      }
    });
  });

  it("keeps rows byte-for-byte unchanged across rejected replacement operations", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = bigTaskScope("replace_rejections");
      const otherScope = projectScope("replace_rejections_other");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      createScopeHierarchy(storage, otherScope);
      const digest = makeContextDigest("dgt_replace_rejections", scope);
      storage.createContextDigest(digest);
      storage.close();
      const before = snapshotTable(databasePath, "context_digests");

      const reopened = reopen(databasePath);
      try {
        const attempts: readonly [() => unknown, string][] = [
          [
            () =>
              reopened.replaceContextDigest(
                makeContextDigest("dgt_missing", scope, { body: "missing" }),
              ),
            "PARENT_NOT_FOUND",
          ],
          [
            () =>
              reopened.replaceContextDigest(
                makeContextDigest(digest.id, otherScope, { body: "moved" }),
              ),
            "INVALID_INPUT",
          ],
          [
            () =>
              reopened.replaceContextDigest({
                ...digest,
                body: " ",
              } as ContextDigest),
            "INVALID_INPUT",
          ],
          [
            () =>
              reopened.replaceContextDigest({
                ...digest,
                provenance: {
                  ...digest.provenance,
                  sourceReference: "x".repeat(2_049),
                },
              } as ContextDigest),
            "INVALID_INPUT",
          ],
        ];
        for (const [operation, code] of attempts) {
          expectCode(operation, code);
          expect(snapshotTable(databasePath, "context_digests")).toEqual(before);
        }
      } finally {
        reopened.close();
      }
    });
  });

  it("rolls back a failure after the replacement transaction begins", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope("replace_trigger");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_replace_trigger", scope);
      storage.createContextDigest(digest);
      storage.close();
      const before = snapshotTable(databasePath, "context_digests");

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        `CREATE TRIGGER reject_hardened_digest_update
         BEFORE UPDATE ON context_digests
         BEGIN SELECT RAISE(ABORT, 'private replacement detail'); END`,
      );
      sqlite.close();

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () =>
            reopened.replaceContextDigest(
              makeContextDigest(digest.id, scope, { body: "rejected" }),
            ),
          "TRANSACTION_FAILED",
        );
      } finally {
        reopened.close();
      }
      expect(snapshotTable(databasePath, "context_digests")).toEqual(before);
    });
  });
});

describe("S0B2b Audit hierarchy and canonical-storage hardening", () => {
  it.each([
    [
      "Audit Big Task belongs to another Project",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE audit_events SET project_id = ? WHERE id = ?")
          .run("prj_audit_hierarchy_b", "aud_hierarchy");
      },
    ],
    [
      "Audit Subtask belongs to another Big Task",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE audit_events SET subtask_id = ? WHERE id = ?")
          .run("st_audit_hierarchy_b", "aud_hierarchy");
      },
    ],
    [
      "Audit hierarchy crosses Project",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE audit_events SET project_id = ? WHERE id = ?")
          .run("prj_audit_hierarchy_b", "aud_hierarchy");
      },
    ],
    [
      "Audit Big Task parent moved after append",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE big_tasks SET project_id = ? WHERE id = ?")
          .run("prj_audit_hierarchy_b", "bt_audit_hierarchy_a");
      },
    ],
    [
      "Audit Subtask parent moved after append",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE subtasks SET big_task_id = ? WHERE id = ?")
          .run("bt_audit_hierarchy_b", "st_audit_hierarchy_a");
      },
    ],
  ] as const)("fails closed after %s", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("audit_hierarchy_a");
      const validScope = projectScope("audit_hierarchy_valid");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      createScopeHierarchy(storage, subtaskScope("audit_hierarchy_b"));
      createScopeHierarchy(storage, validScope);
      const event = makeAuditEvent("aud_hierarchy", scope);
      const valid = makeAuditEvent("aud_hierarchy_valid", validScope);
      storage.appendAuditEvent(event);
      storage.appendAuditEvent(valid);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      corrupt(sqlite);
      sqlite.close();
      const corruptedRows = snapshotTable(databasePath, "audit_events");

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = reopen(databasePath);
        try {
          expectCode(
            () => reopened.getAuditEventById(event.id),
            "MALFORMED_STORED_DATA",
          );
          const scopeResult = (() => {
            try {
              return reopened.listAuditEventsByScope(scope);
            } catch (error) {
              return error;
            }
          })();
          if (scopeResult instanceof Error) {
            expect(scopeResult).toMatchObject({
              code: expect.stringMatching(/^(MALFORMED_STORED_DATA|PARENT_NOT_FOUND)$/),
            });
          } else {
            expect(scopeResult).toEqual([]);
          }
          expect(reopened.getAuditEventById(valid.id)).toEqual(valid);
          expect(reopened.listAuditEventsByScope(validScope)).toEqual([valid]);
        } finally {
          reopened.close();
        }
      }
      expect(snapshotTable(databasePath, "audit_events")).toEqual(corruptedRows);
    });
  });

  it("fails the complete exact-scope list when one Event is malformed", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = bigTaskScope("audit_partial_list");
      const otherScope = projectScope("audit_partial_other");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      createScopeHierarchy(storage, otherScope);
      const events = Array.from({ length: 8 }, (_, index) =>
        makeAuditEvent(`aud_partial_${index}`, scope, {
          occurredAt: `2026-08-10T00:00:0${index}.000Z`,
        }),
      );
      events.forEach((event) => storage.appendAuditEvent(event));
      const unrelated = makeAuditEvent("aud_partial_unrelated", otherScope);
      storage.appendAuditEvent(unrelated);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE audit_events SET summary = ? WHERE id = ?")
        .run(" padded corrupt summary ", events[4]!.id);
      sqlite.close();

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () => reopened.listAuditEventsByScope(scope),
          "MALFORMED_STORED_DATA",
        );
        expect(reopened.listAuditEventsByScope(otherScope)).toEqual([unrelated]);
      } finally {
        reopened.close();
      }
    });
  });

  it.each([
    ["lowercase eventType", "event_type", "task_reviewed", true],
    ["punctuated eventType", "event_type", "TASK-REVIEWED", true],
    ["padded eventType", "event_type", " TASK_REVIEWED ", true],
    ["invalid actorType", "actor_type", "PROVIDER", true],
    ["padded actorReference", "actor_reference", " actor ", false],
    ["whitespace actorReference", "actor_reference", "\t\n", false],
    ["padded summary", "summary", " padded summary ", false],
    ["tab/newline summary", "summary", "\tsummary\n", false],
    ["UTF-16/code-point summary mismatch", "summary", "🚀".repeat(501), false],
    ["padded subjectReference", "subject_reference", " subject ", false],
    [
      "noncanonical occurredAt",
      "occurred_at",
      "2026-08-10T09:00:00.000+09:00",
      false,
    ],
    [
      "noncanonical created_at",
      "created_at",
      "2026-08-10T09:00:00.000+09:00",
      false,
    ],
  ] as const)("rejects %s through ID and exact-scope reads", (_label, column, value, bypassChecks) => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope(`audit_canonical_${column}`);
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      const event = makeAuditEvent(`aud_canonical_${column}`, scope);
      storage.appendAuditEvent(event);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      if (bypassChecks) {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
      }
      sqlite.prepare(`UPDATE audit_events SET ${column} = ? WHERE id = ?`).run(
        value,
        event.id,
      );
      sqlite.close();
      const corruptedRows = snapshotTable(databasePath, "audit_events");

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () => reopened.getAuditEventById(event.id),
          "MALFORMED_STORED_DATA",
        );
        expectCode(
          () => reopened.listAuditEventsByScope(scope),
          "MALFORMED_STORED_DATA",
        );
      } finally {
        reopened.close();
      }
      expect(snapshotTable(databasePath, "audit_events")).toEqual(corruptedRows);
    });
  });

  it("rejects malformed exact scope and a padded stored Audit ID", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("audit_shape");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      const event = makeAuditEvent("aud_padded_id", scope);
      storage.appendAuditEvent(event);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE audit_events SET id = ? WHERE id = ?")
        .run(` ${event.id} `, event.id);
      sqlite.close();

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () => reopened.listAuditEventsByScope(scope),
          "MALFORMED_STORED_DATA",
        );
        expect(reopened.getAuditEventById(event.id)).toBeNull();
      } finally {
        reopened.close();
      }
    });
  });
});

describe("S0B2b Audit valid-state, ordering, and append-only hardening", () => {
  it("preserves 600 Events across 8 Projects, 24 Big Tasks, and 72 Subtasks", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = reopen(databasePath);
      const scopes: ContextScope[] = [];
      for (let projectIndex = 0; projectIndex < 8; projectIndex += 1) {
        const projectId = `prj_audit_data_${projectIndex}`;
        storage.createProject(makeProject(projectId, `audit-data-${projectIndex}`));
        scopes.push(ContextScopeSchema.parse({ scopeType: "PROJECT", projectId }));
        for (let bigTaskIndex = 0; bigTaskIndex < 3; bigTaskIndex += 1) {
          const bigTaskId = `bt_audit_data_${projectIndex}_${bigTaskIndex}`;
          storage.createBigTask(makeBigTask(bigTaskId, projectId));
          scopes.push(
            ContextScopeSchema.parse({
              scopeType: "BIG_TASK",
              projectId,
              bigTaskId,
            }),
          );
          for (let subtaskIndex = 0; subtaskIndex < 3; subtaskIndex += 1) {
            const subtaskId = `st_audit_data_${projectIndex}_${bigTaskIndex}_${subtaskIndex}`;
            storage.createSubtask(makeSubtask(subtaskId, bigTaskId));
            scopes.push(
              ContextScopeSchema.parse({
                scopeType: "SUBTASK",
                projectId,
                bigTaskId,
                subtaskId,
              }),
            );
          }
        }
      }
      expect(scopes.filter(({ scopeType }) => scopeType === "PROJECT")).toHaveLength(8);
      expect(scopes.filter(({ scopeType }) => scopeType === "BIG_TASK")).toHaveLength(24);
      expect(scopes.filter(({ scopeType }) => scopeType === "SUBTASK")).toHaveLength(72);

      const events = Array.from({ length: 600 }, (_, index) => {
        const scope = scopes[(index * 37) % scopes.length]!;
        const actorType = (["HUMAN", "CODEX", "SYSTEM"] as const)[index % 3]!;
        const occurredMinute = (index * 11) % 29;
        const input = {
          id: `aud_dataset_${index.toString().padStart(4, "0")}`,
          scope,
          eventType: (["TASK_CREATED", "TASK_REVIEWED", "DIGEST_USED"] as const)[
            index % 3
          ],
          actorType,
          ...(index % 2 === 0 ? { actorReference: `actor-${index}` } : {}),
          summary: `审计 ${index} — deterministic résumé 🚀`,
          ...(index % 5 === 0 ? { subjectReference: `subject-${index}` } : {}),
          occurredAt: `2026-08-10T00:${occurredMinute
            .toString()
            .padStart(2, "0")}:00.000Z`,
        };
        return AuditEventSchema.parse(input);
      });

      const insertionOrder = Array.from(
        { length: events.length },
        (_, index) => (index * 173) % events.length,
      );
      expect(new Set(insertionOrder).size).toBe(600);
      insertionOrder.forEach((index) => storage.appendAuditEvent(events[index]!));

      const expectedByScope = new Map<string, AuditEvent[]>();
      for (const event of events) {
        const key = JSON.stringify(event.scope);
        const group = expectedByScope.get(key) ?? [];
        group.push(event);
        expectedByScope.set(key, group);
        expect(storage.getAuditEventById(event.id)).toEqual(event);
      }
      for (const group of expectedByScope.values()) {
        group.sort(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) ||
            left.id.localeCompare(right.id),
        );
      }
      for (const scope of scopes) {
        expect(storage.listAuditEventsByScope(scope)).toEqual(
          expectedByScope.get(JSON.stringify(scope)) ?? [],
        );
      }
      storage.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = reopen(databasePath);
        try {
          for (const scope of scopes) {
            expect(reopened.listAuditEventsByScope(scope)).toEqual(
              expectedByScope.get(JSON.stringify(scope)) ?? [],
            );
          }
          for (const index of [0, 199, 399, 599]) {
            expect(reopened.getAuditEventById(events[index]!.id)).toEqual(
              events[index],
            );
          }
        } finally {
          reopened.close();
        }
      }
    });
  });

  it("keeps Audit append-only at the service boundary without automatic emission", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("append_only");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      const event = makeAuditEvent("aud_append_only", scope);
      const input = Object.freeze({
        ...event,
        scope: Object.freeze({ ...event.scope }),
      });
      const snapshot = structuredClone(input);
      storage.appendAuditEvent(input);
      expect(input).toEqual(snapshot);

      const prototypeMethods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(storage) as object,
      );
      expect(prototypeMethods).not.toContain("updateAuditEvent");
      expect(prototypeMethods).not.toContain("deleteAuditEvent");
      expect(prototypeMethods).not.toContain("replaceAuditEvent");

      expectCode(() => storage.appendAuditEvent(event), "CONFLICT");
      expect(storage.getAuditEventById(event.id)).toEqual(event);
      expect(storage.listAuditEventsByScope(scope)).toEqual([event]);

      const project = makeProject("prj_no_auto_audit", "no-auto-audit");
      storage.createProject(project);
      const bigTask = makeBigTask("bt_no_auto_audit", project.id);
      storage.createBigTask(bigTask);
      const subtask = makeSubtask("st_no_auto_audit", bigTask.id);
      storage.createSubtask(subtask);
      storage.replaceDependenciesForBigTask(bigTask.id, []);
      storage.close();

      expect(snapshotTable(databasePath, "audit_events")).toHaveLength(1);
    });
  });
});

describe("S0B2b sanitized failed-write non-mutation hardening", () => {
  it("leaves no Digest row when SQLite rejects creation", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope("failed_digest_insert");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        `CREATE TRIGGER reject_hardened_digest_insert
         BEFORE INSERT ON context_digests
         BEGIN SELECT RAISE(ABORT, 'private digest insert detail'); END`,
      );
      sqlite.close();
      const before = snapshotTable(databasePath, "context_digests");

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () =>
            reopened.createContextDigest(
              makeContextDigest("dgt_failed_insert", scope),
            ),
          "STORAGE_OPERATION_FAILED",
        );
      } finally {
        reopened.close();
      }
      expect(snapshotTable(databasePath, "context_digests")).toEqual(before);
    });
  });

  it("leaves no Audit row when SQLite rejects append", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope("failed_audit_insert");
      const storage = reopen(databasePath);
      createScopeHierarchy(storage, scope);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        `CREATE TRIGGER reject_hardened_audit_insert
         BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'private audit insert detail'); END`,
      );
      sqlite.close();
      const before = snapshotTable(databasePath, "audit_events");

      const reopened = reopen(databasePath);
      try {
        expectCode(
          () => reopened.appendAuditEvent(makeAuditEvent("aud_failed_insert", scope)),
          "STORAGE_OPERATION_FAILED",
        );
      } finally {
        reopened.close();
      }
      expect(snapshotTable(databasePath, "audit_events")).toEqual(before);
    });
  });
});
