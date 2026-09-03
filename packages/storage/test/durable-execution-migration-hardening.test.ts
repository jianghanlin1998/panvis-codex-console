import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ChatThreadIdSchema,
  ContextScopeSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
} from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import {
  createHierarchy,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeContextItem,
  makeDependency,
  makeImplementationCheckpoint,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const migrationNames = [
  "20260809002701_public_mephisto",
  "20260809150746_groovy_iron_monger",
  "20260810133952_messy_shatterstar",
  "20260810161248_crazy_lightspeed",
  "20260811143107_spicy_apocalypse",
  "20260830145904_tough_puma",
  "20260830155716_spicy_dust",
] as const;

const migrations = migrationNames.map((name) =>
  fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url)),
);
const priorBoundaryMigrations = migrations.slice(0, 5);
const preRepairMigrations = migrations.slice(0, 6);
const TIME = "2041-11-12T13:14:15.016Z";
const clock = (): Date => new Date(TIME);

const copyMigrationPrefix = (
  databasePath: string,
  folderName: string,
  sourceMigrations: readonly string[],
): string => {
  const target = join(dirname(databasePath), folderName);
  mkdirSync(target);
  for (const source of sourceMigrations) {
    cpSync(source, join(target, basename(source)), { recursive: true });
  }
  return target;
};

const applicationTables = [
  "projects",
  "big_tasks",
  "subtasks",
  "task_dependencies",
  "subtask_implementation_checkpoints",
  "context_items",
  "context_digests",
  "audit_events",
] as const;

const snapshotTables = (
  databasePath: string,
  tables: readonly string[] = applicationTables,
): Readonly<Record<string, readonly unknown[]>> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    sqlite.close();
  }
};

describe("Durable Execution V0 migration hardening", () => {
  it("runs the fresh chain with the expected durable structures and normal operations", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock });
      expect(storage.isForeignKeyEnforcementEnabled()).toBe(true);
      createHierarchy(storage);
      const chatThreadId = ChatThreadIdSchema.parse("thr_fresh_hardening");
      const executionRunId = ExecutionRunIdSchema.parse("run_fresh_hardening");
      const providerId = ExecutionProviderIdSchema.parse("provider-fresh");
      storage.createChatThread({
        id: chatThreadId,
        subtaskId: makeSubtask("st_a").id,
        providerId,
      });
      storage.bindChatThreadProviderReference({
        chatThreadId,
        providerThread: ProviderThreadReferenceSchema.parse({
          providerId,
          providerThreadId: "fresh-provider-thread",
        }),
      });
      storage.createExecutionRun({ id: executionRunId, chatThreadId });
      storage.startExecutionRun({
        executionRunId,
        providerRun: ProviderRunReferenceSchema.parse({
          providerId,
          providerThreadId: "fresh-provider-thread",
          providerRunId: "fresh-provider-run",
        }),
      });
      storage.finishExecutionRun({
        executionRunId,
        status: "SUCCEEDED",
        normalizedUsage: {},
      });
      storage.closeChatThread(chatThreadId);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const tables = sqlite
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => (row as { readonly name: string }).name);
        expect(tables).toEqual([
          "__drizzle_migrations",
          "audit_events",
          "big_tasks",
          "candidate_task_contract_bindings",
          "canonical_task_materializations",
          "chat_threads",
          "context_digests",
          "context_items",
          "durable_workflow_evidence",
          "durable_workflow_evidence_authorities",
          "durable_workflow_human_requirements",
          "durable_workflow_transitions",
          "execution_runs",
          "governed_big_task_completion_receipts",
          "governed_budget_extensions",
          "governed_dispatch_receipts",
          "governed_finding_resolutions",
          "governed_findings",
          "governed_handoffs",
          "governed_manual_start_authorities",
          "governed_promoted_context_dispositions",
          "governed_role_authorizations",
          "governed_role_execution_links",
          "governed_role_results",
          "orchestration_materializations",
          "orchestration_plan_candidates",
          "orchestration_planning_tracks",
          "orchestration_review_decisions",
          "projects",
          "subtask_implementation_checkpoints",
          "subtask_workflow_instances",
          "subtasks",
          "task_contracts",
          "task_dependencies",
          "workflow_initialization_receipts",
          "worktree_checkout_generations",
          "worktree_ownerships",
        ]);
        expect(
          sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
        ).toEqual({ count: 17 });
        const indexes = sqlite
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name IN ('chat_threads', 'execution_runs') ORDER BY name",
          )
          .all()
          .map((row) => (row as { readonly name: string }).name);
        expect(indexes).toEqual(
          expect.arrayContaining([
            "chat_threads_provider_thread_unique",
            "chat_threads_subtask_order_index",
            "execution_runs_provider_run_unique",
            "execution_runs_thread_order_index",
          ]),
        );
        expect(sqlite.prepare("PRAGMA foreign_key_list(chat_threads)").all()).toHaveLength(1);
        expect(sqlite.prepare("PRAGMA foreign_key_list(execution_runs)").all()).toHaveLength(1);
        const durableSql = sqlite
          .prepare(
            "SELECT group_concat(sql, ' ') AS sql FROM sqlite_schema WHERE name IN ('chat_threads', 'execution_runs')",
          )
          .get() as { readonly sql: string };
        expect(durableSql.sql).toMatch(/chat_threads_lifecycle_check/);
        expect(durableSql.sql).toMatch(/execution_runs_usage_check/);
        expect(durableSql.sql).toMatch(/execution_runs_lifecycle_check/);
      } finally {
        sqlite.close();
      }

      const reopened = openTaskDatabase({ databasePath, clock });
      try {
        expect(reopened.getChatThreadById(chatThreadId)?.status).toBe("CLOSED");
        expect(reopened.getExecutionRunById(executionRunId)?.normalizedUsage).toEqual({});
        expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
      } finally {
        reopened.close();
      }
    });
  });

  it("upgrades the exact tough_puma prior boundary without changing existing rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = copyMigrationPrefix(
        databasePath,
        "exact-prior-boundary",
        priorBoundaryMigrations,
      );
      const prior = openTaskDatabase({
        databasePath,
        clock,
        migrationsFolder: priorFolder,
      });
      const project = makeProject("prj_prior_hard", "prior-hard");
      const bigTask = makeBigTask("bt_prior_hard", project.id);
      const target = makeSubtask("st_prior_target", bigTask.id, "IN_PROGRESS");
      const peer = makeSubtask("st_prior_peer", bigTask.id);
      const dependency = makeDependency(
        target.id,
        peer.id,
        "INFORMATIONAL",
        "NONE",
        "Prior-boundary informational evidence.",
      );
      const scope = ContextScopeSchema.parse({
        scopeType: "SUBTASK",
        projectId: project.id,
        bigTaskId: bigTask.id,
        subtaskId: target.id,
      });
      const contextItems = [
        makeContextItem("ctx_prior_hard_z", scope, { body: "Boundary zeta." }),
        makeContextItem("ctx_prior_hard_a", scope, { body: "Boundary alpha." }),
      ];
      const digest = makeContextDigest("dgt_prior_hard", scope, {
        body: "Boundary digest with distinct content.",
      });
      const auditEvents = [
        makeAuditEvent("aud_prior_hard_z", scope, {
          occurredAt: "2041-11-12T13:14:15.015Z",
        }),
        makeAuditEvent("aud_prior_hard_a", scope, {
          occurredAt: "2041-11-12T13:14:15.014Z",
        }),
      ];
      const checkpoint = makeImplementationCheckpoint(
        "icp_prior_hard",
        target.id,
        { repositoryCommitSha: "b".repeat(40) },
      );
      prior.createProject(project);
      prior.createBigTask(bigTask);
      prior.createSubtask(peer);
      prior.createSubtask(target);
      prior.replaceDependenciesForBigTask(bigTask.id, [dependency]);
      contextItems.forEach((item) => prior.createContextItem(item));
      prior.createContextDigest(digest);
      auditEvents.forEach((event) => prior.appendAuditEvent(event));
      prior.completeSubtaskImplementation({ subtaskId: target.id, checkpoint });
      prior.close();

      const before = snapshotTables(databasePath);
      const migrated = openTaskDatabase({ databasePath, clock });
      expect(snapshotTables(databasePath)).toEqual(before);
      expect(migrated.getProjectById(project.id)).toEqual(project);
      expect(migrated.listDependenciesForBigTask(bigTask.id)).toEqual([dependency]);
      expect(migrated.getContextItemById(contextItems[0]!.id)).toEqual(contextItems[0]);
      expect(migrated.getContextDigestById(digest.id)).toEqual(digest);
      expect(migrated.listAuditEventsByScope(scope)).toEqual([
        auditEvents[1],
        auditEvents[0],
      ]);
      expect(migrated.getSubtaskImplementationCheckpointById(checkpoint.id)).toEqual(
        checkpoint,
      );

      const chatThreadId = ChatThreadIdSchema.parse("thr_prior_upgraded");
      const executionRunId = ExecutionRunIdSchema.parse("run_prior_upgraded");
      migrated.createChatThread({
        id: chatThreadId,
        subtaskId: target.id,
        providerId: ExecutionProviderIdSchema.parse("provider-upgrade"),
      });
      migrated.createExecutionRun({ id: executionRunId, chatThreadId });
      const expectedRun = migrated.failExecutionRunBeforeStart(executionRunId);
      migrated.close();

      const reopened = openTaskDatabase({ databasePath, clock });
      try {
        expect(snapshotTables(databasePath)).toEqual(before);
        expect(reopened.getExecutionRunById(executionRunId)).toEqual(expectedRun);
        expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
      } finally {
        reopened.close();
      }
    });
  });

  it("reruns initialization as a ledger no-op without durable data loss", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock });
      createHierarchy(first);
      const id = ChatThreadIdSchema.parse("thr_repeat_migration");
      first.createChatThread({
        id,
        subtaskId: makeSubtask("st_a").id,
        providerId: ExecutionProviderIdSchema.parse("provider-repeat"),
      });
      first.close();
      const before = snapshotTables(databasePath, [
        ...applicationTables,
        "chat_threads",
        "execution_runs",
      ]);

      openTaskDatabase({ databasePath, clock }).close();
      openTaskDatabase({ databasePath, clock }).close();
      expect(
        snapshotTables(databasePath, [
          ...applicationTables,
          "chat_threads",
          "execution_runs",
        ]),
      ).toEqual(before);
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 17 });
      sqlite.close();
    });
  });

  it("rolls back a failed tough_puma migration and preserves prior user data", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = copyMigrationPrefix(
        databasePath,
        "failed-prior-boundary",
        priorBoundaryMigrations,
      );
      const prior = openTaskDatabase({
        databasePath,
        clock,
        migrationsFolder: priorFolder,
      });
      const project = makeProject("prj_failed_migration", "failed-migration");
      const bigTask = makeBigTask("bt_failed_migration", project.id);
      const subtask = makeSubtask("st_failed_migration", bigTask.id);
      prior.createProject(project);
      prior.createBigTask(bigTask);
      prior.createSubtask(subtask);
      prior.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("CREATE TABLE execution_runs (sentinel TEXT NOT NULL)");
      sqlite.prepare("INSERT INTO execution_runs (sentinel) VALUES (?)").run(
        "collision-state-must-survive",
      );
      sqlite.close();
      const before = snapshotTables(databasePath, [
        "projects",
        "big_tasks",
        "subtasks",
        "execution_runs",
      ]);

      let thrown: unknown;
      try {
        openTaskDatabase({ databasePath, clock });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TaskStorageError);
      expect(thrown).toMatchObject({
        code: "MIGRATION_FAILED",
        message: "Task database migration failed.",
      });
      expect((thrown as Error).message).not.toMatch(/collision|execution_runs|sqlite/i);
      expect(snapshotTables(databasePath, [
        "projects",
        "big_tasks",
        "subtasks",
        "execution_runs",
      ])).toEqual(before);

      const verified = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        verified.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 5 });
      expect(
        verified
          .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'chat_threads'")
          .get(),
      ).toEqual({ count: 0 });
      expect(verified.prepare("SELECT * FROM execution_runs").all()).toEqual([
        { sentinel: "collision-state-must-survive" },
      ]);
      verified.close();

      expect(() => openTaskDatabase({ databasePath, clock })).toThrow(
        expect.objectContaining({ code: "MIGRATION_FAILED" }),
      );
    });
  });

  it("adds provider-run uniqueness forward while preserving existing tough_puma data", () => {
    withTemporaryDatabasePath((databasePath) => {
      const preRepairFolder = copyMigrationPrefix(
        databasePath,
        "pre-provider-run-repair",
        preRepairMigrations,
      );
      const beforeRepair = openTaskDatabase({
        databasePath,
        clock,
        migrationsFolder: preRepairFolder,
      });
      createHierarchy(beforeRepair);
      const threadId = ChatThreadIdSchema.parse("thr_pre_repair");
      const firstRunId = ExecutionRunIdSchema.parse("run_pre_repair_a");
      const secondRunId = ExecutionRunIdSchema.parse("run_pre_repair_b");
      const providerId = ExecutionProviderIdSchema.parse("provider-repair");
      const threadReference = ProviderThreadReferenceSchema.parse({
        providerId,
        providerThreadId: "repair-thread",
      });
      beforeRepair.createChatThread({
        id: threadId,
        subtaskId: makeSubtask("st_a").id,
        providerId,
      });
      beforeRepair.bindChatThreadProviderReference({
        chatThreadId: threadId,
        providerThread: threadReference,
      });
      beforeRepair.createExecutionRun({ id: firstRunId, chatThreadId: threadId });
      beforeRepair.startExecutionRun({
        executionRunId: firstRunId,
        providerRun: ProviderRunReferenceSchema.parse({
          ...threadReference,
          providerRunId: "repair-run-a",
        }),
      });
      const expectedRun = beforeRepair.finishExecutionRun({
        executionRunId: firstRunId,
        status: "SUCCEEDED",
        normalizedUsage: {},
      });
      beforeRepair.createExecutionRun({ id: secondRunId, chatThreadId: threadId });
      beforeRepair.close();
      const before = snapshotTables(databasePath, ["chat_threads", "execution_runs"]);

      const repaired = openTaskDatabase({ databasePath, clock });
      try {
        expect(snapshotTables(databasePath, ["chat_threads", "execution_runs"])).toEqual(
          before,
        );
        expect(repaired.getExecutionRunById(firstRunId)).toEqual(expectedRun);
        expect(() =>
          repaired.startExecutionRun({
            executionRunId: secondRunId,
            providerRun: ProviderRunReferenceSchema.parse({
              ...threadReference,
              providerRunId: "repair-run-a",
            }),
          }),
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      } finally {
        repaired.close();
      }

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'execution_runs_provider_run_unique'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 17 });
      sqlite.close();
    });
  });

  it("fails the repair migration without rewriting ambiguous pre-repair provider runs", () => {
    withTemporaryDatabasePath((databasePath) => {
      const preRepairFolder = copyMigrationPrefix(
        databasePath,
        "ambiguous-pre-provider-run-repair",
        preRepairMigrations,
      );
      const storage = openTaskDatabase({
        databasePath,
        clock,
        migrationsFolder: preRepairFolder,
      });
      createHierarchy(storage);
      const threadId = ChatThreadIdSchema.parse("thr_ambiguous_repair");
      const providerId = ExecutionProviderIdSchema.parse("provider-ambiguous");
      const providerThread = ProviderThreadReferenceSchema.parse({
        providerId,
        providerThreadId: "ambiguous-thread",
      });
      storage.createChatThread({
        id: threadId,
        subtaskId: makeSubtask("st_a").id,
        providerId,
      });
      storage.bindChatThreadProviderReference({ chatThreadId: threadId, providerThread });
      for (const suffix of ["a", "b"] as const) {
        const id = ExecutionRunIdSchema.parse(`run_ambiguous_${suffix}`);
        storage.createExecutionRun({ id, chatThreadId: threadId });
        storage.startExecutionRun({
          executionRunId: id,
          providerRun: ProviderRunReferenceSchema.parse({
            ...providerThread,
            providerRunId: `ambiguous-run-${suffix}`,
          }),
        });
      }
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE execution_runs SET provider_run_id = ? WHERE id = ?")
        .run("ambiguous-run-a", "run_ambiguous_b");
      sqlite.close();
      const before = snapshotTables(databasePath, ["chat_threads", "execution_runs"]);

      expect(() => openTaskDatabase({ databasePath, clock })).toThrow(
        expect.objectContaining({
          code: "MIGRATION_FAILED",
          message: "Task database migration failed.",
        }),
      );
      expect(snapshotTables(databasePath, ["chat_threads", "execution_runs"])).toEqual(
        before,
      );
      const verified = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        verified.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 6 });
      expect(
        verified
          .prepare(
            "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'execution_runs_provider_run_unique'",
          )
          .get(),
      ).toEqual({ count: 0 });
      verified.close();
    });
  });
});
