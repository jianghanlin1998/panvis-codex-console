# S1B2a durable implementation completion

`IN_PROGRESS` is the human/workflow stage in which implementation is actively underway. `IMPLEMENTED` is a separate quality-maturity value meaning the initial implementation has completed sufficiently to enter QA/debug.

S1B2a adds one atomic durable operation:

`IN_PROGRESS + NOT_STARTED -> QA_DEBUG + IMPLEMENTED`

`TaskStorage.completeSubtaskImplementation(...)` supports only that initial completion boundary. It reuses the accepted S1A status and maturity validators and requires an immutable `SubtaskImplementationCheckpoint` in the same transaction. The checkpoint binds the exact Subtask to an exact 40- or 64-character lowercase hexadecimal repository commit SHA, closed actor type, optional actor reference, source reference, compact summary, and canonical occurred-at timestamp. Failed or repeated completion writes neither partial checkpoint evidence nor partial Subtask state.

Checkpoint reads provide exact ID lookup and deterministic per-Subtask listing ordered by occurred-at and checkpoint ID. Relevant stored evidence and its exact Subtask-to-Big-Task-to-Project hierarchy must remain canonical. There is no public checkpoint update, delete, or standalone append operation.

At the initial completion boundary, checkpoint evidence whose durable `subtask_id` canonicalizes through the Subtask ID domain schema to the target but is stored noncanonically is target-relevant malformed evidence. Target listing and initial completion fail closed rather than ignoring that evidence. This does not establish global checkpoint uniqueness or define repair/re-entry behavior.

Status and maturity remain separate concepts generally. This operation does not consult dependency readiness because finishing already-running implementation is not a start decision. It does not emit an Audit Event automatically.

TODO-to-IN_PROGRESS start orchestration, QA_DEBUG-to-IN_PROGRESS repair/re-entry, re-completion, maturity demotion, IMPLEMENTED-to-HARDENED, HARDENED-to-ACCEPTED, hardening or independent-QA evidence, scheduling, worktrees, Codex threads or execution, Context Engine behavior, UI/daemon work, and automatic Audit Event emission remain deferred.
