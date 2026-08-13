# S2B1 Allowed raw Context Item retrieval

S2B1 adds one read-only storage boundary for a durable target Subtask. It resolves and canonically validates the target Subtask, owning Big Task, and owning Project, then passes that evidence through the accepted S2A `buildAllowedContextSet` contract **before** issuing any Context Item query.

The resulting snapshot contains the `AllowedContextSet` and exactly three buckets in canonical ACL order:

1. the target Project exact scope;
2. the target parent Big Task exact scope;
3. the target exact Subtask scope.

Each bucket retains its exact `ContextScope` and raw Context Items ordered by `effectiveAt` ascending and Context Item ID ascending. Bucket order expresses the ACL hierarchy only; it does not rank items across scopes.

All hierarchy, scope-bucket, Context Item, and linked supersession-history reads share one short deferred SQLite read snapshot. An existing synchronous caller transaction is reused without nesting, commit, or rollback ownership changes.

Retrieval is raw: every valid item at an allowed scope is returned regardless of status, kind, authority, or source type. Sibling Subtasks, other Big Tasks, other Projects, and dependency-related Subtasks are never queried as candidate raw scopes. Relevant malformed durable evidence fails closed as sanitized malformed stored data, while malformed evidence outside the three exact scopes remains isolated.

The operation writes no application rows, timestamps, Audit Events, cache, materialized result, or retrieval artifact. Current-context selection, status filtering, ranking, conflict resolution, Digest injection, Promoted Context, search/RAG, Context Packets, prompt compilation, token budgets, and lifecycle preflight remain deferred.
