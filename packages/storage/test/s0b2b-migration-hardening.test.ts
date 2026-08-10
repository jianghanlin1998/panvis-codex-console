import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ContextScopeSchema } from "@codex-task-console/domain";
import type {
  BigTaskId,
  ContextItem,
  ContextScope,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import {
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeContextItem,
  makeDependency,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const s0b1Migration = fileURLToPath(
  new URL("../drizzle/20260809002701_public_mephisto", import.meta.url),
);
const s0b2aMigration = fileURLToPath(
  new URL("../drizzle/20260809150746_groovy_iron_monger", import.meta.url),
);

const preexistingTables = [
  "projects",
  "big_tasks",
  "subtasks",
  "task_dependencies",
  "context_items",
] as const;

const snapshotTables = (
  databasePath: string,
): Readonly<Record<(typeof preexistingTables)[number], readonly unknown[]>> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      preexistingTables.map((table) => [
        table,
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ) as unknown as Readonly<
      Record<(typeof preexistingTables)[number], readonly unknown[]>
    >;
  } finally {
    sqlite.close();
  }
};

const schemaObjects = (databasePath: string): readonly string[] => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite
      .prepare(
        `SELECT type || ':' || name AS object
         FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all()
      .map((row) => (row as { object: string }).object);
  } finally {
    sqlite.close();
  }
};

describe("S0B2b migration hardening", () => {
  it("preserves a nontrivial accepted S0B2a database byte-for-byte", () => {
    withTemporaryDatabasePath((databasePath) => {
      const acceptedMigrations = join(dirname(databasePath), "accepted-s0b2a");
      mkdirSync(acceptedMigrations);
      for (const migration of [s0b1Migration, s0b2aMigration]) {
        cpSync(migration, join(acceptedMigrations, basename(migration)), {
          recursive: true,
        });
      }

      const before = openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: acceptedMigrations,
      });
      const scopes: ContextScope[] = [];
      const bigTaskIds: BigTaskId[] = [];
      const subtaskIdsByBigTask = new Map<BigTaskId, SubtaskId[]>();
      for (let projectIndex = 0; projectIndex < 5; projectIndex += 1) {
        const projectId = `prj_migration_hard_${projectIndex}`;
        before.createProject(
          makeProject(projectId, `migration-hard-${projectIndex}`),
        );
        scopes.push(ContextScopeSchema.parse({ scopeType: "PROJECT", projectId }));
        for (let bigTaskIndex = 0; bigTaskIndex < 3; bigTaskIndex += 1) {
          const bigTask = makeBigTask(
            `bt_migration_hard_${projectIndex}_${bigTaskIndex}`,
            projectId,
          );
          const bigTaskId = bigTask.id;
          before.createBigTask(bigTask);
          bigTaskIds.push(bigTaskId);
          scopes.push(
            ContextScopeSchema.parse({
              scopeType: "BIG_TASK",
              projectId,
              bigTaskId,
            }),
          );
          const subtaskIds: SubtaskId[] = [];
          for (let subtaskIndex = 0; subtaskIndex < 5; subtaskIndex += 1) {
            const subtask = makeSubtask(
              `st_migration_hard_${projectIndex}_${bigTaskIndex}_${subtaskIndex}`,
              bigTaskId,
            );
            const subtaskId = subtask.id;
            before.createSubtask(subtask);
            subtaskIds.push(subtaskId);
            scopes.push(
              ContextScopeSchema.parse({
                scopeType: "SUBTASK",
                projectId,
                bigTaskId,
                subtaskId,
              }),
            );
          }
          subtaskIdsByBigTask.set(bigTaskId, subtaskIds);
          before.replaceDependenciesForBigTask(
            bigTaskId,
            subtaskIds.slice(0, -1).map((upstreamId, index) =>
              makeDependency(
                upstreamId,
                subtaskIds[index + 1]!,
                index % 2 === 0 ? "BLOCKING" : "INFORMATIONAL",
              ),
            ),
          );
        }
      }

      const contextItems: ContextItem[] = [];
      for (let index = 0; index < 120; index += 1) {
        const scope = scopes[(index * 17) % scopes.length]!;
        const item = makeContextItem(
          `ctx_migration_standalone_${index.toString().padStart(3, "0")}`,
          scope,
          {
            title: `证据 Evidence ${index}`,
            body: `Accepted S0B2a evidence ${index}: 日本語・한국어・Résumé 🚀`,
            effectiveAt: `2026-08-09T00:${(index % 7)
              .toString()
              .padStart(2, "0")}:00.000Z`,
          },
        );
        before.createContextItem(item);
        contextItems.push(item);
      }
      const chains: ContextItem[][] = [];
      for (let chainIndex = 0; chainIndex < 10; chainIndex += 1) {
        const scope = scopes[(chainIndex * 13) % scopes.length]!;
        const root = makeContextItem(`ctx_migration_chain_${chainIndex}_0`, scope, {
          body: `Chain ${chainIndex} root 事实`,
          effectiveAt: "2026-08-09T03:00:00.000Z",
        });
        before.createContextItem(root);
        const middle = makeContextItem(`ctx_migration_chain_${chainIndex}_1`, scope, {
          body: `Chain ${chainIndex} middle 決定`,
          effectiveAt: "2026-08-09T03:00:00.000Z",
          supersedesContextItemId: root.id,
        });
        before.supersedeContextItem(middle);
        const tip = makeContextItem(`ctx_migration_chain_${chainIndex}_2`, scope, {
          body: `Chain ${chainIndex} tip 결정`,
          effectiveAt: "2026-08-09T03:00:00.000Z",
          supersedesContextItemId: middle.id,
        });
        before.supersedeContextItem(tip);
        chains.push([root, middle, tip]);
        contextItems.push(root, middle, tip);
      }
      expect(contextItems).toHaveLength(150);
      expect(bigTaskIds).toHaveLength(15);
      expect(
        [...subtaskIdsByBigTask.values()].flat(),
      ).toHaveLength(75);
      expect(
        bigTaskIds.flatMap((bigTaskId) =>
          before.listDependenciesForBigTask(bigTaskId),
        ),
      ).toHaveLength(60);
      const contextListsBefore = scopes.map((scope) => ({
        scope,
        items: before.listContextItemsByScope(scope),
      }));
      for (const { items } of contextListsBefore) {
        const ordered = [...items].sort(
          (left, right) =>
            left.provenance.effectiveAt.localeCompare(
              right.provenance.effectiveAt,
            ) || left.id.localeCompare(right.id),
        );
        expect(items).toEqual(ordered);
      }
      before.close();

      const dataBefore = snapshotTables(databasePath);
      const schemaBefore = schemaObjects(databasePath);
      expect(dataBefore.projects).toHaveLength(5);
      expect(dataBefore.big_tasks).toHaveLength(15);
      expect(dataBefore.subtasks).toHaveLength(75);
      expect(dataBefore.task_dependencies).toHaveLength(60);
      expect(dataBefore.context_items).toHaveLength(150);

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(snapshotTables(databasePath)).toEqual(dataBefore);
      const schemaAfter = schemaObjects(databasePath);
      expect(schemaAfter.filter((entry) => !schemaBefore.includes(entry))).toEqual([
        "index:audit_events_big_task_id_index",
        "index:audit_events_project_id_index",
        "index:audit_events_scope_occurred_at_id_index",
        "index:audit_events_subtask_id_index",
        "index:context_digests_big_task_id_index",
        "index:context_digests_project_id_index",
        "index:context_digests_subtask_id_index",
        "index:context_digests_big_task_scope_unique",
        "index:context_digests_project_scope_unique",
        "index:context_digests_subtask_scope_unique",
        "table:audit_events",
        "table:context_digests",
      ].sort());
      expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      for (const { scope, items } of contextListsBefore) {
        expect(migrated.listContextItemsByScope(scope)).toEqual(items);
      }

      for (const chain of chains) {
        expect(migrated.getContextItemById(chain[0]!.id)).toMatchObject({
          id: chain[0]!.id,
          status: "SUPERSEDED",
        });
        expect(migrated.getContextItemById(chain[1]!.id)).toMatchObject({
          id: chain[1]!.id,
          status: "SUPERSEDED",
        });
        expect(migrated.getContextItemById(chain[2]!.id)).toEqual(chain[2]);
      }
      const digestScope = scopes.at(-1)!;
      const digest = makeContextDigest("dgt_after_hardened_migration", digestScope);
      const event = makeAuditEvent("aud_after_hardened_migration", digestScope);
      expect(migrated.createContextDigest(digest)).toEqual(digest);
      expect(migrated.appendAuditEvent(event)).toEqual(event);
      migrated.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(snapshotTables(databasePath)).toEqual(dataBefore);
          expect(reopened.getContextDigestById(digest.id)).toEqual(digest);
          expect(reopened.getContextDigestByScope(digestScope)).toEqual(digest);
          expect(reopened.getAuditEventById(event.id)).toEqual(event);
          expect(reopened.listAuditEventsByScope(digestScope)).toEqual([event]);
          expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
          for (const { scope, items } of contextListsBefore) {
            expect(reopened.listContextItemsByScope(scope)).toEqual(items);
          }
          expect(
            bigTaskIds.flatMap((bigTaskId) =>
              reopened.listDependenciesForBigTask(bigTaskId),
            ),
          ).toHaveLength(60);
        } finally {
          reopened.close();
        }
      }

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          (
            sqlite
              .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
              .get() as { count: number }
          ).count,
        ).toBe(3);
      } finally {
        sqlite.close();
      }
    });
  });
});
