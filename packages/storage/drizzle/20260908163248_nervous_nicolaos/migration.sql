DROP TRIGGER "canonical_materialized_dependency_delete_guard";
--> statement-breakpoint
DROP TRIGGER "canonical_materialized_dependency_insert_guard";
--> statement-breakpoint
DROP TRIGGER "canonical_materialized_dependency_update_guard";
--> statement-breakpoint
DROP TRIGGER "governed_dispatch_current_state_guard";
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_dependencies` (
	`upstream_subtask_id` text NOT NULL,
	`downstream_subtask_id` text NOT NULL,
	`dependency_type` text NOT NULL,
	`required_gate` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `task_dependencies_pk` PRIMARY KEY(`upstream_subtask_id`, `downstream_subtask_id`),
	CONSTRAINT `fk_task_dependencies_upstream_subtask_id_subtasks_id_fk` FOREIGN KEY (`upstream_subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_task_dependencies_downstream_subtask_id_subtasks_id_fk` FOREIGN KEY (`downstream_subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "task_dependencies_no_self_check" CHECK("upstream_subtask_id" <> "downstream_subtask_id"),
	CONSTRAINT "task_dependencies_type_check" CHECK("dependency_type" in ('BLOCKING', 'INFORMATIONAL')),
	CONSTRAINT "task_dependencies_required_gate_check" CHECK("required_gate" in ('NONE', 'VERIFIED', 'HARDENED', 'ACCEPTED')),
	CONSTRAINT "task_dependencies_type_gate_check" CHECK(("dependency_type" = 'BLOCKING' and "required_gate" in ('VERIFIED', 'HARDENED', 'ACCEPTED'))
        or ("dependency_type" = 'INFORMATIONAL' and "required_gate" = 'NONE')),
	CONSTRAINT "task_dependencies_reason_length_check" CHECK(length(trim("reason")) between 1 and 1000)
);
--> statement-breakpoint
INSERT INTO `__new_task_dependencies`(`upstream_subtask_id`, `downstream_subtask_id`, `dependency_type`, `required_gate`, `reason`, `created_at`) SELECT `upstream_subtask_id`, `downstream_subtask_id`, `dependency_type`, `required_gate`, `reason`, `created_at` FROM `task_dependencies`;--> statement-breakpoint
DROP TABLE `task_dependencies`;--> statement-breakpoint
ALTER TABLE `__new_task_dependencies` RENAME TO `task_dependencies`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `task_dependencies_upstream_index` ON `task_dependencies` (`upstream_subtask_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_downstream_index` ON `task_dependencies` (`downstream_subtask_id`);
--> statement-breakpoint
CREATE TRIGGER `canonical_materialized_dependency_delete_guard`
BEFORE DELETE ON `task_dependencies`
WHEN EXISTS (
	SELECT 1
	FROM `canonical_task_materializations` AS `owned`
	JOIN `subtasks` AS `member` ON `member`.`big_task_id` = `owned`.`big_task_id`
	WHERE `member`.`id` = OLD.`upstream_subtask_id`
	   OR `member`.`id` = OLD.`downstream_subtask_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical materialized dependency graph');
END;
--> statement-breakpoint
CREATE TRIGGER `canonical_materialized_dependency_insert_guard`
BEFORE INSERT ON `task_dependencies`
WHEN EXISTS (
	SELECT 1
	FROM `canonical_task_materializations` AS `owned`
	JOIN `subtasks` AS `member` ON `member`.`big_task_id` = `owned`.`big_task_id`
	WHERE `member`.`id` = NEW.`upstream_subtask_id`
	   OR `member`.`id` = NEW.`downstream_subtask_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical materialized dependency graph');
END;
--> statement-breakpoint
CREATE TRIGGER `canonical_materialized_dependency_update_guard`
BEFORE UPDATE ON `task_dependencies`
WHEN EXISTS (
	SELECT 1
	FROM `canonical_task_materializations` AS `owned`
	JOIN `subtasks` AS `member` ON `member`.`big_task_id` = `owned`.`big_task_id`
	WHERE `member`.`id` IN (
		OLD.`upstream_subtask_id`, OLD.`downstream_subtask_id`,
		NEW.`upstream_subtask_id`, NEW.`downstream_subtask_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical materialized dependency graph');
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

CREATE TEMP TABLE console_dependency_migration_check (violations INTEGER CHECK (violations = 0));
--> statement-breakpoint
INSERT INTO console_dependency_migration_check SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE console_dependency_migration_check;
