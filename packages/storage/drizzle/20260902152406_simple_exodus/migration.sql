PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_orchestration_materializations` (
	`big_task_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`candidate_binding` text NOT NULL,
	`materialized_at` text NOT NULL,
	CONSTRAINT `fk_orchestration_materializations_big_task_id_orchestration_planning_tracks_big_task_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `orchestration_planning_tracks`(`big_task_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_orchestration_materializations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `orchestration_materializations_candidate_fk` FOREIGN KEY (`big_task_id`,`plan_revision`) REFERENCES `orchestration_plan_candidates`(`big_task_id`,`revision`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "orchestration_materializations_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "orchestration_materializations_binding_check" CHECK(length("candidate_binding") >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_orchestration_materializations`(`big_task_id`, `project_id`, `plan_revision`, `candidate_binding`, `materialized_at`) SELECT `big_task_id`, `project_id`, `plan_revision`, `candidate_binding`, `materialized_at` FROM `orchestration_materializations`;--> statement-breakpoint
DROP TABLE `orchestration_materializations`;--> statement-breakpoint
ALTER TABLE `__new_orchestration_materializations` RENAME TO `orchestration_materializations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_orchestration_review_decisions` (
	`big_task_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`outcome` text NOT NULL,
	`candidate_binding` text NOT NULL,
	`revision_requirements` text,
	`created_at` text NOT NULL,
	CONSTRAINT `orchestration_review_decisions_pk` PRIMARY KEY(`big_task_id`, `plan_revision`),
	CONSTRAINT `fk_orchestration_review_decisions_big_task_id_orchestration_planning_tracks_big_task_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `orchestration_planning_tracks`(`big_task_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `orchestration_review_decisions_candidate_fk` FOREIGN KEY (`big_task_id`,`plan_revision`) REFERENCES `orchestration_plan_candidates`(`big_task_id`,`revision`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "orchestration_review_decisions_revision_check" CHECK(typeof("plan_revision") = 'integer' and "plan_revision" >= 1),
	CONSTRAINT "orchestration_review_decisions_outcome_check" CHECK("outcome" in ('APPROVE', 'REJECT', 'ESCALATE')),
	CONSTRAINT "orchestration_review_decisions_binding_check" CHECK(length("candidate_binding") >= 1),
	CONSTRAINT "orchestration_review_decisions_requirements_check" CHECK(("outcome" = 'REJECT' and "revision_requirements" is not null)
        or ("outcome" in ('APPROVE', 'ESCALATE') and "revision_requirements" is null))
);
--> statement-breakpoint
INSERT INTO `__new_orchestration_review_decisions`(`big_task_id`, `plan_revision`, `outcome`, `candidate_binding`, `revision_requirements`, `created_at`) SELECT `big_task_id`, `plan_revision`, `outcome`, `candidate_binding`, `revision_requirements`, `created_at` FROM `orchestration_review_decisions`;--> statement-breakpoint
DROP TABLE `orchestration_review_decisions`;--> statement-breakpoint
ALTER TABLE `__new_orchestration_review_decisions` RENAME TO `orchestration_review_decisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;