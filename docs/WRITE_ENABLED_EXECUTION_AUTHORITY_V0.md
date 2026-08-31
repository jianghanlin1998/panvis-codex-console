# Write-Enabled Execution Authority Binding V0

Status: IMPLEMENTED. Deterministic baseline coverage passes; Comprehensive Hardening and Fresh Independent QA remain pending. This contract does not mark Step 5B accepted.

## Trusted authority chain

The public `executeSingleSubtaskOwnedWorktreeCodex(storage, subtaskId)` operation accepts only `TaskStorage` and a canonical Subtask ID. It fixes the execution role to `STANDARD_SUBTASK_EXECUTION`, invokes Execution Input Preflight itself, and passes the approved preflight text unchanged. Callers cannot supply a worktree path, ownership record, branch, sandbox, writable root, network policy, provider identity, executable, environment, or override.

The operation calls the accepted `resolveActiveOwnedWorktreeForSubtask` producer. Resolution proves the canonical task hierarchy, one exact durable `ACTIVE` ownership, its physical checkout generation, branch, path, common repository, and current HEAD. The same ownership generation and pre-turn HEAD are revalidated immediately before App Server spawn, before `thread/start`, and before `turn/start`. Missing, terminal, provisioning, releasing, replaced, or drifted authority fails closed. Provisioning and release remain separate deterministic operations.

## App Server write policy

The Console-owned, exact tested `codex-cli 0.148.0-alpha.9` runtime and the expanded accepted C-lite contract are required before execution. App Server runs with the exact trusted owned worktree as its process cwd. A separate private disposable OS-temporary directory supplies transient process state and is the only directory removed during cleanup.

`thread/start` binds the exact cwd, `sandbox: "workspace-write"`, `approvalPolicy: "never"`, `approvalsReviewer: "user"`, and an ephemeral thread. `turn/start` repeats the exact cwd and approval policy and sends `{ type: "workspaceWrite", writableRoots: [exactOwnedWorktree], networkAccess: false }`. No additional writable root is added. HOME and optional CODEX_HOME keep the accepted local authentication/config boundary; neither is granted as a writable root.

Command-execution and file-change item lifecycles are allowed only on this write path and are checked against the generated stable item shapes. The accepted read-only entrypoint keeps rejecting the same items as `TOOL_ACTION_ATTEMPTED`. Command and file approval requests are declined and fail execution; unknown authority-bearing requests, malformed events, identity mismatches, post-terminal events, protocol corruption, and bounded-output violations remain fail-closed.

## Durable accounting and seams

Each attempt creates one Console-owned `ChatThread` and one `ExecutionRun` through the accepted `TaskStorage` APIs. The provider thread is bound immediately after `thread/start`; the provider turn and model are bound by the `CREATED -> RUNNING` transition immediately after `turn/start`. Completed, failed, and interrupted provider outcomes map to `SUCCEEDED`, `FAILED`, and `INTERRUPTED`. Normalized usage is persisted; prompt/context text, response text, JSONL, stderr, commands, file changes, diffs, environment, and credentials are not.

SQLite, App Server, and filesystem writes are not atomic. A provider thread can exist before its durable thread binding, a provider turn can begin before durable RUNNING binding, and provider completion can precede the terminal durable transition. A RUNNING-bind failure attempts at most one bounded interrupt, returns failure, and never starts a second turn. A terminal-persistence failure returns failure and leaves the exact persisted state for later diagnosis. Semantic and transport retry count is zero.

## Lifecycle and limitations

Successful and failed executions preserve owned worktree edits and leave independently valid ownership `ACTIVE`. Execution never releases, deletes, resets, cleans, commits, pushes, merges, rebases, or cherry-picks the worktree. It never substitutes the source checkout and never deletes the owned checkout during cleanup.

This remains the accepted local single-user V1 read-isolation boundary: write confinement is exact, but no stronger OS-level same-user read sandbox is claimed. Automatic provisioning/release, maturity orchestration, retry scheduling, checkpoints, daemon/API/UI work, provider-thread resume, and real-target dogfood are out of scope.
