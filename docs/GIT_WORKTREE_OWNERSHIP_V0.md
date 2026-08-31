# Git Worktree Ownership & Provisioning V0

Status: HARDENED. Comprehensive Hardening passed. Fresh Independent QA on `b551278ad89a474c952afd4befef81fbee5337d0` failed on CTC-WORKTREE-FQA-001; the finding is repaired and Focused Fresh Re-QA remains pending. This contract establishes worktree ownership only; it does not authorize write-enabled Codex execution.

## Authority and identity

Provisioning accepts one canonical Subtask ID. The Console resolves its Big Task, Project, and repository from `TaskStorage`; caller-supplied Project, repository, path, branch, starting SHA, concurrency override, and force inputs have no authority. Only a durable `PATH` repository is eligible. `REFERENCE` is rejected without cloning, fetching, or translating it.

The configured source path is resolved to its canonical real path and must be the exact local Git worktree root. Stable filesystem identity, the exact committed local `HEAD`, and the Git common-directory identity are observed around critical probes. A dirty source checkout is allowed: its tracked and untracked changes remain untouched and are not copied. The owned worktree starts from the exact committed source `HEAD` observed during provisioning.

Each owned generation also installs an owner-private Console marker inside that linked worktree's Git administrative directory. The marker binds the durable ownership ID and starting SHA to the observed source-root and common-repository filesystem identities and the pre-activation source HEAD reference. A separate SQLite authority row retains the original Git-administrative-directory and marker filesystem identities as canonical decimal `(device, inode, birthtime-nanoseconds)` tuples. The row is written while ownership is still `PROVISIONING`, is re-read before activation, and is checked whenever nonterminal checkout identity is required.

ACTIVE resolution therefore requires the administrative directory and marker to be the originally provisioned physical generation, not merely equal-shaped files at the same paths. Normal close/reopen, coding edits, staging, untracked files, and commits do not replace either authority object, so they preserve ownership. Normal `git worktree remove` removes the checkout and its Git-administrative marker; the SQLite generation row remains immutable terminal history. Recreating the same path, branch, common repository, and HEAD produces different physical identities, so copying the exact old marker bytes cannot restore authority. Replacing or recreating the marker inside the legitimate checkout also fails closed.

The forward migration deliberately creates no generation rows for pre-repair history. A legacy `PROVISIONING`, `ACTIVE`, or existing `RELEASING` checkout without independently retained generation evidence is insufficient and fails closed; no marker is auto-adopted and no identity is synthesized. `RELEASED` and `FAILED` history remains readable because terminal history grants no checkout authority.

Each generation receives a production-generated `wt_<32 lowercase hex>` ID. The dedicated persistent production root is:

`~/Library/Application Support/Codex Task Console/worktrees/`

The root must be a private, owner-only, non-symlink directory. The generated path is the strict root child named by the ownership ID, and the branch is `ctc/worktree/<ownership-id>`. Existing path, symlink, registered-worktree, durable identity, or branch collisions fail closed and are never adopted, overwritten, reset, or force-cleaned.

Provisioning may create the Console-owned root. ACTIVE resolution, release, and reconciliation only verify an existing root; they never recreate missing authority state. Durable ownership readback requires canonical IDs, canonical UTC millisecond timestamps, canonical absolute paths, derived root/ID path equality, the ID-derived branch, lowercase SHAs, coherent lifecycle fields, and the canonical Project/Subtask hierarchy. Corrupt terminal history is not skipped or normalized.

## Durable lifecycle

`WorktreeOwnership` stores the immutable Project/Subtask ownership, generated ID/path/branch, starting commit, optional release HEAD, and lifecycle timestamps.

The statuses and normal transitions are:

`PROVISIONING -> ACTIVE -> RELEASING -> RELEASED`

`PROVISIONING -> FAILED`

`PROVISIONING`, `ACTIVE`, and `RELEASING` consume the Project's existing `maxActiveCodingSubtasks` capacity. `RELEASED` and `FAILED` are terminal and release the slot. SQLite transactionally enforces one non-terminal ownership per Subtask; the reservation transaction also revalidates the canonical hierarchy and counts Project slots. Terminal history remains durable and is listed by creation time and ID.

Provisioning durably reserves `PROVISIONING` before `git worktree add`. After Git creates and verifies the exact checkout, the Console creates the marker, observes the physical Git-admin/marker generation, durably inserts that independent evidence, revalidates it, and only then transitions to `ACTIVE`. Evidence-install or persistence failure leaves an existing checkout `PROVISIONING` and recovery-required; activation itself also requires a durable evidence row. Returned records are detached and recursively frozen.

## Trusted ACTIVE resolver

`resolveActiveOwnedWorktreeForSubtask(subtaskId)` is the direct trusted producer boundary for a future write-authority binding. It reloads canonical task ownership and durable `ACTIVE` state, then revalidates the exact derived path, filesystem identity, Git registration, common repository, and stored branch. It returns current HEAD as runtime evidence; current HEAD may advance through later commits. Missing, moved, replaced, retargeted, wrong-repository, and wrong-branch states fail closed without changing durable ownership.

A path string, branch string, deserialized record, or equal-shaped object is data only and confers no authority. Step 5B must call this resolver directly.

## Release and recovery

Release requires an exact `ACTIVE` worktree with no tracked, untracked, or unmerged changes. It captures the exact current HEAD, durably transitions to `RELEASING`, revalidates the clean worktree, uses normal non-force `git worktree remove`, verifies that the checkout is absent and unregistered, and verifies that the retained branch still points to `releaseHeadSha` before finalizing `RELEASED`. The branch and commits are preserved. Dirty release fails before the durable transition; a post-transition failure preserves `RELEASING`.

Reconciliation is deliberately bounded because SQLite and Git cannot share one atomic transaction:

- An exact pending `PROVISIONING` worktree at the reserved path, branch, starting HEAD, common repository, checkout-generation marker, unchanged source checkout, and matching previously persisted physical-generation evidence may become `ACTIVE`.
- A pending reservation with both path and registration proven absent becomes `FAILED`; a leftover generated branch is retained.
- A `RELEASING` record becomes `RELEASED` only when the checkout is absent/unregistered and the retained branch matches the durable release HEAD.
- An existing exact `RELEASING` worktree remains pending; ordinary reconciliation does not pretend removal completed.
- `ACTIVE` is validated but never auto-repaired. Terminal records are never resurrected.
- Wrong, partial, inconsistent, or ambiguous state is preserved and requires repair intervention; no unexpected artifact is adopted or deleted.

When a post-reservation failure proves both the generated path and registration absent, the reservation becomes terminal `FAILED`, releases its slot, and reports a Git operation failure rather than claiming reconciliation is required. Any partial or ambiguous external evidence preserves `PROVISIONING` and reports recovery required.

## Git and security boundary

Git is invoked only through fixed argument-vector operations with `shell: false`, bounded time/output, disabled prompting and paging, case-insensitive removal of inherited `GIT_*` variables, excluded system/global configuration, and neutralized hooks. Mutating commands are limited to new-branch worktree add and non-force worktree remove. V0 performs no fetch, pull, push, merge, rebase, reset, prune, branch deletion, arbitrary shell, or generic Git passthrough. Public failures do not include absolute paths, Git stderr, environment values, credentials, or command output.

This is a local same-user V1 ownership boundary, not an adversarial-repository OS sandbox. The generation tuple is physical identity evidence for the supported macOS V1 behavior, not a universal or cryptographic filesystem identity. It closes ordinary stale-marker replay because the old marker bytes do not carry the independently retained SQLite tuple. A malicious same-user principal able to coherently rewrite the Console database and every authority file remains outside this boundary. V1 does not provide OS-level same-user read confinement. It grants no App Server `workspaceWrite`, writable-root serialization, provider run integration, orchestration, or execution write authority. Live Execution V0 remains read-only and continues using its disposable temporary workspace.

V0 invokes the ambient `git` executable selected by the Console process PATH. Git binary provenance is not promoted into a new runtime-ownership policy by this contract; inherited `GIT_*` control variables, global/system configuration, prompting, paging, and hooks remain neutralized for each operation.

## Next maturity gate

The next task is a new-chat Focused Fresh Re-QA for CTC-WORKTREE-FQA-001, followed by explicit acceptance. Write-Enabled Execution Authority Binding V0 (roadmap Step 5B) remains out of scope until this ownership foundation is accepted.
