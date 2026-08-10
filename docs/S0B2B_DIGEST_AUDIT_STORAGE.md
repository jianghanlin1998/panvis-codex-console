# S0B2b Context Digest and Audit Event storage

S0B2b adds two exact-scope persistence primitives. It remains domain and storage foundation code, not an operational Context Engine or audit integration.

## Context Digests

A Context Digest is compact derived current state for one exact Project, Big Task, or Subtask scope. Context Items remain the authoritative facts, decisions, requirements, constraints, questions, and risks. A Digest does not replace that evidence.

Each exact scope has at most one current Digest. The stable Digest identity remains attached to that scope; replacement changes only its trimmed body and digest-specific provenance, preserves storage creation time, and updates storage modification time atomically. S0B2b has no Digest history or supersession graph, automatic generation, LLM summarization, inheritance, or Context Packet compilation.

Digest bodies contain 1–8,000 JavaScript UTF-16 code units. Source references contain 1–2,048. Accepted timestamps are offset-aware and normalized to canonical UTC ISO values. Values are rejected rather than truncated.

## Audit Events

Audit Events are immutable append-only records supplied explicitly by callers. Each event has a stable extensible uppercase event-type slug, a closed `HUMAN` / `CODEX` / `SYSTEM` actor type, compact optional actor and subject references, a compact summary, an offset-aware occurrence time normalized to UTC, and one exact durable scope.

S0B2b provides no public Audit Event update or delete, global search, filters, pagination, retention policy, arbitrary metadata, or automatic event emission. Existing Project, Big Task, Subtask, dependency, and Context Item operations were not changed to append events.

## Persistence integrity

The forward migration adds only `context_digests` and `audit_events`. Foreign keys use restrictive deletes, scope-shape checks reject a Subtask without its Big Task, partial unique indexes enforce one Digest for Project, Big Task, and Subtask scopes despite SQLite `NULL` uniqueness semantics, and bounded checks protect compact fields. Audit listing is ordered by occurrence time and Audit Event ID.

Every public read reconstructs the strict domain object, requires stored values to already be canonical, and verifies the complete Project-to-Big-Task-to-Subtask ownership hierarchy. Stored structural, canonical, or hierarchy corruption fails closed as sanitized `MALFORMED_STORED_DATA`. Caller-provided missing or mismatched hierarchy follows the existing sanitized parent-not-found contract.

## Deferred work

Digest generation and history, semantic retrieval, Context Packets, inheritance, ACL evaluation, Promoted Context, search/FTS, artifacts and Handoffs, automatic audit emission, event subscribers, execution persistence, live Codex integration, worktrees, UI/daemon work, provider expansion, and deployment remain deferred.
