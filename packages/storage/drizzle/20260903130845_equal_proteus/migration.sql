CREATE TABLE `durable_workflow_evidence_authorities` (
	`authority_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`expected_sequence` integer NOT NULL,
	`observed_stage` text NOT NULL,
	`observed_repair_cycles_used` integer NOT NULL,
	`source_type` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`outcome` text NOT NULL,
	`producer` text NOT NULL,
	`source_reference` text NOT NULL,
	`occurred_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `durable_workflow_evidence_authorities_workflow_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) REFERENCES `subtask_workflow_instances`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "durable_workflow_evidence_authorities_id_check" CHECK(length("authority_id") between 5 and 128 and "authority_id" glob 'wfa_*'),
	CONSTRAINT "durable_workflow_evidence_authorities_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "durable_workflow_evidence_authorities_sequence_check" CHECK(typeof("expected_sequence") = 'integer' and "expected_sequence" >= 1),
	CONSTRAINT "durable_workflow_evidence_authorities_stage_check" CHECK("observed_stage" in ('MATERIALIZE', 'EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')),
	CONSTRAINT "durable_workflow_evidence_authorities_repair_check" CHECK(typeof("observed_repair_cycles_used") = 'integer'
        and "observed_repair_cycles_used" in (0, 1)),
	CONSTRAINT "durable_workflow_evidence_authorities_source_check" CHECK(("source_type" = 'REPOSITORY_PREFLIGHT' and "evidence_kind" = 'REPOSITORY_PREFLIGHT_PASSED' and "producer" = 'OPERATIONAL_GATE')
        or ("source_type" = 'CONTEXT_PREFLIGHT' and "evidence_kind" = 'CONTEXT_PREFLIGHT_PASSED' and "producer" = 'OPERATIONAL_GATE')
        or ("source_type" = 'BUDGET_GATE' and "evidence_kind" = 'BUDGET_AVAILABLE' and "producer" = 'OPERATIONAL_GATE')
        or ("source_type" = 'CONCURRENCY_GATE' and "evidence_kind" = 'CONCURRENCY_AVAILABLE' and "producer" = 'OPERATIONAL_GATE')
        or ("source_type" = 'WORKTREE_OWNERSHIP' and "evidence_kind" = 'WORKTREE_OWNERSHIP_AVAILABLE' and "producer" = 'OPERATIONAL_GATE')
        or ("source_type" = 'HUMAN_APPROVAL' and "evidence_kind" = 'HUMAN_APPROVAL_SATISFIED' and "producer" = 'HUMAN_AUTHORITY')
        or ("source_type" = 'VERIFICATION_ROLE' and "evidence_kind" = 'VERIFICATION_EVIDENCE_PASSED' and "producer" = 'WORKFLOW_ROLE')
        or ("source_type" = 'HARDENING_ROLE' and "evidence_kind" = 'HARDENING_EVIDENCE_PASSED' and "producer" = 'WORKFLOW_ROLE')
        or ("source_type" = 'FRESH_INDEPENDENT_QA' and "evidence_kind" = 'FRESH_QA_OUTCOME_RECORDED' and "producer" = 'WORKFLOW_ROLE')
        or ("source_type" = 'REPAIR_ROLE' and "evidence_kind" = 'REPAIR_EVIDENCE_PASSED' and "producer" = 'WORKFLOW_ROLE')
        or ("source_type" = 'FOCUSED_RE_QA' and "evidence_kind" = 'FOCUSED_RE_QA_OUTCOME_RECORDED' and "producer" = 'WORKFLOW_ROLE')
        or ("source_type" = 'BLOCKING_FINDING_CONTROL' and "evidence_kind" = 'NO_UNRESOLVED_BLOCKING_FINDING' and "producer" = 'DELIVERY_CONTROL')
        or ("source_type" = 'HANDOFF_CONTROL' and "evidence_kind" = 'HANDOFF_PRESENT' and "producer" = 'DELIVERY_CONTROL')
        or ("source_type" = 'PROMOTED_CONTEXT_DISPOSITION' and "evidence_kind" = 'PROMOTED_CONTEXT_DISPOSITION_RECORDED' and "producer" = 'DELIVERY_CONTROL')),
	CONSTRAINT "durable_workflow_evidence_authorities_outcome_check" CHECK("outcome" in ('PASS', 'BLOCKING_FAIL')
        and ("evidence_kind" in ('FRESH_QA_OUTCOME_RECORDED', 'FOCUSED_RE_QA_OUTCOME_RECORDED') or "outcome" = 'PASS')),
	CONSTRAINT "durable_workflow_evidence_authorities_reference_check" CHECK(length(trim("source_reference")) between 1 and 2048)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_durable_workflow_evidence` (
	`evidence_id` text PRIMARY KEY,
	`authority_id` text,
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
	CONSTRAINT `durable_workflow_evidence_authority_fk` FOREIGN KEY (`authority_id`) REFERENCES `durable_workflow_evidence_authorities`(`authority_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "durable_workflow_evidence_id_check" CHECK(length("evidence_id") between 5 and 128 and "evidence_id" glob 'wfe_*'),
	CONSTRAINT "durable_workflow_evidence_authority_id_check" CHECK("authority_id" is null or (length("authority_id") between 5 and 128 and "authority_id" glob 'wfa_*')),
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
INSERT INTO `__new_durable_workflow_evidence`(`evidence_id`, `project_id`, `big_task_id`, `plan_revision`, `candidate_binding`, `subtask_id`, `expected_sequence`, `observed_stage`, `observed_repair_cycles_used`, `evidence_kind`, `outcome`, `producer`, `source_reference`, `occurred_at`, `accepted_at`) SELECT `evidence_id`, `project_id`, `big_task_id`, `plan_revision`, `candidate_binding`, `subtask_id`, `expected_sequence`, `observed_stage`, `observed_repair_cycles_used`, `evidence_kind`, `outcome`, `producer`, `source_reference`, `occurred_at`, `accepted_at` FROM `durable_workflow_evidence`;--> statement-breakpoint
DROP TABLE `durable_workflow_evidence`;--> statement-breakpoint
ALTER TABLE `__new_durable_workflow_evidence` RENAME TO `durable_workflow_evidence`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_authority_unique` ON `durable_workflow_evidence` (`authority_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_semantic_unique` ON `durable_workflow_evidence` (`subtask_id`,`expected_sequence`,`evidence_kind`);--> statement-breakpoint
CREATE INDEX `durable_workflow_evidence_workflow_index` ON `durable_workflow_evidence` (`subtask_id`,`expected_sequence`,`evidence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_source_unique` ON `durable_workflow_evidence` (`subtask_id`,`evidence_kind`,`source_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_authorities_source_unique` ON `durable_workflow_evidence_authorities` (`source_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_authorities_semantic_unique` ON `durable_workflow_evidence_authorities` (`subtask_id`,`expected_sequence`,`evidence_kind`);--> statement-breakpoint
CREATE INDEX `durable_workflow_evidence_authorities_workflow_index` ON `durable_workflow_evidence_authorities` (`subtask_id`,`expected_sequence`,`authority_id`);--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_authorities_immutable_insert_conflict`
BEFORE INSERT ON `durable_workflow_evidence_authorities`
WHEN EXISTS (
	SELECT 1 FROM `durable_workflow_evidence_authorities` AS `existing`
	WHERE `existing`.`authority_id` = NEW.`authority_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence authority');
END;--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_authorities_current_state_guard`
BEFORE INSERT ON `durable_workflow_evidence_authorities`
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
	SELECT RAISE(ABORT, 'stale durable workflow evidence authority');
END;--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_authorities_immutable_update`
BEFORE UPDATE ON `durable_workflow_evidence_authorities`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence authority');
END;--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_authorities_immutable_delete`
BEFORE DELETE ON `durable_workflow_evidence_authorities`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence authority');
END;--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_immutable_insert_conflict`
BEFORE INSERT ON `durable_workflow_evidence`
WHEN EXISTS (
	SELECT 1 FROM `durable_workflow_evidence` AS `existing`
	WHERE `existing`.`evidence_id` = NEW.`evidence_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_trusted_authority_guard`
BEFORE INSERT ON `durable_workflow_evidence`
WHEN NEW.`authority_id` IS NULL OR NOT EXISTS (
	SELECT 1 FROM `durable_workflow_evidence_authorities` AS `authority`
	WHERE `authority`.`authority_id` = NEW.`authority_id`
	AND `authority`.`project_id` IS NEW.`project_id`
	AND `authority`.`big_task_id` IS NEW.`big_task_id`
	AND `authority`.`plan_revision` IS NEW.`plan_revision`
	AND `authority`.`candidate_binding` IS NEW.`candidate_binding`
	AND `authority`.`subtask_id` IS NEW.`subtask_id`
	AND `authority`.`expected_sequence` IS NEW.`expected_sequence`
	AND `authority`.`observed_stage` IS NEW.`observed_stage`
	AND `authority`.`observed_repair_cycles_used` IS NEW.`observed_repair_cycles_used`
	AND `authority`.`evidence_kind` IS NEW.`evidence_kind`
	AND `authority`.`outcome` IS NEW.`outcome`
	AND `authority`.`producer` IS NEW.`producer`
	AND `authority`.`source_reference` IS NEW.`source_reference`
	AND `authority`.`occurred_at` IS NEW.`occurred_at`
)
BEGIN
	SELECT RAISE(ABORT, 'untrusted durable workflow evidence');
END;--> statement-breakpoint
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
END;--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_immutable_update`
BEFORE UPDATE ON `durable_workflow_evidence`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_immutable_delete`
BEFORE DELETE ON `durable_workflow_evidence`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;
