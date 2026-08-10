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
  ContextDigestId,
  ContextScope,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
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

const expectMalformed = (operation: () => unknown): void => {
  const error = captureTaskStorageError(operation);
  expect(error).toMatchObject({
    code: "MALFORMED_STORED_DATA",
    message: "Stored task data is malformed.",
  });
  expect(error.message).not.toMatch(
    /SQLite|SQL|constraint|context_digests|audit_events|index|project_id|\/Users\//i,
  );
};

const snapshotS0B2b = (databasePath: string): Readonly<Record<string, unknown>> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      digests: sqlite.prepare("SELECT * FROM context_digests ORDER BY id").all(),
      audits: sqlite.prepare("SELECT * FROM audit_events ORDER BY id").all(),
    };
  } finally {
    sqlite.close();
  }
};

const exactScopeKey = (scope: ContextScope): string => JSON.stringify(scope);

describe("S0B2b large mixed-state campaign", () => {
  it("round-trips 12 Projects, 36 Big Tasks, 108 Subtasks, 120 Digests, and 1,000 Events", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const scopes: ContextScope[] = [];
      for (let projectIndex = 0; projectIndex < 12; projectIndex += 1) {
        const projectId = `prj_mixed_${projectIndex}`;
        storage.createProject(makeProject(projectId, `mixed-${projectIndex}`));
        scopes.push(ContextScopeSchema.parse({ scopeType: "PROJECT", projectId }));
        for (let bigTaskIndex = 0; bigTaskIndex < 3; bigTaskIndex += 1) {
          const bigTaskId = `bt_mixed_${projectIndex}_${bigTaskIndex}`;
          storage.createBigTask(makeBigTask(bigTaskId, projectId));
          scopes.push(
            ContextScopeSchema.parse({
              scopeType: "BIG_TASK",
              projectId,
              bigTaskId,
            }),
          );
          for (let subtaskIndex = 0; subtaskIndex < 3; subtaskIndex += 1) {
            const subtaskId = `st_mixed_${projectIndex}_${bigTaskIndex}_${subtaskIndex}`;
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
      expect(scopes).toHaveLength(156);

      const populatedScopes = scopes.filter((_, index) => index % 13 !== 0).slice(0, 120);
      const digests = populatedScopes.map((scope, index) =>
        makeContextDigest(`dgt_mixed_${index.toString().padStart(3, "0")}`, scope, {
          body: `Derived context ${index}: 中文・日本語・한국어・Résumé 🚀`,
          sourceReference: `mixed#digest-${index}`,
          effectiveAt:
            index % 2 === 0
              ? `2026-08-10T${(index % 20).toString().padStart(2, "0")}:00:00.000Z`
              : `2026-08-10T${((index % 15) + 9).toString().padStart(2, "0")}:00:00+09:00`,
        }),
      );
      digests.forEach((digest) => storage.createContextDigest(digest));

      const events = Array.from({ length: 1_000 }, (_, index) => {
        const scope = scopes[(index * 97) % scopes.length]!;
        return AuditEventSchema.parse({
          id: `aud_mixed_${index.toString().padStart(4, "0")}`,
          scope,
          eventType: (["TASK_CREATED", "TASK_UPDATED", "DIGEST_REVIEWED"] as const)[
            index % 3
          ],
          actorType: (["HUMAN", "CODEX", "SYSTEM"] as const)[index % 3],
          ...(index % 2 === 0 ? { actorReference: `actor-${index}` } : {}),
          summary: `Mixed audit ${index}: 证据 証拠 증거 résumé 🚀`,
          ...(index % 4 === 0 ? { subjectReference: `subject-${index}` } : {}),
          occurredAt: `2026-08-10T${(index % 20)
            .toString()
            .padStart(2, "0")}:${((index * 7) % 31)
            .toString()
            .padStart(2, "0")}:00.000Z`,
        });
      });
      Array.from(
        { length: events.length },
        (_, index) => (index * 371) % events.length,
      ).forEach((index) => storage.appendAuditEvent(events[index]!));

      const digestsByScope = new Map(
        digests.map((digest) => [exactScopeKey(digest.scope), digest] as const),
      );
      const auditsByScope = new Map<string, AuditEvent[]>();
      for (const event of events) {
        const key = exactScopeKey(event.scope);
        const group = auditsByScope.get(key) ?? [];
        group.push(event);
        auditsByScope.set(key, group);
      }
      for (const group of auditsByScope.values()) {
        group.sort(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) ||
            left.id.localeCompare(right.id),
        );
      }

      for (const digest of digests) {
        expect(storage.getContextDigestById(digest.id)).toEqual(digest);
        expect(storage.getContextDigestByScope(digest.scope)).toEqual(digest);
      }
      for (const scope of scopes) {
        expect(storage.getContextDigestByScope(scope)).toEqual(
          digestsByScope.get(exactScopeKey(scope)) ?? null,
        );
        expect(storage.listAuditEventsByScope(scope)).toEqual(
          auditsByScope.get(exactScopeKey(scope)) ?? [],
        );
      }

      const replaced = new Map<string, ContextDigest>();
      for (const index of [0, 7, 19, 43, 71, 95, 119]) {
        const digest = digests[index]!;
        const replacement = makeContextDigest(digest.id, digest.scope, {
          body: `Replacement sample ${index} — 再検証 🚀`,
          sourceReference: `mixed#replacement-${index}`,
          effectiveAt: "2026-08-11T09:00:00+09:00",
        });
        const stored = storage.replaceContextDigest(replacement);
        replaced.set(digest.id, stored);
        expect(stored).toEqual(replacement);
      }
      storage.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          for (const digest of digests) {
            expect(reopened.getContextDigestById(digest.id)).toEqual(
              replaced.get(digest.id) ?? digest,
            );
          }
          for (const scope of scopes) {
            expect(reopened.listAuditEventsByScope(scope)).toEqual(
              auditsByScope.get(exactScopeKey(scope)) ?? [],
            );
          }
          expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
        } finally {
          reopened.close();
        }
      }
    });
  });
});

interface CorruptionScenario {
  readonly index: number;
  readonly scope: ContextScope;
  readonly digest: ContextDigest;
  readonly event: AuditEvent;
  readonly digestCorrupt: boolean;
  readonly auditCorrupt: boolean;
  readonly duplicateId?: ContextDigestId;
}

describe("S0B2b 30-scenario combined corruption campaign", () => {
  it("fails only APIs that depend on each malformed exact scope", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const scenarios: CorruptionScenario[] = [];
      for (let index = 0; index < 30; index += 1) {
        const scope = ContextScopeSchema.parse({
          scopeType: "PROJECT",
          projectId: `prj_combined_${index}`,
        });
        storage.createProject(makeProject(scope.projectId, `combined-${index}`));
        const digest = makeContextDigest(`dgt_combined_${index}`, scope);
        const event = makeAuditEvent(`aud_combined_${index}`, scope);
        storage.createContextDigest(digest);
        storage.appendAuditEvent(event);
        const duplicate = index % 10 === 0 || index === 28 || index === 29;
        const digestCorrupt = duplicate || index < 8 || index >= 20;
        const auditCorrupt = (index >= 8 && index < 20) || index >= 20;
        scenarios.push({
          index,
          scope,
          digest,
          event,
          digestCorrupt,
          auditCorrupt,
          ...(duplicate
            ? {
                duplicateId: ContextDigestIdSchema.parse(
                  `dgt_combined_${index}_duplicate`,
                ),
              }
            : {}),
        });
      }
      const validScope = ContextScopeSchema.parse({
        scopeType: "PROJECT",
        projectId: "prj_combined_valid",
      });
      storage.createProject(makeProject(validScope.projectId, "combined-valid"));
      const validDigest = makeContextDigest("dgt_combined_valid", validScope);
      const validEvent = makeAuditEvent("aud_combined_valid", validScope);
      storage.createContextDigest(validDigest);
      storage.appendAuditEvent(validEvent);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.exec("DROP INDEX context_digests_project_scope_unique");
      const updateDigest = sqlite.prepare(
        "UPDATE context_digests SET body = ?, source_reference = ?, effective_at = ?, created_at = ?, updated_at = ? WHERE id = ?",
      );
      const updateAudit = sqlite.prepare(
        "UPDATE audit_events SET event_type = ?, actor_type = ?, actor_reference = ?, summary = ?, subject_reference = ?, occurred_at = ?, created_at = ? WHERE id = ?",
      );
      const cloneDigest = sqlite.prepare(
        `INSERT INTO context_digests
         SELECT ?, project_id, big_task_id, subtask_id, body, source_type,
                source_reference, effective_at, created_at, updated_at
         FROM context_digests WHERE id = ?`,
      );
      for (const scenario of scenarios) {
        const { index, digest, event, duplicateId } = scenario;
        if (duplicateId !== undefined) {
          cloneDigest.run(duplicateId, digest.id);
          if (index === 29) {
            sqlite
              .prepare("UPDATE context_digests SET body = ? WHERE id = ?")
              .run(" noncanonical duplicate ", duplicateId);
          }
        } else if (scenario.digestCorrupt) {
          const digestVariants = [
            [" padded digest ", digest.provenance.sourceReference, digest.provenance.effectiveAt],
            ["\tbroken\n", digest.provenance.sourceReference, digest.provenance.effectiveAt],
            [digest.body, " padded source ", digest.provenance.effectiveAt],
            [digest.body, "\tsource\n", digest.provenance.effectiveAt],
            [digest.body, digest.provenance.sourceReference, "2026-08-10T09:00:00.000+09:00"],
            ["🚀".repeat(4_001), digest.provenance.sourceReference, digest.provenance.effectiveAt],
          ] as const;
          const variant = digestVariants[index % digestVariants.length]!;
          updateDigest.run(
            variant[0],
            variant[1],
            variant[2],
            index % 4 === 0
              ? "2026-08-10T09:00:00.000+09:00"
              : "2026-08-09T00:00:00.000Z",
            index % 5 === 0
              ? "2026-08-10T09:00:00.000+09:00"
              : "2026-08-09T00:00:00.000Z",
            digest.id,
          );
        }

        if (scenario.auditCorrupt) {
          const auditVariants = [
            ["task_reviewed", event.actorType, event.actorReference, event.summary, event.subjectReference],
            ["TASK-REVIEWED", event.actorType, event.actorReference, event.summary, event.subjectReference],
            [event.eventType, "PROVIDER", event.actorReference, event.summary, event.subjectReference],
            [event.eventType, event.actorType, " padded actor ", event.summary, event.subjectReference],
            [event.eventType, event.actorType, "\t\n", event.summary, event.subjectReference],
            [event.eventType, event.actorType, event.actorReference, " padded summary ", event.subjectReference],
            [event.eventType, event.actorType, event.actorReference, "🚀".repeat(501), event.subjectReference],
            [event.eventType, event.actorType, event.actorReference, event.summary, " padded subject "],
          ] as const;
          const variant = auditVariants[index % auditVariants.length]!;
          updateAudit.run(
            variant[0],
            variant[1],
            variant[2] ?? null,
            variant[3],
            variant[4] ?? null,
            index % 3 === 0
              ? "2026-08-10T09:00:00.000+09:00"
              : event.occurredAt,
            index % 4 === 0
              ? "2026-08-10T09:00:00.000+09:00"
              : "2026-08-09T00:00:00.000Z",
            event.id,
          );
        }
      }
      sqlite.close();
      const beforeReads = snapshotS0B2b(databasePath);

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          for (const scenario of scenarios) {
            if (scenario.digestCorrupt) {
              expectMalformed(() =>
                reopened.getContextDigestById(scenario.digest.id),
              );
              expectMalformed(() =>
                reopened.getContextDigestByScope(scenario.scope),
              );
              if (scenario.duplicateId !== undefined) {
                expectMalformed(() =>
                  reopened.getContextDigestById(scenario.duplicateId!),
                );
              }
            } else {
              expect(reopened.getContextDigestById(scenario.digest.id)).toEqual(
                scenario.digest,
              );
            }

            if (scenario.auditCorrupt) {
              expectMalformed(() => reopened.getAuditEventById(scenario.event.id));
              expectMalformed(() =>
                reopened.listAuditEventsByScope(scenario.scope),
              );
            } else {
              expect(reopened.getAuditEventById(scenario.event.id)).toEqual(
                scenario.event,
              );
              expect(reopened.listAuditEventsByScope(scenario.scope)).toEqual([
                scenario.event,
              ]);
            }
          }
          expect(reopened.getContextDigestById(validDigest.id)).toEqual(validDigest);
          expect(reopened.getContextDigestByScope(validScope)).toEqual(validDigest);
          expect(reopened.getAuditEventById(validEvent.id)).toEqual(validEvent);
          expect(reopened.listAuditEventsByScope(validScope)).toEqual([validEvent]);
        } finally {
          reopened.close();
        }
      }
      expect(snapshotS0B2b(databasePath)).toEqual(beforeReads);
    });
  });
});
