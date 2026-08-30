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

The database does not persist prompt or context text, response text, transcripts, raw events, reasoning, tool traces, stderr, process or environment data, authentication or credentials, billing data, raw provider usage, or arbitrary provider metadata.

## Durability boundary

The forward Drizzle migration adds restrictive `chat_threads` and `execution_runs` tables without recreating existing tables. Existing databases upgrade without changing task, dependency, context, digest, audit, or checkpoint rows. Fresh databases, migrated prior-boundary databases, and closed/reopened databases reconstruct the same strict domain state with deterministic timestamp-plus-ID ordering.

This foundation does not automatically connect `executeSingleSubtaskLiveCodex` to storage, resume provider threads, persist live response content, or add orchestration, retry, cancellation, scheduling, worktrees, UI, or provider expansion. The next maturity gate is Durable Execution / Thread / Run Persistence V0 Comprehensive Hardening.
