import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
    uniqueIndex("subtasks_id_big_task_id_unique").on(table.id, table.bigTaskId),
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

export const orchestrationPlanningTracksTable = sqliteTable(
  "orchestration_planning_tracks",
  {
    bigTaskId: text("big_task_id")
      .primaryKey()
      .references(() => bigTasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("orchestration_planning_tracks_project_id_index").on(table.projectId)],
);

export const orchestrationPlanCandidatesTable = sqliteTable(
  "orchestration_plan_candidates",
  {
    bigTaskId: text("big_task_id")
      .notNull()
      .references(() => orchestrationPlanningTracksTable.bigTaskId, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    revision: integer("revision").notNull(),
    candidatePayload: text("candidate_payload").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    taskContractCount: integer("task_contract_count"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bigTaskId, table.revision] }),
    uniqueIndex("orchestration_plan_candidates_binding_unique").on(
      table.bigTaskId,
      table.candidateBinding,
    ),
    check(
      "orchestration_plan_candidates_revision_check",
      sql`typeof(${table.revision}) = 'integer' and ${table.revision} >= 1`,
    ),
    check(
      "orchestration_plan_candidates_payload_check",
      sql`length(${table.candidatePayload}) >= 1`,
    ),
    check(
      "orchestration_plan_candidates_binding_check",
      sql`length(${table.candidateBinding}) >= 1`,
    ),
  ],
);

export const taskContractsTable = sqliteTable(
  "task_contracts",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    taskContractRef: text("task_contract_ref").notNull(),
    bigTaskId: text("big_task_id")
      .notNull()
      .references(() => bigTasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    subtaskId: text("subtask_id").notNull(),
    contractPayload: text("contract_payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.taskContractRef] }),
    index("task_contracts_big_task_subtask_index").on(
      table.bigTaskId,
      table.subtaskId,
    ),
    check(
      "task_contracts_ref_check",
      sql`length(${table.taskContractRef}) between 1 and 1000`,
    ),
    check(
      "task_contracts_payload_check",
      sql`length(${table.contractPayload}) >= 1`,
    ),
  ],
);

export const candidateTaskContractBindingsTable = sqliteTable(
  "candidate_task_contract_bindings",
  {
    projectId: text("project_id").notNull(),
    bigTaskId: text("big_task_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    subtaskId: text("subtask_id").notNull(),
    taskContractRef: text("task_contract_ref").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bigTaskId, table.planRevision, table.subtaskId] }),
    uniqueIndex("candidate_task_contract_bindings_ref_unique").on(
      table.projectId,
      table.bigTaskId,
      table.planRevision,
      table.taskContractRef,
    ),
    foreignKey({
      name: "candidate_task_contract_bindings_candidate_fk",
      columns: [table.bigTaskId, table.planRevision],
      foreignColumns: [
        orchestrationPlanCandidatesTable.bigTaskId,
        orchestrationPlanCandidatesTable.revision,
      ],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    foreignKey({
      name: "candidate_task_contract_bindings_contract_fk",
      columns: [table.projectId, table.taskContractRef],
      foreignColumns: [taskContractsTable.projectId, taskContractsTable.taskContractRef],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    check(
      "candidate_task_contract_bindings_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "candidate_task_contract_bindings_candidate_binding_check",
      sql`length(${table.candidateBinding}) >= 1`,
    ),
    check(
      "candidate_task_contract_bindings_ref_check",
      sql`length(${table.taskContractRef}) between 1 and 1000`,
    ),
  ],
);

export const orchestrationReviewDecisionsTable = sqliteTable(
  "orchestration_review_decisions",
  {
    bigTaskId: text("big_task_id")
      .notNull()
      .references(() => orchestrationPlanningTracksTable.bigTaskId, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    planRevision: integer("plan_revision").notNull(),
    outcome: text("outcome").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    revisionRequirements: text("revision_requirements"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bigTaskId, table.planRevision] }),
    foreignKey({
      name: "orchestration_review_decisions_candidate_fk",
      columns: [table.bigTaskId, table.planRevision],
      foreignColumns: [
        orchestrationPlanCandidatesTable.bigTaskId,
        orchestrationPlanCandidatesTable.revision,
      ],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    check(
      "orchestration_review_decisions_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "orchestration_review_decisions_outcome_check",
      sql`${table.outcome} in ('APPROVE', 'REJECT', 'ESCALATE')`,
    ),
    check(
      "orchestration_review_decisions_binding_check",
      sql`length(${table.candidateBinding}) >= 1`,
    ),
    check(
      "orchestration_review_decisions_requirements_check",
      sql`(${table.outcome} = 'REJECT' and ${table.revisionRequirements} is not null)
        or (${table.outcome} in ('APPROVE', 'ESCALATE') and ${table.revisionRequirements} is null)`,
    ),
  ],
);

export const orchestrationMaterializationsTable = sqliteTable(
  "orchestration_materializations",
  {
    bigTaskId: text("big_task_id")
      .primaryKey()
      .references(() => orchestrationPlanningTracksTable.bigTaskId, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    materializedAt: text("materialized_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "orchestration_materializations_candidate_fk",
      columns: [table.bigTaskId, table.planRevision],
      foreignColumns: [
        orchestrationPlanCandidatesTable.bigTaskId,
        orchestrationPlanCandidatesTable.revision,
      ],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    check(
      "orchestration_materializations_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "orchestration_materializations_binding_check",
      sql`length(${table.candidateBinding}) >= 1`,
    ),
  ],
);

export const canonicalTaskMaterializationsTable = sqliteTable(
  "canonical_task_materializations",
  {
    bigTaskId: text("big_task_id")
      .primaryKey()
      .references(() => orchestrationMaterializationsTable.bigTaskId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "restrict" }),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    subtaskCount: integer("subtask_count").notNull(),
    dependencyCount: integer("dependency_count").notNull(),
    materializedAt: text("materialized_at").notNull(),
  },
  (table) => [
    uniqueIndex("canonical_task_materializations_authority_unique").on(
      table.projectId,
      table.bigTaskId,
      table.planRevision,
      table.candidateBinding,
    ),
    foreignKey({
      name: "canonical_task_materializations_candidate_fk",
      columns: [table.bigTaskId, table.planRevision],
      foreignColumns: [
        orchestrationPlanCandidatesTable.bigTaskId,
        orchestrationPlanCandidatesTable.revision,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "canonical_task_materializations_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "canonical_task_materializations_binding_check",
      sql`length(${table.candidateBinding}) >= 1`,
    ),
    check(
      "canonical_task_materializations_subtask_count_check",
      sql`typeof(${table.subtaskCount}) = 'integer' and ${table.subtaskCount} >= 1`,
    ),
    check(
      "canonical_task_materializations_dependency_count_check",
      sql`typeof(${table.dependencyCount}) = 'integer' and ${table.dependencyCount} >= 0`,
    ),
  ],
);

export const subtaskWorkflowInstancesTable = sqliteTable(
  "subtask_workflow_instances",
  {
    subtaskId: text("subtask_id").primaryKey(),
    projectId: text("project_id").notNull(),
    bigTaskId: text("big_task_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    initialStage: text("initial_stage").notNull(),
    initialRepairCyclesUsed: integer("initial_repair_cycles_used").notNull(),
    initializedAt: text("initialized_at").notNull(),
  },
  (table) => [
    index("subtask_workflow_instances_big_task_index").on(
      table.bigTaskId,
      table.subtaskId,
    ),
    uniqueIndex("subtask_workflow_instances_authority_unique").on(
      table.projectId,
      table.bigTaskId,
      table.planRevision,
      table.candidateBinding,
      table.subtaskId,
    ),
    foreignKey({
      name: "subtask_workflow_instances_materialization_fk",
      columns: [
        table.projectId,
        table.bigTaskId,
        table.planRevision,
        table.candidateBinding,
      ],
      foreignColumns: [
        canonicalTaskMaterializationsTable.projectId,
        canonicalTaskMaterializationsTable.bigTaskId,
        canonicalTaskMaterializationsTable.planRevision,
        canonicalTaskMaterializationsTable.candidateBinding,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "subtask_workflow_instances_subtask_fk",
      columns: [table.subtaskId, table.bigTaskId],
      foreignColumns: [subtasksTable.id, subtasksTable.bigTaskId],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "subtask_workflow_instances_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "subtask_workflow_instances_binding_check",
      sql`length(${table.candidateBinding}) >= 1`,
    ),
    check(
      "subtask_workflow_instances_initial_stage_check",
      sql`${table.initialStage} in ('MATERIALIZE', 'EXECUTE')`,
    ),
    check(
      "subtask_workflow_instances_initial_repair_check",
      sql`typeof(${table.initialRepairCyclesUsed}) = 'integer' and ${table.initialRepairCyclesUsed} = 0`,
    ),
    check(
      "subtask_workflow_instances_initialized_at_check",
      sql`length(${table.initializedAt}) >= 1`,
    ),
  ],
);

export const workflowInitializationReceiptsTable = sqliteTable(
  "workflow_initialization_receipts",
  {
    bigTaskId: text("big_task_id").primaryKey(),
    projectId: text("project_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    workflowInstanceCount: integer("workflow_instance_count").notNull(),
    initializedAt: text("initialized_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "workflow_initialization_receipts_materialization_fk",
      columns: [
        table.projectId,
        table.bigTaskId,
        table.planRevision,
        table.candidateBinding,
      ],
      foreignColumns: [
        canonicalTaskMaterializationsTable.projectId,
        canonicalTaskMaterializationsTable.bigTaskId,
        canonicalTaskMaterializationsTable.planRevision,
        canonicalTaskMaterializationsTable.candidateBinding,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "workflow_initialization_receipts_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "workflow_initialization_receipts_binding_check",
      sql`length(${table.candidateBinding}) >= 1`,
    ),
    check(
      "workflow_initialization_receipts_count_check",
      sql`typeof(${table.workflowInstanceCount}) = 'integer' and ${table.workflowInstanceCount} >= 1`,
    ),
    check(
      "workflow_initialization_receipts_initialized_at_check",
      sql`length(${table.initializedAt}) >= 1`,
    ),
  ],
);

export const durableWorkflowEvidenceTable = sqliteTable(
  "durable_workflow_evidence",
  {
    evidenceId: text("evidence_id").primaryKey(),
    projectId: text("project_id").notNull(),
    bigTaskId: text("big_task_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    subtaskId: text("subtask_id").notNull(),
    expectedSequence: integer("expected_sequence").notNull(),
    observedStage: text("observed_stage").notNull(),
    observedRepairCyclesUsed: integer("observed_repair_cycles_used").notNull(),
    evidenceKind: text("evidence_kind").notNull(),
    outcome: text("outcome").notNull(),
    producer: text("producer").notNull(),
    sourceReference: text("source_reference").notNull(),
    occurredAt: text("occurred_at").notNull(),
    acceptedAt: text("accepted_at").notNull(),
  },
  (table) => [
    index("durable_workflow_evidence_workflow_index").on(
      table.subtaskId,
      table.expectedSequence,
      table.evidenceId,
    ),
    uniqueIndex("durable_workflow_evidence_source_unique").on(
      table.subtaskId,
      table.evidenceKind,
      table.sourceReference,
    ),
    foreignKey({
      name: "durable_workflow_evidence_workflow_fk",
      columns: [
        table.projectId,
        table.bigTaskId,
        table.planRevision,
        table.candidateBinding,
        table.subtaskId,
      ],
      foreignColumns: [
        subtaskWorkflowInstancesTable.projectId,
        subtaskWorkflowInstancesTable.bigTaskId,
        subtaskWorkflowInstancesTable.planRevision,
        subtaskWorkflowInstancesTable.candidateBinding,
        subtaskWorkflowInstancesTable.subtaskId,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "durable_workflow_evidence_id_check",
      sql`length(${table.evidenceId}) between 5 and 128 and ${table.evidenceId} glob 'wfe_*'`,
    ),
    check(
      "durable_workflow_evidence_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "durable_workflow_evidence_sequence_check",
      sql`typeof(${table.expectedSequence}) = 'integer' and ${table.expectedSequence} >= 1`,
    ),
    check(
      "durable_workflow_evidence_stage_check",
      sql`${table.observedStage} in ('MATERIALIZE', 'EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')`,
    ),
    check(
      "durable_workflow_evidence_repair_check",
      sql`typeof(${table.observedRepairCyclesUsed}) = 'integer'
        and ${table.observedRepairCyclesUsed} in (0, 1)`,
    ),
    check(
      "durable_workflow_evidence_kind_check",
      sql`${table.evidenceKind} in (
        'REPOSITORY_PREFLIGHT_PASSED',
        'CONTEXT_PREFLIGHT_PASSED',
        'BUDGET_AVAILABLE',
        'CONCURRENCY_AVAILABLE',
        'WORKTREE_OWNERSHIP_AVAILABLE',
        'HUMAN_APPROVAL_SATISFIED',
        'VERIFICATION_EVIDENCE_PASSED',
        'HARDENING_EVIDENCE_PASSED',
        'FRESH_QA_OUTCOME_RECORDED',
        'REPAIR_EVIDENCE_PASSED',
        'FOCUSED_RE_QA_OUTCOME_RECORDED',
        'NO_UNRESOLVED_BLOCKING_FINDING',
        'HANDOFF_PRESENT',
        'PROMOTED_CONTEXT_DISPOSITION_RECORDED'
      )`,
    ),
    check(
      "durable_workflow_evidence_outcome_check",
      sql`${table.outcome} in ('PASS', 'BLOCKING_FAIL')`,
    ),
    check(
      "durable_workflow_evidence_qa_outcome_check",
      sql`(${table.evidenceKind} in ('FRESH_QA_OUTCOME_RECORDED', 'FOCUSED_RE_QA_OUTCOME_RECORDED'))
        or ${table.outcome} = 'PASS'`,
    ),
    check(
      "durable_workflow_evidence_producer_check",
      sql`${table.producer} in ('OPERATIONAL_GATE', 'WORKFLOW_ROLE', 'HUMAN_AUTHORITY', 'DELIVERY_CONTROL')`,
    ),
    check(
      "durable_workflow_evidence_source_length_check",
      sql`length(trim(${table.sourceReference})) between 1 and 2048`,
    ),
  ],
);

export const durableWorkflowTransitionsTable = sqliteTable(
  "durable_workflow_transitions",
  {
    operationId: text("operation_id").primaryKey(),
    projectId: text("project_id").notNull(),
    bigTaskId: text("big_task_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    subtaskId: text("subtask_id").notNull(),
    sequence: integer("sequence").notNull(),
    priorStage: text("prior_stage").notNull(),
    resultingStage: text("resulting_stage").notNull(),
    priorRepairCyclesUsed: integer("prior_repair_cycles_used").notNull(),
    resultingRepairCyclesUsed: integer("resulting_repair_cycles_used").notNull(),
    evidenceReferences: text("evidence_references").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("durable_workflow_transitions_sequence_unique").on(
      table.subtaskId,
      table.sequence,
    ),
    index("durable_workflow_transitions_workflow_order_index").on(
      table.subtaskId,
      table.sequence,
      table.operationId,
    ),
    foreignKey({
      name: "durable_workflow_transitions_workflow_fk",
      columns: [
        table.projectId,
        table.bigTaskId,
        table.planRevision,
        table.candidateBinding,
        table.subtaskId,
      ],
      foreignColumns: [
        subtaskWorkflowInstancesTable.projectId,
        subtaskWorkflowInstancesTable.bigTaskId,
        subtaskWorkflowInstancesTable.planRevision,
        subtaskWorkflowInstancesTable.candidateBinding,
        subtaskWorkflowInstancesTable.subtaskId,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "durable_workflow_transitions_id_check",
      sql`length(${table.operationId}) between 5 and 128 and ${table.operationId} glob 'wop_*'`,
    ),
    check(
      "durable_workflow_transitions_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "durable_workflow_transitions_sequence_check",
      sql`typeof(${table.sequence}) = 'integer' and ${table.sequence} >= 1`,
    ),
    check(
      "durable_workflow_transitions_stage_check",
      sql`${table.priorStage} in ('MATERIALIZE', 'EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')
        and ${table.resultingStage} in ('EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA', 'COMPLETE')`,
    ),
    check(
      "durable_workflow_transitions_repair_check",
      sql`typeof(${table.priorRepairCyclesUsed}) = 'integer'
        and typeof(${table.resultingRepairCyclesUsed}) = 'integer'
        and ${table.priorRepairCyclesUsed} in (0, 1)
        and ${table.resultingRepairCyclesUsed} in (0, 1)`,
    ),
    check(
      "durable_workflow_transitions_evidence_check",
      sql`length(${table.evidenceReferences}) between 2 and 16384`,
    ),
  ],
);

export const durableWorkflowHumanRequirementsTable = sqliteTable(
  "durable_workflow_human_requirements",
  {
    operationId: text("operation_id").primaryKey(),
    projectId: text("project_id").notNull(),
    bigTaskId: text("big_task_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    candidateBinding: text("candidate_binding").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeKey: text("scope_key").notNull(),
    subtaskId: text("subtask_id"),
    sequence: integer("sequence"),
    currentStage: text("current_stage"),
    requestedNextStage: text("requested_next_stage"),
    repairCyclesUsed: integer("repair_cycles_used"),
    reason: text("reason").notNull(),
    evidenceReferences: text("evidence_references").notNull(),
    sourceReference: text("source_reference").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("durable_workflow_human_requirements_scope_unique").on(
      table.projectId,
      table.bigTaskId,
      table.scopeKey,
    ),
    index("durable_workflow_human_requirements_big_task_index").on(
      table.bigTaskId,
      table.scopeKind,
      table.scopeKey,
    ),
    foreignKey({
      name: "durable_workflow_human_requirements_materialization_fk",
      columns: [
        table.projectId,
        table.bigTaskId,
        table.planRevision,
        table.candidateBinding,
      ],
      foreignColumns: [
        canonicalTaskMaterializationsTable.projectId,
        canonicalTaskMaterializationsTable.bigTaskId,
        canonicalTaskMaterializationsTable.planRevision,
        canonicalTaskMaterializationsTable.candidateBinding,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "durable_workflow_human_requirements_id_check",
      sql`length(${table.operationId}) between 5 and 128 and ${table.operationId} glob 'wop_*'`,
    ),
    check(
      "durable_workflow_human_requirements_revision_check",
      sql`typeof(${table.planRevision}) = 'integer' and ${table.planRevision} >= 1`,
    ),
    check(
      "durable_workflow_human_requirements_scope_check",
      sql`(${table.scopeKind} = 'BIG_TASK'
          and ${table.scopeKey} = ${table.bigTaskId}
          and ${table.subtaskId} is null
          and ${table.sequence} is null
          and ${table.currentStage} is null
          and ${table.requestedNextStage} is null
          and ${table.repairCyclesUsed} is null
          and ${table.reason} = 'REPLAN_REQUIRED')
        or (${table.scopeKind} = 'SUBTASK'
          and ${table.scopeKey} = ${table.subtaskId}
          and ${table.subtaskId} is not null
          and typeof(${table.sequence}) = 'integer'
          and ${table.sequence} >= 1
          and ${table.currentStage} in ('MATERIALIZE', 'EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')
          and ${table.requestedNextStage} in ('EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA', 'COMPLETE')
          and typeof(${table.repairCyclesUsed}) = 'integer'
          and ${table.repairCyclesUsed} in (0, 1)
          and ${table.reason} in ('REPAIR_REQA_EXHAUSTED', 'AUTHORITY_BLOCKED'))`,
    ),
    check(
      "durable_workflow_human_requirements_evidence_check",
      sql`length(${table.evidenceReferences}) between 2 and 16384`,
    ),
    check(
      "durable_workflow_human_requirements_source_check",
      sql`length(trim(${table.sourceReference})) between 1 and 2048`,
    ),
  ],
);

export const worktreeOwnershipsTable = sqliteTable(
  "worktree_ownerships",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    subtaskId: text("subtask_id")
      .notNull()
      .references(() => subtasksTable.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status").notNull(),
    worktreePath: text("worktree_path").notNull(),
    branchName: text("branch_name").notNull(),
    startingCommitSha: text("starting_commit_sha").notNull(),
    releaseHeadSha: text("release_head_sha"),
    createdAt: text("created_at").notNull(),
    activatedAt: text("activated_at"),
    releaseStartedAt: text("release_started_at"),
    releasedAt: text("released_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("worktree_ownerships_worktree_path_unique").on(table.worktreePath),
    uniqueIndex("worktree_ownerships_branch_name_unique").on(table.branchName),
    uniqueIndex("worktree_ownerships_subtask_non_terminal_unique")
      .on(table.subtaskId)
      .where(sql`${table.status} in ('PROVISIONING', 'ACTIVE', 'RELEASING')`),
    index("worktree_ownerships_subtask_history_index").on(
      table.subtaskId,
      table.createdAt,
      table.id,
    ),
    index("worktree_ownerships_project_slots_index").on(
      table.projectId,
      table.status,
      table.createdAt,
      table.id,
    ),
    check(
      "worktree_ownerships_id_check",
      sql`length(${table.id}) = 35
        and substr(${table.id}, 1, 3) = 'wt_'
        and substr(${table.id}, 4) not glob '*[^0-9a-f]*'`,
    ),
    check(
      "worktree_ownerships_status_check",
      sql`${table.status} in ('PROVISIONING', 'ACTIVE', 'RELEASING', 'RELEASED', 'FAILED')`,
    ),
    check(
      "worktree_ownerships_path_check",
      sql`length(${table.worktreePath}) between 1 and 4096
        and substr(${table.worktreePath}, 1, 1) = '/'
        and instr(${table.worktreePath}, char(0)) = 0
        and instr(${table.worktreePath}, char(10)) = 0
        and instr(${table.worktreePath}, char(13)) = 0`,
    ),
    check(
      "worktree_ownerships_branch_check",
      sql`length(${table.branchName}) between 1 and 255
        and ${table.branchName} = 'ctc/worktree/' || ${table.id}`,
    ),
    check(
      "worktree_ownerships_starting_sha_check",
      sql`length(${table.startingCommitSha}) in (40, 64)
        and ${table.startingCommitSha} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "worktree_ownerships_release_sha_check",
      sql`${table.releaseHeadSha} is null
        or (length(${table.releaseHeadSha}) in (40, 64)
          and ${table.releaseHeadSha} not glob '*[^0-9a-f]*')`,
    ),
    check(
      "worktree_ownerships_lifecycle_check",
      sql`(${table.status} = 'PROVISIONING'
          and ${table.activatedAt} is null
          and ${table.releaseStartedAt} is null
          and ${table.releasedAt} is null
          and ${table.releaseHeadSha} is null
          and ${table.updatedAt} = ${table.createdAt})
        or (${table.status} = 'FAILED'
          and ${table.activatedAt} is null
          and ${table.releaseStartedAt} is null
          and ${table.releasedAt} is null
          and ${table.releaseHeadSha} is null
          and ${table.updatedAt} >= ${table.createdAt})
        or (${table.status} = 'ACTIVE'
          and ${table.activatedAt} is not null
          and ${table.releaseStartedAt} is null
          and ${table.releasedAt} is null
          and ${table.releaseHeadSha} is null
          and ${table.activatedAt} >= ${table.createdAt}
          and ${table.updatedAt} = ${table.activatedAt})
        or (${table.status} = 'RELEASING'
          and ${table.activatedAt} is not null
          and ${table.releaseStartedAt} is not null
          and ${table.releasedAt} is null
          and ${table.releaseHeadSha} is not null
          and ${table.activatedAt} >= ${table.createdAt}
          and ${table.releaseStartedAt} >= ${table.activatedAt}
          and ${table.updatedAt} = ${table.releaseStartedAt})
        or (${table.status} = 'RELEASED'
          and ${table.activatedAt} is not null
          and ${table.releaseStartedAt} is not null
          and ${table.releasedAt} is not null
          and ${table.releaseHeadSha} is not null
          and ${table.activatedAt} >= ${table.createdAt}
          and ${table.releaseStartedAt} >= ${table.activatedAt}
          and ${table.releasedAt} >= ${table.releaseStartedAt}
          and ${table.updatedAt} = ${table.releasedAt})`,
    ),
  ],
);

export const worktreeCheckoutGenerationsTable = sqliteTable(
  "worktree_checkout_generations",
  {
    ownershipId: text("ownership_id")
      .primaryKey()
      .references(() => worktreeOwnershipsTable.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    gitAdminDevice: text("git_admin_device").notNull(),
    gitAdminInode: text("git_admin_inode").notNull(),
    gitAdminBirthtimeNs: text("git_admin_birthtime_ns").notNull(),
    markerDevice: text("marker_device").notNull(),
    markerInode: text("marker_inode").notNull(),
    markerBirthtimeNs: text("marker_birthtime_ns").notNull(),
  },
  (table) => [
    check(
      "worktree_checkout_generations_identity_check",
      sql`length(${table.gitAdminDevice}) between 1 and 20
        and ${table.gitAdminDevice} not glob '*[^0-9]*'
        and (length(${table.gitAdminDevice}) = 1 or substr(${table.gitAdminDevice}, 1, 1) != '0')
        and length(${table.gitAdminInode}) between 1 and 20
        and ${table.gitAdminInode} not glob '*[^0-9]*'
        and (length(${table.gitAdminInode}) = 1 or substr(${table.gitAdminInode}, 1, 1) != '0')
        and length(${table.gitAdminBirthtimeNs}) between 1 and 20
        and ${table.gitAdminBirthtimeNs} not glob '*[^0-9]*'
        and (length(${table.gitAdminBirthtimeNs}) = 1 or substr(${table.gitAdminBirthtimeNs}, 1, 1) != '0')
        and length(${table.markerDevice}) between 1 and 20
        and ${table.markerDevice} not glob '*[^0-9]*'
        and (length(${table.markerDevice}) = 1 or substr(${table.markerDevice}, 1, 1) != '0')
        and length(${table.markerInode}) between 1 and 20
        and ${table.markerInode} not glob '*[^0-9]*'
        and (length(${table.markerInode}) = 1 or substr(${table.markerInode}, 1, 1) != '0')
        and length(${table.markerBirthtimeNs}) between 1 and 20
        and ${table.markerBirthtimeNs} not glob '*[^0-9]*'
        and (length(${table.markerBirthtimeNs}) = 1 or substr(${table.markerBirthtimeNs}, 1, 1) != '0')`,
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
    uniqueIndex("execution_runs_provider_run_unique")
      .on(table.chatThreadId, table.providerRunId)
      .where(sql`${table.providerRunId} is not null`),
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
