import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ContextScopeSchema } from "@codex-task-console/domain";
import type { ContextScope } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage, TaskStorageError } from "../src/index.js";
import {
  captureTaskStorageError,
  FIXED_TIME,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeProject,
  withTemporaryDatabasePath,
} from "./fixtures.js";

type BigTaskScope = Extract<ContextScope, { scopeType: "BIG_TASK" }>;

const scope: BigTaskScope = ContextScopeSchema.parse({
  scopeType: "BIG_TASK",
  projectId: "prj_concurrency",
  bigTaskId: "bt_concurrency",
}) as BigTaskScope;

const seedHierarchy = (storage: TaskStorage): void => {
  storage.createProject(makeProject(scope.projectId, "concurrency"));
  storage.createBigTask(makeBigTask(scope.bigTaskId, scope.projectId));
};

const assertSanitizedContention = (error: TaskStorageError): void => {
  expect(["STORAGE_OPERATION_FAILED", "TRANSACTION_FAILED"]).toContain(error.code);
  expect(error.message).not.toMatch(
    /SQLite|SQL|locked|busy|constraint|context_digests|audit_events|index|\/Users\//i,
  );
};

const readDigestUpdatedAt = (databasePath: string, digestId: string): string => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      sqlite
        .prepare("SELECT updated_at FROM context_digests WHERE id = ?")
        .get(digestId) as { readonly updated_at: string }
    ).updated_at;
  } finally {
    sqlite.close();
  }
};

const timestampAfter = (milliseconds: number): string =>
  new Date(new Date(FIXED_TIME).getTime() + milliseconds).toISOString();

const withTwoConnections = (
  databasePath: string,
  operation: (first: TaskStorage, second: TaskStorage) => void,
): void => {
  const first = openTaskDatabase({ databasePath, clock: fixedClock });
  const second = openTaskDatabase({ databasePath, clock: fixedClock });
  try {
    operation(first, second);
  } finally {
    first.close();
    second.close();
  }
};

describe("S0B2b deterministic two-connection concurrency hardening", () => {
  it(
    "keeps one Digest when different IDs contend for the same exact scope",
    () => {
      withTemporaryDatabasePath((databasePath) => {
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        seed.close();
        const firstDigest = makeContextDigest("dgt_race_scope_a", scope);
        const secondDigest = makeContextDigest("dgt_race_scope_b", scope);

        withTwoConnections(databasePath, (first, second) => {
          first.runInTransaction((transaction) => {
            transaction.createContextDigest(firstDigest);
            assertSanitizedContention(
              captureTaskStorageError(() => second.createContextDigest(secondDigest)),
            );
          });
        });

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(reopened.getContextDigestByScope(scope)).toEqual(firstDigest);
          expect(reopened.getContextDigestById(firstDigest.id)).toEqual(firstDigest);
          expect(reopened.getContextDigestById(secondDigest.id)).toBeNull();
        } finally {
          reopened.close();
        }
      });
    },
    10_000,
  );

  it(
    "keeps one durable Digest identity when the same ID contends",
    () => {
      withTemporaryDatabasePath((databasePath) => {
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        seed.close();
        const digest = makeContextDigest("dgt_race_identity", scope);

        withTwoConnections(databasePath, (first, second) => {
          first.runInTransaction((transaction) => {
            transaction.createContextDigest(digest);
            assertSanitizedContention(
              captureTaskStorageError(() => second.createContextDigest(digest)),
            );
          });
        });

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(reopened.getContextDigestById(digest.id)).toEqual(digest);
          expect(reopened.getContextDigestByScope(scope)).toEqual(digest);
        } finally {
          reopened.close();
        }
      });
    },
    10_000,
  );

  it(
    "keeps replacement structurally atomic at a two-connection boundary",
    () => {
      withTemporaryDatabasePath((databasePath) => {
        const original = makeContextDigest("dgt_race_replace", scope);
        const firstReplacement = makeContextDigest(original.id, scope, {
          body: "First serialized replacement.",
          sourceReference: "race#first",
        });
        const secondReplacement = makeContextDigest(original.id, scope, {
          body: "Second contending replacement.",
          sourceReference: "race#second",
        });
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        seed.createContextDigest(original);
        seed.close();
        expect(readDigestUpdatedAt(databasePath, original.id)).toBe(FIXED_TIME);

        withTwoConnections(databasePath, (first, second) => {
          first.runInTransaction((transaction) => {
            expect(transaction.replaceContextDigest(firstReplacement)).toEqual(
              firstReplacement,
            );
            assertSanitizedContention(
              captureTaskStorageError(() =>
                second.replaceContextDigest(secondReplacement),
              ),
            );
          });
        });
        expect(readDigestUpdatedAt(databasePath, original.id)).toBe(
          timestampAfter(1),
        );

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(reopened.getContextDigestById(original.id)).toEqual(firstReplacement);
          expect(reopened.getContextDigestByScope(scope)).toEqual(firstReplacement);
        } finally {
          reopened.close();
        }
      });
    },
    10_000,
  );

  it(
    "keeps one Audit identity when the same ID contends",
    () => {
      withTemporaryDatabasePath((databasePath) => {
        const event = makeAuditEvent("aud_race_identity", scope);
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        seed.close();

        withTwoConnections(databasePath, (first, second) => {
          first.runInTransaction((transaction) => {
            transaction.appendAuditEvent(event);
            assertSanitizedContention(
              captureTaskStorageError(() => second.appendAuditEvent(event)),
            );
          });
        });

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(reopened.getAuditEventById(event.id)).toEqual(event);
          expect(reopened.listAuditEventsByScope(scope)).toEqual([event]);
        } finally {
          reopened.close();
        }
      });
    },
    10_000,
  );

  it(
    "serializes distinct tied-time Audit appends without partial rows",
    () => {
      withTemporaryDatabasePath((databasePath) => {
        const firstEvent = makeAuditEvent("aud_race_distinct_a", scope, {
          occurredAt: "2026-08-10T00:00:00.000Z",
        });
        const secondEvent = makeAuditEvent("aud_race_distinct_b", scope, {
          occurredAt: "2026-08-10T00:00:00.000Z",
        });
        const seed = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(seed);
        seed.close();

        withTwoConnections(databasePath, (first, second) => {
          first.runInTransaction((transaction) => {
            transaction.appendAuditEvent(firstEvent);
            assertSanitizedContention(
              captureTaskStorageError(() => second.appendAuditEvent(secondEvent)),
            );
          });
          expect(second.appendAuditEvent(secondEvent)).toEqual(secondEvent);
        });

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(reopened.listAuditEventsByScope(scope)).toEqual([
            firstEvent,
            secondEvent,
          ]);
        } finally {
          reopened.close();
        }
      });
    },
    10_000,
  );

  it("permits last-writer-wins only after two valid replacements serialize", () => {
    withTemporaryDatabasePath((databasePath) => {
      const original = makeContextDigest("dgt_serial_replace", scope);
      const seed = openTaskDatabase({ databasePath, clock: fixedClock });
      seedHierarchy(seed);
      seed.createContextDigest(original);
      seed.close();
      expect(readDigestUpdatedAt(databasePath, original.id)).toBe(FIXED_TIME);

      withTwoConnections(databasePath, (first, second) => {
        first.replaceContextDigest(
          makeContextDigest(original.id, scope, { body: "Serialized first." }),
        );
        expect(readDigestUpdatedAt(databasePath, original.id)).toBe(
          timestampAfter(1),
        );
        second.replaceContextDigest(
          makeContextDigest(original.id, scope, { body: "Serialized second." }),
        );
        expect(readDigestUpdatedAt(databasePath, original.id)).toBe(
          timestampAfter(2),
        );
      });

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getContextDigestById(original.id)).toMatchObject({
          id: original.id,
          scope,
          body: "Serialized second.",
        });
      } finally {
        reopened.close();
      }
    });
  });
});
