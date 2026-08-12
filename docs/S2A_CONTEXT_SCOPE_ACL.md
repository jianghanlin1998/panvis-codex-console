# S2A Context Scope ACL

S2A establishes one pure deterministic access boundary for raw durable context scope. It does not retrieve, rank, compile, or inject context.

`buildAllowedContextSet(project, bigTask, subtask)` accepts the existing strict domain entities as ownership evidence. It produces no set unless the evidence proves the exact hierarchy `Project -> Big Task -> Subtask`. Malformed, noncanonical, or mismatched evidence fails closed with stable validation codes.

For one valid target Subtask, `AllowedContextSet.allowedRawScopes` is always ordered as:

1. the target Project scope;
2. the target parent Big Task scope in that Project;
3. the target exact Subtask scope in that Big Task and Project.

`evaluateContextScopeAccess(allowedContextSet, candidateScope)` returns an inspectable allow/deny decision. It allows only those three exact scopes. Sibling Subtasks, unrelated Big Tasks in the same Project, Subtasks under unrelated Big Tasks, and every scope in another Project are denied. Malformed, noncanonical, unknown, or corrupt runtime inputs are denied by default. The canonical set and its nested values are immutable.

Task dependencies do not expand this ACL. Blocking, informational, upstream, downstream, and unrelated dependency evidence never grants raw Subtask scope. Future accepted Promoted Context may carry compact conclusions across a separate contract; it is not raw-scope access and is not implemented here.

Scope access is independent of Context Item status, Subtask status, maturity, retrieval history, and injection policy. A scope being accessible does not mean any item from it will be injected.

Storage-backed retrieval, search, embeddings, RAG, Context Packets, prompt compilation, status and supersession selection, ranking, conflict resolution, raw-history budgets, token allocation, Promoted Context, lifecycle preflight persistence, UI/daemon work, provider changes, and deployment remain deferred.
