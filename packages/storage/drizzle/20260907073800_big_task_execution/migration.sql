CREATE TABLE big_task_execution_approvals (big_task_id TEXT NOT NULL REFERENCES live_planning_intakes(big_task_id) ON DELETE RESTRICT, payload TEXT NOT NULL CHECK (json_valid(payload)), PRIMARY KEY (big_task_id));
--> statement-breakpoint
CREATE TRIGGER big_task_execution_approvals_immutable_update BEFORE UPDATE ON big_task_execution_approvals BEGIN SELECT RAISE(ABORT, 'execution evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER big_task_execution_approvals_immutable_delete BEFORE DELETE ON big_task_execution_approvals BEGIN SELECT RAISE(ABORT, 'execution evidence is immutable'); END;
--> statement-breakpoint
CREATE TABLE big_task_execution_events (big_task_id TEXT NOT NULL REFERENCES live_planning_intakes(big_task_id) ON DELETE RESTRICT, sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1024), payload TEXT NOT NULL CHECK (json_valid(payload)), PRIMARY KEY (big_task_id, sequence));
--> statement-breakpoint
CREATE TRIGGER big_task_execution_events_immutable_update BEFORE UPDATE ON big_task_execution_events BEGIN SELECT RAISE(ABORT, 'execution evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER big_task_execution_events_immutable_delete BEFORE DELETE ON big_task_execution_events BEGIN SELECT RAISE(ABORT, 'execution evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER big_task_execution_event_order BEFORE INSERT ON big_task_execution_events BEGIN
 SELECT CASE WHEN NEW.sequence IS NOT (SELECT count(*) + 1 FROM big_task_execution_events WHERE big_task_id = NEW.big_task_id)
 OR NOT EXISTS (SELECT 1 FROM big_task_execution_approvals WHERE big_task_id = NEW.big_task_id)
 THEN RAISE(ABORT, 'execution event order is invalid') END;
END;
