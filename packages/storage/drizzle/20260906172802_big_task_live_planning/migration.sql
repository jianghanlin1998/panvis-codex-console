CREATE TABLE `live_planning_intakes` (
	`big_task_id` text PRIMARY KEY,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_live_planning_intakes_big_task_id_big_tasks_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `big_tasks`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `live_planning_runs` (
	`big_task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `live_planning_runs_pk` PRIMARY KEY(`big_task_id`, `sequence`),
	CONSTRAINT `fk_live_planning_runs_big_task_id_live_planning_intakes_big_task_id_fk` FOREIGN KEY (`big_task_id`) REFERENCES `live_planning_intakes`(`big_task_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER live_planning_intake_immutable_update BEFORE UPDATE ON live_planning_intakes
BEGIN SELECT RAISE(ABORT, 'planning intake is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER live_planning_intake_immutable_delete BEFORE DELETE ON live_planning_intakes
BEGIN SELECT RAISE(ABORT, 'planning intake is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER live_planning_run_insert_guard BEFORE INSERT ON live_planning_runs
BEGIN
  SELECT CASE WHEN json_valid(NEW.payload) IS NOT 1 THEN RAISE(ABORT, 'invalid planning run') END;
  SELECT CASE WHEN NEW.sequence NOT BETWEEN 1 AND 6
    OR NEW.sequence IS NOT (SELECT count(*) + 1 FROM live_planning_runs WHERE big_task_id = NEW.big_task_id)
    OR json_extract(NEW.payload, '$.sequence') IS NOT NEW.sequence
    OR json_extract(NEW.payload, '$.role') NOT IN ('PLANNER', 'REVIEWER')
    OR json_extract(NEW.payload, '$.status') NOT IN ('RUNNING', 'HUMAN_REQUIRED')
    OR EXISTS (SELECT 1 FROM live_planning_runs WHERE big_task_id = NEW.big_task_id AND json_extract(payload, '$.status') != 'COMPLETED')
    THEN RAISE(ABORT, 'invalid planning run') END;
END;
--> statement-breakpoint
CREATE TRIGGER live_planning_run_update_guard BEFORE UPDATE ON live_planning_runs
BEGIN
  SELECT CASE WHEN json_valid(NEW.payload) IS NOT 1 THEN RAISE(ABORT, 'invalid planning run') END;
  SELECT CASE WHEN OLD.big_task_id IS NOT NEW.big_task_id OR OLD.sequence IS NOT NEW.sequence
    OR json_extract(OLD.payload, '$.status') IS NOT 'RUNNING'
    OR json_extract(NEW.payload, '$.sequence') IS NOT OLD.sequence
    OR json_extract(NEW.payload, '$.role') IS NOT json_extract(OLD.payload, '$.role')
    OR json_extract(NEW.payload, '$.inputBinding') IS NOT json_extract(OLD.payload, '$.inputBinding')
    OR json_extract(NEW.payload, '$.inputText') IS NOT json_extract(OLD.payload, '$.inputText')
    OR json_extract(NEW.payload, '$.startedAt') IS NOT json_extract(OLD.payload, '$.startedAt')
    THEN RAISE(ABORT, 'immutable planning evidence') END;
END;
--> statement-breakpoint
CREATE TRIGGER live_planning_run_immutable_delete BEFORE DELETE ON live_planning_runs
BEGIN SELECT RAISE(ABORT, 'planning evidence is immutable'); END;
