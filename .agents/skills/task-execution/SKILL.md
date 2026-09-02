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

## Known mechanical environment normalization

Classify a failure as `KNOWN_MECHANICAL_ENVIRONMENT` only when it exactly matches one of the cases below and the stated evidence excludes a repository or product cause. Unknown or ambiguous failures are `REPOSITORY_OR_PRODUCT_FAILURE`. Each mechanical class permits at most one automatic correction per task; never repeat an unchanged recovery loop. If that correction fails or the same class needs another correction, stop as an unresolved environment blocker unless the Task Contract explicitly grants a different bounded policy.

### Authorized Git metadata write

When an already-authorized ordinary fetch, reconciliation, checkout, commit, or push operation against the approved current repository first fails specifically because the sandbox denies repository-metadata writes, retry the same operation once with the available repository-write permission mechanism. Do so only when there is no evidence of corruption, conflict, unexpected remote movement, ownership mismatch, or a destructive operation. Never force-push, destructively reset, discard work, retry a Git semantic error, or treat divergence or a merge conflict as a sandbox failure.

### Workspace-link / pnpm refresh

After an approved intentional package or workspace manifest change, first establish that a Node command failed because local workspace links or `node_modules` metadata need refresh, rather than because of a source, type, or build assertion. Perform at most one smallest repository-supported non-interactive offline refresh using the existing pnpm store, without contacting the network or downloading dependencies unless the Task Contract separately authorizes them. After a successful refresh, rerun only the affected verification command. Stop if the offline store is insufficient, lockfile or package state is unexpectedly inconsistent, or another refresh would be needed. `scripts/runtime-preflight.sh` remains authoritative; do not rediscover or reinstall the runtime during this correction.

### Loopback-listener sandbox

When every failure in an affected test command occurs before meaningful assertions solely because the sandbox denied an intentionally required localhost or loopback listener (for example, `EPERM` or `LISTEN_FAILED`), preserve the tests and rerun the same command once with the required listener permission. Record both observations in the Handoff, and do not count the initial sandbox-only denial as a repository defect. This does not apply when an assertion failed, the listener bound before a later failure, the host is non-loopback, or access beyond the approved local listener is required.

### Host-load-only test timeout

When a full suite has only a bounded set of short timeout failures, the affected tests pass in focused isolation, no assertion or invariant failure reproduces, and evidence supports host load rather than code behavior, allow one controlled-worker rerun using the repository's supported direct runner form, such as `pnpm exec vitest run --maxWorkers=4`. Do not forward a stray literal `--` and do not rerun repeatedly until green. A repeated timeout class follows the Task Contract's blocker policy; any reproducible assertion or invariant failure is a real failure.

### Accounting and fail-closed boundary

Mechanical corrections consume neither production repair or re-QA cycles nor semantic or provider retry budgets; they do not change product maturity and are not product defects. Add an **Environment normalization** Handoff section listing each class used, its initial evidence, correction, attempt count, and final outcome.

Never normalize assertion or invariant failures; source-caused type, lint, or build errors; schema or migration failures; database corruption or integrity failures; dependency or readiness failures; Context ACL or budget failures; worktree ownership or hardlink-safety failures; provider protocol or model failures; security, privacy, or authority failures; unexpected Git divergence or conflict; dirty or unresolved repository state; or test-invalidity or ambiguous evidence. These remain fail-closed blockers or normal root-cause work.
