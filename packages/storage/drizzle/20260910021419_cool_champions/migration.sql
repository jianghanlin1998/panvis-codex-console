-- Preserve all provenance guards while enlarging text capacity; no rows are rewritten.
DROP TRIGGER "governed_finding_resolution_guard";
--> statement-breakpoint
DROP TRIGGER "governed_provider_claim_guard";
--> statement-breakpoint
DROP TRIGGER "governed_provider_claims_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "governed_provider_claims_immutable_update";
--> statement-breakpoint
DROP TRIGGER "governed_provider_claims_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "governed_result_provenance_guard";
--> statement-breakpoint
DROP TRIGGER "governed_result_provenance_immutable_delete";
--> statement-breakpoint
DROP TRIGGER "governed_result_provenance_immutable_update";
--> statement-breakpoint
DROP TRIGGER "governed_result_provenance_insert_conflict";
--> statement-breakpoint
DROP TRIGGER "governed_success_provenance_guard";
--> statement-breakpoint
CREATE TABLE `__new_governed_provider_claims` (
	`authorization_id` text PRIMARY KEY,
	`execution_run_id` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_bytes` integer NOT NULL,
	`target_finding_ids` text NOT NULL,
	`claimed_at` text NOT NULL,
	CONSTRAINT `fk_governed_provider_claims_authorization_id_governed_role_authorizations_authorization_id_fk` FOREIGN KEY (`authorization_id`) REFERENCES `governed_role_authorizations`(`authorization_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_provider_claims_execution_run_id_execution_runs_id_fk` FOREIGN KEY (`execution_run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_provider_claim_bytes_check" CHECK(typeof("input_bytes") = 'integer' and "input_bytes" between 1 and 1048576),
	CONSTRAINT "governed_provider_claim_hash_check" CHECK(length("input_hash") = 64 and "input_hash" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_governed_provider_claims`(`authorization_id`, `execution_run_id`, `candidate_sha`, `input_hash`, `input_bytes`, `target_finding_ids`, `claimed_at`) SELECT `authorization_id`, `execution_run_id`, `candidate_sha`, `input_hash`, `input_bytes`, `target_finding_ids`, `claimed_at` FROM `governed_provider_claims`;--> statement-breakpoint
DROP TABLE `governed_provider_claims`;--> statement-breakpoint
ALTER TABLE `__new_governed_provider_claims` RENAME TO `governed_provider_claims`;--> statement-breakpoint
CREATE TABLE `__new_governed_result_provenance` (
	`result_id` text PRIMARY KEY,
	`authorization_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`provider_run_id` text NOT NULL,
	`provider_model_id` text NOT NULL,
	`normalized_usage` text NOT NULL,
	`structured_result` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `fk_governed_result_provenance_result_id_governed_role_results_result_id_fk` FOREIGN KEY (`result_id`) REFERENCES `governed_role_results`(`result_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_result_provenance_authorization_id_governed_provider_claims_authorization_id_fk` FOREIGN KEY (`authorization_id`) REFERENCES `governed_provider_claims`(`authorization_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_result_provenance_size_check" CHECK(length("structured_result") between 2 and 1048576)
);
--> statement-breakpoint
INSERT INTO `__new_governed_result_provenance`(`result_id`, `authorization_id`, `provider_thread_id`, `provider_run_id`, `provider_model_id`, `normalized_usage`, `structured_result`, `candidate_sha`, `recorded_at`) SELECT `result_id`, `authorization_id`, `provider_thread_id`, `provider_run_id`, `provider_model_id`, `normalized_usage`, `structured_result`, `candidate_sha`, `recorded_at` FROM `governed_result_provenance`;--> statement-breakpoint
DROP TABLE `governed_result_provenance`;--> statement-breakpoint
ALTER TABLE `__new_governed_result_provenance` RENAME TO `governed_result_provenance`;--> statement-breakpoint
CREATE UNIQUE INDEX `governed_provider_claim_run_unique` ON `governed_provider_claims` (`execution_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_result_provenance_authorization_unique` ON `governed_result_provenance` (`authorization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_result_provenance_thread_unique` ON `governed_result_provenance` (`provider_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_result_provenance_run_unique` ON `governed_result_provenance` (`provider_run_id`);
--> statement-breakpoint
CREATE TRIGGER `governed_finding_resolution_guard`
BEFORE INSERT ON `governed_finding_resolutions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_findings` AS `finding`
	JOIN `governed_role_results` AS `result`
		ON `result`.`result_id` = NEW.`role_result_id`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `finding`.`finding_id` = NEW.`finding_id`
	AND `finding`.`blocking` = 1
	AND `finding`.`subtask_id` IS `authorization`.`subtask_id`
	AND `result`.`role` = 'FOCUSED_RE_QA'
	AND `result`.`outcome` = 'PASS'
 AND EXISTS (SELECT 1 FROM governed_provider_claims claim, json_each(claim.target_finding_ids) target
   WHERE claim.authorization_id = result.authorization_id AND target.value = NEW.finding_id)
 AND EXISTS (SELECT 1 FROM governed_role_results fresh WHERE fresh.result_id = finding.result_id
   AND fresh.role IN ('FRESH_QA', 'FOCUSED_RE_QA') AND fresh.outcome = 'BLOCKING_FAIL'
   AND EXISTS (SELECT 1 FROM governed_role_authorizations qa_authority WHERE qa_authority.authorization_id = fresh.authorization_id
     AND qa_authority.subtask_id = authorization.subtask_id AND qa_authority.workflow_sequence < authorization.workflow_sequence))
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed finding resolution');
END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claim_guard BEFORE INSERT ON governed_provider_claims
WHEN NOT EXISTS (SELECT 1 FROM governed_role_authorizations a
 JOIN governed_role_execution_links l ON l.authorization_id = a.authorization_id
 JOIN execution_runs er ON er.id = l.execution_run_id JOIN chat_threads ct ON ct.id = l.chat_thread_id
 WHERE a.authorization_id = NEW.authorization_id AND l.execution_run_id IS NEW.execution_run_id
 AND a.candidate_sha IS NEW.candidate_sha AND er.status = 'CREATED' AND ct.provider_thread_id IS NULL)
 OR NOT json_valid(NEW.target_finding_ids) OR json_array_length(NEW.target_finding_ids) > CASE WHEN EXISTS (
  SELECT 1 FROM big_task_execution_approvals approval JOIN governed_role_authorizations auth ON auth.big_task_id = approval.big_task_id
  WHERE auth.authorization_id = NEW.authorization_id AND json_extract(approval.payload, '$.request.limits.repairCycleLimit') = 2
 ) THEN 32 ELSE 16 END
BEGIN SELECT RAISE(ABORT, 'invalid governed provider claim'); END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claims_immutable_delete BEFORE DELETE ON governed_provider_claims
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claims_immutable_update BEFORE UPDATE ON governed_provider_claims
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claims_insert_conflict BEFORE INSERT ON governed_provider_claims
WHEN EXISTS (SELECT 1 FROM governed_provider_claims WHERE (authorization_id IS NEW.authorization_id) OR (execution_run_id IS NEW.execution_run_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_result_provenance_guard BEFORE INSERT ON governed_result_provenance
WHEN NOT EXISTS (SELECT 1 FROM governed_role_results r
 JOIN governed_role_execution_links l ON l.authorization_id = r.authorization_id
 JOIN execution_runs er ON er.id = l.execution_run_id JOIN chat_threads ct ON ct.id = l.chat_thread_id
 JOIN governed_provider_claims claim ON claim.authorization_id = r.authorization_id
 WHERE r.result_id = NEW.result_id AND r.authorization_id IS NEW.authorization_id
 AND r.candidate_sha IS NEW.candidate_sha AND r.occurred_at IS NEW.recorded_at
 AND er.status = 'RUNNING' AND er.provider_run_id IS NEW.provider_run_id
 AND ct.provider_thread_id IS NEW.provider_thread_id AND er.provider_model_id IS NEW.provider_model_id)
 OR NOT json_valid(NEW.structured_result) OR NOT json_valid(NEW.normalized_usage)
BEGIN SELECT RAISE(ABORT, 'invalid governed result provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_result_provenance_immutable_delete BEFORE DELETE ON governed_result_provenance
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_result_provenance_immutable_update BEFORE UPDATE ON governed_result_provenance
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_result_provenance_insert_conflict BEFORE INSERT ON governed_result_provenance
WHEN EXISTS (SELECT 1 FROM governed_result_provenance WHERE (result_id IS NEW.result_id) OR (authorization_id IS NEW.authorization_id) OR (provider_thread_id IS NEW.provider_thread_id) OR (provider_run_id IS NEW.provider_run_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
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
