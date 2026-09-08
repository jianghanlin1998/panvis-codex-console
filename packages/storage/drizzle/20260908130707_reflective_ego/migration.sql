CREATE TABLE `console_discussion_turns` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_console_discussion_turns_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "console_turn_status" CHECK("status" in ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')),
	CONSTRAINT "console_turn_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `console_drafts` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_console_drafts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "console_draft_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `console_turn_scope_sequence` ON `console_discussion_turns` (`scope_key`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_one_running_turn` ON `console_discussion_turns` (`scope_key`) WHERE "console_discussion_turns"."status" = 'RUNNING';