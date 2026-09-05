CREATE TABLE `governed_gate_observations` (
	`source_reference` text PRIMARY KEY,
	`subtask_id` text NOT NULL,
	`workflow_sequence` integer NOT NULL,
	`gate_kind` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_governed_gate_observations_subtask_id_subtasks_id_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_gate_observation_sequence_check" CHECK("workflow_sequence" > 0),
	CONSTRAINT "governed_gate_observation_kind_check" CHECK("gate_kind" IN ('dependency','repository','context','budget','concurrency','worktree','human-policy')),
	CONSTRAINT "governed_gate_observation_payload_check" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `governed_provider_input_observations` (
	`authorization_id` text PRIMARY KEY,
	`observation_id` text NOT NULL UNIQUE,
	`payload` text NOT NULL,
	CONSTRAINT `fk_governed_provider_input_observations_authorization_id_governed_provider_claims_authorization_id_fk` FOREIGN KEY (`authorization_id`) REFERENCES `governed_provider_claims`(`authorization_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "governed_input_observation_payload_check" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `governed_provider_turn_starts` (
	`authorization_id` text PRIMARY KEY,
	`observation_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`validated_at` text NOT NULL,
	CONSTRAINT `fk_governed_provider_turn_starts_authorization_id_governed_provider_input_observations_authorization_id_fk` FOREIGN KEY (`authorization_id`) REFERENCES `governed_provider_input_observations`(`authorization_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_governed_provider_turn_starts_observation_id_governed_provider_input_observations_observation_id_fk` FOREIGN KEY (`observation_id`) REFERENCES `governed_provider_input_observations`(`observation_id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `governed_gate_observation_occurrence_unique` ON `governed_gate_observations` (`subtask_id`,`workflow_sequence`,`gate_kind`);
--> statement-breakpoint
CREATE TRIGGER governed_gate_observations_immutable_insert BEFORE INSERT ON governed_gate_observations
WHEN EXISTS (SELECT 1 FROM governed_gate_observations WHERE source_reference = NEW.source_reference)
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_gate_observations_immutable_update BEFORE UPDATE ON governed_gate_observations
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_gate_observations_immutable_delete BEFORE DELETE ON governed_gate_observations
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_provider_input_observations_immutable_insert BEFORE INSERT ON governed_provider_input_observations
WHEN EXISTS (SELECT 1 FROM governed_provider_input_observations WHERE authorization_id = NEW.authorization_id)
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_provider_input_observations_immutable_update BEFORE UPDATE ON governed_provider_input_observations
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_provider_input_observations_immutable_delete BEFORE DELETE ON governed_provider_input_observations
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_provider_turn_starts_immutable_insert BEFORE INSERT ON governed_provider_turn_starts
WHEN EXISTS (SELECT 1 FROM governed_provider_turn_starts WHERE authorization_id = NEW.authorization_id)
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_provider_turn_starts_immutable_update BEFORE UPDATE ON governed_provider_turn_starts
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;

--> statement-breakpoint
CREATE TRIGGER governed_provider_turn_starts_immutable_delete BEFORE DELETE ON governed_provider_turn_starts
BEGIN SELECT RAISE(ABORT, 'immutable governed occurrence provenance'); END;
