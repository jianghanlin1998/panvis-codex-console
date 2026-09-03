CREATE TABLE `durable_workflow_evidence` (
	`evidence_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`expected_sequence` integer NOT NULL,
	`observed_stage` text NOT NULL,
	`observed_repair_cycles_used` integer NOT NULL,
	`evidence_kind` text NOT NULL,
	`outcome` text NOT NULL,
	`producer` text NOT NULL,
	`source_reference` text NOT NULL,
	`occurred_at` text NOT NULL,
	`accepted_at` text NOT NULL,
	CONSTRAINT `durable_workflow_evidence_workflow_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) REFERENCES `subtask_workflow_instances`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "durable_workflow_evidence_id_check" CHECK(length("evidence_id") between 5 and 128 and "evidence_id" glob 'wfe_*'),
	CONSTRAINT "durable_workflow_evidence_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "durable_workflow_evidence_sequence_check" CHECK(typeof("expected_sequence") = 'integer' and "expected_sequence" >= 1),
	CONSTRAINT "durable_workflow_evidence_stage_check" CHECK("observed_stage" in ('MATERIALIZE', 'EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')),
	CONSTRAINT "durable_workflow_evidence_repair_check" CHECK(typeof("observed_repair_cycles_used") = 'integer'
        and "observed_repair_cycles_used" in (0, 1)),
	CONSTRAINT "durable_workflow_evidence_kind_check" CHECK("evidence_kind" in (
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
      )),
	CONSTRAINT "durable_workflow_evidence_outcome_check" CHECK("outcome" in ('PASS', 'BLOCKING_FAIL')),
	CONSTRAINT "durable_workflow_evidence_qa_outcome_check" CHECK(("evidence_kind" in ('FRESH_QA_OUTCOME_RECORDED', 'FOCUSED_RE_QA_OUTCOME_RECORDED'))
        or "outcome" = 'PASS'),
	CONSTRAINT "durable_workflow_evidence_producer_check" CHECK("producer" in ('OPERATIONAL_GATE', 'WORKFLOW_ROLE', 'HUMAN_AUTHORITY', 'DELIVERY_CONTROL')),
	CONSTRAINT "durable_workflow_evidence_source_length_check" CHECK(length(trim("source_reference")) between 1 and 2048)
);
--> statement-breakpoint
CREATE TABLE `durable_workflow_human_requirements` (
	`operation_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_key` text NOT NULL,
	`subtask_id` text,
	`sequence` integer,
	`current_stage` text,
	`requested_next_stage` text,
	`repair_cycles_used` integer,
	`reason` text NOT NULL,
	`evidence_references` text NOT NULL,
	`source_reference` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `durable_workflow_human_requirements_materialization_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) REFERENCES `canonical_task_materializations`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "durable_workflow_human_requirements_id_check" CHECK(length("operation_id") between 5 and 128 and "operation_id" glob 'wop_*'),
	CONSTRAINT "durable_workflow_human_requirements_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "durable_workflow_human_requirements_scope_check" CHECK(("scope_kind" = 'BIG_TASK'
          and "scope_key" = "big_task_id"
          and "subtask_id" is null
          and "sequence" is null
          and "current_stage" is null
          and "requested_next_stage" is null
          and "repair_cycles_used" is null
          and "reason" = 'REPLAN_REQUIRED')
        or ("scope_kind" = 'SUBTASK'
          and "scope_key" = "subtask_id"
          and "subtask_id" is not null
          and typeof("sequence") = 'integer'
          and "sequence" >= 1
          and "current_stage" in ('MATERIALIZE', 'EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')
          and "requested_next_stage" in ('EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA', 'COMPLETE')
          and typeof("repair_cycles_used") = 'integer'
          and "repair_cycles_used" in (0, 1)
          and "reason" in ('REPAIR_REQA_EXHAUSTED', 'AUTHORITY_BLOCKED'))),
	CONSTRAINT "durable_workflow_human_requirements_evidence_check" CHECK(length("evidence_references") between 2 and 16384),
	CONSTRAINT "durable_workflow_human_requirements_source_check" CHECK(length(trim("source_reference")) between 1 and 2048)
);
--> statement-breakpoint
CREATE TABLE `durable_workflow_transitions` (
	`operation_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`prior_stage` text NOT NULL,
	`resulting_stage` text NOT NULL,
	`prior_repair_cycles_used` integer NOT NULL,
	`resulting_repair_cycles_used` integer NOT NULL,
	`evidence_references` text NOT NULL,
	`occurred_at` text NOT NULL,
	CONSTRAINT `durable_workflow_transitions_workflow_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) REFERENCES `subtask_workflow_instances`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "durable_workflow_transitions_id_check" CHECK(length("operation_id") between 5 and 128 and "operation_id" glob 'wop_*'),
	CONSTRAINT "durable_workflow_transitions_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "durable_workflow_transitions_sequence_check" CHECK(typeof("sequence") = 'integer' and "sequence" >= 1),
	CONSTRAINT "durable_workflow_transitions_stage_check" CHECK("prior_stage" in ('MATERIALIZE', 'EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')
        and "resulting_stage" in ('EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA', 'COMPLETE')),
	CONSTRAINT "durable_workflow_transitions_repair_check" CHECK(typeof("prior_repair_cycles_used") = 'integer'
        and typeof("resulting_repair_cycles_used") = 'integer'
        and "prior_repair_cycles_used" in (0, 1)
        and "resulting_repair_cycles_used" in (0, 1)),
	CONSTRAINT "durable_workflow_transitions_evidence_check" CHECK(length("evidence_references") between 2 and 16384)
);
--> statement-breakpoint
CREATE INDEX `durable_workflow_evidence_workflow_index` ON `durable_workflow_evidence` (`subtask_id`,`expected_sequence`,`evidence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_source_unique` ON `durable_workflow_evidence` (`subtask_id`,`evidence_kind`,`source_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_human_requirements_scope_unique` ON `durable_workflow_human_requirements` (`project_id`,`big_task_id`,`scope_key`);--> statement-breakpoint
CREATE INDEX `durable_workflow_human_requirements_big_task_index` ON `durable_workflow_human_requirements` (`big_task_id`,`scope_kind`,`scope_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_transitions_sequence_unique` ON `durable_workflow_transitions` (`subtask_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `durable_workflow_transitions_workflow_order_index` ON `durable_workflow_transitions` (`subtask_id`,`sequence`,`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subtask_workflow_instances_authority_unique` ON `subtask_workflow_instances` (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`);
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_immutable_insert_conflict`
BEFORE INSERT ON `durable_workflow_evidence`
WHEN EXISTS (
	SELECT 1 FROM `durable_workflow_evidence` AS `existing`
	WHERE `existing`.`evidence_id` = NEW.`evidence_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_current_state_guard`
BEFORE INSERT ON `durable_workflow_evidence`
WHEN NEW.`expected_sequence` IS NOT (
		SELECT coalesce(max(`transition`.`sequence`), 0) + 1
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	OR NEW.`observed_stage` IS NOT coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		(SELECT `instance`.`initial_stage`
		 FROM `subtask_workflow_instances` AS `instance`
		 WHERE `instance`.`subtask_id` = NEW.`subtask_id`)
	)
	OR NEW.`observed_repair_cycles_used` IS NOT coalesce(
		(SELECT `transition`.`resulting_repair_cycles_used`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		(SELECT `instance`.`initial_repair_cycles_used`
		 FROM `subtask_workflow_instances` AS `instance`
		 WHERE `instance`.`subtask_id` = NEW.`subtask_id`)
	)
	OR EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
BEGIN
	SELECT RAISE(ABORT, 'stale durable workflow evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_immutable_update`
BEFORE UPDATE ON `durable_workflow_evidence`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_immutable_delete`
BEFORE DELETE ON `durable_workflow_evidence`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_transitions_immutable_insert_conflict`
BEFORE INSERT ON `durable_workflow_transitions`
WHEN EXISTS (
	SELECT 1 FROM `durable_workflow_transitions` AS `existing`
	WHERE `existing`.`operation_id` = NEW.`operation_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow transition');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_transitions_linear_append_guard`
BEFORE INSERT ON `durable_workflow_transitions`
WHEN NEW.`sequence` IS NOT (
		SELECT coalesce(max(`transition`.`sequence`), 0) + 1
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	OR NEW.`prior_stage` IS NOT coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		(SELECT `instance`.`initial_stage`
		 FROM `subtask_workflow_instances` AS `instance`
		 WHERE `instance`.`subtask_id` = NEW.`subtask_id`)
	)
	OR NEW.`prior_repair_cycles_used` IS NOT coalesce(
		(SELECT `transition`.`resulting_repair_cycles_used`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		(SELECT `instance`.`initial_repair_cycles_used`
		 FROM `subtask_workflow_instances` AS `instance`
		 WHERE `instance`.`subtask_id` = NEW.`subtask_id`)
	)
	OR EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
BEGIN
	SELECT RAISE(ABORT, 'nonlinear durable workflow transition');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_transitions_immutable_update`
BEFORE UPDATE ON `durable_workflow_transitions`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow transition');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_transitions_immutable_delete`
BEFORE DELETE ON `durable_workflow_transitions`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow transition');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_human_requirements_immutable_insert_conflict`
BEFORE INSERT ON `durable_workflow_human_requirements`
WHEN EXISTS (
	SELECT 1 FROM `durable_workflow_human_requirements` AS `existing`
	WHERE `existing`.`operation_id` = NEW.`operation_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable durable human requirement');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_human_requirements_current_state_guard`
BEFORE INSERT ON `durable_workflow_human_requirements`
WHEN (NEW.`scope_kind` = 'SUBTASK' AND (
	NEW.`sequence` IS NOT (
		SELECT coalesce(max(`transition`.`sequence`), 0) + 1
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	OR NEW.`current_stage` IS NOT coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		(SELECT `instance`.`initial_stage`
		 FROM `subtask_workflow_instances` AS `instance`
		 WHERE `instance`.`subtask_id` = NEW.`subtask_id`)
	)
	OR NEW.`repair_cycles_used` IS NOT coalesce(
		(SELECT `transition`.`resulting_repair_cycles_used`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		(SELECT `instance`.`initial_repair_cycles_used`
		 FROM `subtask_workflow_instances` AS `instance`
		 WHERE `instance`.`subtask_id` = NEW.`subtask_id`)
	)))
	OR EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (
			`human`.`scope_kind` = 'BIG_TASK'
			OR NEW.`scope_kind` = 'BIG_TASK'
			OR `human`.`subtask_id` = NEW.`subtask_id`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'conflicting durable human requirement');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_human_requirements_immutable_update`
BEFORE UPDATE ON `durable_workflow_human_requirements`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable human requirement');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_human_requirements_immutable_delete`
BEFORE DELETE ON `durable_workflow_human_requirements`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable human requirement');
END;
