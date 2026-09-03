CREATE TABLE `canonical_task_materializations` (
	`big_task_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`subtask_count` integer NOT NULL,
	`dependency_count` integer NOT NULL,
	`materialized_at` text NOT NULL,
	CONSTRAINT `fk_canonical_task_materializations_big_task_id_orchestration_materializations_big_task_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `orchestration_materializations`(`big_task_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_canonical_task_materializations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `canonical_task_materializations_candidate_fk` FOREIGN KEY (`big_task_id`,`plan_revision`) REFERENCES `orchestration_plan_candidates`(`big_task_id`,`revision`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "canonical_task_materializations_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "canonical_task_materializations_binding_check" CHECK(length("candidate_binding") >= 1),
	CONSTRAINT "canonical_task_materializations_subtask_count_check" CHECK(typeof("subtask_count") = 'integer' and "subtask_count" >= 1),
	CONSTRAINT "canonical_task_materializations_dependency_count_check" CHECK(typeof("dependency_count") = 'integer' and "dependency_count" >= 0)
);
--> statement-breakpoint
CREATE TRIGGER `canonical_task_materializations_immutable_insert_conflict`
BEFORE INSERT ON `canonical_task_materializations`
WHEN EXISTS (
	SELECT 1 FROM `canonical_task_materializations` AS `existing`
	WHERE `existing`.`big_task_id` = NEW.`big_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical task materialization');
END;
--> statement-breakpoint
CREATE TRIGGER `canonical_task_materializations_immutable_update`
BEFORE UPDATE ON `canonical_task_materializations`
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical task materialization');
END;
--> statement-breakpoint
CREATE TRIGGER `canonical_task_materializations_immutable_delete`
BEFORE DELETE ON `canonical_task_materializations`
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical task materialization');
END;
--> statement-breakpoint
CREATE TRIGGER `canonical_materialized_subtask_set_insert_guard`
BEFORE INSERT ON `subtasks`
WHEN EXISTS (
	SELECT 1 FROM `canonical_task_materializations` AS `owned`
	WHERE `owned`.`big_task_id` = NEW.`big_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical materialized Subtask set');
END;
--> statement-breakpoint
CREATE TRIGGER `canonical_materialized_subtask_stable_update_guard`
BEFORE UPDATE ON `subtasks`
WHEN EXISTS (
	SELECT 1 FROM `canonical_task_materializations` AS `owned`
	WHERE `owned`.`big_task_id` = OLD.`big_task_id`
	   OR `owned`.`big_task_id` = NEW.`big_task_id`
)
AND (
	OLD.`id` IS NOT NEW.`id`
	OR OLD.`big_task_id` IS NOT NEW.`big_task_id`
	OR OLD.`title` IS NOT NEW.`title`
	OR OLD.`goal` IS NOT NEW.`goal`
	OR OLD.`scope_in` IS NOT NEW.`scope_in`
	OR OLD.`scope_out` IS NOT NEW.`scope_out`
	OR OLD.`acceptance_criteria` IS NOT NEW.`acceptance_criteria`
	OR OLD.`untouched_areas` IS NOT NEW.`untouched_areas`
	OR OLD.`start_policy` IS NOT NEW.`start_policy`
	OR OLD.`delegation_policy` IS NOT NEW.`delegation_policy`
	OR OLD.`recommended_reasoning_level` IS NOT NEW.`recommended_reasoning_level`
	OR OLD.`prompt_seed` IS NOT NEW.`prompt_seed`
	OR OLD.`created_at` IS NOT NEW.`created_at`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical materialized Subtask intent');
END;
--> statement-breakpoint
CREATE TRIGGER `canonical_materialized_subtask_delete_guard`
BEFORE DELETE ON `subtasks`
WHEN EXISTS (
	SELECT 1 FROM `canonical_task_materializations` AS `owned`
	WHERE `owned`.`big_task_id` = OLD.`big_task_id`
)
BEGIN
	SELECT RAISE(ABORT, 'immutable canonical materialized Subtask');
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
