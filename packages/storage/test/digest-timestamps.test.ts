import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ContextScopeSchema } from "@codex-task-console/domain";
import type { ContextDigest, ContextScope } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  makeBigTask,
  makeContextDigest,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const BASE_TIME = "2037-04-05T06:07:08.000Z";
const FORWARD_TIME = "2037-04-05T07:07:08.000Z";
const BACKWARD_TIME = "2037-04-05T05:07:08.000Z";

const timestampAfter = (timestamp: string, milliseconds: number): string =>
  new Date(new Date(timestamp).getTime() + milliseconds).toISOString();

const scopes = [
  [
    "PROJECT",
    ContextScopeSchema.parse({
      scopeType: "PROJECT",
      projectId: "prj_digest_timestamp_project",
    }),
  ],
  [
    "BIG_TASK",
    ContextScopeSchema.parse({
      scopeType: "BIG_TASK",
      projectId: "prj_digest_timestamp_big",
      bigTaskId: "bt_digest_timestamp_big",
    }),
  ],
  [
    "SUBTASK",
    ContextScopeSchema.parse({
      scopeType: "SUBTASK",
      projectId: "prj_digest_timestamp_sub",
      bigTaskId: "bt_digest_timestamp_sub",
      subtaskId: "st_digest_timestamp_sub",
    }),
  ],
] as const;

const createScopeHierarchy = (storage: TaskStorage, scope: ContextScope): void => {
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

interface DigestStorageRow {
  readonly id: string;
  readonly project_id: string;
  readonly big_task_id: string | null;
  readonly subtask_id: string | null;
  readonly body: string;
  readonly source_type: string;
  readonly source_reference: string;
  readonly effective_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const readDigestRow = (
  databasePath: string,
  digestId: string,
): DigestStorageRow => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite
      .prepare(
        `SELECT id, project_id, big_task_id, subtask_id, body, source_type,
                source_reference, effective_at, created_at, updated_at
         FROM context_digests WHERE id = ?`,
      )
      .get(digestId) as unknown as DigestStorageRow;
  } finally {
    sqlite.close();
  }
};

const snapshotDigestRows = (databasePath: string): readonly DigestStorageRow[] => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite
      .prepare(
        `SELECT id, project_id, big_task_id, subtask_id, body, source_type,
                source_reference, effective_at, created_at, updated_at
         FROM context_digests ORDER BY id`,
      )
      .all() as unknown as readonly DigestStorageRow[];
  } finally {
    sqlite.close();
  }
};

describe("Context Digest monotonic replacement timestamps", () => {
  it.each(scopes)(
    "uses the clock or one canonical millisecond while preserving every %s invariant",
    (label, scope) => {
      withTemporaryDatabasePath((databasePath) => {
        let currentTime = BASE_TIME;
        const storage = openTaskDatabase({
          databasePath,
          clock: () => new Date(currentTime),
        });
        createScopeHierarchy(storage, scope);
        const original = makeContextDigest(
          `dgt_timestamp_${label.toLowerCase()}`,
          scope,
          { body: "Original Digest." },
        );
        storage.createContextDigest(original);

        const replacements = [
          {
            clock: FORWARD_TIME,
            expectedTimestamp: FORWARD_TIME,
            body: "Forward replacement.",
            sourceReference: "timestamp#forward",
          },
          {
            clock: FORWARD_TIME,
            expectedTimestamp: timestampAfter(FORWARD_TIME, 1),
            body: "Same-time replacement.",
            sourceReference: "timestamp#same",
          },
          {
            clock: BACKWARD_TIME,
            expectedTimestamp: timestampAfter(FORWARD_TIME, 2),
            body: "Backward replacement.",
            sourceReference: "timestamp#backward",
          },
        ] as const;

        for (const replacementCase of replacements) {
          currentTime = replacementCase.clock;
          const replacement = makeContextDigest(original.id, scope, {
            body: replacementCase.body,
            sourceReference: replacementCase.sourceReference,
            effectiveAt: replacementCase.expectedTimestamp,
          });
          expect(storage.replaceContextDigest(replacement)).toEqual(replacement);
          expect(storage.getContextDigestById(original.id)).toEqual(replacement);
          expect(storage.getContextDigestByScope(scope)).toEqual(replacement);

          const row = readDigestRow(databasePath, original.id);
          expect(row).toMatchObject({
            id: original.id,
            project_id: scope.projectId,
            big_task_id: scope.scopeType === "PROJECT" ? null : scope.bigTaskId,
            subtask_id: scope.scopeType === "SUBTASK" ? scope.subtaskId : null,
            body: replacementCase.body,
            source_type: replacement.provenance.sourceType,
            source_reference: replacementCase.sourceReference,
            effective_at: replacementCase.expectedTimestamp,
            created_at: BASE_TIME,
            updated_at: replacementCase.expectedTimestamp,
          });
        }
        storage.close();
      });
    },
  );

  it("strictly increases across ten fixed-clock replacements", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(BASE_TIME),
      });
      const scope = scopes[1][1];
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_timestamp_fixed", scope);
      storage.createContextDigest(digest);

      const timestamps: string[] = [];
      for (let index = 1; index <= 10; index += 1) {
        const replacement = makeContextDigest(digest.id, scope, {
          body: `Fixed replacement ${index}.`,
          sourceReference: `timestamp#fixed-${index}`,
        });
        expect(storage.replaceContextDigest(replacement)).toEqual(replacement);
        timestamps.push(readDigestRow(databasePath, digest.id).updated_at);
      }

      expect(timestamps).toEqual(
        Array.from({ length: 10 }, (_, index) => timestampAfter(BASE_TIME, index + 1)),
      );
      timestamps.forEach((timestamp, index) => {
        const previous = index === 0 ? BASE_TIME : timestamps[index - 1]!;
        expect(new Date(timestamp).getTime()).toBeGreaterThan(
          new Date(previous).getTime(),
        );
      });
      expect(readDigestRow(databasePath, digest.id)).toMatchObject({
        id: digest.id,
        body: "Fixed replacement 10.",
        source_reference: "timestamp#fixed-10",
        created_at: BASE_TIME,
        updated_at: timestampAfter(BASE_TIME, 10),
      });
      storage.close();
    });
  });

  it("strictly increases through repeated replacements while the clock stays backward", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = BASE_TIME;
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      const scope = scopes[0][1];
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_timestamp_repeated_backward", scope);
      storage.createContextDigest(digest);
      currentTime = BACKWARD_TIME;

      const timestamps = Array.from({ length: 5 }, (_, index) => {
        storage.replaceContextDigest(
          makeContextDigest(digest.id, scope, {
            body: `Backward replacement ${index + 1}.`,
          }),
        );
        return readDigestRow(databasePath, digest.id).updated_at;
      });
      expect(timestamps).toEqual(
        Array.from({ length: 5 }, (_, index) => timestampAfter(BASE_TIME, index + 1)),
      );
      expect(readDigestRow(databasePath, digest.id).created_at).toBe(BASE_TIME);
      storage.close();
    });
  });

  it("preserves monotonic evidence through close and two reopens", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = scopes[2][1];
      const digest = makeContextDigest("dgt_timestamp_reopen", scope);
      const first = openTaskDatabase({
        databasePath,
        clock: () => new Date(BASE_TIME),
      });
      createScopeHierarchy(first, scope);
      first.createContextDigest(digest);
      first.replaceContextDigest(
        makeContextDigest(digest.id, scope, { body: "Before first reopen." }),
      );
      expect(readDigestRow(databasePath, digest.id).updated_at).toBe(
        timestampAfter(BASE_TIME, 1),
      );
      first.close();

      const reopened = openTaskDatabase({
        databasePath,
        clock: () => new Date(BASE_TIME),
      });
      reopened.replaceContextDigest(
        makeContextDigest(digest.id, scope, { body: "Before second reopen." }),
      );
      expect(readDigestRow(databasePath, digest.id).updated_at).toBe(
        timestampAfter(BASE_TIME, 2),
      );
      reopened.close();

      const reopenedAgain = openTaskDatabase({
        databasePath,
        clock: () => new Date(BASE_TIME),
      });
      const finalReplacement = makeContextDigest(digest.id, scope, {
        body: "After second reopen.",
        sourceReference: "timestamp#second-reopen",
      });
      expect(reopenedAgain.replaceContextDigest(finalReplacement)).toEqual(
        finalReplacement,
      );
      expect(reopenedAgain.getContextDigestById(digest.id)).toEqual(finalReplacement);
      expect(readDigestRow(databasePath, digest.id)).toMatchObject({
        created_at: BASE_TIME,
        updated_at: timestampAfter(BASE_TIME, 3),
        body: "After second reopen.",
        source_reference: "timestamp#second-reopen",
      });
      reopenedAgain.close();
    });
  });

  it("does not advance updated_at for a rejected replacement", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = scopes[1][1];
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(FORWARD_TIME),
      });
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_timestamp_rejected", scope);
      storage.createContextDigest(digest);
      const before = readDigestRow(databasePath, digest.id);

      const error = captureTaskStorageError(() =>
        storage.replaceContextDigest({ ...digest, body: " " } as ContextDigest),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(readDigestRow(databasePath, digest.id)).toEqual(before);
      storage.close();
    });
  });

  it("does not advance updated_at when the replacement transaction fails", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = scopes[0][1];
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(BASE_TIME),
      });
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_timestamp_transaction_failure", scope);
      storage.createContextDigest(digest);
      storage.close();
      const before = readDigestRow(databasePath, digest.id);

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        `CREATE TRIGGER reject_timestamp_replacement
         BEFORE UPDATE ON context_digests
         BEGIN SELECT RAISE(ABORT, 'private failure'); END`,
      );
      sqlite.close();

      const reopened = openTaskDatabase({
        databasePath,
        clock: () => new Date(FORWARD_TIME),
      });
      const error = captureTaskStorageError(() =>
        reopened.replaceContextDigest(
          makeContextDigest(digest.id, scope, { body: "Rejected by trigger." }),
        ),
      );
      expect(error.code).toBe("TRANSACTION_FAILED");
      expect(readDigestRow(databasePath, digest.id)).toEqual(before);
      reopened.close();
    });
  });

  it("does not mutate either row when duplicate exact-scope state rejects replacement", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = scopes[1][1];
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(BASE_TIME),
      });
      createScopeHierarchy(storage, scope);
      const digest = makeContextDigest("dgt_timestamp_duplicate_a", scope);
      storage.createContextDigest(digest);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("DROP INDEX context_digests_big_task_scope_unique");
      sqlite
        .prepare(
          `INSERT INTO context_digests
           SELECT ?, project_id, big_task_id, subtask_id, body, source_type,
                  source_reference, effective_at, created_at, updated_at
           FROM context_digests WHERE id = ?`,
        )
        .run("dgt_timestamp_duplicate_b", digest.id);
      sqlite.close();
      const before = snapshotDigestRows(databasePath);

      const reopened = openTaskDatabase({
        databasePath,
        clock: () => new Date(FORWARD_TIME),
      });
      const error = captureTaskStorageError(() =>
        reopened.replaceContextDigest(
          makeContextDigest(digest.id, scope, { body: "Rejected duplicate." }),
        ),
      );
      expect(error.code).toBe("MALFORMED_STORED_DATA");
      expect(snapshotDigestRows(databasePath)).toEqual(before);
      reopened.close();
    });
  });
});
