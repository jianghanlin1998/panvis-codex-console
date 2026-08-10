---
name: task-execution
description: Execute an approved repository Task Contract with scoped implementation, deterministic verification, reconciliation, and a structured Handoff. Use when explicitly invoked for an authorized engineering task; do not use for planning-only, review-only, or unapproved product or architecture decisions.
---

# Execute a Task Contract

1. Read the supplied Task Contract and repository instructions. Before any Node-dependent install, baseline, or test command, inspect `command -v node`, `node --version` when available, `command -v pnpm`, and `pnpm --version` when available. If the direct runtime is missing or incompatible, source `scripts/runtime-preflight.sh` once in the task shell, re-run those four checks, and stop with a concise environment blocker if the declared repository versions still cannot be established. A missing direct runtime is an environment preflight condition, not a repository test failure; do not repeatedly rediscover the runtime during the task.
2. Read current repository truth. Verify the repository root, branch, HEAD, remotes, and worktree state before editing. Reconcile current main when applicable without discarding legitimate work.
3. Treat explicit scope and untouched areas as hard boundaries. Make the smallest safe change, preserve public contracts unless authorized, and do not invent product or architecture decisions.
4. Stop only for a real product, architecture, security, privacy, ownership, scope, or unresolved environment blocker that available evidence cannot resolve.
5. Implement with deterministic tests. Never weaken, delete, skip, or bypass meaningful tests to obtain a pass. Never expose secrets, sensitive user data, or raw provider and internal errors.
6. Run the Task Contract's focused and full verification, including `git diff --check`. Summarize successful logs instead of pasting them; investigate failures at their root cause.
7. Update `CURRENT_STATE.md` when a write-enabled task changes operational state, keeping it compact and limited to verified facts.
8. Produce the required structured Handoff with repository and commit state, planned versus actual scope, changed files, behavior, exact verification results, push or deployment status, remaining risks, and rollback or activation instructions when applicable.
