ALTER TABLE `governed_role_authorizations` ADD `recovery_attempt` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP INDEX `governed_role_stage_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `governed_role_stage_unique` ON `governed_role_authorizations` (`subtask_id`,`workflow_sequence`,`recovery_attempt`);
--> statement-breakpoint
DROP TRIGGER governed_role_authorizations_insert_conflict;
--> statement-breakpoint
CREATE TRIGGER governed_role_authorizations_insert_conflict BEFORE INSERT ON governed_role_authorizations
WHEN typeof(NEW.recovery_attempt) != 'integer' OR NEW.recovery_attempt NOT IN (0,1)
 OR (NEW.recovery_attempt = 1 AND (NEW.role != 'EXECUTE' OR NEW.write_enabled != 1))
 OR EXISTS (SELECT 1 FROM governed_role_authorizations WHERE authorization_id IS NEW.authorization_id
 OR (subtask_id IS NEW.subtask_id AND workflow_sequence IS NEW.workflow_sequence AND recovery_attempt IS NEW.recovery_attempt))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
