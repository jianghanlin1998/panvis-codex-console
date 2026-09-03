CREATE TABLE `candidate_task_contract_bindings` (
	`project_id` text NOT NULL,
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_id` text NOT NULL,
	`task_contract_ref` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `candidate_task_contract_bindings_pk` PRIMARY KEY(`big_task_id`, `plan_revision`, `subtask_id`),
	CONSTRAINT `candidate_task_contract_bindings_candidate_fk` FOREIGN KEY (`big_task_id`,`plan_revision`) REFERENCES `orchestration_plan_candidates`(`big_task_id`,`revision`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `candidate_task_contract_bindings_contract_fk` FOREIGN KEY (`project_id`,`task_contract_ref`) REFERENCES `task_contracts`(`project_id`,`task_contract_ref`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "candidate_task_contract_bindings_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "candidate_task_contract_bindings_candidate_binding_check" CHECK(length("candidate_binding") >= 1),
	CONSTRAINT "candidate_task_contract_bindings_ref_check" CHECK(length("task_contract_ref") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE `task_contracts` (
	`project_id` text NOT NULL,
	`task_contract_ref` text NOT NULL,
	`big_task_id` text NOT NULL,
	`subtask_id` text NOT NULL,
	`contract_payload` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `task_contracts_pk` PRIMARY KEY(`project_id`, `task_contract_ref`),
	CONSTRAINT `fk_task_contracts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_task_contracts_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "task_contracts_ref_check" CHECK(length("task_contract_ref") between 1 and 1000),
	CONSTRAINT "task_contracts_payload_check" CHECK(length("contract_payload") >= 1)
);
--> statement-breakpoint
ALTER TABLE `orchestration_plan_candidates` ADD `task_contract_count` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_task_contract_bindings_ref_unique` ON `candidate_task_contract_bindings` (`project_id`,`big_task_id`,`plan_revision`,`task_contract_ref`);--> statement-breakpoint
CREATE INDEX `task_contracts_big_task_subtask_index` ON `task_contracts` (`big_task_id`,`subtask_id`);--> statement-breakpoint
CREATE TRIGGER `task_contracts_immutable_insert_conflict`
BEFORE INSERT ON `task_contracts`
WHEN EXISTS (
	SELECT 1
	FROM `task_contracts` AS `existing`
	WHERE `existing`.`project_id` = NEW.`project_id`
	  AND `existing`.`task_contract_ref` = NEW.`task_contract_ref`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable Task Contract artifact');
END;--> statement-breakpoint
CREATE TRIGGER `task_contracts_immutable_update`
BEFORE UPDATE ON `task_contracts`
BEGIN
	SELECT RAISE(ABORT, 'immutable Task Contract artifact');
END;--> statement-breakpoint
CREATE TRIGGER `task_contracts_immutable_delete`
BEFORE DELETE ON `task_contracts`
BEGIN
	SELECT RAISE(ABORT, 'immutable Task Contract artifact');
END;--> statement-breakpoint
CREATE TRIGGER `candidate_task_contract_bindings_immutable_insert_conflict`
BEFORE INSERT ON `candidate_task_contract_bindings`
WHEN EXISTS (
	SELECT 1
	FROM `candidate_task_contract_bindings` AS `existing`
	WHERE (
		`existing`.`big_task_id` = NEW.`big_task_id`
		AND `existing`.`plan_revision` = NEW.`plan_revision`
		AND `existing`.`subtask_id` = NEW.`subtask_id`
	) OR (
		`existing`.`project_id` = NEW.`project_id`
		AND `existing`.`big_task_id` = NEW.`big_task_id`
		AND `existing`.`plan_revision` = NEW.`plan_revision`
		AND `existing`.`task_contract_ref` = NEW.`task_contract_ref`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'immutable candidate Task Contract association');
END;--> statement-breakpoint
CREATE TRIGGER `candidate_task_contract_bindings_immutable_update`
BEFORE UPDATE ON `candidate_task_contract_bindings`
BEGIN
	SELECT RAISE(ABORT, 'immutable candidate Task Contract association');
END;--> statement-breakpoint
CREATE TRIGGER `candidate_task_contract_bindings_immutable_delete`
BEFORE DELETE ON `candidate_task_contract_bindings`
BEGIN
	SELECT RAISE(ABORT, 'immutable candidate Task Contract association');
END;--> statement-breakpoint
CREATE TRIGGER `orchestration_plan_candidate_task_contract_count_insert_conflict`
BEFORE INSERT ON `orchestration_plan_candidates`
WHEN EXISTS (
	SELECT 1
	FROM `orchestration_plan_candidates` AS `existing`
	WHERE `existing`.`big_task_id` = NEW.`big_task_id`
	  AND `existing`.`revision` = NEW.`revision`
	  AND `existing`.`task_contract_count` IS NOT NEW.`task_contract_count`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable Task Contract bundle marker');
END;--> statement-breakpoint
CREATE TRIGGER `orchestration_plan_candidate_task_contract_count_immutable`
BEFORE UPDATE OF `task_contract_count` ON `orchestration_plan_candidates`
WHEN OLD.`task_contract_count` IS NOT NEW.`task_contract_count`
BEGIN
	SELECT RAISE(ABORT, 'immutable Task Contract bundle marker');
END;--> statement-breakpoint
CREATE TRIGGER `orchestration_plan_candidate_task_contract_count_insert_check`
BEFORE INSERT ON `orchestration_plan_candidates`
WHEN NEW.`task_contract_count` IS NOT NULL
  AND (typeof(NEW.`task_contract_count`) != 'integer' OR NEW.`task_contract_count` < 1)
BEGIN
	SELECT RAISE(ABORT, 'invalid Task Contract bundle marker');
END;
