import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { AuditEventSchema, ContextScopeSchema } from "@codex-task-console/domain";
import type { ContextScope } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
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

describe("Audit Event storage", () => {
  it("appends and gets Audit Events with and without optional references", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const complete = makeAuditEvent();
      const minimal = AuditEventSchema.parse({
        id: "aud_minimal",
        scope: projectScope(),
        eventType: "TASK_VIEWED",
        actorType: "SYSTEM",
        summary: "Viewed the task.",
        occurredAt: "2026-08-10T09:00:00+09:00",
      });

      expect(storage.appendAuditEvent(complete)).toEqual(complete);
      expect(storage.appendAuditEvent(minimal)).toEqual(minimal);
      expect(storage.getAuditEventById(complete.id)).toEqual(complete);
      expect(storage.getAuditEventById(minimal.id)).toEqual(minimal);
    });
  });

  it("isolates Project, Big Task, and Subtask events at exact scope", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const events = [
        makeAuditEvent("aud_project", projectScope()),
        makeAuditEvent("aud_big_task", bigTaskScope()),
        makeAuditEvent("aud_subtask", subtaskScope()),
      ];
      events.forEach((event) => storage.appendAuditEvent(event));

      expect(storage.listAuditEventsByScope(projectScope())).toEqual([events[0]]);
      expect(storage.listAuditEventsByScope(bigTaskScope())).toEqual([events[1]]);
      expect(storage.listAuditEventsByScope(subtaskScope())).toEqual([events[2]]);
    });
  });

  it("orders exact-scope events by occurredAt and then Audit Event ID", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      [
        makeAuditEvent("aud_z", bigTaskScope(), {
          occurredAt: "2026-08-10T01:00:00.000Z",
        }),
        makeAuditEvent("aud_b", bigTaskScope(), {
          occurredAt: "2026-08-10T09:00:00+09:00",
        }),
        makeAuditEvent("aud_a", bigTaskScope(), {
          occurredAt: "2026-08-09T19:00:00-05:00",
        }),
      ].forEach((event) => storage.appendAuditEvent(event));

      expect(storage.listAuditEventsByScope(bigTaskScope()).map(({ id }) => id)).toEqual([
        "aud_a",
        "aud_b",
        "aud_z",
      ]);
    });
  });

  it("rejects duplicate IDs with a sanitized conflict and no duplicate append", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const event = makeAuditEvent();
      storage.appendAuditEvent(event);

      const error = captureTaskStorageError(() => storage.appendAuditEvent(event));
      expect(error).toMatchObject({ code: "CONFLICT" });
      expect(error.message).not.toMatch(/UNIQUE|constraint|audit_events|SQLite|SQL/i);
      expect(storage.listAuditEventsByScope(event.scope)).toEqual([event]);
    });
  });

  it("rejects invalid caller hierarchies for append and exact-scope listing", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      const invalidScope = bigTaskScope("prj_b", "bt_a");

      expect(
        captureTaskStorageError(() =>
          storage.appendAuditEvent(makeAuditEvent("aud_wrong", invalidScope)),
        ),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
      expect(
        captureTaskStorageError(() => storage.listAuditEventsByScope(invalidScope)),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
    });
  });

  it("preserves file close and reopen parity", () => {
    withTemporaryDatabasePath((databasePath) => {
      const event = makeAuditEvent();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.appendAuditEvent(event);
      storage.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getAuditEventById(event.id)).toEqual(event);
        expect(reopened.listAuditEventsByScope(event.scope)).toEqual([event]);
      } finally {
        reopened.close();
      }
    });
  });

  it("does not mutate caller input and exposes no public update or delete", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const event = makeAuditEvent("aud_frozen");
      const input = Object.freeze({
        ...event,
        scope: Object.freeze({ ...event.scope }),
      });
      const snapshot = JSON.stringify(input);

      storage.appendAuditEvent(input);
      expect(JSON.stringify(input)).toBe(snapshot);
      const publicStorage = storage as unknown as Record<string, unknown>;
      expect(publicStorage.updateAuditEvent).toBeUndefined();
      expect(publicStorage.deleteAuditEvent).toBeUndefined();
    });
  });

  it("enforces actor, event-type, compact text, and RESTRICT constraints in SQLite", () => {
    withTemporaryDatabasePath((databasePath) => {
      const event = makeAuditEvent("aud_constraints", subtaskScope());
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.appendAuditEvent(event);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        sqlite.exec("PRAGMA foreign_keys = ON");
        for (const [column, value] of [
          ["event_type", "task-created"],
          ["actor_type", "PROVIDER"],
          ["summary", ""],
        ] as const) {
          expect(() =>
            sqlite.prepare(`UPDATE audit_events SET ${column} = ? WHERE id = ?`).run(
              value,
              event.id,
            ),
          ).toThrow();
        }
        expect(() =>
          sqlite.prepare("DELETE FROM projects WHERE id = ?").run("prj_console"),
        ).toThrow();
      } finally {
        sqlite.close();
      }
    });
  });
});

describe("Audit Event stored-data integrity", () => {
  it("fails closed for a structurally malformed stored row", () => {
    withTemporaryDatabasePath((databasePath) => {
      const event = makeAuditEvent();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.appendAuditEvent(event);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE audit_events SET event_type = 'bad' WHERE id = ?").run(event.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          captureTaskStorageError(() => reopened.getAuditEventById(event.id)),
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
      const event = makeAuditEvent("aud_mismatch", bigTaskScope("prj_a", "bt_a"));
      storage.appendAuditEvent(event);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE audit_events SET project_id = ? WHERE id = ?")
        .run("prj_b", event.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const error = captureTaskStorageError(() => reopened.getAuditEventById(event.id));
        expect(error).toMatchObject({ code: "MALFORMED_STORED_DATA" });
        expect(error.message).not.toMatch(/aud_mismatch|prj_[ab]|bt_a|audit_events|SQL/i);
      } finally {
        reopened.close();
      }
    });
  });

  it.each([
    ["summary", "  noncanonical audit summary  "],
    ["actor_reference", "  actor-1  "],
    ["occurred_at", "2026-08-09T09:00:00.000+09:00"],
  ] as const)("fails closed for noncanonical stored %s", (column, value) => {
    withTemporaryDatabasePath((databasePath) => {
      const event = makeAuditEvent(`aud_noncanonical_${column}`);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.appendAuditEvent(event);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.prepare(`UPDATE audit_events SET ${column} = ? WHERE id = ?`).run(value, event.id);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          captureTaskStorageError(() => reopened.getAuditEventById(event.id)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
        expect(
          captureTaskStorageError(() => reopened.listAuditEventsByScope(event.scope)),
        ).toMatchObject({ code: "MALFORMED_STORED_DATA" });
      } finally {
        reopened.close();
      }
    });
  });
});
