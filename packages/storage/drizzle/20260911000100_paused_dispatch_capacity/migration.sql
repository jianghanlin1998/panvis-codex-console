-- Add an explicit retained PAUSED dispatch state. Preserve the UNIQUE index
-- covering RESERVED and ACTIVE writes. No work records or QA outcomes change.
DROP TRIGGER "governed_dispatch_current_state_guard";
--> statement-breakpoint
DROP TRIGGER "governed_dispatch_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "governed_dispatch_receipts_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "governed_dispatch_start_subtask";
--> statement-breakpoint
DROP TRIGGER "governed_dispatch_update_guard";
--> statement-breakpoint
DROP TRIGGER "governed_role_authorization_current_state_guard";
--> statement-breakpoint
CREATE TABLE __new_governed_dispatch_receipts (
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
	CONSTRAINT "governed_dispatch_lifecycle_check" CHECK(("status" in ('RESERVED', 'ACTIVE', 'PAUSED') and "terminal_at" is null)
        or ("status" in ('COMPLETED', 'HUMAN_REQUIRED')
          and "terminal_at" is not null
          and "updated_at" = "terminal_at"))
);
--> statement-breakpoint
INSERT INTO __new_governed_dispatch_receipts SELECT * FROM governed_dispatch_receipts;
--> statement-breakpoint
DROP TABLE governed_dispatch_receipts;
--> statement-breakpoint
ALTER TABLE __new_governed_dispatch_receipts RENAME TO governed_dispatch_receipts;
--> statement-breakpoint
CREATE INDEX `governed_dispatch_big_task_index` ON `governed_dispatch_receipts` (`big_task_id`,`status`,`receipt_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `governed_dispatch_operation_unique` ON `governed_dispatch_receipts` (`operation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `governed_dispatch_project_active_write_unique` ON `governed_dispatch_receipts` (`project_id`) WHERE "governed_dispatch_receipts"."write_enabled" = 1 and "governed_dispatch_receipts"."status" in ('RESERVED', 'ACTIVE');
--> statement-breakpoint
CREATE UNIQUE INDEX `governed_dispatch_subtask_unique` ON `governed_dispatch_receipts` (`subtask_id`);
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
 AND ((`dependency`.`required_gate` = 'VERIFIED' AND NOT EXISTS (SELECT 1 FROM durable_workflow_transitions t WHERE t.subtask_id = upstream.id AND t.resulting_stage = 'COMPLETE'))
   OR (`dependency`.`required_gate` = 'HARDENED' AND `upstream`.`maturity` NOT IN ('HARDENED','ACCEPTED'))
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
CREATE TRIGGER `governed_dispatch_immutable_delete`
BEFORE DELETE ON `governed_dispatch_receipts`
BEGIN
	SELECT RAISE(ABORT, 'immutable governed dispatch receipt');
END;
--> statement-breakpoint
CREATE TRIGGER governed_dispatch_receipts_insert_conflict BEFORE INSERT ON governed_dispatch_receipts
WHEN EXISTS (SELECT 1 FROM governed_dispatch_receipts WHERE (receipt_id IS NEW.receipt_id) OR (operation_id IS NEW.operation_id) OR (subtask_id IS NEW.subtask_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
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
WHEN NEW.updated_at < OLD.updated_at
 OR NEW.`receipt_id` IS NOT OLD.`receipt_id`
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
		OR (OLD.`status` IN ('RESERVED', 'ACTIVE', 'PAUSED')
			AND NEW.`status` IN ('COMPLETED', 'HUMAN_REQUIRED')
			AND NEW.`terminal_at` IS NOT NULL)
        OR (OLD.status = 'ACTIVE' AND NEW.status = 'PAUSED' AND NEW.terminal_at IS NULL AND EXISTS (SELECT 1 FROM console_scope_settings c WHERE c.scope_key IN ('PROJECT:' || OLD.project_id, 'BIG_TASK:' || OLD.big_task_id, 'SUBTASK:' || OLD.subtask_id) AND (json_extract(c.payload, '$.lifecycle') IN ('PAUSED','ENDED') OR json_extract(c.payload, '$.projectClosed') = 1)) AND NOT EXISTS (SELECT 1 FROM execution_runs er JOIN chat_threads ct ON ct.id=er.chat_thread_id WHERE ct.subtask_id=OLD.subtask_id AND er.status IN ('CREATED','RUNNING')))
        OR (OLD.status = 'PAUSED' AND NEW.status = 'ACTIVE' AND NEW.terminal_at IS NULL AND NOT EXISTS (SELECT 1 FROM console_scope_settings c WHERE c.scope_key IN ('PROJECT:' || OLD.project_id, 'BIG_TASK:' || OLD.big_task_id, 'SUBTASK:' || OLD.subtask_id) AND (json_extract(c.payload, '$.lifecycle') IN ('PAUSED','ENDED') OR json_extract(c.payload, '$.projectClosed') = 1)) AND NOT EXISTS (SELECT 1 FROM execution_runs er JOIN chat_threads ct ON ct.id=er.chat_thread_id WHERE ct.subtask_id=OLD.subtask_id AND er.status IN ('CREATED','RUNNING'))
          AND (SELECT count(*) FROM governed_dispatch_receipts d WHERE d.project_id=OLD.project_id AND d.status IN ('RESERVED','ACTIVE')) < (SELECT max_active_coding_subtasks FROM projects WHERE id=OLD.project_id)
          AND NOT EXISTS (SELECT 1 FROM durable_workflow_human_requirements h WHERE h.big_task_id=OLD.big_task_id AND (h.scope_kind='BIG_TASK' OR h.subtask_id=OLD.subtask_id)))
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed dispatch update');
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
CREATE TEMP TABLE paused_dispatch_migration_check (violations INTEGER CHECK (violations = 0));
--> statement-breakpoint
INSERT INTO paused_dispatch_migration_check SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE paused_dispatch_migration_check;
