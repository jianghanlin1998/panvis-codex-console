import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuditEventSchema,
  BigTaskSchema,
  ContextDigestSchema,
  ContextItemSchema,
  ContextScopeSchema,
  ProjectSchema,
  SubtaskDependencySchema,
  SubtaskCreateInputSchema,
  SubtaskImplementationCheckpointSchema,
} from "@codex-task-console/domain";
import type {
  AuditActorType,
  AuditEvent,
  BigTask,
  ContextDigest,
  ContextItem,
  ContextItemId,
  ContextScope,
  ContextStatus,
  Project,
  SubtaskCreateInput,
  SubtaskDependency,
  SubtaskImplementationCheckpoint,
} from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";

// Current-schema assertions only. Historical and failed-migration counts stay pinned separately.
export const EXPECTED_CURRENT_MIGRATION_COUNT = 28;

// Explicit current table inventory, independent from generated/runtime schema.
export const EXPECTED_CURRENT_TABLES = [
  "__drizzle_migrations",
  "audit_events",
  "big_task_execution_approvals",
  "big_task_execution_events",
  "big_tasks",
  "candidate_task_contract_bindings",
  "canonical_task_materializations",
  "chat_threads",
  "console_discussion_turns",
  "console_drafts",
  "context_digests",
  "context_items",
  "durable_workflow_evidence",
  "durable_workflow_evidence_authorities",
  "durable_workflow_human_requirements",
  "durable_workflow_transitions",
  "execution_run_progress",
  "execution_runs",
  "governed_big_task_completion_receipts",
  "governed_budget_extensions",
  "governed_dispatch_gate_snapshots",
  "governed_dispatch_receipts",
  "governed_finding_resolutions",
  "governed_findings",
  "governed_gate_observations",
  "governed_gate_sources",
  "governed_handoffs",
  "governed_manual_start_authorities",
  "governed_promoted_context_dispositions",
  "governed_promotion_candidates",
  "governed_provider_claims",
  "governed_provider_input_observations",
  "governed_provider_turn_starts",
  "governed_result_provenance",
  "governed_role_authorizations",
  "governed_role_execution_links",
  "governed_role_results",
  "live_planning_intakes",
  "live_planning_runs",
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
] as const;

export const FIXED_TIME = "2026-08-09T00:00:00.000Z";
export const fixedClock = (): Date => new Date(FIXED_TIME);

export const makeProject = (id = "prj_console", slug = "codex-task-console"): Project =>
  ProjectSchema.parse({
    recordType: "PROJECT",
    id,
    name: `Project ${id}`,
    slug,
    repository: { kind: "PATH", path: `/repositories/${slug}` },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });

export const makeBigTask = (
  id = "bt_v1",
  projectId = "prj_console",
  status: "IN_PROGRESS" | "DONE" = "IN_PROGRESS",
): BigTask =>
  BigTaskSchema.parse({
    recordType: "BIG_TASK",
    id,
    projectId,
    title: `Big Task ${id}`,
    goal: `Goal ${id}`,
    rationale: `Rationale ${id}`,
    scopeIn: ["Core task storage", id],
    scopeOut: ["Deferred capabilities"],
    acceptanceCriteria: ["Round-trips exactly"],
    status,
  });

export const makeSubtask = (
  id = "st_a",
  bigTaskId = "bt_v1",
  status: "TODO" | "IN_PROGRESS" | "QA_DEBUG" | "DONE" | "DROPPED" | "ARCHIVED" =
    "TODO",
): SubtaskCreateInput =>
  SubtaskCreateInputSchema.parse({
    recordType: "SUBTASK",
    id,
    bigTaskId,
    title: `Subtask ${id}`,
    goal: `Goal ${id}`,
    scopeIn: ["Persist", id],
    scopeOut: ["Run Codex"],
    acceptanceCriteria: ["Data round-trips"],
    untouchedAreas: ["Panvis"],
    status,
    maturity: "NOT_STARTED",
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
    promptSeed: `Stable intent for ${id}`,
  });

export const makeDependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  dependencyType: "BLOCKING" | "INFORMATIONAL" = "BLOCKING",
  requiredGate: "NONE" | "HARDENED" | "ACCEPTED" =
    dependencyType === "BLOCKING" ? "ACCEPTED" : "NONE",
  reason = `Dependency ${upstreamSubtaskId} -> ${downstreamSubtaskId}.`,
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType,
    requiredGate,
    reason,
  });

interface MakeContextItemOptions {
  readonly status?: ContextStatus;
  readonly effectiveAt?: string;
  readonly supersedesContextItemId?: ContextItemId;
  readonly title?: string;
  readonly body?: string;
}

export const makeContextItem = (
  id = "ctx_a",
  scope: ContextScope = ContextScopeSchema.parse({
    scopeType: "BIG_TASK",
    projectId: "prj_console",
    bigTaskId: "bt_v1",
  }),
  options: MakeContextItemOptions = {},
): ContextItem =>
  ContextItemSchema.parse({
    id,
    projectId: scope.projectId,
    ...(scope.scopeType === "PROJECT" ? {} : { bigTaskId: scope.bigTaskId }),
    ...(scope.scopeType === "SUBTASK" ? { subtaskId: scope.subtaskId } : {}),
    kind: "ENGINEERING_FACT",
    status: options.status ?? "ACTIVE",
    authority: "REPO_EVIDENCE",
    title: options.title ?? `Context ${id}`,
    body: options.body ?? `Compact body for ${id}.`,
    provenance: {
      sourceType: "REPO",
      sourceReference: `repository#${id}`,
      effectiveAt: options.effectiveAt ?? FIXED_TIME,
      ...(options.supersedesContextItemId === undefined
        ? {}
        : { supersedesContextItemId: options.supersedesContextItemId }),
    },
  });

interface MakeContextDigestOptions {
  readonly body?: string;
  readonly effectiveAt?: string;
  readonly sourceReference?: string;
}

export const makeContextDigest = (
  id = "dgt_current",
  scope: ContextScope = ContextScopeSchema.parse({
    scopeType: "BIG_TASK",
    projectId: "prj_console",
    bigTaskId: "bt_v1",
  }),
  options: MakeContextDigestOptions = {},
): ContextDigest =>
  ContextDigestSchema.parse({
    id,
    scope,
    body: options.body ?? `Compact digest for ${id}.`,
    provenance: {
      sourceType: "SYSTEM",
      sourceReference: options.sourceReference ?? `digest-source#${id}`,
      effectiveAt: options.effectiveAt ?? FIXED_TIME,
    },
  });

interface MakeAuditEventOptions {
  readonly actorType?: AuditActorType;
  readonly eventType?: string;
  readonly occurredAt?: string;
  readonly actorReference?: string;
  readonly subjectReference?: string;
  readonly summary?: string;
}

export const makeAuditEvent = (
  id = "aud_task_created",
  scope: ContextScope = ContextScopeSchema.parse({
    scopeType: "BIG_TASK",
    projectId: "prj_console",
    bigTaskId: "bt_v1",
  }),
  options: MakeAuditEventOptions = {},
): AuditEvent =>
  AuditEventSchema.parse({
    id,
    scope,
    eventType: options.eventType ?? "TASK_CREATED",
    actorType: options.actorType ?? "CODEX",
    ...(options.actorReference === undefined
      ? { actorReference: "codex-session-1" }
      : { actorReference: options.actorReference }),
    summary: options.summary ?? `Audit summary for ${id}.`,
    ...(options.subjectReference === undefined
      ? { subjectReference: scope.scopeType === "PROJECT" ? scope.projectId : scope.bigTaskId }
      : { subjectReference: options.subjectReference }),
    occurredAt: options.occurredAt ?? FIXED_TIME,
  });

interface MakeImplementationCheckpointOptions {
  readonly actorType?: AuditActorType;
  readonly actorReference?: string;
  readonly repositoryCommitSha?: string;
  readonly sourceReference?: string;
  readonly summary?: string;
  readonly occurredAt?: string;
}

export const makeImplementationCheckpoint = (
  id = "icp_initial_implementation",
  subtaskId = "st_a",
  options: MakeImplementationCheckpointOptions = {},
): SubtaskImplementationCheckpoint =>
  SubtaskImplementationCheckpointSchema.parse({
    id,
    subtaskId,
    repositoryCommitSha: options.repositoryCommitSha ?? "a".repeat(40),
    actorType: options.actorType ?? "CODEX",
    ...(options.actorReference === undefined
      ? { actorReference: "codex-task-1" }
      : { actorReference: options.actorReference }),
    sourceReference: options.sourceReference ?? "task://s1b2a",
    summary: options.summary ?? "Initial implementation completed.",
    occurredAt: options.occurredAt ?? FIXED_TIME,
  });

export const withMemoryStorage = <T>(operation: (storage: TaskStorage) => T): T => {
  const storage = openTaskDatabase({ databasePath: ":memory:", clock: fixedClock });
  try {
    return operation(storage);
  } finally {
    storage.close();
  }
};

export const withTemporaryDatabasePath = <T>(operation: (databasePath: string) => T): T => {
  const directory = mkdtempSync(join(tmpdir(), "codex-task-console-storage-"));
  const databasePath = join(directory, "task-console.sqlite");
  try {
    return operation(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

export const createHierarchy = (storage: TaskStorage): void => {
  storage.createProject(makeProject());
  storage.createBigTask(makeBigTask());
  storage.createSubtask(makeSubtask("st_a"));
  storage.createSubtask(makeSubtask("st_b"));
  storage.createSubtask(makeSubtask("st_c"));
};

export const captureTaskStorageError = (operation: () => unknown): TaskStorageError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof TaskStorageError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a TaskStorageError.");
};
