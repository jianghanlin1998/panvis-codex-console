CREATE TABLE `governed_gate_sources` (
	`authority_id` text PRIMARY KEY,
	`source_type` text NOT NULL,
	`source_reference` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_governed_gate_sources_authority_id_durable_workflow_evidence_authorities_authority_id_fk` FOREIGN KEY (`authority_id`) REFERENCES `durable_workflow_evidence_authorities`(`authority_id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);

--> statement-breakpoint
CREATE TRIGGER governed_gate_sources_insert_conflict BEFORE INSERT ON governed_gate_sources
WHEN EXISTS (SELECT 1 FROM governed_gate_sources WHERE authority_id = NEW.authority_id)
BEGIN SELECT RAISE(ABORT, 'immutable governed gate source'); END;
--> statement-breakpoint
CREATE TRIGGER governed_gate_sources_immutable_update BEFORE UPDATE ON governed_gate_sources
BEGIN SELECT RAISE(ABORT, 'immutable governed gate source'); END;
--> statement-breakpoint
CREATE TRIGGER governed_gate_sources_immutable_delete BEFORE DELETE ON governed_gate_sources
BEGIN SELECT RAISE(ABORT, 'immutable governed gate source'); END;

--> statement-breakpoint
DROP TRIGGER governed_manual_start_current_state_guard;
--> statement-breakpoint
CREATE TRIGGER `governed_manual_start_current_state_guard`
BEFORE INSERT ON `governed_manual_start_authorities`
WHEN NOT EXISTS (
	SELECT 1
	FROM `subtask_workflow_instances` AS `workflow`
	JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `workflow`.`subtask_id`
	WHERE `workflow`.`subtask_id` = NEW.`subtask_id`
	AND `workflow`.`project_id` IS NEW.`project_id`
	AND `workflow`.`big_task_id` IS NEW.`big_task_id`
	AND `workflow`.`plan_revision` IS NEW.`plan_revision`
	AND `workflow`.`candidate_binding` IS NEW.`candidate_binding`
	AND `subtask`.`start_policy` = 'MANUAL'
	AND `subtask`.`status` = 'TODO'
	AND coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		`workflow`.`initial_stage`
	) IN ('MATERIALIZE', 'EXECUTE')
	AND NEW.`workflow_sequence` = (
		SELECT coalesce(max(`transition`.`sequence`), 0) + CASE WHEN `workflow`.`initial_stage` = 'MATERIALIZE' AND count(*) = 0 THEN 2 ELSE 1 END
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'stale governed manual-start authority');
END;
