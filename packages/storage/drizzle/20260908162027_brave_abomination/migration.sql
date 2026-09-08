CREATE TABLE `console_scope_settings` (
	`scope_key` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_console_scope_settings_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "console_settings_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `console_settings_changes` (
	`request_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_console_settings_changes_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "console_settings_change_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `console_task_presentation` (
	`big_task_id` text PRIMARY KEY,
	`payload` text NOT NULL,
	CONSTRAINT `fk_console_task_presentation_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`),
	CONSTRAINT "console_task_presentation_json" CHECK(json_valid("payload"))
);
