CREATE TABLE `worktree_ownerships` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`subtask_id` text NOT NULL,
	`status` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch_name` text NOT NULL,
	`starting_commit_sha` text NOT NULL,
	`release_head_sha` text,
	`created_at` text NOT NULL,
	`activated_at` text,
	`release_started_at` text,
	`released_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_worktree_ownerships_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_worktree_ownerships_subtask_id_subtasks_id_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "worktree_ownerships_id_check" CHECK(length("id") = 35
        and substr("id", 1, 3) = 'wt_'
        and substr("id", 4) not glob '*[^0-9a-f]*'),
	CONSTRAINT "worktree_ownerships_status_check" CHECK("status" in ('PROVISIONING', 'ACTIVE', 'RELEASING', 'RELEASED', 'FAILED')),
	CONSTRAINT "worktree_ownerships_path_check" CHECK(length("worktree_path") between 1 and 4096
        and substr("worktree_path", 1, 1) = '/'
        and instr("worktree_path", char(0)) = 0
        and instr("worktree_path", char(10)) = 0
        and instr("worktree_path", char(13)) = 0),
	CONSTRAINT "worktree_ownerships_branch_check" CHECK(length("branch_name") between 1 and 255
        and "branch_name" = 'ctc/worktree/' || "id"),
	CONSTRAINT "worktree_ownerships_starting_sha_check" CHECK(length("starting_commit_sha") in (40, 64)
        and "starting_commit_sha" not glob '*[^0-9a-f]*'),
	CONSTRAINT "worktree_ownerships_release_sha_check" CHECK("release_head_sha" is null
        or (length("release_head_sha") in (40, 64)
          and "release_head_sha" not glob '*[^0-9a-f]*')),
	CONSTRAINT "worktree_ownerships_lifecycle_check" CHECK(("status" = 'PROVISIONING'
          and "activated_at" is null
          and "release_started_at" is null
          and "released_at" is null
          and "release_head_sha" is null
          and "updated_at" = "created_at")
        or ("status" = 'FAILED'
          and "activated_at" is null
          and "release_started_at" is null
          and "released_at" is null
          and "release_head_sha" is null
          and "updated_at" >= "created_at")
        or ("status" = 'ACTIVE'
          and "activated_at" is not null
          and "release_started_at" is null
          and "released_at" is null
          and "release_head_sha" is null
          and "activated_at" >= "created_at"
          and "updated_at" = "activated_at")
        or ("status" = 'RELEASING'
          and "activated_at" is not null
          and "release_started_at" is not null
          and "released_at" is null
          and "release_head_sha" is not null
          and "activated_at" >= "created_at"
          and "release_started_at" >= "activated_at"
          and "updated_at" = "release_started_at")
        or ("status" = 'RELEASED'
          and "activated_at" is not null
          and "release_started_at" is not null
          and "released_at" is not null
          and "release_head_sha" is not null
          and "activated_at" >= "created_at"
          and "release_started_at" >= "activated_at"
          and "released_at" >= "release_started_at"
          and "updated_at" = "released_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_ownerships_worktree_path_unique` ON `worktree_ownerships` (`worktree_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_ownerships_branch_name_unique` ON `worktree_ownerships` (`branch_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_ownerships_subtask_non_terminal_unique` ON `worktree_ownerships` (`subtask_id`) WHERE "worktree_ownerships"."status" in ('PROVISIONING', 'ACTIVE', 'RELEASING');--> statement-breakpoint
CREATE INDEX `worktree_ownerships_subtask_history_index` ON `worktree_ownerships` (`subtask_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `worktree_ownerships_project_slots_index` ON `worktree_ownerships` (`project_id`,`status`,`created_at`,`id`);