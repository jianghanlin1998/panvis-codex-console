CREATE TABLE `orchestration_materializations` (
	`big_task_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`materialized_at` text NOT NULL,
	CONSTRAINT `fk_orchestration_materializations_big_task_id_orchestration_planning_tracks_big_task_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `orchestration_planning_tracks`(`big_task_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_orchestration_materializations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "orchestration_materializations_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "orchestration_materializations_binding_check" CHECK(length("candidate_binding") >= 1)
);
--> statement-breakpoint
CREATE TABLE `orchestration_plan_candidates` (
	`big_task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`candidate_payload` text NOT NULL,
	`candidate_binding` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `orchestration_plan_candidates_pk` PRIMARY KEY(`big_task_id`, `revision`),
	CONSTRAINT `fk_orchestration_plan_candidates_big_task_id_orchestration_planning_tracks_big_task_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `orchestration_planning_tracks`(`big_task_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_orchestration_plan_candidates_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "orchestration_plan_candidates_revision_check" CHECK(typeof("revision") = 'integer' and "revision" >= 1),
	CONSTRAINT "orchestration_plan_candidates_payload_check" CHECK(length("candidate_payload") >= 1),
	CONSTRAINT "orchestration_plan_candidates_binding_check" CHECK(length("candidate_binding") >= 1)
);
--> statement-breakpoint
CREATE TABLE `orchestration_planning_tracks` (
	`big_task_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_orchestration_planning_tracks_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_orchestration_planning_tracks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `orchestration_review_decisions` (
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`outcome` text NOT NULL,
	`candidate_binding` text NOT NULL,
	`revision_requirements` text,
	`created_at` text NOT NULL,
	CONSTRAINT `orchestration_review_decisions_pk` PRIMARY KEY(`big_task_id`, `plan_revision`),
	CONSTRAINT `fk_orchestration_review_decisions_big_task_id_orchestration_planning_tracks_big_task_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `orchestration_planning_tracks`(`big_task_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "orchestration_review_decisions_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "orchestration_review_decisions_outcome_check" CHECK("outcome" in ('APPROVE', 'REJECT', 'ESCALATE')),
	CONSTRAINT "orchestration_review_decisions_binding_check" CHECK(length("candidate_binding") >= 1),
	CONSTRAINT "orchestration_review_decisions_requirements_check" CHECK(("outcome" = 'REJECT' and "revision_requirements" is not null)
        or ("outcome" in ('APPROVE', 'ESCALATE') and "revision_requirements" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orchestration_plan_candidates_binding_unique` ON `orchestration_plan_candidates` (`big_task_id`,`candidate_binding`);--> statement-breakpoint
CREATE INDEX `orchestration_planning_tracks_project_id_index` ON `orchestration_planning_tracks` (`project_id`);