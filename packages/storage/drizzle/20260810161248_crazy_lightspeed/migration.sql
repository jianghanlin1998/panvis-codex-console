ALTER TABLE `subtasks` ADD `maturity` text DEFAULT 'NOT_STARTED' NOT NULL CONSTRAINT "subtasks_maturity_check" CHECK("maturity" in ('NOT_STARTED', 'IMPLEMENTED', 'HARDENED', 'ACCEPTED'));--> statement-breakpoint
CREATE TABLE `__new_task_dependencies` (
	`upstream_subtask_id` text NOT NULL,
	`downstream_subtask_id` text NOT NULL,
	`dependency_type` text NOT NULL,
	`required_gate` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `task_dependencies_pk` PRIMARY KEY(`upstream_subtask_id`, `downstream_subtask_id`),
	CONSTRAINT `fk_task_dependencies_upstream_subtask_id_subtasks_id_fk` FOREIGN KEY (`upstream_subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_task_dependencies_downstream_subtask_id_subtasks_id_fk` FOREIGN KEY (`downstream_subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "task_dependencies_no_self_check" CHECK("upstream_subtask_id" <> "downstream_subtask_id"),
	CONSTRAINT "task_dependencies_type_check" CHECK("dependency_type" in ('BLOCKING', 'INFORMATIONAL')),
	CONSTRAINT "task_dependencies_required_gate_check" CHECK("required_gate" in ('NONE', 'HARDENED', 'ACCEPTED')),
	CONSTRAINT "task_dependencies_type_gate_check" CHECK(("dependency_type" = 'BLOCKING' and "required_gate" in ('HARDENED', 'ACCEPTED'))
        or ("dependency_type" = 'INFORMATIONAL' and "required_gate" = 'NONE')),
	CONSTRAINT "task_dependencies_reason_length_check" CHECK(length(trim("reason")) between 1 and 1000)
);
--> statement-breakpoint
INSERT INTO `__new_task_dependencies`(
	`upstream_subtask_id`,
	`downstream_subtask_id`,
	`dependency_type`,
	`required_gate`,
	`reason`,
	`created_at`
)
SELECT
	`upstream_subtask_id`,
	`downstream_subtask_id`,
	`dependency_type`,
	CASE `dependency_type`
		WHEN 'BLOCKING' THEN 'ACCEPTED'
		ELSE 'NONE'
	END,
	CASE `dependency_type`
		WHEN 'BLOCKING' THEN 'Legacy BLOCKING dependency migrated without a recorded reason.'
		ELSE 'Legacy INFORMATIONAL dependency migrated without a recorded reason.'
	END,
	`created_at`
FROM `task_dependencies`;--> statement-breakpoint
DROP TABLE `task_dependencies`;--> statement-breakpoint
ALTER TABLE `__new_task_dependencies` RENAME TO `task_dependencies`;--> statement-breakpoint
CREATE INDEX `task_dependencies_upstream_index` ON `task_dependencies` (`upstream_subtask_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_downstream_index` ON `task_dependencies` (`downstream_subtask_id`);
