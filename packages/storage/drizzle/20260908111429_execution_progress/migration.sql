CREATE TABLE `execution_run_progress` (
	`execution_run_id` text PRIMARY KEY,
	`payload` text NOT NULL,
	CONSTRAINT `fk_execution_run_progress_execution_run_id_execution_runs_id_fk` FOREIGN KEY (`execution_run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT
);
