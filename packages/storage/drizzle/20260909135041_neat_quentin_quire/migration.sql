CREATE TABLE `console_context_entries` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_console_context_entries_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT "console_context_entry_json" CHECK(json_valid("payload"))
);

--> statement-breakpoint
DROP TRIGGER governed_success_provenance_guard;
--> statement-breakpoint
CREATE TRIGGER governed_success_provenance_guard BEFORE UPDATE OF status ON execution_runs
WHEN NEW.status = 'SUCCEEDED' AND EXISTS (SELECT 1 FROM governed_role_execution_links WHERE execution_run_id = NEW.id)
AND (((NEW.usage_present <> 1 OR NEW.total_tokens IS NULL) AND NOT EXISTS (
 SELECT 1 FROM governed_role_execution_links l
 JOIN governed_role_authorizations a ON a.authorization_id = l.authorization_id
 JOIN big_task_execution_approvals approval ON approval.big_task_id = a.big_task_id
 WHERE l.execution_run_id = NEW.id AND json_extract(approval.payload, '$.request.limits.budgetMode') = 'MEASURE'))
 OR NOT EXISTS (
 SELECT 1 FROM governed_result_provenance p JOIN governed_role_results r ON r.result_id = p.result_id
 WHERE r.execution_run_id = NEW.id AND p.provider_run_id IS NEW.provider_run_id))
BEGIN SELECT RAISE(ABORT, 'governed success requires provider provenance and configured usage'); END;
