CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text,
	`subtask_id` text,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_reference` text,
	`summary` text NOT NULL,
	`subject_reference` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_audit_events_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_audit_events_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_audit_events_subtask_id_subtasks_id_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "audit_events_scope_check" CHECK(("big_task_id" is null and "subtask_id" is null)
        or ("big_task_id" is not null and "subtask_id" is null)
        or ("big_task_id" is not null and "subtask_id" is not null)),
	CONSTRAINT "audit_events_event_type_check" CHECK(length(trim("event_type")) between 1 and 64
        and "event_type" glob '[A-Z]*'
        and "event_type" not glob '*[^A-Z0-9_]*'),
	CONSTRAINT "audit_events_actor_type_check" CHECK("actor_type" in ('HUMAN', 'CODEX', 'SYSTEM')),
	CONSTRAINT "audit_events_actor_reference_length_check" CHECK("actor_reference" is null or length(trim("actor_reference")) between 1 and 256),
	CONSTRAINT "audit_events_summary_length_check" CHECK(length(trim("summary")) between 1 and 1000),
	CONSTRAINT "audit_events_subject_reference_length_check" CHECK("subject_reference" is null or length(trim("subject_reference")) between 1 and 512)
);
--> statement-breakpoint
CREATE TABLE `context_digests` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`big_task_id` text,
	`subtask_id` text,
	`body` text NOT NULL,
	`source_type` text NOT NULL,
	`source_reference` text NOT NULL,
	`effective_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_context_digests_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_context_digests_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_context_digests_subtask_id_subtasks_id_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "context_digests_scope_check" CHECK(("big_task_id" is null and "subtask_id" is null)
        or ("big_task_id" is not null and "subtask_id" is null)
        or ("big_task_id" is not null and "subtask_id" is not null)),
	CONSTRAINT "context_digests_source_type_check" CHECK("source_type" in ('CHAT_MESSAGE', 'REPO', 'HANDOFF', 'IMPORT', 'MANUAL', 'SYSTEM')),
	CONSTRAINT "context_digests_body_length_check" CHECK(length(trim("body")) between 1 and 8000),
	CONSTRAINT "context_digests_source_reference_length_check" CHECK(length(trim("source_reference")) between 1 and 2048)
);
--> statement-breakpoint
CREATE INDEX `audit_events_project_id_index` ON `audit_events` (`project_id`);--> statement-breakpoint
CREATE INDEX `audit_events_big_task_id_index` ON `audit_events` (`big_task_id`);--> statement-breakpoint
CREATE INDEX `audit_events_subtask_id_index` ON `audit_events` (`subtask_id`);--> statement-breakpoint
CREATE INDEX `audit_events_scope_occurred_at_id_index` ON `audit_events` (`project_id`,`big_task_id`,`subtask_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `context_digests_project_id_index` ON `context_digests` (`project_id`);--> statement-breakpoint
CREATE INDEX `context_digests_big_task_id_index` ON `context_digests` (`big_task_id`);--> statement-breakpoint
CREATE INDEX `context_digests_subtask_id_index` ON `context_digests` (`subtask_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `context_digests_project_scope_unique` ON `context_digests` (`project_id`) WHERE "context_digests"."big_task_id" is null and "context_digests"."subtask_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `context_digests_big_task_scope_unique` ON `context_digests` (`project_id`,`big_task_id`) WHERE "context_digests"."big_task_id" is not null and "context_digests"."subtask_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `context_digests_subtask_scope_unique` ON `context_digests` (`project_id`,`big_task_id`,`subtask_id`) WHERE "context_digests"."big_task_id" is not null and "context_digests"."subtask_id" is not null;