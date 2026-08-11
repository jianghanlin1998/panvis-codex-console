CREATE TABLE `subtask_implementation_checkpoints` (
	`id` text PRIMARY KEY,
	`subtask_id` text NOT NULL,
	`repository_commit_sha` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_reference` text,
	`source_reference` text NOT NULL,
	`summary` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_subtask_implementation_checkpoints_subtask_id_subtasks_id_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "subtask_implementation_checkpoints_id_check" CHECK(length("id") between 5 and 128 and "id" glob 'icp_*'),
	CONSTRAINT "subtask_implementation_checkpoints_sha_check" CHECK(length("repository_commit_sha") in (40, 64)
        and "repository_commit_sha" not glob '*[^0-9a-f]*'),
	CONSTRAINT "subtask_implementation_checkpoints_actor_type_check" CHECK("actor_type" in ('HUMAN', 'CODEX', 'SYSTEM')),
	CONSTRAINT "subtask_implementation_checkpoints_actor_reference_length_check" CHECK("actor_reference" is null or length(trim("actor_reference")) between 1 and 256),
	CONSTRAINT "subtask_implementation_checkpoints_source_reference_length_check" CHECK(length(trim("source_reference")) between 1 and 2048),
	CONSTRAINT "subtask_implementation_checkpoints_summary_length_check" CHECK(length(trim("summary")) between 1 and 1000)
);
--> statement-breakpoint
CREATE INDEX `subtask_implementation_checkpoints_subtask_index` ON `subtask_implementation_checkpoints` (`subtask_id`);--> statement-breakpoint
CREATE INDEX `subtask_implementation_checkpoints_subtask_order_index` ON `subtask_implementation_checkpoints` (`subtask_id`,`occurred_at`,`id`);