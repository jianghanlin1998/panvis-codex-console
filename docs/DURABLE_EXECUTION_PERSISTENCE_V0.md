# Durable Execution Persistence V0

This slice durably records the provider-neutral ownership hierarchy `Subtask -> ChatThread -> ExecutionRun`. Console `thr_` and `run_` IDs are the durable identities. Provider-owned thread, run, and model IDs are optional external references and never replace Console IDs.

## Lifecycle

A ChatThread is created `OPEN`; its only transition is `OPEN -> CLOSED`, and `CLOSED` is terminal. New runs require an open thread. A thread may close only when every owned run is terminal.

An ExecutionRun is created `CREATED`. Legal transitions are:

- `CREATED -> RUNNING`
- `CREATED -> FAILED` for a pre-provider-start failure
- `RUNNING -> SUCCEEDED`
- `RUNNING -> FAILED`
- `RUNNING -> INTERRUPTED`

`SUCCEEDED`, `FAILED`, and `INTERRUPTED` are terminal and immutable. Explicit storage operations enforce transitions atomically; there is no generic status mutation API.

## Provider bindings and usage

Each ChatThread has one immutable provider ID. Its provider thread reference may be absent initially, may be bound once, and may be re-observed idempotently only when it is exactly identical. A concrete provider thread reference can belong to only one Console ChatThread.

A run can start only after its owning thread has a matching provider thread binding. Its provider run reference is established by that start and cannot change. Optional model references must use the same provider and cannot be silently replaced. Optional final usage stores only the existing normalized fields in explicit columns; absent usage remains distinguishable from a present empty normalized usage object.

Persisted durable rows whose normalized usage integers cannot be safely represented by the accepted numeric contract fail closed as malformed stored data; they are not coerced or exposed as generic raw driver errors.

One concrete provider run reference may belong to only one Console ExecutionRun within its owning ChatThread. The application rejects a competing start and the database independently enforces the provider-neutral `(chat_thread_id, provider_run_id)` ownership key.

Durable lifecycle mutations persist the injected clock value exactly when it is equal to or later than the row's current lifecycle timestamp. A regressing clock is rejected atomically; storage does not synthesize a later timestamp.

The database does not persist prompt or context text, response text, transcripts, raw events, reasoning, tool traces, stderr, process or environment data, authentication or credentials, billing data, raw provider usage, or arbitrary provider metadata.

## Durability boundary

The original forward Drizzle migration adds restrictive `chat_threads` and `execution_runs` tables without recreating existing tables. A later forward migration adds provider-run ownership uniqueness without rewriting the historical migration. Existing unambiguous durable data and all task, dependency, context, digest, audit, and checkpoint rows survive the upgrade unchanged. If pre-repair data contains ambiguous duplicate provider-run ownership, migration fails and rolls back instead of selecting or deleting an owner.

Fresh databases, migrated prior-boundary databases, and closed/reopened databases reconstruct the same strict domain state with deterministic timestamp-plus-ID ordering. Every accepted Console or provider-owned identifier is preserved as the exact JavaScript string supplied by the authoritative Domain contract; persistence performs no Unicode normalization.

This foundation does not automatically connect `executeSingleSubtaskLiveCodex` to storage, resume provider threads, persist live response content, or add orchestration, retry, cancellation, scheduling, worktrees, UI, or provider expansion.

Comprehensive Hardening passed. Initial Fresh Independent QA found one strict corrupt-readback blocker, which was repaired at `e2f486a8888d6d8aba8831b861adc5b0cf995047`. Focused Fresh Re-QA passed with no blocking findings. Durable Execution / Thread / Run Persistence V0 is ACCEPTED.
