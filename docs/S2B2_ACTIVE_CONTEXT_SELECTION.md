# S2B2 Active Context Item selection

S2B2 adds one read-only active view over the accepted S2B1 allowed raw Context Item snapshot. `readAllowedRawContextItemsForSubtask` continues to return every valid status, while `readActiveContextItemsForSubtask` returns only items whose status is `ACTIVE`. `PROPOSED`, `SUPERSEDED`, `REJECTED`, and `RESOLVED` items remain durable raw evidence and are not modified or deleted.

The active view preserves the accepted `AllowedContextSet` and exactly three ordered buckets: the target Project, its parent Big Task, and the target Subtask. Sibling Subtasks, unrelated Big Tasks, and foreign Projects remain outside the boundary. Items within each bucket remain ordered by `effectiveAt` ascending and Context Item ID ascending, and empty buckets are retained.

S2B2 derives its result only after S2B1 has retrieved and validated the complete allowed raw snapshot. Malformed relevant evidence therefore fails closed even when its status would exclude it from the active view. Alias, linked-history, hierarchy, canonicality, corruption-isolation, coherent-snapshot, and caller-owned transaction semantics remain those of S2B1.

Multiple `ACTIVE` items are all returned. S2B2 does not rank by authority, kind, time, source, or semantic judgment and does not resolve conflicts or select final truth. The operation writes no Context Item, status, timestamp, Audit Event, cache, materialized result, or lifecycle state.

Promoted Context, Context Digest injection, Context Packets, prompt compilation, token budgets, search/RAG, lifecycle execution, UI, provider changes, and deployment remain deferred.
