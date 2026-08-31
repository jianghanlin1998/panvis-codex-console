# Write-Enabled Execution Authority Binding V0

Status: HARDENED. Fresh Independent QA on `a7931b31f85e66b282a4288ff7ecfd3bef3b6564` historically failed with `CTC-WRITE-FQA-001`, `CTC-WRITE-FQA-002`, and `CTC-WRITE-FQA-003`. All three findings are repaired in the repository state that includes this document, but Focused Fresh Re-QA and explicit acceptance remain pending; Step 5B is not accepted.

## Trusted authority chain

The public `executeSingleSubtaskOwnedWorktreeCodex(storage, subtaskId)` operation accepts only `TaskStorage` and a canonical Subtask ID. It fixes the execution role to `STANDARD_SUBTASK_EXECUTION`, invokes Execution Input Preflight itself, and passes the approved preflight text unchanged. Callers cannot supply a worktree path, ownership record, branch, sandbox, writable root, network policy, provider identity, executable, environment, or override.

The operation calls the accepted `resolveActiveOwnedWorktreeForSubtask` producer. Resolution proves the canonical task hierarchy, one exact durable `ACTIVE` ownership, its physical checkout generation, branch, path, common repository, and current HEAD. The same ownership ID, physical generation, path, branch, source/common-repository identity, and starting HEAD are revalidated before App Server spawn, immediately before `turn/start`, and after provider terminal evidence before durable success. Ordinary dirty edits inside the same owned generation are allowed. Missing, terminal, provisioning, releasing, replaced, retargeted, wrong-branch, wrong-HEAD, or otherwise drifted authority fails closed.

Deterministic Subtask lifecycle and dependency readiness are also execution authority. `STANDARD_SUBTASK_EXECUTION` requires the canonical target Subtask to remain exactly `IN_PROGRESS`; `TODO`, `QA_DEBUG`, `DONE`, `DROPPED`, and `ARCHIVED` do not authorize this V0 primitive. The Console uses `TaskStorage.evaluateStoredSubtaskDependencyReadiness` from the complete owning-Big-Task durable snapshot and accepts neither a caller-provided readiness boolean nor a cached result. Lifecycle and readiness are checked inside the primary reservation transaction, re-read together immediately before `turn/start`, and re-read again after provider terminal evidence before durable success. An ineligible reservation creates no attempt. Pre-turn loss of eligibility takes the legal pre-provider-start `FAILED/CLOSED` path. Post-turn loss of eligibility prevents `SUCCEEDED`, preserves edits, and terminalizes an already-`RUNNING` attempt as `FAILED/CLOSED`.

## Hardlink-free V1 write precondition

`workspaceWrite` alone does not confine writes through an existing hardlink: the exact-runtime no-model probe proved that writing a worktree alias can change an outside sentinel that shares its inode. V1 therefore grants provider write authority only when every regular file reachable below the owned worktree without following symbolic links has link count exactly one.

The Console scans before durable reservation, immediately before `turn/start`, and again after a completed provider turn before durable success. Traversal opens directories and regular files with no-follow semantics, compares path and descriptor device/inode/mode evidence, requires stable link count/size/mtime/ctime observations, skips symbolic links rather than following them, and fails closed on disappearance, replacement, malformed state, or ambiguity. It never repairs, copies, unlinks, or normalizes files. A pre-existing external alias and multiple links entirely inside the worktree are both rejected. A hardlink introduced during or after the turn prevents durable success, although V1 cannot claim that a concurrent same-user actor was unable to race the provider before the final scan.

## App Server write and tool policy

The Console-owned exact `codex-cli 0.148.0-alpha.9` runtime and accepted C-lite gate are required. App Server runs with the exact trusted owned worktree as cwd. A separate private OS-temporary directory supplies transient process state and is the only directory removed during cleanup.

`thread/start` binds the exact cwd, `sandbox: "workspace-write"`, `approvalPolicy: "never"`, `approvalsReviewer: "user"`, and an ephemeral thread. `turn/start` repeats the exact cwd and approval policy and sends `{ type: "workspaceWrite", writableRoots: [exactOwnedWorktree], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: false }`. Thus the exact worktree and Console-private `TMPDIR` are writable; arbitrary `/tmp`, the source checkout, sibling/parent directories, other worktrees, HOME, CODEX_HOME, the Git common directory, absolute/traversal/symlink escapes, background descendants, and loopback network are not.

The write App Server starts with strict config, web search disabled, orchestrator MCP disabled, and apps, browser/computer use, hooks, image generation, multi-agent, plugin, remote-control, tool-suggestion, and workspace-dependency features disabled. The production client sends no MCP, plugin, hook, app, browser, or computer-use request. An exact-runtime synthetic configured-MCP sentinel was not launched by the production initialization/command sequence. A deliberately issued `mcpServerStatus/list` request can still start a configured MCP server, so that API remains outside the write execution protocol and is never exposed by this entrypoint.

Command-execution and file-change events require bounded, correlated `item/started -> zero or more matching output/patch notifications -> item/completed` lifecycles. IDs are unique and type-stable; duplicate, missing, late, mismatched, terminal-status, in-progress-completion, malformed action/change, active-at-terminal, post-terminal, and over-cardinality sequences fail closed. Provider-reported command cwd must be an existing real directory inside the worktree. File-change and move paths must be relative, component-safe, and resolve through real in-worktree ancestors; absolute, traversal, symlink, replacement, or directory-target paths are rejected. Approval requests are declined and fail execution. The accepted read-only entrypoint still rejects write-tool activity.

## Durable accounting and lifecycle

One SQLite `BEGIN IMMEDIATE` reservation atomically verifies the canonical target exists, is exactly `IN_PROGRESS`, has valid ready stored dependencies, has exact `ACTIVE` ownership, excludes any `CREATED` or `RUNNING` execution for the Subtask across ChatThreads and processes, and creates one `OPEN` ChatThread plus one `CREATED` ExecutionRun. No process-local mutex is used and different Subtasks remain independent. A release transition checks the same active-execution state in its transaction: reservation-winning release fails, and release-winning reservation fails. Crash residue remains authoritative after reopen; it is never auto-healed.

The provider thread is bound after `thread/start`; the provider turn/model is bound by `CREATED -> RUNNING` after `turn/start`. Successful transmission of `turn/start` is the conservative provider-start boundary. Before that send, a reserved attempt that fails takes the legal pre-start `CREATED -> FAILED` transition and closes its thread. After that send, provider execution may have begun even if the response, provider run ID, tool activity, or terminal event has not arrived. A later RUNNING-bind failure therefore preserves truthful unresolved `CREATED + OPEN` history, including any durable provider-thread binding, without fabricating a provider run, `startedAt`, model, or usage. It attempts at most one bounded interrupt when possible, never retries, preserves edits, and keeps later same-Subtask primary reservation blocked across reopen. Future operator/recovery work must resolve that seam; this V0 performs no automatic repair.

Once RUNNING is durably bound, completed, failed, and interrupted outcomes map to `SUCCEEDED`, `FAILED`, and `INTERRUPTED`. One atomic finalization terminalizes the ExecutionRun and closes its one-attempt ChatThread. If atomic finalization fails, both records remain at their truthful prior `RUNNING/OPEN` seam for diagnosis.

Protocol shutdown and transient cleanup finish before authority revalidation and durable finalization. A post-turn authority or hardlink failure overrides cosmetic cleanup failure; terminal persistence failure overrides earlier outcome classification. Cleanup cannot produce success. Normalized usage is persisted; prompt/context text, response text, JSONL, stderr, commands, file changes, diffs, environment, and credentials are not.

## Hardening findings and limitations

- `CTC-WRITE-HARD-001`: CLOSED — raw hardlink write escape is gated by conservative no-follow link-count scans.
- `CTC-WRITE-HARD-002`: CLOSED — one primary active execution is reserved atomically across processes.
- `CTC-WRITE-HARD-003`: CLOSED — thread/run creation and terminalization are atomic per attempt.
- `CTC-WRITE-HARD-004`: CLOSED — post-turn ownership, generation, HEAD, and hardlink gates deny stale success.
- `CTC-WRITE-HARD-005`: CLOSED — worktree release and execution reservation exclude each other transactionally.
- `CTC-WRITE-HARD-006`: CLOSED — exact temporary-directory policy is explicit and compatibility-gated.
- `CTC-WRITE-HARD-007`: CLOSED — ephemeral ChatThreads close on every durable terminal attempt.
- `CTC-WRITE-HARD-008`: CLOSED — write-tool lifecycles and provider paths are correlated, bounded, and filesystem-aware.

Successful and failed executions preserve owned worktree edits and independently valid ownership `ACTIVE`. Execution never releases, deletes, resets, cleans, commits, pushes, merges, rebases, or cherry-picks the worktree. It never substitutes the source checkout and never deletes the owned checkout during cleanup.

This remains a local single-user V1 boundary. It does not provide OS-enforced same-user read confinement or defend against a malicious same-user principal that can coherently rewrite Console storage and authority files. Automatic provisioning/release, unresolved-attempt recovery, crash repair, maturity orchestration, retry scheduling, checkpoints, daemon/API/UI work, provider-thread resume, real-target dogfood, Focused Fresh Re-QA, and Step 5B acceptance remain out of scope or pending.
