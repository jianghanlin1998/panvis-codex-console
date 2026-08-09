# S0B2a Context Item and supersession storage

S0B2a persists compact authoritative Context Items at one exact durable scope. Context Items are facts, decisions, requirements, constraints, questions, and risks; they are not raw chats, transcripts, reports, logs, diffs, or artifacts.

## Compact domain contract

- Titles are trimmed, non-empty, and at most 256 characters.
- Bodies are trimmed, non-empty, and at most 4,000 characters.
- Provenance source references are trimmed, non-empty, and at most 2,048 characters.
- Oversized values are rejected without truncation.
- Existing kind, status, authority, and source-type enums remain unchanged.

`ContextScope` is a closed discriminated union:

- `PROJECT` contains `projectId` only.
- `BIG_TASK` contains `projectId` and `bigTaskId`.
- `SUBTASK` contains `projectId`, `bigTaskId`, and `subtaskId`.

The flat `ContextItem` shape enforces the same hierarchy structurally, and a pure domain helper derives its exact scope. Storage validates that every referenced Project exists, every Big Task belongs to the claimed Project, and every Subtask belongs to the claimed Big Task before writing.

## Persistence and retrieval

The forward migration adds only `context_items`. It stores the Context Item identity, exact hierarchy, kind, status, authority, compact content, provenance, UTC-normalized effective time, optional supersession link, and deterministic UTC creation/update timestamps.

Database constraints protect foreign keys with `RESTRICT` deletes, accepted enums, compact field lengths, Subtask-to-Big-Task scope shape, self-supersession, and one replacement per prior item. Indexes cover hierarchy IDs, status, the unique supersession link, and effective-time/ID ordering.

`listContextItemsByScope` is exact-scope only. Project queries exclude all Big Task and Subtask rows; Big Task queries exclude Subtask rows; Subtask queries require the complete exact hierarchy. Results are ordered by `effectiveAt` ascending and Context Item ID ascending. No inheritance, ancestor merging, ACL evaluation, or semantic retrieval occurs.

## Atomic supersession

Direct creation rejects a supersession pointer. `supersedeContextItem` requires an `ACTIVE` replacement that points to one existing `ACTIVE` prior item at the identical exact scope. In one transaction it revalidates the prior item and hierarchy, inserts the replacement, and changes only the prior status and `updated_at` value.

Prior title, body, authority, provenance, effective time, and creation time remain immutable historical evidence. A prior item cannot branch to multiple replacements, non-active statuses cannot be superseded by this operation, and a later valid replacement can extend an A-to-B-to-C chain without deleting A or B. No public update or hard-delete Context Item operation exists.

## Deferred work

Context Digests, Context Packets, Audit Events, Promoted Context, Handoffs, FTS5, artifacts, raw transcripts, Decision/Roadmap persistence, provisioning, execution/provider persistence, Context Compiler behavior, inheritance, ACLs, retrieval, UI/daemon work, live Codex, worktrees, and deployment remain deferred.
