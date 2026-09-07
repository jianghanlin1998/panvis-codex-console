-- Preserve all historical rows; the coordinator enables foreign keys again before exposing the database.
DROP TRIGGER "durable_workflow_evidence_authorities_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_authorities_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_authorities_immutable_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_authorities_immutable_update";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_immutable_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_immutable_update";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_evidence_trusted_authority_guard";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_human_requirements_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_human_requirements_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_human_requirements_immutable_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_human_requirements_immutable_update";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_transitions_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_transitions_immutable_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_transitions_immutable_update";
--> statement-breakpoint
DROP TRIGGER "durable_workflow_transitions_linear_append_guard";
--> statement-breakpoint
DROP TRIGGER "governed_big_task_completion_guard";
--> statement-breakpoint
DROP TRIGGER "governed_budget_extension_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "governed_dispatch_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "governed_finding_guard";
--> statement-breakpoint
DROP TRIGGER "governed_finding_resolution_guard";
--> statement-breakpoint
DROP TRIGGER "governed_handoff_guard";
--> statement-breakpoint
DROP TRIGGER "governed_manual_start_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "governed_promoted_context_guard";
--> statement-breakpoint
DROP TRIGGER "governed_provider_claim_guard";
--> statement-breakpoint
DROP TRIGGER "governed_role_authorization_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "governed_role_authorization_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "governed_role_authorization_immutable_update";
--> statement-breakpoint
DROP TRIGGER "governed_role_authorizations_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "governed_role_execution_link_guard";
--> statement-breakpoint
DROP TRIGGER "governed_role_result_guard";
--> statement-breakpoint
CREATE TABLE `__ctc_two_durable_workflow_evidence_authorities` (
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
        and "observed_repair_cycles_used" in (0, 1, 2)),
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
INSERT INTO "__ctc_two_durable_workflow_evidence_authorities" ("authority_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "expected_sequence", "observed_stage", "observed_repair_cycles_used", "source_type", "evidence_kind", "outcome", "producer", "source_reference", "occurred_at", "recorded_at") SELECT "authority_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "expected_sequence", "observed_stage", "observed_repair_cycles_used", "source_type", "evidence_kind", "outcome", "producer", "source_reference", "occurred_at", "recorded_at" FROM "durable_workflow_evidence_authorities";
--> statement-breakpoint
DROP TABLE "durable_workflow_evidence_authorities";
--> statement-breakpoint
ALTER TABLE "__ctc_two_durable_workflow_evidence_authorities" RENAME TO "durable_workflow_evidence_authorities";
--> statement-breakpoint
CREATE TABLE "__ctc_two_durable_workflow_evidence" (
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
        and "observed_repair_cycles_used" in (0, 1, 2)),
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
INSERT INTO "__ctc_two_durable_workflow_evidence" ("evidence_id", "authority_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "expected_sequence", "observed_stage", "observed_repair_cycles_used", "evidence_kind", "outcome", "producer", "source_reference", "occurred_at", "accepted_at") SELECT "evidence_id", "authority_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "expected_sequence", "observed_stage", "observed_repair_cycles_used", "evidence_kind", "outcome", "producer", "source_reference", "occurred_at", "accepted_at" FROM "durable_workflow_evidence";
--> statement-breakpoint
DROP TABLE "durable_workflow_evidence";
--> statement-breakpoint
ALTER TABLE "__ctc_two_durable_workflow_evidence" RENAME TO "durable_workflow_evidence";
--> statement-breakpoint
CREATE TABLE `__ctc_two_durable_workflow_transitions` (
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
        and "prior_repair_cycles_used" in (0, 1, 2)
        and "resulting_repair_cycles_used" in (0, 1, 2)),
	CONSTRAINT "durable_workflow_transitions_evidence_check" CHECK(length("evidence_references") between 2 and 16384)
);
--> statement-breakpoint
INSERT INTO "__ctc_two_durable_workflow_transitions" ("operation_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "sequence", "prior_stage", "resulting_stage", "prior_repair_cycles_used", "resulting_repair_cycles_used", "evidence_references", "occurred_at") SELECT "operation_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "sequence", "prior_stage", "resulting_stage", "prior_repair_cycles_used", "resulting_repair_cycles_used", "evidence_references", "occurred_at" FROM "durable_workflow_transitions";
--> statement-breakpoint
DROP TABLE "durable_workflow_transitions";
--> statement-breakpoint
ALTER TABLE "__ctc_two_durable_workflow_transitions" RENAME TO "durable_workflow_transitions";
--> statement-breakpoint
CREATE TABLE `__ctc_two_durable_workflow_human_requirements` (
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
          and "repair_cycles_used" in (0, 1, 2)
          and "reason" in ('REPAIR_REQA_EXHAUSTED', 'AUTHORITY_BLOCKED'))),
	CONSTRAINT "durable_workflow_human_requirements_evidence_check" CHECK(length("evidence_references") between 2 and 16384),
	CONSTRAINT "durable_workflow_human_requirements_source_check" CHECK(length(trim("source_reference")) between 1 and 2048)
);
--> statement-breakpoint
INSERT INTO "__ctc_two_durable_workflow_human_requirements" ("operation_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "scope_kind", "scope_key", "subtask_id", "sequence", "current_stage", "requested_next_stage", "repair_cycles_used", "reason", "evidence_references", "source_reference", "created_at") SELECT "operation_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "scope_kind", "scope_key", "subtask_id", "sequence", "current_stage", "requested_next_stage", "repair_cycles_used", "reason", "evidence_references", "source_reference", "created_at" FROM "durable_workflow_human_requirements";
--> statement-breakpoint
DROP TABLE "durable_workflow_human_requirements";
--> statement-breakpoint
ALTER TABLE "__ctc_two_durable_workflow_human_requirements" RENAME TO "durable_workflow_human_requirements";
--> statement-breakpoint
CREATE TABLE `__ctc_two_governed_role_authorizations` (
	`authorization_id` text PRIMARY KEY,
	`dispatch_receipt_id` text NOT NULL,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`workflow_sequence` integer NOT NULL,
	`workflow_stage` text NOT NULL,
	`repair_cycles_used` integer NOT NULL,
	`role` text NOT NULL,
	`context_profile` text NOT NULL,
	`write_enabled` integer NOT NULL,
	`worktree_ownership_id` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`authorized_at` text NOT NULL,
	CONSTRAINT `fk_governed_role_authorizations_dispatch_receipt_id_governed_dispatch_receipts_receipt_id_fk` FOREIGN KEY (`dispatch_receipt_id`) REFERENCES `governed_dispatch_receipts`(`receipt_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_role_authorizations_worktree_ownership_id_worktree_ownerships_id_fk` FOREIGN KEY (`worktree_ownership_id`) REFERENCES `worktree_ownerships`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `governed_role_workflow_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) REFERENCES `subtask_workflow_instances`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_role_id_check" CHECK(length("authorization_id") between 5 and 128 and "authorization_id" glob 'gra_*'),
	CONSTRAINT "governed_role_sequence_check" CHECK(typeof("workflow_sequence") = 'integer' and "workflow_sequence" >= 1),
	CONSTRAINT "governed_role_stage_role_check" CHECK(("workflow_stage" = 'EXECUTE' and "role" = 'EXECUTE')
        or ("workflow_stage" = 'VERIFY' and "role" = 'VERIFY')
        or ("workflow_stage" = 'HARDEN' and "role" = 'HARDEN')
        or ("workflow_stage" = 'FRESH_QA' and "role" = 'FRESH_QA')
        or ("workflow_stage" = 'REPAIR' and "role" = 'REPAIR')
        or ("workflow_stage" = 'FOCUSED_RE_QA' and "role" = 'FOCUSED_RE_QA')),
	CONSTRAINT "governed_role_repair_check" CHECK(typeof("repair_cycles_used") = 'integer' and "repair_cycles_used" in (0, 1, 2)),
	CONSTRAINT "governed_role_profile_check" CHECK(("role" in ('EXECUTE', 'VERIFY', 'HARDEN', 'REPAIR')
          and "context_profile" = 'STANDARD_SUBTASK_EXECUTION')
        or ("role" = 'FRESH_QA' and "context_profile" = 'FRESH_INDEPENDENT_QA')
        or ("role" = 'FOCUSED_RE_QA' and "context_profile" = 'FOCUSED_RE_QA')),
	CONSTRAINT "governed_role_write_check" CHECK(("role" in ('VERIFY', 'FRESH_QA', 'FOCUSED_RE_QA') and "write_enabled" = 0)
        or ("role" in ('EXECUTE', 'HARDEN', 'REPAIR') and "write_enabled" in (0, 1))),
	CONSTRAINT "governed_role_sha_check" CHECK(length("candidate_sha") in (40, 64) and "candidate_sha" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
INSERT INTO "__ctc_two_governed_role_authorizations" ("authorization_id", "dispatch_receipt_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "workflow_sequence", "workflow_stage", "repair_cycles_used", "role", "context_profile", "write_enabled", "worktree_ownership_id", "candidate_sha", "authorized_at") SELECT "authorization_id", "dispatch_receipt_id", "project_id", "big_task_id", "plan_revision", "candidate_binding", "subtask_id", "workflow_sequence", "workflow_stage", "repair_cycles_used", "role", "context_profile", "write_enabled", "worktree_ownership_id", "candidate_sha", "authorized_at" FROM "governed_role_authorizations";
--> statement-breakpoint
DROP TABLE "governed_role_authorizations";
--> statement-breakpoint
ALTER TABLE "__ctc_two_governed_role_authorizations" RENAME TO "governed_role_authorizations";
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_authorities_semantic_unique` ON `durable_workflow_evidence_authorities` (`subtask_id`,`expected_sequence`,`evidence_kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_authorities_source_unique` ON `durable_workflow_evidence_authorities` (`source_reference`);
--> statement-breakpoint
CREATE INDEX `durable_workflow_evidence_authorities_workflow_index` ON `durable_workflow_evidence_authorities` (`subtask_id`,`expected_sequence`,`authority_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_authority_unique` ON `durable_workflow_evidence` (`authority_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_semantic_unique` ON `durable_workflow_evidence` (`subtask_id`,`expected_sequence`,`evidence_kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_evidence_source_unique` ON `durable_workflow_evidence` (`subtask_id`,`evidence_kind`,`source_reference`);
--> statement-breakpoint
CREATE INDEX `durable_workflow_evidence_workflow_index` ON `durable_workflow_evidence` (`subtask_id`,`expected_sequence`,`evidence_id`);
--> statement-breakpoint
CREATE INDEX `durable_workflow_human_requirements_big_task_index` ON `durable_workflow_human_requirements` (`big_task_id`,`scope_kind`,`scope_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_human_requirements_scope_unique` ON `durable_workflow_human_requirements` (`project_id`,`big_task_id`,`scope_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_workflow_transitions_sequence_unique` ON `durable_workflow_transitions` (`subtask_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `durable_workflow_transitions_workflow_order_index` ON `durable_workflow_transitions` (`subtask_id`,`sequence`,`operation_id`);
--> statement-breakpoint
CREATE INDEX `governed_role_dispatch_index` ON `governed_role_authorizations` (`dispatch_receipt_id`,`workflow_sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `governed_role_stage_unique` ON `governed_role_authorizations` (`subtask_id`,`workflow_sequence`);
--> statement-breakpoint
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
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_authorities_immutable_delete`
BEFORE DELETE ON `durable_workflow_evidence_authorities`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence authority');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_authorities_immutable_insert_conflict`
BEFORE INSERT ON `durable_workflow_evidence_authorities`
WHEN EXISTS (
	SELECT 1 FROM `durable_workflow_evidence_authorities` AS `existing`
	WHERE `existing`.`authority_id` = NEW.`authority_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence authority');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_evidence_authorities_immutable_update`
BEFORE UPDATE ON `durable_workflow_evidence_authorities`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence authority');
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
CREATE TRIGGER `durable_workflow_evidence_immutable_delete`
BEFORE DELETE ON `durable_workflow_evidence`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;
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
CREATE TRIGGER `durable_workflow_evidence_immutable_update`
BEFORE UPDATE ON `durable_workflow_evidence`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow evidence');
END;
--> statement-breakpoint
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
CREATE TRIGGER `durable_workflow_human_requirements_immutable_delete`
BEFORE DELETE ON `durable_workflow_human_requirements`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable human requirement');
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
CREATE TRIGGER `durable_workflow_human_requirements_immutable_update`
BEFORE UPDATE ON `durable_workflow_human_requirements`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable human requirement');
END;
--> statement-breakpoint
CREATE TRIGGER `durable_workflow_transitions_immutable_delete`
BEFORE DELETE ON `durable_workflow_transitions`
BEGIN
	SELECT RAISE(ABORT, 'immutable durable workflow transition');
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
CREATE TRIGGER `durable_workflow_transitions_immutable_update`
BEFORE UPDATE ON `durable_workflow_transitions`
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
CREATE TRIGGER `governed_big_task_completion_guard`
BEFORE INSERT ON `governed_big_task_completion_receipts`
WHEN NOT EXISTS (
	SELECT 1
	FROM `canonical_task_materializations` AS `materialization`
	JOIN `big_tasks` AS `big_task` ON `big_task`.`id` = NEW.`big_task_id`
	WHERE `materialization`.`project_id` IS NEW.`project_id`
	AND `materialization`.`big_task_id` IS NEW.`big_task_id`
	AND `materialization`.`plan_revision` IS NEW.`plan_revision`
	AND `materialization`.`candidate_binding` IS NEW.`candidate_binding`
	AND `materialization`.`subtask_count` IS NEW.`subtask_count`
	AND `big_task`.`project_id` IS NEW.`project_id`
	AND `big_task`.`status` = 'IN_PROGRESS'
	AND NEW.`subtask_count` = (
		SELECT count(*) FROM `candidate_task_contract_bindings` AS `canonical`
		WHERE `canonical`.`project_id` = NEW.`project_id`
		AND `canonical`.`big_task_id` = NEW.`big_task_id`
		AND `canonical`.`plan_revision` = NEW.`plan_revision`
		AND `canonical`.`candidate_binding` = NEW.`candidate_binding`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `candidate_task_contract_bindings` AS `canonical`
		LEFT JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `canonical`.`subtask_id`
		LEFT JOIN `subtask_workflow_instances` AS `workflow`
			ON `workflow`.`subtask_id` = `canonical`.`subtask_id`
		WHERE `canonical`.`project_id` = NEW.`project_id`
		AND `canonical`.`big_task_id` = NEW.`big_task_id`
		AND `canonical`.`plan_revision` = NEW.`plan_revision`
		AND `canonical`.`candidate_binding` = NEW.`candidate_binding`
		AND (`subtask`.`id` IS NULL OR `workflow`.`subtask_id` IS NULL
   OR `workflow`.`candidate_binding` IS NOT NEW.candidate_binding
   OR `subtask`.`maturity` = 'NOT_STARTED'
   OR `subtask`.`status` <> 'DONE'
			OR coalesce(
				(SELECT `transition`.`resulting_stage`
				 FROM `durable_workflow_transitions` AS `transition`
				 WHERE `transition`.`subtask_id` = `canonical`.`subtask_id`
				 ORDER BY `transition`.`sequence` DESC LIMIT 1),
				`workflow`.`initial_stage`
			) <> 'COMPLETE')
	)
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'Big Task completion authority is incomplete');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_budget_extension_current_state_guard`
BEFORE INSERT ON `governed_budget_extensions`
WHEN NEW.usage_at_grant IS NULL OR NEW.usage_at_grant < 120000 OR NEW.usage_at_grant >= 160000
 OR NEW.usage_at_grant IS NOT (SELECT coalesce(sum(er.total_tokens), 0) FROM execution_runs er
   JOIN chat_threads ct ON ct.id = er.chat_thread_id WHERE ct.subtask_id = NEW.subtask_id AND er.usage_present = 1)
 OR EXISTS (SELECT 1 FROM execution_runs er JOIN chat_threads ct ON ct.id = er.chat_thread_id
   WHERE ct.subtask_id = NEW.subtask_id AND (er.status = 'RUNNING' OR er.started_at IS NOT NULL)
   AND (er.usage_present <> 1 OR er.total_tokens IS NULL))
 OR NOT EXISTS (
	SELECT 1 FROM `subtask_workflow_instances` AS `workflow`
	JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `workflow`.`subtask_id`
	WHERE `workflow`.`subtask_id` = NEW.`subtask_id`
	AND `workflow`.`project_id` IS NEW.`project_id`
	AND `workflow`.`big_task_id` IS NEW.`big_task_id`
	AND `workflow`.`plan_revision` IS NEW.`plan_revision`
	AND `workflow`.`candidate_binding` IS NEW.`candidate_binding`
	AND `subtask`.`status` IN ('TODO', 'IN_PROGRESS', 'QA_DEBUG')
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'stale governed budget-extension authority');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_dispatch_current_state_guard`
BEFORE INSERT ON `governed_dispatch_receipts`
WHEN NOT EXISTS (
	SELECT 1
	FROM `subtask_workflow_instances` AS `workflow`
	JOIN `candidate_task_contract_bindings` AS `canonical`
		ON `canonical`.`subtask_id` = `workflow`.`subtask_id`
	JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `workflow`.`subtask_id`
	JOIN `worktree_ownerships` AS `worktree`
		ON `worktree`.`id` = NEW.`worktree_ownership_id`
	WHERE `workflow`.`subtask_id` = NEW.`subtask_id`
	AND `workflow`.`project_id` IS NEW.`project_id`
	AND `workflow`.`big_task_id` IS NEW.`big_task_id`
	AND `workflow`.`plan_revision` IS NEW.`plan_revision`
	AND `workflow`.`candidate_binding` IS NEW.`candidate_binding`
	AND `canonical`.`project_id` IS NEW.`project_id`
	AND `canonical`.`big_task_id` IS NEW.`big_task_id`
	AND `canonical`.`plan_revision` IS NEW.`plan_revision`
	AND `canonical`.`candidate_binding` IS NEW.`candidate_binding`
	AND `subtask`.`status` = 'TODO'
	AND `subtask`.`start_policy` IS NEW.`start_policy`
	AND `worktree`.`subtask_id` IS NEW.`subtask_id`
	AND `worktree`.`project_id` IS NEW.`project_id`
	AND `worktree`.`status` = 'ACTIVE'
	AND coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		`workflow`.`initial_stage`
	) = 'EXECUTE'
	AND NEW.`workflow_sequence` = (
		SELECT coalesce(max(`transition`.`sequence`), 0) + 1
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
	AND (
		NEW.`start_policy` = 'WHEN_READY'
		OR EXISTS (
			SELECT 1 FROM `governed_manual_start_authorities` AS `manual`
			WHERE `manual`.`authority_id` = NEW.`manual_start_authority_id`
			AND `manual`.`project_id` IS NEW.`project_id`
			AND `manual`.`big_task_id` IS NEW.`big_task_id`
			AND `manual`.`plan_revision` IS NEW.`plan_revision`
			AND `manual`.`candidate_binding` IS NEW.`candidate_binding`
			AND `manual`.`subtask_id` IS NEW.`subtask_id`
			AND `manual`.`workflow_sequence` IS NEW.`workflow_sequence`
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM `task_dependencies` AS `dependency`
		JOIN `subtasks` AS `upstream`
			ON `upstream`.`id` = `dependency`.`upstream_subtask_id`
		WHERE `dependency`.`downstream_subtask_id` = NEW.`subtask_id`
		AND `dependency`.`dependency_type` = 'BLOCKING'
 AND ((`dependency`.`required_gate` = 'HARDENED' AND `upstream`.`maturity` NOT IN ('HARDENED','ACCEPTED'))
   OR (`dependency`.`required_gate` = 'ACCEPTED' AND `upstream`.`maturity` <> 'ACCEPTED'))
	)
	AND (
		SELECT count(*) FROM `governed_dispatch_receipts` AS `active`
		WHERE `active`.`project_id` = NEW.`project_id`
		AND `active`.`status` IN ('RESERVED', 'ACTIVE')
	) < 2
)
BEGIN
	SELECT RAISE(ABORT, 'stale or unauthorized governed dispatch');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_finding_guard`
BEFORE INSERT ON `governed_findings`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_results` AS `result`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `result`.`result_id` = NEW.`result_id`
	AND `authorization`.`subtask_id` IS NEW.`subtask_id`
	AND (`result`.`outcome` = 'BLOCKING_FAIL' OR (`result`.`outcome` = 'PASS' AND NEW.`blocking` = 0))
	AND `result`.`role` IN ('VERIFY', 'HARDEN', 'FRESH_QA', 'FOCUSED_RE_QA')
)
BEGIN
 SELECT RAISE(ABORT, 'invalid governed finding');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_finding_resolution_guard`
BEFORE INSERT ON `governed_finding_resolutions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_findings` AS `finding`
	JOIN `governed_role_results` AS `result`
		ON `result`.`result_id` = NEW.`role_result_id`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `finding`.`finding_id` = NEW.`finding_id`
	AND `finding`.`blocking` = 1
	AND `finding`.`subtask_id` IS `authorization`.`subtask_id`
	AND `result`.`role` = 'FOCUSED_RE_QA'
	AND `result`.`outcome` = 'PASS'
 AND EXISTS (SELECT 1 FROM governed_provider_claims claim, json_each(claim.target_finding_ids) target
   WHERE claim.authorization_id = result.authorization_id AND target.value = NEW.finding_id)
 AND EXISTS (SELECT 1 FROM governed_role_results fresh WHERE fresh.result_id = finding.result_id
   AND fresh.role IN ('FRESH_QA', 'FOCUSED_RE_QA') AND fresh.outcome = 'BLOCKING_FAIL'
   AND EXISTS (SELECT 1 FROM governed_role_authorizations qa_authority WHERE qa_authority.authorization_id = fresh.authorization_id
     AND qa_authority.subtask_id = authorization.subtask_id AND qa_authority.workflow_sequence < authorization.workflow_sequence))
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed finding resolution');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_handoff_guard`
BEFORE INSERT ON `governed_handoffs`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_results` AS `result`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `result`.`result_id` = NEW.`role_result_id`
	AND `authorization`.`subtask_id` IS NEW.`subtask_id`
	AND `result`.`outcome` = 'PASS'
 AND `result`.`role` IN ('VERIFY','FRESH_QA','FOCUSED_RE_QA')
 AND `result`.`summary` IS NEW.summary AND `result`.`occurred_at` IS NEW.created_at
	AND `result`.`candidate_sha` IS NEW.`candidate_sha`
	AND NOT EXISTS (
		SELECT 1 FROM `governed_findings` AS `finding`
		LEFT JOIN `governed_finding_resolutions` AS `resolution`
			ON `resolution`.`finding_id` = `finding`.`finding_id`
		WHERE `finding`.`subtask_id` = NEW.`subtask_id`
		AND `finding`.`blocking` = 1
		AND `resolution`.`finding_id` IS NULL
	)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed handoff');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_manual_start_current_state_guard`
BEFORE INSERT ON `governed_manual_start_authorities`
WHEN NOT EXISTS (
	SELECT 1
	FROM `subtask_workflow_instances` AS `workflow`
	JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `workflow`.`subtask_id`
	WHERE `workflow`.`subtask_id` = NEW.`subtask_id`
	AND `workflow`.`project_id` IS NEW.`project_id`
	AND `workflow`.`big_task_id` IS NEW.`big_task_id`
	AND `workflow`.`plan_revision` IS NEW.`plan_revision`
	AND `workflow`.`candidate_binding` IS NEW.`candidate_binding`
	AND `subtask`.`start_policy` = 'MANUAL'
	AND `subtask`.`status` = 'TODO'
	AND coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		`workflow`.`initial_stage`
	) IN ('MATERIALIZE', 'EXECUTE')
	AND NEW.`workflow_sequence` = (
		SELECT coalesce(max(`transition`.`sequence`), 0) + CASE WHEN `workflow`.`initial_stage` = 'MATERIALIZE' AND count(*) = 0 THEN 2 ELSE 1 END
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'stale governed manual-start authority');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_promoted_context_guard`
BEFORE INSERT ON `governed_promoted_context_dispositions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_results` AS `result`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `result`.`result_id` = NEW.`role_result_id`
	AND `authorization`.`subtask_id` IS NEW.`subtask_id`
	AND `result`.`outcome` = 'PASS'
 AND `result`.`role` IN ('VERIFY','FRESH_QA','FOCUSED_RE_QA')
 AND `result`.`occurred_at` IS NEW.created_at
 AND NEW.decision = CASE WHEN EXISTS (
   SELECT 1 FROM governed_promotion_candidates pc
   JOIN governed_role_results rr ON rr.result_id = pc.result_id
   JOIN governed_role_authorizations a ON a.authorization_id = rr.authorization_id
   WHERE a.subtask_id = NEW.subtask_id
 ) THEN 'CANDIDATE_RECORDED' ELSE 'NO_PROMOTION_CANDIDATE' END
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed promoted-context disposition');
END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claim_guard BEFORE INSERT ON governed_provider_claims
WHEN NOT EXISTS (SELECT 1 FROM governed_role_authorizations a
 JOIN governed_role_execution_links l ON l.authorization_id = a.authorization_id
 JOIN execution_runs er ON er.id = l.execution_run_id JOIN chat_threads ct ON ct.id = l.chat_thread_id
 WHERE a.authorization_id = NEW.authorization_id AND l.execution_run_id IS NEW.execution_run_id
 AND a.candidate_sha IS NEW.candidate_sha AND er.status = 'CREATED' AND ct.provider_thread_id IS NULL)
 OR NOT json_valid(NEW.target_finding_ids) OR json_array_length(NEW.target_finding_ids) > CASE WHEN EXISTS (
  SELECT 1 FROM big_task_execution_approvals approval JOIN governed_role_authorizations auth ON auth.big_task_id = approval.big_task_id
  WHERE auth.authorization_id = NEW.authorization_id AND json_extract(approval.payload, '$.request.limits.repairCycleLimit') = 2
 ) THEN 32 ELSE 16 END
BEGIN SELECT RAISE(ABORT, 'invalid governed provider claim'); END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_authorization_current_state_guard`
BEFORE INSERT ON `governed_role_authorizations`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_dispatch_receipts` AS `dispatch`
	JOIN `subtask_workflow_instances` AS `workflow`
		ON `workflow`.`subtask_id` = NEW.`subtask_id`
	JOIN `candidate_task_contract_bindings` AS `canonical`
		ON `canonical`.`subtask_id` = NEW.`subtask_id`
	JOIN `worktree_ownerships` AS `worktree`
		ON `worktree`.`id` = NEW.`worktree_ownership_id`
	WHERE `dispatch`.`receipt_id` = NEW.`dispatch_receipt_id`
	AND `dispatch`.`status` IN ('RESERVED', 'ACTIVE')
	AND `dispatch`.`project_id` IS NEW.`project_id`
	AND `dispatch`.`big_task_id` IS NEW.`big_task_id`
	AND `dispatch`.`plan_revision` IS NEW.`plan_revision`
	AND `dispatch`.`candidate_binding` IS NEW.`candidate_binding`
	AND `dispatch`.`subtask_id` IS NEW.`subtask_id`
	AND `dispatch`.`worktree_ownership_id` IS NEW.`worktree_ownership_id`
	AND `workflow`.`project_id` IS NEW.`project_id`
	AND `workflow`.`big_task_id` IS NEW.`big_task_id`
	AND `workflow`.`plan_revision` IS NEW.`plan_revision`
	AND `workflow`.`candidate_binding` IS NEW.`candidate_binding`
	AND `canonical`.`project_id` IS NEW.`project_id`
	AND `canonical`.`big_task_id` IS NEW.`big_task_id`
	AND `canonical`.`plan_revision` IS NEW.`plan_revision`
	AND `canonical`.`candidate_binding` IS NEW.`candidate_binding`
	AND `worktree`.`subtask_id` IS NEW.`subtask_id`
	AND `worktree`.`project_id` IS NEW.`project_id`
	AND `worktree`.`status` = 'ACTIVE'
	AND NEW.`workflow_sequence` = (
		SELECT coalesce(max(`transition`.`sequence`), 0) + 1
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	AND NEW.`workflow_stage` IS coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		`workflow`.`initial_stage`
	)
	AND NEW.`repair_cycles_used` IS coalesce(
		(SELECT `transition`.`resulting_repair_cycles_used`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		`workflow`.`initial_repair_cycles_used`
	)
	AND NEW.`write_enabled` = CASE
		WHEN NEW.`role` IN ('EXECUTE', 'HARDEN', 'REPAIR')
			THEN `dispatch`.`write_enabled`
		ELSE 0 END
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'stale governed role authorization');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_authorization_immutable_delete`
BEFORE DELETE ON `governed_role_authorizations`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role authorization');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_authorization_immutable_update`
BEFORE UPDATE ON `governed_role_authorizations`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role authorization');
END;
--> statement-breakpoint
CREATE TRIGGER governed_role_authorizations_insert_conflict BEFORE INSERT ON governed_role_authorizations
WHEN EXISTS (SELECT 1 FROM governed_role_authorizations WHERE (authorization_id IS NEW.authorization_id) OR (subtask_id IS NEW.subtask_id AND workflow_sequence IS NEW.workflow_sequence))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_execution_link_guard`
BEFORE INSERT ON `governed_role_execution_links`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_authorizations` AS `authorization`
	JOIN `chat_threads` AS `thread` ON `thread`.`id` = NEW.`chat_thread_id`
	JOIN `execution_runs` AS `run` ON `run`.`id` = NEW.`execution_run_id`
	WHERE `authorization`.`authorization_id` = NEW.`authorization_id`
	AND `thread`.`subtask_id` IS `authorization`.`subtask_id`
	AND `thread`.`provider_id` = 'codex-app-server'
	AND `thread`.`status` = 'OPEN'
	AND `thread`.`provider_thread_id` IS NULL
	AND `run`.`chat_thread_id` IS NEW.`chat_thread_id`
	AND `run`.`status` = 'CREATED'
	AND `run`.`started_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed role execution link');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_result_guard`
BEFORE INSERT ON `governed_role_results`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_authorizations` AS `authorization`
	JOIN `governed_role_execution_links` AS `link`
		ON `link`.`authorization_id` = `authorization`.`authorization_id`
	JOIN `execution_runs` AS `run` ON `run`.`id` = `link`.`execution_run_id`
	WHERE `authorization`.`authorization_id` = NEW.`authorization_id`
	AND `authorization`.`role` IS NEW.`role`
	AND `link`.`execution_run_id` IS NEW.`execution_run_id`
	AND `run`.`status` = 'RUNNING'
	AND (`authorization`.`write_enabled` = 1
		OR NEW.`candidate_sha` IS `authorization`.`candidate_sha`)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed role result');
END;
--> statement-breakpoint
CREATE TABLE __ctc_migration_integrity (valid INTEGER CHECK (valid = 1));
--> statement-breakpoint
INSERT INTO __ctc_migration_integrity SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE __ctc_migration_integrity;
