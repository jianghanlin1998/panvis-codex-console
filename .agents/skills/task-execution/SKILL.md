---
name: task-execution
description: Execute an approved repository Task Contract with scoped implementation, deterministic verification, reconciliation, and a structured Handoff. Use when explicitly invoked for an authorized engineering task; do not use for planning-only, review-only, or unapproved product or architecture decisions.
---

# Execute a Task Contract

1. Read the supplied Task Contract, repository instructions, and current repository truth. Verify the repository root, branch, HEAD, remotes, and worktree state before editing. Reconcile current main when applicable without discarding legitimate work.
2. Treat explicit scope and untouched areas as hard boundaries. Make the smallest safe change, preserve public contracts unless authorized, and do not invent product or architecture decisions.
3. Stop only for a real product, architecture, security, privacy, ownership, or scope blocker that available evidence cannot resolve.
4. Implement with deterministic tests. Never weaken, delete, skip, or bypass meaningful tests to obtain a pass. Never expose secrets, sensitive user data, or raw provider and internal errors.
5. Run the Task Contract's focused and full verification, including `git diff --check`. Summarize successful logs instead of pasting them; investigate failures at their root cause.
6. Produce the required structured Handoff with repository and commit state, planned versus actual scope, changed files, behavior, exact verification results, push or deployment status, remaining risks, and rollback or activation instructions when applicable.
