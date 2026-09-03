CREATE TABLE `governed_big_task_completion_receipts` (
	`receipt_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_count` integer NOT NULL,
	`completed_at` text NOT NULL,
	CONSTRAINT `fk_governed_big_task_completion_receipts_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `governed_big_task_completion_materialization_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) REFERENCES `canonical_task_materializations`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_big_task_completion_id_check" CHECK(length("receipt_id") between 5 and 128 and "receipt_id" glob 'gbc_*'),
	CONSTRAINT "governed_big_task_completion_count_check" CHECK(typeof("subtask_count") = 'integer' and "subtask_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE `governed_budget_extensions` (
	`authority_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`granted_tokens` integer NOT NULL,
	`authorized_at` text NOT NULL,
	CONSTRAINT `governed_budget_extension_workflow_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) REFERENCES `subtask_workflow_instances`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_budget_extension_id_check" CHECK(length("authority_id") between 5 and 128 and "authority_id" glob 'gbe_*'),
	CONSTRAINT "governed_budget_extension_amount_check" CHECK(typeof("granted_tokens") = 'integer' and "granted_tokens" = 40000)
);
--> statement-breakpoint
CREATE TABLE `governed_dispatch_receipts` (
	`receipt_id` text PRIMARY KEY,
	`operation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`workflow_sequence` integer NOT NULL,
	`profile` text NOT NULL,
	`write_enabled` integer NOT NULL,
	`start_policy` text NOT NULL,
	`manual_start_authority_id` text,
	`worktree_ownership_id` text NOT NULL,
	`gate_evidence_references` text NOT NULL,
	`status` text NOT NULL,
	`reserved_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`terminal_at` text,
	CONSTRAINT `fk_governed_dispatch_receipts_worktree_ownership_id_worktree_ownerships_id_fk` FOREIGN KEY (`worktree_ownership_id`) REFERENCES `worktree_ownerships`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `governed_dispatch_workflow_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) REFERENCES `subtask_workflow_instances`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `governed_dispatch_manual_start_fk` FOREIGN KEY (`manual_start_authority_id`) REFERENCES `governed_manual_start_authorities`(`authority_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_dispatch_id_check" CHECK(length("receipt_id") between 5 and 128 and "receipt_id" glob 'gdr_*'),
	CONSTRAINT "governed_dispatch_operation_id_check" CHECK(length("operation_id") between 5 and 128 and "operation_id" glob 'gdo_*'),
	CONSTRAINT "governed_dispatch_sequence_check" CHECK(typeof("workflow_sequence") = 'integer' and "workflow_sequence" >= 1),
	CONSTRAINT "governed_dispatch_profile_check" CHECK("profile" in ('LOW', 'STANDARD', 'HIGH_RISK_FOUNDATION')),
	CONSTRAINT "governed_dispatch_write_check" CHECK("write_enabled" in (0, 1)),
	CONSTRAINT "governed_dispatch_start_policy_check" CHECK(("start_policy" = 'WHEN_READY' and "manual_start_authority_id" is null)
        or ("start_policy" = 'MANUAL' and "manual_start_authority_id" is not null)),
	CONSTRAINT "governed_dispatch_gate_refs_check" CHECK(length("gate_evidence_references") between 2 and 16384),
	CONSTRAINT "governed_dispatch_lifecycle_check" CHECK(("status" in ('RESERVED', 'ACTIVE') and "terminal_at" is null)
        or ("status" in ('COMPLETED', 'HUMAN_REQUIRED')
          and "terminal_at" is not null
          and "updated_at" = "terminal_at"))
);
--> statement-breakpoint
CREATE TABLE `governed_finding_resolutions` (
	`finding_id` text PRIMARY KEY,
	`role_result_id` text NOT NULL,
	`resolved_at` text NOT NULL,
	CONSTRAINT `fk_governed_finding_resolutions_finding_id_governed_findings_finding_id_fk` FOREIGN KEY (`finding_id`) REFERENCES `governed_findings`(`finding_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_finding_resolutions_role_result_id_governed_role_results_result_id_fk` FOREIGN KEY (`role_result_id`) REFERENCES `governed_role_results`(`result_id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `governed_findings` (
	`finding_id` text PRIMARY KEY,
	`result_id` text NOT NULL,
	`subtask_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`provider_finding_key` text NOT NULL,
	`blocking` integer NOT NULL,
	`violated_invariant` text NOT NULL,
	`affected_contract` text NOT NULL,
	`reproduction` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_governed_findings_result_id_governed_role_results_result_id_fk` FOREIGN KEY (`result_id`) REFERENCES `governed_role_results`(`result_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_finding_id_check" CHECK(length("finding_id") between 5 and 128 and "finding_id" glob 'gfd_*'),
	CONSTRAINT "governed_finding_ordinal_check" CHECK(typeof("ordinal") = 'integer' and "ordinal" between 0 and 15),
	CONSTRAINT "governed_finding_blocking_check" CHECK("blocking" in (0, 1)),
	CONSTRAINT "governed_finding_text_check" CHECK(length(trim("provider_finding_key")) between 1 and 128
        and length(trim("violated_invariant")) between 1 and 1000
        and length(trim("affected_contract")) between 1 and 256
        and length(trim("reproduction")) between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE `governed_handoffs` (
	`handoff_id` text PRIMARY KEY,
	`subtask_id` text NOT NULL,
	`role_result_id` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`summary` text NOT NULL,
	`verification_disposition` text NOT NULL,
	`remaining_blocker_count` integer NOT NULL,
	`scope_confirmation` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_governed_handoffs_role_result_id_governed_role_results_result_id_fk` FOREIGN KEY (`role_result_id`) REFERENCES `governed_role_results`(`result_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_handoff_id_check" CHECK(length("handoff_id") between 5 and 128 and "handoff_id" glob 'gho_*'),
	CONSTRAINT "governed_handoff_sha_check" CHECK(length("candidate_sha") in (40, 64) and "candidate_sha" not glob '*[^0-9a-f]*'),
	CONSTRAINT "governed_handoff_disposition_check" CHECK("verification_disposition" = 'PASS'
        and typeof("remaining_blocker_count") = 'integer'
        and "remaining_blocker_count" = 0
        and "scope_confirmation" = 'TASK_CONTRACT_SCOPE_CONFIRMED')
);
--> statement-breakpoint
CREATE TABLE `governed_manual_start_authorities` (
	`authority_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`workflow_sequence` integer NOT NULL,
	`authorized_at` text NOT NULL,
	CONSTRAINT `governed_manual_start_workflow_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) REFERENCES `subtask_workflow_instances`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`,`subtask_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_manual_start_id_check" CHECK(length("authority_id") between 5 and 128 and "authority_id" glob 'gms_*'),
	CONSTRAINT "governed_manual_start_sequence_check" CHECK(typeof("workflow_sequence") = 'integer' and "workflow_sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE `governed_promoted_context_dispositions` (
	`disposition_id` text PRIMARY KEY,
	`subtask_id` text NOT NULL,
	`role_result_id` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_governed_promoted_context_dispositions_role_result_id_governed_role_results_result_id_fk` FOREIGN KEY (`role_result_id`) REFERENCES `governed_role_results`(`result_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_promoted_context_id_check" CHECK(length("disposition_id") between 5 and 128 and "disposition_id" glob 'gpc_*'),
	CONSTRAINT "governed_promoted_context_decision_check" CHECK("decision" in ('NO_PROMOTION_CANDIDATE', 'CANDIDATE_RECORDED'))
);
--> statement-breakpoint
CREATE TABLE `governed_role_authorizations` (
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
	CONSTRAINT "governed_role_repair_check" CHECK(typeof("repair_cycles_used") = 'integer' and "repair_cycles_used" in (0, 1)),
	CONSTRAINT "governed_role_profile_check" CHECK(("role" in ('EXECUTE', 'VERIFY', 'HARDEN', 'REPAIR')
          and "context_profile" = 'STANDARD_SUBTASK_EXECUTION')
        or ("role" = 'FRESH_QA' and "context_profile" = 'FRESH_INDEPENDENT_QA')
        or ("role" = 'FOCUSED_RE_QA' and "context_profile" = 'FOCUSED_RE_QA')),
	CONSTRAINT "governed_role_write_check" CHECK(("role" in ('VERIFY', 'FRESH_QA', 'FOCUSED_RE_QA') and "write_enabled" = 0)
        or ("role" in ('EXECUTE', 'HARDEN', 'REPAIR') and "write_enabled" in (0, 1))),
	CONSTRAINT "governed_role_sha_check" CHECK(length("candidate_sha") in (40, 64) and "candidate_sha" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `governed_role_execution_links` (
	`authorization_id` text PRIMARY KEY,
	`chat_thread_id` text NOT NULL,
	`execution_run_id` text NOT NULL,
	`linked_at` text NOT NULL,
	CONSTRAINT `fk_governed_role_execution_links_authorization_id_governed_role_authorizations_authorization_id_fk` FOREIGN KEY (`authorization_id`) REFERENCES `governed_role_authorizations`(`authorization_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_role_execution_links_chat_thread_id_chat_threads_id_fk` FOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_role_execution_links_execution_run_id_execution_runs_id_fk` FOREIGN KEY (`execution_run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `governed_role_results` (
	`result_id` text PRIMARY KEY,
	`authorization_id` text NOT NULL,
	`execution_run_id` text NOT NULL,
	`role` text NOT NULL,
	`outcome` text NOT NULL,
	`summary` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`occurred_at` text NOT NULL,
	CONSTRAINT `fk_governed_role_results_authorization_id_governed_role_authorizations_authorization_id_fk` FOREIGN KEY (`authorization_id`) REFERENCES `governed_role_authorizations`(`authorization_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_role_results_execution_run_id_execution_runs_id_fk` FOREIGN KEY (`execution_run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_role_result_id_check" CHECK(length("result_id") between 5 and 128 and "result_id" glob 'grr_*'),
	CONSTRAINT "governed_role_result_role_check" CHECK("role" in ('EXECUTE', 'VERIFY', 'HARDEN', 'FRESH_QA', 'REPAIR', 'FOCUSED_RE_QA')),
	CONSTRAINT "governed_role_result_outcome_check" CHECK(("role" in ('EXECUTE', 'REPAIR') and "outcome" in ('READY', 'BLOCKED'))
        or ("role" in ('VERIFY', 'HARDEN', 'FRESH_QA', 'FOCUSED_RE_QA')
          and "outcome" in ('PASS', 'BLOCKING_FAIL'))),
	CONSTRAINT "governed_role_result_summary_check" CHECK(length(trim("summary")) between 1 and 1000),
	CONSTRAINT "governed_role_result_sha_check" CHECK(length("candidate_sha") in (40, 64) and "candidate_sha" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `governed_big_task_completion_big_task_unique` ON `governed_big_task_completion_receipts` (`big_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_budget_extension_subtask_unique` ON `governed_budget_extensions` (`subtask_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_dispatch_operation_unique` ON `governed_dispatch_receipts` (`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_dispatch_subtask_unique` ON `governed_dispatch_receipts` (`subtask_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_dispatch_project_active_write_unique` ON `governed_dispatch_receipts` (`project_id`) WHERE "governed_dispatch_receipts"."write_enabled" = 1 and "governed_dispatch_receipts"."status" in ('RESERVED', 'ACTIVE');--> statement-breakpoint
CREATE INDEX `governed_dispatch_big_task_index` ON `governed_dispatch_receipts` (`big_task_id`,`status`,`receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_finding_result_ordinal_unique` ON `governed_findings` (`result_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `governed_finding_subtask_index` ON `governed_findings` (`subtask_id`,`created_at`,`finding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_handoff_subtask_unique` ON `governed_handoffs` (`subtask_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_handoff_result_unique` ON `governed_handoffs` (`role_result_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_manual_start_subtask_unique` ON `governed_manual_start_authorities` (`subtask_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_promoted_context_subtask_unique` ON `governed_promoted_context_dispositions` (`subtask_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_promoted_context_result_unique` ON `governed_promoted_context_dispositions` (`role_result_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_role_stage_unique` ON `governed_role_authorizations` (`subtask_id`,`workflow_sequence`);--> statement-breakpoint
CREATE INDEX `governed_role_dispatch_index` ON `governed_role_authorizations` (`dispatch_receipt_id`,`workflow_sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_role_thread_unique` ON `governed_role_execution_links` (`chat_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_role_run_unique` ON `governed_role_execution_links` (`execution_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_role_result_authorization_unique` ON `governed_role_results` (`authorization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_role_result_run_unique` ON `governed_role_results` (`execution_run_id`);
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
)
BEGIN
	SELECT RAISE(ABORT, 'stale governed manual-start authority');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_manual_start_immutable_update`
BEFORE UPDATE ON `governed_manual_start_authorities`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed manual-start authority');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_manual_start_immutable_delete`
BEFORE DELETE ON `governed_manual_start_authorities`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed manual-start authority');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_budget_extension_current_state_guard`
BEFORE INSERT ON `governed_budget_extensions`
WHEN NOT EXISTS (
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
CREATE TRIGGER `governed_budget_extension_immutable_update`
BEFORE UPDATE ON `governed_budget_extensions`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed budget-extension authority');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_budget_extension_immutable_delete`
BEFORE DELETE ON `governed_budget_extensions`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed budget-extension authority');
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
		AND `upstream`.`status` <> 'DONE'
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
CREATE TRIGGER `governed_dispatch_start_subtask`
AFTER INSERT ON `governed_dispatch_receipts`
BEGIN
	UPDATE `subtasks`
	SET `status` = 'IN_PROGRESS', `updated_at` = NEW.`reserved_at`
	WHERE `id` = NEW.`subtask_id` AND `status` = 'TODO';
	SELECT CASE WHEN changes() <> 1
		THEN RAISE(ABORT, 'governed dispatch lost subtask start race') END;
END;
--> statement-breakpoint
CREATE TRIGGER `governed_dispatch_update_guard`
BEFORE UPDATE ON `governed_dispatch_receipts`
WHEN NEW.`receipt_id` IS NOT OLD.`receipt_id`
	OR NEW.`operation_id` IS NOT OLD.`operation_id`
	OR NEW.`project_id` IS NOT OLD.`project_id`
	OR NEW.`big_task_id` IS NOT OLD.`big_task_id`
	OR NEW.`plan_revision` IS NOT OLD.`plan_revision`
	OR NEW.`candidate_binding` IS NOT OLD.`candidate_binding`
	OR NEW.`subtask_id` IS NOT OLD.`subtask_id`
	OR NEW.`workflow_sequence` IS NOT OLD.`workflow_sequence`
	OR NEW.`profile` IS NOT OLD.`profile`
	OR NEW.`write_enabled` IS NOT OLD.`write_enabled`
	OR NEW.`start_policy` IS NOT OLD.`start_policy`
	OR NEW.`manual_start_authority_id` IS NOT OLD.`manual_start_authority_id`
	OR NEW.`worktree_ownership_id` IS NOT OLD.`worktree_ownership_id`
	OR NEW.`gate_evidence_references` IS NOT OLD.`gate_evidence_references`
	OR NEW.`reserved_at` IS NOT OLD.`reserved_at`
	OR NOT (
		(OLD.`status` = 'RESERVED' AND NEW.`status` = 'ACTIVE'
			AND NEW.`terminal_at` IS NULL)
		OR (OLD.`status` IN ('RESERVED', 'ACTIVE')
			AND NEW.`status` IN ('COMPLETED', 'HUMAN_REQUIRED')
			AND NEW.`terminal_at` IS NOT NULL)
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed dispatch update');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_dispatch_immutable_delete`
BEFORE DELETE ON `governed_dispatch_receipts`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed dispatch receipt');
END;
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
CREATE TRIGGER `governed_role_authorization_immutable_update`
BEFORE UPDATE ON `governed_role_authorizations`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role authorization');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_authorization_immutable_delete`
BEFORE DELETE ON `governed_role_authorizations`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role authorization');
END;
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
CREATE TRIGGER `governed_role_execution_link_immutable_update`
BEFORE UPDATE ON `governed_role_execution_links`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role execution link');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_execution_link_immutable_delete`
BEFORE DELETE ON `governed_role_execution_links`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role execution link');
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
CREATE TRIGGER `governed_execution_success_requires_result`
BEFORE UPDATE OF `status` ON `execution_runs`
WHEN NEW.`status` = 'SUCCEEDED'
AND EXISTS (
	SELECT 1 FROM `governed_role_execution_links` AS `link`
	WHERE `link`.`execution_run_id` = NEW.`id`
)
AND NOT EXISTS (
	SELECT 1 FROM `governed_role_results` AS `result`
	WHERE `result`.`execution_run_id` = NEW.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'governed execution success requires structured result');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_result_immutable_update`
BEFORE UPDATE ON `governed_role_results`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role result');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_role_result_immutable_delete`
BEFORE DELETE ON `governed_role_results`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed role result');
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
	AND `result`.`outcome` = 'BLOCKING_FAIL'
	AND `result`.`role` IN ('VERIFY', 'HARDEN', 'FRESH_QA', 'FOCUSED_RE_QA')
)
OR (NEW.`blocking` = 1 AND EXISTS (
	SELECT 1 FROM `governed_findings` AS `finding`
	LEFT JOIN `governed_finding_resolutions` AS `resolution`
		ON `resolution`.`finding_id` = `finding`.`finding_id`
	WHERE `finding`.`subtask_id` = NEW.`subtask_id`
	AND `finding`.`blocking` = 1
	AND `resolution`.`finding_id` IS NULL
))
BEGIN
	SELECT RAISE(ABORT, 'invalid or duplicate active governed finding');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_finding_immutable_update`
BEFORE UPDATE ON `governed_findings`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed finding');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_finding_immutable_delete`
BEFORE DELETE ON `governed_findings`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed finding');
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
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed finding resolution');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_finding_resolution_immutable_update`
BEFORE UPDATE ON `governed_finding_resolutions`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed finding resolution');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_finding_resolution_immutable_delete`
BEFORE DELETE ON `governed_finding_resolutions`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed finding resolution');
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
CREATE TRIGGER `governed_handoff_immutable_update`
BEFORE UPDATE ON `governed_handoffs`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed handoff');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_handoff_immutable_delete`
BEFORE DELETE ON `governed_handoffs`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed handoff');
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
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed promoted-context disposition');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_promoted_context_immutable_update`
BEFORE UPDATE ON `governed_promoted_context_dispositions`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed promoted-context disposition');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_promoted_context_immutable_delete`
BEFORE DELETE ON `governed_promoted_context_dispositions`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed promoted-context disposition');
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
		JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `canonical`.`subtask_id`
		JOIN `subtask_workflow_instances` AS `workflow`
			ON `workflow`.`subtask_id` = `canonical`.`subtask_id`
		WHERE `canonical`.`project_id` = NEW.`project_id`
		AND `canonical`.`big_task_id` = NEW.`big_task_id`
		AND `canonical`.`plan_revision` = NEW.`plan_revision`
		AND `canonical`.`candidate_binding` = NEW.`candidate_binding`
		AND (`subtask`.`status` <> 'DONE'
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
CREATE TRIGGER `governed_big_task_completion_apply`
AFTER INSERT ON `governed_big_task_completion_receipts`
BEGIN
	UPDATE `big_tasks`
	SET `status` = 'DONE', `updated_at` = NEW.`completed_at`
	WHERE `id` = NEW.`big_task_id` AND `status` = 'IN_PROGRESS';
	SELECT CASE WHEN changes() <> 1
		THEN RAISE(ABORT, 'Big Task completion race lost') END;
END;
--> statement-breakpoint
CREATE TRIGGER `governed_big_task_completion_immutable_update`
BEFORE UPDATE ON `governed_big_task_completion_receipts`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed Big Task completion receipt');
END;
--> statement-breakpoint
CREATE TRIGGER `governed_big_task_completion_immutable_delete`
BEFORE DELETE ON `governed_big_task_completion_receipts`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed Big Task completion receipt');
END;
