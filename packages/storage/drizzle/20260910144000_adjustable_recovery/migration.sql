DROP TRIGGER governed_role_authorizations_insert_conflict;
--> statement-breakpoint
CREATE TRIGGER governed_role_authorizations_insert_conflict BEFORE INSERT ON governed_role_authorizations
WHEN typeof(NEW.recovery_attempt) != 'integer' OR NEW.recovery_attempt < 0 OR NEW.recovery_attempt > 100
 OR EXISTS (SELECT 1 FROM governed_role_authorizations WHERE authorization_id IS NEW.authorization_id
 OR (subtask_id IS NEW.subtask_id AND workflow_sequence IS NEW.workflow_sequence AND recovery_attempt IS NEW.recovery_attempt))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
