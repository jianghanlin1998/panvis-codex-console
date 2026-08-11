# S1B1 persisted readiness snapshot

S1B1 adds one storage-backed readiness read to the Task Control Plane foundation. It remains a derived, read-only query, not lifecycle orchestration.

`TaskStorage.evaluateStoredSubtaskDependencyReadiness(subtaskId)` accepts one strict canonical Subtask ID. It resolves that Subtask's owning Big Task, loads every canonical Subtask in that Big Task plus every dependency connected to that scope, and delegates final graph and gate semantics to the accepted S1A `evaluateSubtaskDependencyReadiness` function.

Owning-Big-Task completeness is structural, not target-local: disconnected same-Big-Task corruption fails closed even when it cannot change the target's direct blockers. Connected foreign endpoints are loaded only to prove the cross-Big-Task violation; foreign-to-foreign evidence remains outside the target scope. Stored Project, Big Task, Subtask, and dependency values must already be canonical and are never normalized or repaired by the read.

The complete read runs inside one short SQLite deferred transaction. The first read establishes one durable snapshot for target resolution, ownership, maturities, Subtasks, and dependencies; concurrent commits cannot produce a result assembled from different durable states. When called inside the existing synchronous storage transaction callback, the operation reuses that transaction instead of nesting another one.

Only the owning Big Task participates. Malformed relevant Subtask or dependency evidence, missing or cross-Big-Task endpoints, duplicate or self edges, and blocking cycles fail closed with sanitized `MALFORMED_STORED_DATA`. Corruption in an unrelated Big Task is not loaded or validated and cannot poison a valid result. A missing target uses `PARENT_NOT_FOUND`; invalid input and closed-database behavior retain the existing sanitized storage contracts.

Relevant endpoints are selected with durable SQL subqueries rather than a materialized bind-parameter list. The query therefore has a constant bind count as the owning graph grows and does not inherit SQLite's `MAX_VARIABLE_NUMBER` as an undeclared Subtask-count limit.

Readiness is not persisted or cached. The operation does not update status, maturity, dependencies, timestamps, or Audit Events and does not repair stored data. Maturity mutation, lifecycle orchestration, scheduling, `WHEN_READY` execution, concurrency control, evidence and checkpoint persistence, worktrees, Codex threads, execution persistence, Context Engine behavior, UI/daemon work, provider expansion, and deployment remain deferred.
