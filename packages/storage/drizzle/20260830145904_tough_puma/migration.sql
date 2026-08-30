CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY,
	`subtask_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_thread_id` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	CONSTRAINT `fk_chat_threads_subtask_id_subtasks_id_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "chat_threads_id_check" CHECK(length("id") between 5 and 128 and "id" glob 'thr_*'),
	CONSTRAINT "chat_threads_provider_id_check" CHECK(length("provider_id") between 1 and 64
        and "provider_id" = lower("provider_id")
        and "provider_id" not glob '*[^a-z0-9-]*'
        and "provider_id" not glob '-*'
        and "provider_id" not glob '*-'
        and "provider_id" not glob '*--*'),
	CONSTRAINT "chat_threads_provider_thread_id_check" CHECK("provider_thread_id" is null
        or (length("provider_thread_id") between 1 and 512
          and trim("provider_thread_id") = "provider_thread_id")),
	CONSTRAINT "chat_threads_lifecycle_check" CHECK(("status" = 'OPEN' and "closed_at" is null)
        or ("status" = 'CLOSED'
          and "closed_at" is not null
          and "closed_at" = "updated_at"))
);
--> statement-breakpoint
CREATE TABLE `execution_runs` (
	`id` text PRIMARY KEY,
	`chat_thread_id` text NOT NULL,
	`status` text NOT NULL,
	`provider_thread_id` text,
	`provider_run_id` text,
	`provider_model_id` text,
	`usage_present` integer NOT NULL,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`total_tokens` integer,
	`runtime_seconds` real,
	`tool_call_count` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	CONSTRAINT `fk_execution_runs_chat_thread_id_chat_threads_id_fk` FOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "execution_runs_id_check" CHECK(length("id") between 5 and 128 and "id" glob 'run_*'),
	CONSTRAINT "execution_runs_provider_thread_id_check" CHECK("provider_thread_id" is null
        or (length("provider_thread_id") between 1 and 512
          and trim("provider_thread_id") = "provider_thread_id")),
	CONSTRAINT "execution_runs_provider_run_id_check" CHECK("provider_run_id" is null
        or (length("provider_run_id") between 1 and 512
          and trim("provider_run_id") = "provider_run_id")),
	CONSTRAINT "execution_runs_provider_model_id_check" CHECK("provider_model_id" is null
        or (length("provider_model_id") between 1 and 512
          and trim("provider_model_id") = "provider_model_id")),
	CONSTRAINT "execution_runs_provider_run_pair_check" CHECK(("provider_thread_id" is null and "provider_run_id" is null)
        or ("provider_thread_id" is not null and "provider_run_id" is not null)),
	CONSTRAINT "execution_runs_usage_check" CHECK("usage_present" in (0, 1)
        and ("input_tokens" is null or (typeof("input_tokens") = 'integer' and "input_tokens" between 0 and 9007199254740991))
        and ("cached_input_tokens" is null or (typeof("cached_input_tokens") = 'integer' and "cached_input_tokens" between 0 and 9007199254740991))
        and ("output_tokens" is null or (typeof("output_tokens") = 'integer' and "output_tokens" between 0 and 9007199254740991))
        and ("reasoning_tokens" is null or (typeof("reasoning_tokens") = 'integer' and "reasoning_tokens" between 0 and 9007199254740991))
        and ("total_tokens" is null or (typeof("total_tokens") = 'integer' and "total_tokens" between 0 and 9007199254740991))
        and ("runtime_seconds" is null or (typeof("runtime_seconds") in ('integer', 'real') and "runtime_seconds" >= 0))
        and ("tool_call_count" is null or (typeof("tool_call_count") = 'integer' and "tool_call_count" between 0 and 9007199254740991))
        and ("input_tokens" is null or "output_tokens" is null or "total_tokens" is null
          or "total_tokens" = "input_tokens" + "output_tokens")
        and ("usage_present" = 1
          or ("input_tokens" is null
            and "cached_input_tokens" is null
            and "output_tokens" is null
            and "reasoning_tokens" is null
            and "total_tokens" is null
            and "runtime_seconds" is null
            and "tool_call_count" is null))),
	CONSTRAINT "execution_runs_lifecycle_check" CHECK(("status" = 'CREATED'
          and "provider_thread_id" is null
          and "provider_run_id" is null
          and "provider_model_id" is null
          and "usage_present" = 0
          and "input_tokens" is null
          and "cached_input_tokens" is null
          and "output_tokens" is null
          and "reasoning_tokens" is null
          and "total_tokens" is null
          and "runtime_seconds" is null
          and "tool_call_count" is null
          and "started_at" is null
          and "ended_at" is null
          and "updated_at" = "created_at")
        or ("status" = 'RUNNING'
          and "provider_thread_id" is not null
          and "provider_run_id" is not null
          and "started_at" is not null
          and "ended_at" is null
          and "usage_present" = 0
          and "input_tokens" is null
          and "cached_input_tokens" is null
          and "output_tokens" is null
          and "reasoning_tokens" is null
          and "total_tokens" is null
          and "runtime_seconds" is null
          and "tool_call_count" is null
          and "updated_at" = "started_at")
        or ("status" in ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
          and "ended_at" is not null
          and "updated_at" = "ended_at"
          and (("started_at" is null
              and "status" = 'FAILED'
              and "provider_thread_id" is null
              and "provider_run_id" is null
              and "provider_model_id" is null
              and "usage_present" = 0
              and "input_tokens" is null
              and "cached_input_tokens" is null
              and "output_tokens" is null
              and "reasoning_tokens" is null
              and "total_tokens" is null
              and "runtime_seconds" is null
              and "tool_call_count" is null)
            or ("started_at" is not null
              and "provider_thread_id" is not null
              and "provider_run_id" is not null))))
);
--> statement-breakpoint
CREATE INDEX `chat_threads_subtask_order_index` ON `chat_threads` (`subtask_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_threads_provider_thread_unique` ON `chat_threads` (`provider_id`,`provider_thread_id`) WHERE "chat_threads"."provider_thread_id" is not null;--> statement-breakpoint
CREATE INDEX `execution_runs_thread_order_index` ON `execution_runs` (`chat_thread_id`,`created_at`,`id`);