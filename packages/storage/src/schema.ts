import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
  ],
);
