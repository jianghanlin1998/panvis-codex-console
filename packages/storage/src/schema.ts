import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const projectsTable = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    repositoryKind: text("repository_kind").notNull(),
    repositoryValue: text("repository_value").notNull(),
    defaultBranch: text("default_branch").notNull(),
    maxActiveCodingSubtasks: integer("max_active_coding_subtasks").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_slug_unique").on(table.slug),
    check(
      "projects_repository_kind_check",
      sql`${table.repositoryKind} in ('PATH', 'REFERENCE')`,
    ),
    check(
      "projects_max_active_coding_subtasks_check",
      sql`${table.maxActiveCodingSubtasks} between 1 and 2`,
    ),
  ],
);

export const bigTasksTable = sqliteTable(
  "big_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    rationale: text("rationale").notNull(),
    scopeIn: text("scope_in").notNull(),
    scopeOut: text("scope_out").notNull(),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("big_tasks_project_id_index").on(table.projectId),
    check("big_tasks_status_check", sql`${table.status} in ('IN_PROGRESS', 'DONE')`),
  ],
);

export const subtasksTable = sqliteTable(
  "subtasks",
  {
    id: text("id").primaryKey(),
    bigTaskId: text("big_task_id")
      .notNull()
      .references(() => bigTasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    scopeIn: text("scope_in").notNull(),
    scopeOut: text("scope_out").notNull(),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    untouchedAreas: text("untouched_areas").notNull(),
    status: text("status").notNull(),
    maturity: text("maturity").notNull().default("NOT_STARTED"),
    startPolicy: text("start_policy").notNull(),
    delegationPolicy: text("delegation_policy").notNull(),
    recommendedReasoningLevel: text("recommended_reasoning_level").notNull(),
    promptSeed: text("prompt_seed").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("subtasks_big_task_id_index").on(table.bigTaskId),
    check(
      "subtasks_status_check",
      sql`${table.status} in ('TODO', 'IN_PROGRESS', 'QA_DEBUG', 'DONE', 'DROPPED', 'ARCHIVED')`,
    ),
    check(
      "subtasks_maturity_check",
      sql`${table.maturity} in ('NOT_STARTED', 'IMPLEMENTED', 'HARDENED', 'ACCEPTED')`,
    ),
    check("subtasks_start_policy_check", sql`${table.startPolicy} in ('MANUAL', 'WHEN_READY')`),
    check(
      "subtasks_delegation_policy_check",
      sql`${table.delegationPolicy} in ('NONE', 'READ_ONLY_AUXILIARY', 'REVIEW_ONLY')`,
    ),
    check(
      "subtasks_reasoning_level_check",
      sql`${table.recommendedReasoningLevel} in ('LOW', 'MEDIUM', 'HIGH', 'XHIGH')`,
    ),
  ],
);

export const chatThreadsTable = sqliteTable(
  "chat_threads",
  {
    id: text("id").primaryKey(),
    subtaskId: text("subtask_id")
      .notNull()
      .references(() => subtasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    providerId: text("provider_id").notNull(),
    providerThreadId: text("provider_thread_id"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
  },
  (table) => [
    index("chat_threads_subtask_order_index").on(
      table.subtaskId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("chat_threads_provider_thread_unique")
      .on(table.providerId, table.providerThreadId)
      .where(sql`${table.providerThreadId} is not null`),
    check(
      "chat_threads_id_check",
      sql`length(${table.id}) between 5 and 128 and ${table.id} glob 'thr_*'`,
    ),
    check(
      "chat_threads_provider_id_check",
      sql`length(${table.providerId}) between 1 and 64
        and ${table.providerId} = lower(${table.providerId})
        and ${table.providerId} not glob '*[^a-z0-9-]*'
        and ${table.providerId} not glob '-*'
        and ${table.providerId} not glob '*-'
        and ${table.providerId} not glob '*--*'`,
    ),
    check(
      "chat_threads_provider_thread_id_check",
      sql`${table.providerThreadId} is null
        or (length(${table.providerThreadId}) between 1 and 512
          and trim(${table.providerThreadId}) = ${table.providerThreadId})`,
    ),
    check(
      "chat_threads_lifecycle_check",
      sql`(${table.status} = 'OPEN' and ${table.closedAt} is null)
        or (${table.status} = 'CLOSED'
          and ${table.closedAt} is not null
          and ${table.closedAt} = ${table.updatedAt})`,
    ),
  ],
);

export const executionRunsTable = sqliteTable(
  "execution_runs",
  {
    id: text("id").primaryKey(),
    chatThreadId: text("chat_thread_id")
      .notNull()
      .references(() => chatThreadsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status").notNull(),
    providerThreadId: text("provider_thread_id"),
    providerRunId: text("provider_run_id"),
    providerModelId: text("provider_model_id"),
    usagePresent: integer("usage_present").notNull(),
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    totalTokens: integer("total_tokens"),
    runtimeSeconds: real("runtime_seconds"),
    toolCallCount: integer("tool_call_count"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (table) => [
    index("execution_runs_thread_order_index").on(
      table.chatThreadId,
      table.createdAt,
      table.id,
    ),
    check(
      "execution_runs_id_check",
      sql`length(${table.id}) between 5 and 128 and ${table.id} glob 'run_*'`,
    ),
    check(
      "execution_runs_provider_thread_id_check",
      sql`${table.providerThreadId} is null
        or (length(${table.providerThreadId}) between 1 and 512
          and trim(${table.providerThreadId}) = ${table.providerThreadId})`,
    ),
    check(
      "execution_runs_provider_run_id_check",
      sql`${table.providerRunId} is null
        or (length(${table.providerRunId}) between 1 and 512
          and trim(${table.providerRunId}) = ${table.providerRunId})`,
    ),
    check(
      "execution_runs_provider_model_id_check",
      sql`${table.providerModelId} is null
        or (length(${table.providerModelId}) between 1 and 512
          and trim(${table.providerModelId}) = ${table.providerModelId})`,
    ),
    check(
      "execution_runs_provider_run_pair_check",
      sql`(${table.providerThreadId} is null and ${table.providerRunId} is null)
        or (${table.providerThreadId} is not null and ${table.providerRunId} is not null)`,
    ),
    check(
      "execution_runs_usage_check",
      sql`${table.usagePresent} in (0, 1)
        and (${table.inputTokens} is null or (typeof(${table.inputTokens}) = 'integer' and ${table.inputTokens} between 0 and 9007199254740991))
        and (${table.cachedInputTokens} is null or (typeof(${table.cachedInputTokens}) = 'integer' and ${table.cachedInputTokens} between 0 and 9007199254740991))
        and (${table.outputTokens} is null or (typeof(${table.outputTokens}) = 'integer' and ${table.outputTokens} between 0 and 9007199254740991))
        and (${table.reasoningTokens} is null or (typeof(${table.reasoningTokens}) = 'integer' and ${table.reasoningTokens} between 0 and 9007199254740991))
        and (${table.totalTokens} is null or (typeof(${table.totalTokens}) = 'integer' and ${table.totalTokens} between 0 and 9007199254740991))
        and (${table.runtimeSeconds} is null or (typeof(${table.runtimeSeconds}) in ('integer', 'real') and ${table.runtimeSeconds} >= 0))
        and (${table.toolCallCount} is null or (typeof(${table.toolCallCount}) = 'integer' and ${table.toolCallCount} between 0 and 9007199254740991))
        and (${table.inputTokens} is null or ${table.outputTokens} is null or ${table.totalTokens} is null
          or ${table.totalTokens} = ${table.inputTokens} + ${table.outputTokens})
        and (${table.usagePresent} = 1
          or (${table.inputTokens} is null
            and ${table.cachedInputTokens} is null
            and ${table.outputTokens} is null
            and ${table.reasoningTokens} is null
            and ${table.totalTokens} is null
            and ${table.runtimeSeconds} is null
            and ${table.toolCallCount} is null))`,
    ),
    check(
      "execution_runs_lifecycle_check",
      sql`(${table.status} = 'CREATED'
          and ${table.providerThreadId} is null
          and ${table.providerRunId} is null
          and ${table.providerModelId} is null
          and ${table.usagePresent} = 0
          and ${table.inputTokens} is null
          and ${table.cachedInputTokens} is null
          and ${table.outputTokens} is null
          and ${table.reasoningTokens} is null
          and ${table.totalTokens} is null
          and ${table.runtimeSeconds} is null
          and ${table.toolCallCount} is null
          and ${table.startedAt} is null
          and ${table.endedAt} is null
          and ${table.updatedAt} = ${table.createdAt})
        or (${table.status} = 'RUNNING'
          and ${table.providerThreadId} is not null
          and ${table.providerRunId} is not null
          and ${table.startedAt} is not null
          and ${table.endedAt} is null
          and ${table.usagePresent} = 0
          and ${table.inputTokens} is null
          and ${table.cachedInputTokens} is null
          and ${table.outputTokens} is null
          and ${table.reasoningTokens} is null
          and ${table.totalTokens} is null
          and ${table.runtimeSeconds} is null
          and ${table.toolCallCount} is null
          and ${table.updatedAt} = ${table.startedAt})
        or (${table.status} in ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
          and ${table.endedAt} is not null
          and ${table.updatedAt} = ${table.endedAt}
          and ((${table.startedAt} is null
              and ${table.status} = 'FAILED'
              and ${table.providerThreadId} is null
              and ${table.providerRunId} is null
              and ${table.providerModelId} is null
              and ${table.usagePresent} = 0
              and ${table.inputTokens} is null
              and ${table.cachedInputTokens} is null
              and ${table.outputTokens} is null
              and ${table.reasoningTokens} is null
              and ${table.totalTokens} is null
              and ${table.runtimeSeconds} is null
              and ${table.toolCallCount} is null)
            or (${table.startedAt} is not null
              and ${table.providerThreadId} is not null
              and ${table.providerRunId} is not null)))`,
    ),
  ],
);

export const taskDependenciesTable = sqliteTable(
  "task_dependencies",
  {
    upstreamSubtaskId: text("upstream_subtask_id")
      .notNull()
      .references(() => subtasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    downstreamSubtaskId: text("downstream_subtask_id")
      .notNull()
      .references(() => subtasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    dependencyType: text("dependency_type").notNull(),
    requiredGate: text("required_gate").notNull(),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.upstreamSubtaskId, table.downstreamSubtaskId] }),
    index("task_dependencies_upstream_index").on(table.upstreamSubtaskId),
    index("task_dependencies_downstream_index").on(table.downstreamSubtaskId),
    check(
      "task_dependencies_no_self_check",
      sql`${table.upstreamSubtaskId} <> ${table.downstreamSubtaskId}`,
    ),
    check(
      "task_dependencies_type_check",
      sql`${table.dependencyType} in ('BLOCKING', 'INFORMATIONAL')`,
    ),
    check(
      "task_dependencies_required_gate_check",
      sql`${table.requiredGate} in ('NONE', 'HARDENED', 'ACCEPTED')`,
    ),
    check(
      "task_dependencies_type_gate_check",
      sql`(${table.dependencyType} = 'BLOCKING' and ${table.requiredGate} in ('HARDENED', 'ACCEPTED'))
        or (${table.dependencyType} = 'INFORMATIONAL' and ${table.requiredGate} = 'NONE')`,
    ),
    check(
      "task_dependencies_reason_length_check",
      sql`length(trim(${table.reason})) between 1 and 1000`,
    ),
  ],
);

export const subtaskImplementationCheckpointsTable = sqliteTable(
  "subtask_implementation_checkpoints",
  {
    id: text("id").primaryKey(),
    subtaskId: text("subtask_id")
      .notNull()
      .references(() => subtasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    repositoryCommitSha: text("repository_commit_sha").notNull(),
    actorType: text("actor_type").notNull(),
    actorReference: text("actor_reference"),
    sourceReference: text("source_reference").notNull(),
    summary: text("summary").notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("subtask_implementation_checkpoints_subtask_index").on(table.subtaskId),
    index("subtask_implementation_checkpoints_subtask_order_index").on(
      table.subtaskId,
      table.occurredAt,
      table.id,
    ),
    check(
      "subtask_implementation_checkpoints_id_check",
      sql`length(${table.id}) between 5 and 128 and ${table.id} glob 'icp_*'`,
    ),
    check(
      "subtask_implementation_checkpoints_sha_check",
      sql`length(${table.repositoryCommitSha}) in (40, 64)
        and ${table.repositoryCommitSha} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "subtask_implementation_checkpoints_actor_type_check",
      sql`${table.actorType} in ('HUMAN', 'CODEX', 'SYSTEM')`,
    ),
    check(
      "subtask_implementation_checkpoints_actor_reference_length_check",
      sql`${table.actorReference} is null or length(trim(${table.actorReference})) between 1 and 256`,
    ),
    check(
      "subtask_implementation_checkpoints_source_reference_length_check",
      sql`length(trim(${table.sourceReference})) between 1 and 2048`,
    ),
    check(
      "subtask_implementation_checkpoints_summary_length_check",
      sql`length(trim(${table.summary})) between 1 and 1000`,
    ),
  ],
);

export const contextItemsTable = sqliteTable(
  "context_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    bigTaskId: text("big_task_id").references(() => bigTasksTable.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    subtaskId: text("subtask_id").references(() => subtasksTable.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    authority: text("authority").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sourceType: text("source_type").notNull(),
    sourceReference: text("source_reference").notNull(),
    effectiveAt: text("effective_at").notNull(),
    supersedesContextItemId: text("supersedes_context_item_id").references(
      (): AnySQLiteColumn => contextItemsTable.id,
      { onDelete: "restrict", onUpdate: "cascade" },
    ),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("context_items_project_id_index").on(table.projectId),
    index("context_items_big_task_id_index").on(table.bigTaskId),
    index("context_items_subtask_id_index").on(table.subtaskId),
    index("context_items_status_index").on(table.status),
    uniqueIndex("context_items_supersedes_unique").on(table.supersedesContextItemId),
    index("context_items_effective_at_id_index").on(table.effectiveAt, table.id),
    check(
      "context_items_kind_check",
      sql`${table.kind} in ('DECISION', 'REQUIREMENT', 'CONSTRAINT', 'ENGINEERING_FACT', 'OPEN_QUESTION', 'RISK')`,
    ),
    check(
      "context_items_status_check",
      sql`${table.status} in ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'RESOLVED')`,
    ),
    check(
      "context_items_authority_check",
      sql`${table.authority} in ('HUMAN', 'REPO_EVIDENCE', 'CODEX_CANDIDATE', 'SYSTEM')`,
    ),
    check(
      "context_items_source_type_check",
      sql`${table.sourceType} in ('CHAT_MESSAGE', 'REPO', 'HANDOFF', 'IMPORT', 'MANUAL', 'SYSTEM')`,
    ),
    check(
      "context_items_scope_check",
      sql`${table.subtaskId} is null or ${table.bigTaskId} is not null`,
    ),
    check(
      "context_items_no_self_supersession_check",
      sql`${table.supersedesContextItemId} is null or ${table.id} <> ${table.supersedesContextItemId}`,
    ),
    check(
      "context_items_title_length_check",
      sql`length(trim(${table.title})) between 1 and 256`,
    ),
    check(
      "context_items_body_length_check",
      sql`length(trim(${table.body})) between 1 and 4000`,
    ),
    check(
      "context_items_source_reference_length_check",
      sql`length(trim(${table.sourceReference})) between 1 and 2048`,
    ),
  ],
);

export const contextDigestsTable = sqliteTable(
  "context_digests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    bigTaskId: text("big_task_id").references(() => bigTasksTable.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    subtaskId: text("subtask_id").references(() => subtasksTable.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    body: text("body").notNull(),
    sourceType: text("source_type").notNull(),
    sourceReference: text("source_reference").notNull(),
    effectiveAt: text("effective_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("context_digests_project_id_index").on(table.projectId),
    index("context_digests_big_task_id_index").on(table.bigTaskId),
    index("context_digests_subtask_id_index").on(table.subtaskId),
    uniqueIndex("context_digests_project_scope_unique")
      .on(table.projectId)
      .where(sql`${table.bigTaskId} is null and ${table.subtaskId} is null`),
    uniqueIndex("context_digests_big_task_scope_unique")
      .on(table.projectId, table.bigTaskId)
      .where(sql`${table.bigTaskId} is not null and ${table.subtaskId} is null`),
    uniqueIndex("context_digests_subtask_scope_unique")
      .on(table.projectId, table.bigTaskId, table.subtaskId)
      .where(
        sql`${table.bigTaskId} is not null and ${table.subtaskId} is not null`,
      ),
    check(
      "context_digests_scope_check",
      sql`(${table.bigTaskId} is null and ${table.subtaskId} is null)
        or (${table.bigTaskId} is not null and ${table.subtaskId} is null)
        or (${table.bigTaskId} is not null and ${table.subtaskId} is not null)`,
    ),
    check(
      "context_digests_source_type_check",
      sql`${table.sourceType} in ('CHAT_MESSAGE', 'REPO', 'HANDOFF', 'IMPORT', 'MANUAL', 'SYSTEM')`,
    ),
    check(
      "context_digests_body_length_check",
      sql`length(trim(${table.body})) between 1 and 8000`,
    ),
    check(
      "context_digests_source_reference_length_check",
      sql`length(trim(${table.sourceReference})) between 1 and 2048`,
    ),
  ],
);

export const auditEventsTable = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    bigTaskId: text("big_task_id").references(() => bigTasksTable.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    subtaskId: text("subtask_id").references(() => subtasksTable.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorReference: text("actor_reference"),
    summary: text("summary").notNull(),
    subjectReference: text("subject_reference"),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("audit_events_project_id_index").on(table.projectId),
    index("audit_events_big_task_id_index").on(table.bigTaskId),
    index("audit_events_subtask_id_index").on(table.subtaskId),
    index("audit_events_scope_occurred_at_id_index").on(
      table.projectId,
      table.bigTaskId,
      table.subtaskId,
      table.occurredAt,
      table.id,
    ),
    check(
      "audit_events_scope_check",
      sql`(${table.bigTaskId} is null and ${table.subtaskId} is null)
        or (${table.bigTaskId} is not null and ${table.subtaskId} is null)
        or (${table.bigTaskId} is not null and ${table.subtaskId} is not null)`,
    ),
    check(
      "audit_events_event_type_check",
      sql`length(trim(${table.eventType})) between 1 and 64
        and ${table.eventType} glob '[A-Z]*'
        and ${table.eventType} not glob '*[^A-Z0-9_]*'`,
    ),
    check(
      "audit_events_actor_type_check",
      sql`${table.actorType} in ('HUMAN', 'CODEX', 'SYSTEM')`,
    ),
    check(
      "audit_events_actor_reference_length_check",
      sql`${table.actorReference} is null or length(trim(${table.actorReference})) between 1 and 256`,
    ),
    check(
      "audit_events_summary_length_check",
      sql`length(trim(${table.summary})) between 1 and 1000`,
    ),
    check(
      "audit_events_subject_reference_length_check",
      sql`${table.subjectReference} is null or length(trim(${table.subjectReference})) between 1 and 512`,
    ),
  ],
);
