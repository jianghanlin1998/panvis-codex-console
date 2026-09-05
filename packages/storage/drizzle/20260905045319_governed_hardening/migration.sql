CREATE TABLE `governed_dispatch_gate_snapshots` (
	`receipt_id` text PRIMARY KEY,
	`gate_references` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `fk_governed_dispatch_gate_snapshots_receipt_id_governed_dispatch_receipts_receipt_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `governed_dispatch_receipts`(`receipt_id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `governed_promotion_candidates` (
	`result_id` text PRIMARY KEY,
	`summary` text NOT NULL,
	`disposition` text NOT NULL,
	CONSTRAINT `fk_governed_promotion_candidates_result_id_governed_role_results_result_id_fk` FOREIGN KEY (`result_id`) REFERENCES `governed_role_results`(`result_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_promotion_candidate_disposition_check" CHECK("disposition" = 'PENDING_HUMAN_REVIEW'),
	CONSTRAINT "governed_promotion_candidate_summary_check" CHECK(length("summary") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE `governed_provider_claims` (
	`authorization_id` text PRIMARY KEY,
	`execution_run_id` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_bytes` integer NOT NULL,
	`target_finding_ids` text NOT NULL,
	`claimed_at` text NOT NULL,
	CONSTRAINT `fk_governed_provider_claims_authorization_id_governed_role_authorizations_authorization_id_fk` FOREIGN KEY (`authorization_id`) REFERENCES `governed_role_authorizations`(`authorization_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_provider_claims_execution_run_id_execution_runs_id_fk` FOREIGN KEY (`execution_run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_provider_claim_bytes_check" CHECK(typeof("input_bytes") = 'integer' and "input_bytes" between 1 and 64000),
	CONSTRAINT "governed_provider_claim_hash_check" CHECK(length("input_hash") = 64 and "input_hash" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `governed_result_provenance` (
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
	CONSTRAINT "governed_result_provenance_size_check" CHECK(length("structured_result") between 2 and 16384)
);
--> statement-breakpoint
ALTER TABLE `governed_budget_extensions` ADD `usage_at_grant` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `governed_provider_claim_run_unique` ON `governed_provider_claims` (`execution_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_result_provenance_authorization_unique` ON `governed_result_provenance` (`authorization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_result_provenance_thread_unique` ON `governed_result_provenance` (`provider_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `governed_result_provenance_run_unique` ON `governed_result_provenance` (`provider_run_id`);
-- Governed hardening guards; no legacy authority adoption.
--> statement-breakpoint
DROP TRIGGER `governed_finding_guard`;
--> statement-breakpoint
CREATE TRIGGER `governed_finding_guard`
BEFORE INSERT ON `governed_findings`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_results` AS `result`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `result`.`result_id` = NEW.`result_id`
	AND `authorization`.`subtask_id` IS NEW.`subtask_id`
	AND (`result`.`outcome` = 'BLOCKING_FAIL' OR (`result`.`outcome` = 'PASS' AND NEW.`blocking` = 0))
	AND `result`.`role` IN ('VERIFY', 'HARDEN', 'FRESH_QA', 'FOCUSED_RE_QA')
)
BEGIN
 SELECT RAISE(ABORT, 'invalid governed finding');
END;
--> statement-breakpoint
CREATE UNIQUE INDEX governed_finding_provider_key_unique ON governed_findings(result_id, provider_finding_key);
--> statement-breakpoint
DROP TRIGGER `governed_finding_resolution_guard`;
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
   AND fresh.role = 'FRESH_QA' AND fresh.outcome = 'BLOCKING_FAIL')
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed finding resolution');
END;
--> statement-breakpoint
DROP TRIGGER `governed_budget_extension_current_state_guard`;
--> statement-breakpoint
CREATE TRIGGER `governed_budget_extension_current_state_guard`
BEFORE INSERT ON `governed_budget_extensions`
WHEN NEW.usage_at_grant IS NULL OR NEW.usage_at_grant < 120000 OR NEW.usage_at_grant >= 160000
 OR NEW.usage_at_grant IS NOT (SELECT coalesce(sum(er.total_tokens), 0) FROM execution_runs er
   JOIN chat_threads ct ON ct.id = er.chat_thread_id WHERE ct.subtask_id = NEW.subtask_id AND er.usage_present = 1)
 OR EXISTS (SELECT 1 FROM execution_runs er JOIN chat_threads ct ON ct.id = er.chat_thread_id
   WHERE ct.subtask_id = NEW.subtask_id AND (er.status = 'RUNNING' OR er.started_at IS NOT NULL)
   AND (er.usage_present <> 1 OR er.total_tokens IS NULL))
 OR NOT EXISTS (
	SELECT 1 FROM `subtask_workflow_instances` AS `workflow`
	JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `workflow`.`subtask_id`
	WHERE `workflow`.`subtask_id` = NEW.`subtask_id`
	AND `workflow`.`project_id` IS NEW.`project_id`
	AND `workflow`.`big_task_id` IS NEW.`big_task_id`
	AND `workflow`.`plan_revision` IS NEW.`plan_revision`
	AND `workflow`.`candidate_binding` IS NEW.`candidate_binding`
	AND `subtask`.`status` IN ('TODO', 'IN_PROGRESS', 'QA_DEBUG')
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'stale governed budget-extension authority');
END;
--> statement-breakpoint
DROP TRIGGER `governed_dispatch_current_state_guard`;
--> statement-breakpoint
CREATE TRIGGER `governed_dispatch_current_state_guard`
BEFORE INSERT ON `governed_dispatch_receipts`
WHEN NOT EXISTS (
	SELECT 1
	FROM `subtask_workflow_instances` AS `workflow`
	JOIN `candidate_task_contract_bindings` AS `canonical`
		ON `canonical`.`subtask_id` = `workflow`.`subtask_id`
	JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `workflow`.`subtask_id`
	JOIN `worktree_ownerships` AS `worktree`
		ON `worktree`.`id` = NEW.`worktree_ownership_id`
	WHERE `workflow`.`subtask_id` = NEW.`subtask_id`
	AND `workflow`.`project_id` IS NEW.`project_id`
	AND `workflow`.`big_task_id` IS NEW.`big_task_id`
	AND `workflow`.`plan_revision` IS NEW.`plan_revision`
	AND `workflow`.`candidate_binding` IS NEW.`candidate_binding`
	AND `canonical`.`project_id` IS NEW.`project_id`
	AND `canonical`.`big_task_id` IS NEW.`big_task_id`
	AND `canonical`.`plan_revision` IS NEW.`plan_revision`
	AND `canonical`.`candidate_binding` IS NEW.`candidate_binding`
	AND `subtask`.`status` = 'TODO'
	AND `subtask`.`start_policy` IS NEW.`start_policy`
	AND `worktree`.`subtask_id` IS NEW.`subtask_id`
	AND `worktree`.`project_id` IS NEW.`project_id`
	AND `worktree`.`status` = 'ACTIVE'
	AND coalesce(
		(SELECT `transition`.`resulting_stage`
		 FROM `durable_workflow_transitions` AS `transition`
		 WHERE `transition`.`subtask_id` = NEW.`subtask_id`
		 ORDER BY `transition`.`sequence` DESC LIMIT 1),
		`workflow`.`initial_stage`
	) = 'EXECUTE'
	AND NEW.`workflow_sequence` = (
		SELECT coalesce(max(`transition`.`sequence`), 0) + 1
		FROM `durable_workflow_transitions` AS `transition`
		WHERE `transition`.`subtask_id` = NEW.`subtask_id`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
		AND (`human`.`scope_kind` = 'BIG_TASK' OR `human`.`subtask_id` = NEW.`subtask_id`)
	)
	AND (
		NEW.`start_policy` = 'WHEN_READY'
		OR EXISTS (
			SELECT 1 FROM `governed_manual_start_authorities` AS `manual`
			WHERE `manual`.`authority_id` = NEW.`manual_start_authority_id`
			AND `manual`.`project_id` IS NEW.`project_id`
			AND `manual`.`big_task_id` IS NEW.`big_task_id`
			AND `manual`.`plan_revision` IS NEW.`plan_revision`
			AND `manual`.`candidate_binding` IS NEW.`candidate_binding`
			AND `manual`.`subtask_id` IS NEW.`subtask_id`
			AND `manual`.`workflow_sequence` IS NEW.`workflow_sequence`
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM `task_dependencies` AS `dependency`
		JOIN `subtasks` AS `upstream`
			ON `upstream`.`id` = `dependency`.`upstream_subtask_id`
		WHERE `dependency`.`downstream_subtask_id` = NEW.`subtask_id`
		AND `dependency`.`dependency_type` = 'BLOCKING'
 AND ((`dependency`.`required_gate` = 'HARDENED' AND `upstream`.`maturity` NOT IN ('HARDENED','ACCEPTED'))
   OR (`dependency`.`required_gate` = 'ACCEPTED' AND `upstream`.`maturity` <> 'ACCEPTED'))
	)
	AND (
		SELECT count(*) FROM `governed_dispatch_receipts` AS `active`
		WHERE `active`.`project_id` = NEW.`project_id`
		AND `active`.`status` IN ('RESERVED', 'ACTIVE')
	) < 2
)
BEGIN
	SELECT RAISE(ABORT, 'stale or unauthorized governed dispatch');
END;
--> statement-breakpoint
DROP TRIGGER `governed_handoff_guard`;
--> statement-breakpoint
CREATE TRIGGER `governed_handoff_guard`
BEFORE INSERT ON `governed_handoffs`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_results` AS `result`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `result`.`result_id` = NEW.`role_result_id`
	AND `authorization`.`subtask_id` IS NEW.`subtask_id`
	AND `result`.`outcome` = 'PASS'
 AND `result`.`role` IN ('VERIFY','FRESH_QA','FOCUSED_RE_QA')
 AND `result`.`summary` IS NEW.summary AND `result`.`occurred_at` IS NEW.created_at
	AND `result`.`candidate_sha` IS NEW.`candidate_sha`
	AND NOT EXISTS (
		SELECT 1 FROM `governed_findings` AS `finding`
		LEFT JOIN `governed_finding_resolutions` AS `resolution`
			ON `resolution`.`finding_id` = `finding`.`finding_id`
		WHERE `finding`.`subtask_id` = NEW.`subtask_id`
		AND `finding`.`blocking` = 1
		AND `resolution`.`finding_id` IS NULL
	)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed handoff');
END;
--> statement-breakpoint
DROP TRIGGER `governed_promoted_context_guard`;
--> statement-breakpoint
CREATE TRIGGER `governed_promoted_context_guard`
BEFORE INSERT ON `governed_promoted_context_dispositions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `governed_role_results` AS `result`
	JOIN `governed_role_authorizations` AS `authorization`
		ON `authorization`.`authorization_id` = `result`.`authorization_id`
	WHERE `result`.`result_id` = NEW.`role_result_id`
	AND `authorization`.`subtask_id` IS NEW.`subtask_id`
	AND `result`.`outcome` = 'PASS'
 AND `result`.`role` IN ('VERIFY','FRESH_QA','FOCUSED_RE_QA')
 AND `result`.`occurred_at` IS NEW.created_at
 AND NEW.decision = CASE WHEN EXISTS (
   SELECT 1 FROM governed_promotion_candidates pc
   JOIN governed_role_results rr ON rr.result_id = pc.result_id
   JOIN governed_role_authorizations a ON a.authorization_id = rr.authorization_id
   WHERE a.subtask_id = NEW.subtask_id
 ) THEN 'CANDIDATE_RECORDED' ELSE 'NO_PROMOTION_CANDIDATE' END
)
BEGIN
	SELECT RAISE(ABORT, 'invalid governed promoted-context disposition');
END;
--> statement-breakpoint
DROP TRIGGER `governed_big_task_completion_guard`;
--> statement-breakpoint
CREATE TRIGGER `governed_big_task_completion_guard`
BEFORE INSERT ON `governed_big_task_completion_receipts`
WHEN NOT EXISTS (
	SELECT 1
	FROM `canonical_task_materializations` AS `materialization`
	JOIN `big_tasks` AS `big_task` ON `big_task`.`id` = NEW.`big_task_id`
	WHERE `materialization`.`project_id` IS NEW.`project_id`
	AND `materialization`.`big_task_id` IS NEW.`big_task_id`
	AND `materialization`.`plan_revision` IS NEW.`plan_revision`
	AND `materialization`.`candidate_binding` IS NEW.`candidate_binding`
	AND `materialization`.`subtask_count` IS NEW.`subtask_count`
	AND `big_task`.`project_id` IS NEW.`project_id`
	AND `big_task`.`status` = 'IN_PROGRESS'
	AND NEW.`subtask_count` = (
		SELECT count(*) FROM `candidate_task_contract_bindings` AS `canonical`
		WHERE `canonical`.`project_id` = NEW.`project_id`
		AND `canonical`.`big_task_id` = NEW.`big_task_id`
		AND `canonical`.`plan_revision` = NEW.`plan_revision`
		AND `canonical`.`candidate_binding` = NEW.`candidate_binding`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `candidate_task_contract_bindings` AS `canonical`
		LEFT JOIN `subtasks` AS `subtask` ON `subtask`.`id` = `canonical`.`subtask_id`
		LEFT JOIN `subtask_workflow_instances` AS `workflow`
			ON `workflow`.`subtask_id` = `canonical`.`subtask_id`
		WHERE `canonical`.`project_id` = NEW.`project_id`
		AND `canonical`.`big_task_id` = NEW.`big_task_id`
		AND `canonical`.`plan_revision` = NEW.`plan_revision`
		AND `canonical`.`candidate_binding` = NEW.`candidate_binding`
		AND (`subtask`.`id` IS NULL OR `workflow`.`subtask_id` IS NULL
   OR `workflow`.`candidate_binding` IS NOT NEW.candidate_binding
   OR `subtask`.`maturity` = 'NOT_STARTED'
   OR `subtask`.`status` <> 'DONE'
			OR coalesce(
				(SELECT `transition`.`resulting_stage`
				 FROM `durable_workflow_transitions` AS `transition`
				 WHERE `transition`.`subtask_id` = `canonical`.`subtask_id`
				 ORDER BY `transition`.`sequence` DESC LIMIT 1),
				`workflow`.`initial_stage`
			) <> 'COMPLETE')
	)
	AND NOT EXISTS (
		SELECT 1 FROM `durable_workflow_human_requirements` AS `human`
		WHERE `human`.`big_task_id` = NEW.`big_task_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'Big Task completion authority is incomplete');
END;
--> statement-breakpoint
CREATE TRIGGER governed_success_provenance_guard BEFORE UPDATE OF status ON execution_runs
WHEN NEW.status = 'SUCCEEDED' AND EXISTS (SELECT 1 FROM governed_role_execution_links WHERE execution_run_id = NEW.id)
AND (NEW.usage_present <> 1 OR NEW.total_tokens IS NULL OR NOT EXISTS (
 SELECT 1 FROM governed_result_provenance p JOIN governed_role_results r ON r.result_id = p.result_id
 WHERE r.execution_run_id = NEW.id AND p.provider_run_id IS NEW.provider_run_id))
BEGIN SELECT RAISE(ABORT, 'governed success requires provider provenance and usage'); END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claim_guard BEFORE INSERT ON governed_provider_claims
WHEN NOT EXISTS (SELECT 1 FROM governed_role_authorizations a
 JOIN governed_role_execution_links l ON l.authorization_id = a.authorization_id
 JOIN execution_runs er ON er.id = l.execution_run_id JOIN chat_threads ct ON ct.id = l.chat_thread_id
 WHERE a.authorization_id = NEW.authorization_id AND l.execution_run_id IS NEW.execution_run_id
 AND a.candidate_sha IS NEW.candidate_sha AND er.status = 'CREATED' AND ct.provider_thread_id IS NULL)
 OR NOT json_valid(NEW.target_finding_ids) OR json_array_length(NEW.target_finding_ids) > 16
BEGIN SELECT RAISE(ABORT, 'invalid governed provider claim'); END;
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
CREATE TRIGGER governed_big_task_completion_receipts_insert_conflict BEFORE INSERT ON governed_big_task_completion_receipts
WHEN EXISTS (SELECT 1 FROM governed_big_task_completion_receipts WHERE (receipt_id IS NEW.receipt_id) OR (big_task_id IS NEW.big_task_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_budget_extensions_insert_conflict BEFORE INSERT ON governed_budget_extensions
WHEN EXISTS (SELECT 1 FROM governed_budget_extensions WHERE (authority_id IS NEW.authority_id) OR (subtask_id IS NEW.subtask_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_dispatch_receipts_insert_conflict BEFORE INSERT ON governed_dispatch_receipts
WHEN EXISTS (SELECT 1 FROM governed_dispatch_receipts WHERE (receipt_id IS NEW.receipt_id) OR (operation_id IS NEW.operation_id) OR (subtask_id IS NEW.subtask_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_role_authorizations_insert_conflict BEFORE INSERT ON governed_role_authorizations
WHEN EXISTS (SELECT 1 FROM governed_role_authorizations WHERE (authorization_id IS NEW.authorization_id) OR (subtask_id IS NEW.subtask_id AND workflow_sequence IS NEW.workflow_sequence))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_role_execution_links_insert_conflict BEFORE INSERT ON governed_role_execution_links
WHEN EXISTS (SELECT 1 FROM governed_role_execution_links WHERE (authorization_id IS NEW.authorization_id) OR (chat_thread_id IS NEW.chat_thread_id) OR (execution_run_id IS NEW.execution_run_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_role_results_insert_conflict BEFORE INSERT ON governed_role_results
WHEN EXISTS (SELECT 1 FROM governed_role_results WHERE (result_id IS NEW.result_id) OR (authorization_id IS NEW.authorization_id) OR (execution_run_id IS NEW.execution_run_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_findings_insert_conflict BEFORE INSERT ON governed_findings
WHEN EXISTS (SELECT 1 FROM governed_findings WHERE (finding_id IS NEW.finding_id) OR (result_id IS NEW.result_id AND ordinal IS NEW.ordinal) OR (result_id IS NEW.result_id AND provider_finding_key IS NEW.provider_finding_key))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_finding_resolutions_insert_conflict BEFORE INSERT ON governed_finding_resolutions
WHEN EXISTS (SELECT 1 FROM governed_finding_resolutions WHERE (finding_id IS NEW.finding_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_handoffs_insert_conflict BEFORE INSERT ON governed_handoffs
WHEN EXISTS (SELECT 1 FROM governed_handoffs WHERE (handoff_id IS NEW.handoff_id) OR (subtask_id IS NEW.subtask_id) OR (role_result_id IS NEW.role_result_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_promoted_context_dispositions_insert_conflict BEFORE INSERT ON governed_promoted_context_dispositions
WHEN EXISTS (SELECT 1 FROM governed_promoted_context_dispositions WHERE (disposition_id IS NEW.disposition_id) OR (subtask_id IS NEW.subtask_id) OR (role_result_id IS NEW.role_result_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_manual_start_authorities_insert_conflict BEFORE INSERT ON governed_manual_start_authorities
WHEN EXISTS (SELECT 1 FROM governed_manual_start_authorities WHERE (authority_id IS NEW.authority_id) OR (subtask_id IS NEW.subtask_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_dispatch_gate_snapshots_insert_conflict BEFORE INSERT ON governed_dispatch_gate_snapshots
WHEN EXISTS (SELECT 1 FROM governed_dispatch_gate_snapshots WHERE (receipt_id IS NEW.receipt_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claims_insert_conflict BEFORE INSERT ON governed_provider_claims
WHEN EXISTS (SELECT 1 FROM governed_provider_claims WHERE (authorization_id IS NEW.authorization_id) OR (execution_run_id IS NEW.execution_run_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_result_provenance_insert_conflict BEFORE INSERT ON governed_result_provenance
WHEN EXISTS (SELECT 1 FROM governed_result_provenance WHERE (result_id IS NEW.result_id) OR (authorization_id IS NEW.authorization_id) OR (provider_thread_id IS NEW.provider_thread_id) OR (provider_run_id IS NEW.provider_run_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_promotion_candidates_insert_conflict BEFORE INSERT ON governed_promotion_candidates
WHEN EXISTS (SELECT 1 FROM governed_promotion_candidates WHERE (result_id IS NEW.result_id))
BEGIN SELECT RAISE(ABORT, 'immutable governed identity'); END;
--> statement-breakpoint
CREATE TRIGGER governed_dispatch_gate_snapshots_immutable_update BEFORE UPDATE ON governed_dispatch_gate_snapshots
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_dispatch_gate_snapshots_immutable_delete BEFORE DELETE ON governed_dispatch_gate_snapshots
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claims_immutable_update BEFORE UPDATE ON governed_provider_claims
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_provider_claims_immutable_delete BEFORE DELETE ON governed_provider_claims
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_result_provenance_immutable_update BEFORE UPDATE ON governed_result_provenance
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_result_provenance_immutable_delete BEFORE DELETE ON governed_result_provenance
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_promotion_candidates_immutable_update BEFORE UPDATE ON governed_promotion_candidates
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
--> statement-breakpoint
CREATE TRIGGER governed_promotion_candidates_immutable_delete BEFORE DELETE ON governed_promotion_candidates
BEGIN SELECT RAISE(ABORT, 'immutable governed provenance'); END;
