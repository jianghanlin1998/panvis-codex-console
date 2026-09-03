CREATE TABLE `subtask_workflow_instances` (
	`subtask_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`initial_stage` text NOT NULL,
	`initial_repair_cycles_used` integer NOT NULL,
	`initialized_at` text NOT NULL,
	CONSTRAINT `subtask_workflow_instances_materialization_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) REFERENCES `canonical_task_materializations`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `subtask_workflow_instances_subtask_fk` FOREIGN KEY (`subtask_id`,`big_task_id`) REFERENCES `subtasks`(`id`,`big_task_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "subtask_workflow_instances_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "subtask_workflow_instances_binding_check" CHECK(length("candidate_binding") >= 1),
	CONSTRAINT "subtask_workflow_instances_initial_stage_check" CHECK("initial_stage" in ('MATERIALIZE', 'EXECUTE')),
	CONSTRAINT "subtask_workflow_instances_initial_repair_check" CHECK(typeof("initial_repair_cycles_used") = 'integer' and "initial_repair_cycles_used" = 0),
	CONSTRAINT "subtask_workflow_instances_initialized_at_check" CHECK(length("initialized_at") >= 1)
);
--> statement-breakpoint
CREATE TABLE `workflow_initialization_receipts` (
	`big_task_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`workflow_instance_count` integer NOT NULL,
	`initialized_at` text NOT NULL,
	CONSTRAINT `workflow_initialization_receipts_materialization_fk` FOREIGN KEY (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) REFERENCES `canonical_task_materializations`(`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "workflow_initialization_receipts_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "workflow_initialization_receipts_binding_check" CHECK(length("candidate_binding") >= 1),
	CONSTRAINT "workflow_initialization_receipts_count_check" CHECK(typeof("workflow_instance_count") = 'integer' and "workflow_instance_count" >= 1),
	CONSTRAINT "workflow_initialization_receipts_initialized_at_check" CHECK(length("initialized_at") >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canonical_task_materializations_authority_unique` ON `canonical_task_materializations` (`project_id`,`big_task_id`,`plan_revision`,`candidate_binding`);--> statement-breakpoint
CREATE INDEX `subtask_workflow_instances_big_task_index` ON `subtask_workflow_instances` (`big_task_id`,`subtask_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subtasks_id_big_task_id_unique` ON `subtasks` (`id`,`big_task_id`);--> statement-breakpoint
CREATE TRIGGER `subtask_workflow_instances_owned_insert_guard`
BEFORE INSERT ON `subtask_workflow_instances`
WHEN EXISTS (
	SELECT 1 FROM `workflow_initialization_receipts` AS `owned`
	WHERE `owned`.`big_task_id` = NEW.`big_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable owned workflow instance set');
END;--> statement-breakpoint
CREATE TRIGGER `subtask_workflow_instances_immutable_insert_conflict`
BEFORE INSERT ON `subtask_workflow_instances`
WHEN EXISTS (
	SELECT 1 FROM `subtask_workflow_instances` AS `existing`
	WHERE `existing`.`subtask_id` = NEW.`subtask_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable workflow instance bootstrap');
END;--> statement-breakpoint
CREATE TRIGGER `subtask_workflow_instances_immutable_update`
BEFORE UPDATE ON `subtask_workflow_instances`
BEGIN
	SELECT RAISE(ABORT, 'immutable workflow instance bootstrap');
END;--> statement-breakpoint
CREATE TRIGGER `subtask_workflow_instances_immutable_delete`
BEFORE DELETE ON `subtask_workflow_instances`
BEGIN
	SELECT RAISE(ABORT, 'immutable workflow instance bootstrap');
END;--> statement-breakpoint
CREATE TRIGGER `workflow_initialization_receipts_complete_insert_guard`
BEFORE INSERT ON `workflow_initialization_receipts`
WHEN NEW.`workflow_instance_count` IS NOT (
		SELECT count(*) FROM `subtask_workflow_instances` AS `instance`
		WHERE `instance`.`big_task_id` = NEW.`big_task_id`
	)
	OR NEW.`workflow_instance_count` IS NOT (
		SELECT `owned`.`subtask_count`
		FROM `canonical_task_materializations` AS `owned`
		WHERE `owned`.`big_task_id` = NEW.`big_task_id`
	)
	OR EXISTS (
		SELECT 1 FROM `subtask_workflow_instances` AS `instance`
		WHERE `instance`.`big_task_id` = NEW.`big_task_id`
		AND (
			`instance`.`project_id` IS NOT NEW.`project_id`
			OR `instance`.`plan_revision` IS NOT NEW.`plan_revision`
			OR `instance`.`candidate_binding` IS NOT NEW.`candidate_binding`
			OR `instance`.`initialized_at` IS NOT NEW.`initialized_at`
		)
	)
	OR EXISTS (
		SELECT 1 FROM `subtasks` AS `subtask`
		WHERE `subtask`.`big_task_id` = NEW.`big_task_id`
		AND NOT EXISTS (
			SELECT 1 FROM `subtask_workflow_instances` AS `instance`
			WHERE `instance`.`subtask_id` = `subtask`.`id`
			AND `instance`.`big_task_id` = NEW.`big_task_id`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'incomplete workflow initialization receipt');
END;--> statement-breakpoint
CREATE TRIGGER `workflow_initialization_receipts_immutable_insert_conflict`
BEFORE INSERT ON `workflow_initialization_receipts`
WHEN EXISTS (
	SELECT 1 FROM `workflow_initialization_receipts` AS `existing`
	WHERE `existing`.`big_task_id` = NEW.`big_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable workflow initialization receipt');
END;--> statement-breakpoint
CREATE TRIGGER `workflow_initialization_receipts_immutable_update`
BEFORE UPDATE ON `workflow_initialization_receipts`
BEGIN
	SELECT RAISE(ABORT, 'immutable workflow initialization receipt');
END;--> statement-breakpoint
CREATE TRIGGER `workflow_initialization_receipts_immutable_delete`
BEFORE DELETE ON `workflow_initialization_receipts`
BEGIN
	SELECT RAISE(ABORT, 'immutable workflow initialization receipt');
END;
