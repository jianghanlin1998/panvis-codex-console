import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ContextItemSchema, ContextScopeSchema } from "@codex-task-console/domain";
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
import {
  insertLegacyAuditEvent,
  insertLegacyBigTask,
  insertLegacyContextDigest,
  insertLegacyContextItem,
  insertLegacyDependency,
  insertLegacyProject,
  insertLegacySubtask,
  migratedLegacyDependency,
} from "./legacy-fixtures.js";

const acceptedMigrations = [
  "20260809002701_public_mephisto",
  "20260809150746_groovy_iron_monger",
  "20260810133952_messy_shatterstar",
].map((name) => fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url)));

const legacyColumns = {
  projects: "*",
  big_tasks: "*",
  subtasks: `id, big_task_id, title, goal, scope_in, scope_out,
    acceptance_criteria, untouched_areas, status, start_policy,
    delegation_policy, recommended_reasoning_level, prompt_seed,
    created_at, updated_at`,
  task_dependencies: `upstream_subtask_id, downstream_subtask_id,
    dependency_type, created_at`,
  context_items: "*",
  context_digests: "*",
  audit_events: "*",
} as const;

const snapshotLegacyColumns = (
  databasePath: string,
): Readonly<Record<keyof typeof legacyColumns, readonly unknown[]>> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      Object.entries(legacyColumns).map(([table, columns]) => [
        table,
        sqlite.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all(),
      ]),
    ) as unknown as Readonly<
      Record<keyof typeof legacyColumns, readonly unknown[]>
    >;
  } finally {
    sqlite.close();
  }
};

describe("S1A migration from the accepted S0B2b foundation", () => {
  it("preserves old durable data while adding explicit conservative maturity and gates", () => {
    withTemporaryDatabasePath((databasePath) => {
      const preS1AMigrations = join(dirname(databasePath), "accepted-pre-s1a");
      mkdirSync(preS1AMigrations);
      for (const migration of acceptedMigrations) {
        cpSync(migration, join(preS1AMigrations, basename(migration)), {
          recursive: true,
        });
      }
      openTaskDatabase({
        databasePath,
        clock: fixedClock,
        migrationsFolder: preS1AMigrations,
      }).close();

      const projects = Array.from({ length: 5 }, (_, projectIndex) =>
        makeProject(`prj_s1a_migration_${projectIndex}`, `s1a-migration-${projectIndex}`),
      );
      const bigTasks = projects.flatMap((project, projectIndex) =>
        Array.from({ length: 3 }, (_, bigTaskIndex) =>
          makeBigTask(`bt_s1a_migration_${projectIndex}_${bigTaskIndex}`, project.id),
        ),
      );
      const statuses = [
        "TODO",
        "IN_PROGRESS",
        "QA_DEBUG",
        "DONE",
        "DROPPED",
        "ARCHIVED",
      ] as const;
      const subtasks = bigTasks.flatMap((bigTask, bigTaskIndex) =>
        Array.from({ length: 5 }, (_, subtaskIndex) =>
          makeSubtask(
            `st_s1a_migration_${bigTaskIndex}_${subtaskIndex}`,
            bigTask.id,
            statuses[(bigTaskIndex + subtaskIndex) % statuses.length],
          ),
        ),
      );
      const subtaskIdsByBigTask = new Map<BigTaskId, readonly SubtaskId[]>(
        bigTasks.map((bigTask) => [
          bigTask.id,
          subtasks
            .filter(({ bigTaskId }) => bigTaskId === bigTask.id)
            .map(({ id }) => id),
        ]),
      );
      const dependencies = bigTasks.flatMap((bigTask) => {
        const ids = subtaskIdsByBigTask.get(bigTask.id)!;
        return ids.slice(0, -1).map((upstreamSubtaskId, index) =>
          makeDependency(
            upstreamSubtaskId,
            ids[index + 1]!,
            index % 2 === 0 ? "BLOCKING" : "INFORMATIONAL",
          ),
        );
      });

      const scopes: ContextScope[] = projects.map((project) =>
        ContextScopeSchema.parse({ scopeType: "PROJECT", projectId: project.id }),
      );
      for (const bigTask of bigTasks) {
        scopes.push(
          ContextScopeSchema.parse({
            scopeType: "BIG_TASK",
            projectId: bigTask.projectId,
            bigTaskId: bigTask.id,
          }),
        );
      }
      for (const subtask of subtasks) {
        const bigTask = bigTasks.find(({ id }) => id === subtask.bigTaskId)!;
        scopes.push(
          ContextScopeSchema.parse({
            scopeType: "SUBTASK",
            projectId: bigTask.projectId,
            bigTaskId: bigTask.id,
            subtaskId: subtask.id,
          }),
        );
      }

      const contextItems: ContextItem[] = Array.from({ length: 120 }, (_, index) =>
        makeContextItem(
          `ctx_s1a_migration_${index.toString().padStart(3, "0")}`,
          scopes[(index * 17) % scopes.length]!,
          {
            title: `Evidence ${index} 事实`,
            body: `Accepted evidence ${index}: 日本語・한국어・Résumé 🚀`,
            effectiveAt: `2026-08-09T00:${(index % 7)
              .toString()
              .padStart(2, "0")}:00.000Z`,
          },
        ),
      );
      const chains: ContextItem[][] = [];
      for (let chainIndex = 0; chainIndex < 10; chainIndex += 1) {
        const scope = scopes[(chainIndex * 13) % scopes.length]!;
        const root = ContextItemSchema.parse({
          ...makeContextItem(`ctx_s1a_chain_${chainIndex}_0`, scope),
          status: "SUPERSEDED",
        });
        const middle = ContextItemSchema.parse({
          ...makeContextItem(`ctx_s1a_chain_${chainIndex}_1`, scope, {
            supersedesContextItemId: root.id,
          }),
          status: "SUPERSEDED",
        });
        const tip = makeContextItem(`ctx_s1a_chain_${chainIndex}_2`, scope, {
          supersedesContextItemId: middle.id,
        });
        chains.push([root, middle, tip]);
        contextItems.push(root, middle, tip);
      }

      const digestScopes = [scopes[0]!, scopes[5]!, scopes.at(-1)!];
      const digests = digestScopes.map((scope, index) =>
        makeContextDigest(`dgt_s1a_migration_${index}`, scope),
      );
      const auditEvents = digestScopes.flatMap((scope, scopeIndex) =>
        Array.from({ length: 2 }, (_, eventIndex) =>
          makeAuditEvent(`aud_s1a_migration_${scopeIndex}_${eventIndex}`, scope, {
            occurredAt: `2026-08-09T0${scopeIndex}:${eventIndex}0:00.000Z`,
          }),
        ),
      );

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      projects.forEach((project) => insertLegacyProject(sqlite, project));
      bigTasks.forEach((bigTask) => insertLegacyBigTask(sqlite, bigTask));
      subtasks.forEach((subtask) => insertLegacySubtask(sqlite, subtask));
      dependencies.forEach((dependency) => insertLegacyDependency(sqlite, dependency));
      contextItems.forEach((contextItem) => insertLegacyContextItem(sqlite, contextItem));
      digests.forEach((digest) => insertLegacyContextDigest(sqlite, digest));
      auditEvents.forEach((event) => insertLegacyAuditEvent(sqlite, event));
      sqlite.close();

      expect(projects).toHaveLength(5);
      expect(bigTasks).toHaveLength(15);
      expect(subtasks).toHaveLength(75);
      expect(dependencies).toHaveLength(60);
      expect(contextItems).toHaveLength(150);
      expect(digests).toHaveLength(3);
      expect(auditEvents).toHaveLength(6);
      const durableBefore = snapshotLegacyColumns(databasePath);

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(snapshotLegacyColumns(databasePath)).toEqual(durableBefore);
      expect(
        bigTasks.flatMap(({ id }) => migrated.listSubtasksByBigTask(id)),
      ).toEqual(subtasks);
      expect(
        bigTasks.flatMap(({ id }) => migrated.listDependenciesForBigTask(id)),
      ).toEqual(dependencies.map(migratedLegacyDependency));
      for (const chain of chains) {
        expect(migrated.getContextItemById(chain[0]!.id)).toEqual(chain[0]);
        expect(migrated.getContextItemById(chain[1]!.id)).toEqual(chain[1]);
        expect(migrated.getContextItemById(chain[2]!.id)).toEqual(chain[2]);
      }
      digests.forEach((digest) =>
        expect(migrated.getContextDigestById(digest.id)).toEqual(digest),
      );
      for (const event of auditEvents) {
        expect(migrated.getAuditEventById(event.id)).toEqual(event);
      }
      expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      migrated.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(snapshotLegacyColumns(databasePath)).toEqual(durableBefore);
          expect(reopened.listSubtasksByBigTask(bigTasks[0]!.id)).toEqual(
            subtasks.filter(({ bigTaskId }) => bigTaskId === bigTasks[0]!.id),
          );
          expect(reopened.getContextDigestById(digests[0]!.id)).toEqual(digests[0]);
          expect(reopened.listAuditEventsByScope(digestScopes[0]!)).toEqual(
            auditEvents.slice(0, 2),
          );
          expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
        } finally {
          reopened.close();
        }
      }

      const verified = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const maturities = verified
          .prepare("SELECT DISTINCT maturity FROM subtasks ORDER BY maturity")
          .all();
        expect(maturities).toEqual([{ maturity: "NOT_STARTED" }]);
        expect(
          verified
            .prepare(
              "SELECT count(*) AS count FROM subtasks WHERE status = 'DONE' AND maturity <> 'NOT_STARTED'",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(
          verified.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
        ).toEqual({ count: 14 });
        expect(
          verified
            .prepare(
              "SELECT count(*) AS count FROM subtask_implementation_checkpoints",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(
          verified
            .prepare(
              "SELECT count(*) AS count FROM sqlite_schema WHERE name = '__new_task_dependencies'",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        verified.close();
      }
    });
  });
});
