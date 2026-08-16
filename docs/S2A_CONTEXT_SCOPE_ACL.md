# S2A Context Scope ACL

S2A establishes one pure deterministic access boundary for raw durable context scope. It does not retrieve, rank, compile, or inject context.

`buildAllowedContextSet(project, bigTask, subtask)` accepts the existing strict domain entities as ownership evidence. It produces no set unless the evidence proves the exact hierarchy `Project -> Big Task -> Subtask`. Multi-input evidence is captured through repeated alternating forward/reverse joint structural sweeps, so independently repeatable inputs that relay mutually incompatible ownership states fail closed. Malformed structural shapes, noncanonical identity or ownership fields, and mismatched ownership fail closed with stable validation codes. Parser-normalizable non-access fields such as names, titles, repository references, scope text, and prompt seeds may be accepted because they do not participate in the ACL; valid canonical changes to those fields cannot change access.

For one valid target Subtask, `AllowedContextSet.allowedRawScopes` is always ordered as:

1. the target Project scope;
2. the target parent Big Task scope in that Project;
3. the target exact Subtask scope in that Big Task and Project.

`evaluateContextScopeAccess(allowedContextSet, candidateScope)` is a pure structural evaluator relative to the supplied set; it does not authenticate builder provenance or durable ownership. Its set and candidate evidence must also survive the shared alternating-order joint capture. A canonical structural copy, including a JSON round trip, is accepted. Any valid supplied set can contain only its own exact ordered three-scope hierarchy. Reordered, duplicated, widened, malformed, noncanonical, or cross-input inconsistent sets fail closed.

The evaluator allows only those three exact scopes. Sibling Subtasks, unrelated Big Tasks in the same Project, Subtasks under unrelated Big Tasks, and every scope in another Project are denied. Candidate scope IDs must already be canonical; parser normalization never turns a raw request into an allow. Malformed, inherited-field, unknown, corrupt, or hostile runtime inputs are denied by default without broadening access. The builder output and its nested values are immutable.

Task dependencies do not expand this ACL. Blocking, informational, upstream, downstream, and unrelated dependency evidence never grants raw Subtask scope. Future accepted Promoted Context may carry compact conclusions across a separate contract; it is not raw-scope access and is not implemented here.

Scope access is independent of Context Item status, Subtask status, maturity, retrieval history, and injection policy. A scope being accessible does not mean any item from it will be injected.

Storage-backed retrieval, search, embeddings, RAG, Context Packets, prompt compilation, status and supersession selection, ranking, conflict resolution, raw-history budgets, token allocation, Promoted Context, lifecycle preflight persistence, UI/daemon work, provider changes, and deployment remain deferred.
