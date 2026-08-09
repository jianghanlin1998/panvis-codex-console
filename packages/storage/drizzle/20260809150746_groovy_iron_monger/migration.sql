CREATE TABLE `context_items` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text,
	`subtask_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`authority` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`source_type` text NOT NULL,
	`source_reference` text NOT NULL,
	`effective_at` text NOT NULL,
	`supersedes_context_item_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_context_items_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_context_items_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_context_items_subtask_id_subtasks_id_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_context_items_supersedes_context_item_id_context_items_id_fk` FOREIGN KEY (`supersedes_context_item_id`) REFERENCES `context_items`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "context_items_kind_check" CHECK("kind" in ('DECISION', 'REQUIREMENT', 'CONSTRAINT', 'ENGINEERING_FACT', 'OPEN_QUESTION', 'RISK')),
	CONSTRAINT "context_items_status_check" CHECK("status" in ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'RESOLVED')),
	CONSTRAINT "context_items_authority_check" CHECK("authority" in ('HUMAN', 'REPO_EVIDENCE', 'CODEX_CANDIDATE', 'SYSTEM')),
	CONSTRAINT "context_items_source_type_check" CHECK("source_type" in ('CHAT_MESSAGE', 'REPO', 'HANDOFF', 'IMPORT', 'MANUAL', 'SYSTEM')),
	CONSTRAINT "context_items_scope_check" CHECK("subtask_id" is null or "big_task_id" is not null),
	CONSTRAINT "context_items_no_self_supersession_check" CHECK("supersedes_context_item_id" is null or "id" <> "supersedes_context_item_id"),
	CONSTRAINT "context_items_title_length_check" CHECK(length(trim("title")) between 1 and 256),
	CONSTRAINT "context_items_body_length_check" CHECK(length(trim("body")) between 1 and 4000),
	CONSTRAINT "context_items_source_reference_length_check" CHECK(length(trim("source_reference")) between 1 and 2048)
);
--> statement-breakpoint
CREATE INDEX `context_items_project_id_index` ON `context_items` (`project_id`);--> statement-breakpoint
CREATE INDEX `context_items_big_task_id_index` ON `context_items` (`big_task_id`);--> statement-breakpoint
CREATE INDEX `context_items_subtask_id_index` ON `context_items` (`subtask_id`);--> statement-breakpoint
CREATE INDEX `context_items_status_index` ON `context_items` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `context_items_supersedes_unique` ON `context_items` (`supersedes_context_item_id`);--> statement-breakpoint
CREATE INDEX `context_items_effective_at_id_index` ON `context_items` (`effective_at`,`id`);