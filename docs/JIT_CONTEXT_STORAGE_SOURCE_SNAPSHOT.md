# JIT Context storage source snapshot

`TaskStorage.readJitContextSourceSnapshotForSubtask(subtaskId, profile)` is the
read-only durable-source boundary for one future JIT Context Packet assembly.
It always returns the canonical Project, Big Task, and target Subtask from one
coherent SQLite read snapshot.

The accepted profile vocabulary is reused exactly:

- `STANDARD_SUBTASK_EXECUTION` also returns the accepted `AllowedContextSet`
  and the Project-, Big-Task-, and Subtask-scope ACTIVE Context Items. The ACL
  is complete before the three exact-scope queries, and S2B1/S2B2 ordering,
  validation, isolation, and status-selection semantics are preserved.
- `FRESH_INDEPENDENT_QA` and `FOCUSED_RE_QA` return only the task hierarchy.
  Context Items are never queried for either QA profile, so generic ACTIVE or
  raw Context Item content does not cross the retrieval boundary.

The complete operation owns one read-snapshot boundary when called normally.
Inside an existing supported synchronous caller transaction it reuses that
transaction without nesting, committing, or rolling it back. The operation
performs no application write, timestamp update, Audit Event, cache, or
materialization. Returned values are detached from SQLite state and deeply
frozen against accidental post-read mutation.

Trust is operational, not structural: this snapshot is trusted as a storage
source only when consumed directly from this verified TaskStorage operation.
A caller can manually construct equal-shaped data; shape or type compatibility
does not prove database origin, ACL authorization, trusted classification, or
packet-injection authority. No trust marker, parser, signature, or capability
is exposed.

The caller supplies the profile. This method enforces that profile but does not
infer or authorize it from task lifecycle fields; trusted profile selection is
deferred to future orchestration. The method does not compile a
`JitContextPacket`. Project rules, repository/runtime evidence, QA
instructions, retest targets, Promoted Context, Digests, raw history, token
budgets, provider serialization, and execution remain separate future sources
or layers.
