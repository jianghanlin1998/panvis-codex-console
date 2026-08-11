# S1A Subtask maturity and dependency readiness

S1A adds deterministic Task Control Plane foundation contracts. It does not start or mutate operational work.

## Subtask maturity

Subtask board status and maturity are separate persisted fields. Board status remains `TODO`, `IN_PROGRESS`, `QA_DEBUG`, `DONE`, `DROPPED`, or `ARCHIVED`; it never implies maturity.

Maturity is always explicit and is exactly one of:

- `NOT_STARTED`
- `IMPLEMENTED`
- `HARDENED`
- `ACCEPTED`

There is no null or inferred maturity. New durable Subtasks may be created only at `NOT_STARTED`. The pure maturity-transition validator allows only adjacent forward transitions: `NOT_STARTED` to `IMPLEMENTED`, `IMPLEMENTED` to `HARDENED`, and `HARDENED` to `ACCEPTED`. S1A provides no durable maturity mutation API.

## Dependency contract

Every dependency records endpoints, relation type, required gate, and a caller-supplied reason. Reasons are trimmed, non-empty strings of at most 1,000 JavaScript UTF-16 code units and are rejected rather than truncated.

The only legal type and gate combinations are:

- `BLOCKING + HARDENED`
- `BLOCKING + ACCEPTED`
- `INFORMATIONAL + NONE`

Informational dependencies never block. Only blocking edges participate in readiness-cycle detection. Informational cycles and a blocking edge with an informational reverse edge are therefore not readiness deadlocks. All edges still require real, distinct, nonduplicate endpoints within one Big Task.

`HARDENED` gates are satisfied by upstream `HARDENED` or `ACCEPTED` maturity. `ACCEPTED` gates are satisfied only by upstream `ACCEPTED`. `NONE` is always satisfied.

## Pure readiness evaluation

`evaluateSubtaskDependencyReadiness` consumes explicit Subtask IDs, Big Task ownership, maturity, the complete dependency set, and one downstream Subtask ID. It performs no storage, Git, filesystem, chat, or model access.

The result reports structural validity, readiness, stable validation codes, and deterministically ordered blockers. Each blocker includes the upstream Subtask ID, required gate, actual maturity, and durable dependency reason. Blockers use locale-independent JavaScript UTF-16 code-unit ordering by upstream Subtask ID, then required gate, then reason. Structurally invalid input fails closed with `ready: false`. Malformed runtime entity shapes and duplicate Subtask records also fail closed; because the approved validation-code taxonomy covers dependency-graph structure rather than malformed runtime records, those boundary failures return empty validation diagnostics instead of exposing parser errors or inventing a new public code.

## Persistence and migration

The storage schema persists Subtask maturity plus dependency required gate and reason, with SQLite checks for supported enums, legal type/gate combinations, and basic reason bounds. Public reads revalidate the strict domain contract and canonical stored values.

The forward migration assigns every legacy Subtask `NOT_STARTED`, regardless of board status. Legacy blocking dependencies become `BLOCKING + ACCEPTED` with `Legacy BLOCKING dependency migrated without a recorded reason.` Legacy informational dependencies become `INFORMATIONAL + NONE` with `Legacy INFORMATIONAL dependency migrated without a recorded reason.` No historical intent is invented.

## Deferred

S1B and later slices own evidence-gated lifecycle and maturity mutation, ready/blocked orchestration, scheduling, concurrency enforcement, `WHEN_READY` execution, worktrees, Codex threads, execution persistence, Context Packet compilation, automatic audit emission, UI/daemon work, and deployment.
