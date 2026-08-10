import type { DatabaseSync } from "node:sqlite";

import type {
  AuditEvent,
  BigTask,
  ContextDigest,
  ContextItem,
  Project,
  SubtaskCreateInput,
  SubtaskDependency,
} from "@codex-task-console/domain";

import { FIXED_TIME } from "./fixtures.js";

export const LEGACY_BLOCKING_REASON =
  "Legacy BLOCKING dependency migrated without a recorded reason.";
export const LEGACY_INFORMATIONAL_REASON =
  "Legacy INFORMATIONAL dependency migrated without a recorded reason.";

export const insertLegacyProject = (sqlite: DatabaseSync, project: Project): void => {
  sqlite
    .prepare(
      `INSERT INTO projects (
        id, name, slug, repository_kind, repository_value, default_branch,
        max_active_coding_subtasks, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      project.name,
      project.slug,
      project.repository.kind,
      project.repository.kind === "PATH"
        ? project.repository.path
        : project.repository.reference,
      project.defaultBranch,
      project.maxActiveCodingSubtasks,
      FIXED_TIME,
      FIXED_TIME,
    );
};

export const insertLegacyBigTask = (sqlite: DatabaseSync, bigTask: BigTask): void => {
  sqlite
    .prepare(
      `INSERT INTO big_tasks (
        id, project_id, title, goal, rationale, scope_in, scope_out,
        acceptance_criteria, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      bigTask.id,
      bigTask.projectId,
      bigTask.title,
      bigTask.goal,
      bigTask.rationale,
      JSON.stringify(bigTask.scopeIn),
      JSON.stringify(bigTask.scopeOut),
      JSON.stringify(bigTask.acceptanceCriteria),
      bigTask.status,
      FIXED_TIME,
      FIXED_TIME,
    );
};

export const insertLegacySubtask = (
  sqlite: DatabaseSync,
  subtask: SubtaskCreateInput,
): void => {
  sqlite
    .prepare(
      `INSERT INTO subtasks (
        id, big_task_id, title, goal, scope_in, scope_out, acceptance_criteria,
        untouched_areas, status, start_policy, delegation_policy,
        recommended_reasoning_level, prompt_seed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      subtask.id,
      subtask.bigTaskId,
      subtask.title,
      subtask.goal,
      JSON.stringify(subtask.scopeIn),
      JSON.stringify(subtask.scopeOut),
      JSON.stringify(subtask.acceptanceCriteria),
      JSON.stringify(subtask.untouchedAreas),
      subtask.status,
      subtask.startPolicy,
      subtask.delegationPolicy,
      subtask.recommendedReasoningLevel,
      subtask.promptSeed,
      FIXED_TIME,
      FIXED_TIME,
    );
};

export const insertLegacyDependency = (
  sqlite: DatabaseSync,
  dependency: SubtaskDependency,
): void => {
  sqlite
    .prepare(
      `INSERT INTO task_dependencies (
        upstream_subtask_id, downstream_subtask_id, dependency_type, created_at
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      dependency.upstreamSubtaskId,
      dependency.downstreamSubtaskId,
      dependency.dependencyType,
      FIXED_TIME,
    );
};

export const migratedLegacyDependency = (
  dependency: SubtaskDependency,
): SubtaskDependency =>
  dependency.dependencyType === "BLOCKING"
    ? {
        upstreamSubtaskId: dependency.upstreamSubtaskId,
        downstreamSubtaskId: dependency.downstreamSubtaskId,
        dependencyType: "BLOCKING",
        requiredGate: "ACCEPTED",
        reason: LEGACY_BLOCKING_REASON,
      }
    : {
        upstreamSubtaskId: dependency.upstreamSubtaskId,
        downstreamSubtaskId: dependency.downstreamSubtaskId,
        dependencyType: "INFORMATIONAL",
        requiredGate: "NONE",
        reason: LEGACY_INFORMATIONAL_REASON,
      };

export const insertLegacyContextItem = (
  sqlite: DatabaseSync,
  contextItem: ContextItem,
): void => {
  sqlite
    .prepare(
      `INSERT INTO context_items (
        id, project_id, big_task_id, subtask_id, kind, status, authority, title,
        body, source_type, source_reference, effective_at,
        supersedes_context_item_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      contextItem.id,
      contextItem.projectId,
      "bigTaskId" in contextItem ? contextItem.bigTaskId : null,
      "subtaskId" in contextItem ? contextItem.subtaskId : null,
      contextItem.kind,
      contextItem.status,
      contextItem.authority,
      contextItem.title,
      contextItem.body,
      contextItem.provenance.sourceType,
      contextItem.provenance.sourceReference,
      contextItem.provenance.effectiveAt,
      contextItem.provenance.supersedesContextItemId ?? null,
      FIXED_TIME,
      FIXED_TIME,
    );
};

export const insertLegacyContextDigest = (
  sqlite: DatabaseSync,
  digest: ContextDigest,
): void => {
  sqlite
    .prepare(
      `INSERT INTO context_digests (
        id, project_id, big_task_id, subtask_id, body, source_type,
        source_reference, effective_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      digest.id,
      digest.scope.projectId,
      digest.scope.scopeType === "PROJECT" ? null : digest.scope.bigTaskId,
      digest.scope.scopeType === "SUBTASK" ? digest.scope.subtaskId : null,
      digest.body,
      digest.provenance.sourceType,
      digest.provenance.sourceReference,
      digest.provenance.effectiveAt,
      FIXED_TIME,
      FIXED_TIME,
    );
};

export const insertLegacyAuditEvent = (
  sqlite: DatabaseSync,
  auditEvent: AuditEvent,
): void => {
  sqlite
    .prepare(
      `INSERT INTO audit_events (
        id, project_id, big_task_id, subtask_id, event_type, actor_type,
        actor_reference, summary, subject_reference, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      auditEvent.id,
      auditEvent.scope.projectId,
      auditEvent.scope.scopeType === "PROJECT" ? null : auditEvent.scope.bigTaskId,
      auditEvent.scope.scopeType === "SUBTASK" ? auditEvent.scope.subtaskId : null,
      auditEvent.eventType,
      auditEvent.actorType,
      auditEvent.actorReference ?? null,
      auditEvent.summary,
      auditEvent.subjectReference ?? null,
      auditEvent.occurredAt,
      FIXED_TIME,
    );
};
