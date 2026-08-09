CREATE TABLE `big_tasks` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`rationale` text NOT NULL,
	`scope_in` text NOT NULL,
	`scope_out` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_big_tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "big_tasks_status_check" CHECK("status" in ('IN_PROGRESS', 'DONE'))
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`repository_kind` text NOT NULL,
	`repository_value` text NOT NULL,
	`default_branch` text NOT NULL,
	`max_active_coding_subtasks` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "projects_repository_kind_check" CHECK("repository_kind" in ('PATH', 'REFERENCE')),
	CONSTRAINT "projects_max_active_coding_subtasks_check" CHECK("max_active_coding_subtasks" between 1 and 2)
);
--> statement-breakpoint
CREATE TABLE `subtasks` (
	`id` text PRIMARY KEY,
	`big_task_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`scope_in` text NOT NULL,
	`scope_out` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`untouched_areas` text NOT NULL,
	`status` text NOT NULL,
	`start_policy` text NOT NULL,
	`delegation_policy` text NOT NULL,
	`recommended_reasoning_level` text NOT NULL,
	`prompt_seed` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_subtasks_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "subtasks_status_check" CHECK("status" in ('TODO', 'IN_PROGRESS', 'QA_DEBUG', 'DONE', 'DROPPED', 'ARCHIVED')),
	CONSTRAINT "subtasks_start_policy_check" CHECK("start_policy" in ('MANUAL', 'WHEN_READY')),
	CONSTRAINT "subtasks_delegation_policy_check" CHECK("delegation_policy" in ('NONE', 'READ_ONLY_AUXILIARY', 'REVIEW_ONLY')),
	CONSTRAINT "subtasks_reasoning_level_check" CHECK("recommended_reasoning_level" in ('LOW', 'MEDIUM', 'HIGH', 'XHIGH'))
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`upstream_subtask_id` text NOT NULL,
	`downstream_subtask_id` text NOT NULL,
	`dependency_type` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `task_dependencies_pk` PRIMARY KEY(`upstream_subtask_id`, `downstream_subtask_id`),
	CONSTRAINT `fk_task_dependencies_upstream_subtask_id_subtasks_id_fk` FOREIGN KEY (`upstream_subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_task_dependencies_downstream_subtask_id_subtasks_id_fk` FOREIGN KEY (`downstream_subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "task_dependencies_no_self_check" CHECK("upstream_subtask_id" <> "downstream_subtask_id"),
	CONSTRAINT "task_dependencies_type_check" CHECK("dependency_type" in ('BLOCKING', 'INFORMATIONAL'))
);
--> statement-breakpoint
CREATE INDEX `big_tasks_project_id_index` ON `big_tasks` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE INDEX `subtasks_big_task_id_index` ON `subtasks` (`big_task_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_upstream_index` ON `task_dependencies` (`upstream_subtask_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_downstream_index` ON `task_dependencies` (`downstream_subtask_id`);