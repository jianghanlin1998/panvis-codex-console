# Single-Subtask Live Codex App Server Execution V0

## Purpose and accepted gates

This slice provides one bounded in-memory Codex App Server execution for a
canonical Console Subtask. It depends on ACCEPTED Execution Input Preflight V0,
Console-Owned Codex Runtime Ownership V0, C-lite Compatibility Check V0, and
provider-neutral execution contracts. The exact runtime is the active owned
`codex-cli 0.148.0-alpha.9` release for `aarch64-apple-darwin`.

The implementation follows the official [Codex App Server
documentation](https://developers.openai.com/codex/app-server/) for stdio JSONL,
initialization, auth inspection, threads, turns, streaming, approvals, and
shutdown. Exact generated `.9` stable schemas remain authoritative for the
fields sent to this pinned runtime. No experimental API capability is enabled.

## Trusted execution authority

The public live entrypoint accepts only `TaskStorage`, a canonical `SubtaskId`,
and an already supported Operational Context profile. It invokes the existing
`ExecutionInputPreflight` itself. An allowed result supplies the one text input
unchanged, including whitespace and bytes. Caller-created text, packets,
measurements, or preflight-shaped data cannot enter the trusted operation.
`HARD_CAP_EXCEEDED` blocks before App Server startup.

Provider-specific process and protocol behavior remains in
`packages/codex-adapter`; the dependency direction is
`codex-adapter -> storage -> domain`. Storage and domain contracts remain
provider-neutral.

## Runtime, transport, and auth

The production path resolves `resolveActiveOwnedCodexRuntime()` and requires the
exact owned version and target. It directly spawns the canonical executable as
`app-server --listen stdio://` with no shell, ambient `codex`, PATH fallback,
development override, install, activation, rollback, or retry.

The child receives a fixed PATH, normal HOME, optional existing absolute
`CODEX_HOME`, a private temporary directory, and a small locale/system
allowlist. OpenAI keys and arbitrary key/token/secret/auth environment variables
are not propagated. Console code does not read credential contents.

Each connection sends one `initialize`, waits for its correlated response, and
sends one `initialized` notification. It then sends one private
`account/read { refreshToken: false }`. Only `account.type = "chatgpt"` may
continue. The result retains only the auth type and a bounded plan type; email,
account identifiers, tokens, auth URLs, and credential data are discarded. No
API-key fallback, login, logout, or credential persistence exists.

## Ephemeral read-only one-turn policy

The adapter creates a fresh private workspace beneath the canonical OS
temporary root. Exact `.9` stable fields require `ephemeral: true`,
`approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "read-only"` on `thread/start`. `turn/start` repeats the cwd and
approval policy and uses `{ type: "readOnly", networkAccess: false }`.

At most one `turn/start` is sent. Its only input item contains the exact
preflight text and an empty `text_elements` array. The adapter adds no model,
provider, skill, mention, image, file, base instruction, developer instruction,
dynamic tool, MCP, or experimental field.

Command and file approvals are always declined and fail execution. Any other
server request or any observed tool/action item fails closed. No file, command,
shell, process, or external authority is granted by this V0 path.

## Bounds, completion, and shutdown

Startup, requests, the turn, interrupt, and shutdown are time-bounded. JSONL
line bytes, pending requests, notifications, unknown notifications, accumulated
agent response bytes, and retained stderr bytes are bounded. Responses require
exact request-ID correlation; malformed JSON, duplicate or mismatched IDs,
oversized input, early exit, and disconnect fail with sanitized typed results.
Unknown notifications are ignored only within the event bound. Unknown server
requests never gain authority.

The adapter retains only bounded agent-message text and normalized usage. It
does not retain raw reasoning, stderr, protocol transcripts, provider metadata,
or environment content. A terminal `turn/completed` status is required. A turn
timeout may send at most one `turn/interrupt` when valid thread and turn IDs are
known; no real turn is automatically retried.

Normal shutdown closes stdin, waits a bounded grace period, then uses TERM and
KILL fallbacks if necessary. The disposable workspace is removed. Failure to
clean the child or workspace is reported without exposing raw process details.

## Persistence and next dependency

The result exists only in process memory. This slice does not persist provider
thread or turn IDs, events, response text, usage, process IDs, transcripts, or
temporary storage. It adds no migrations, lifecycle mutation, orchestration,
worktrees, UI, daemon, deployment, or provider routing.

The next dependency is Single-Subtask Live Execution V0 Comprehensive
Hardening. Live Execution V0 is not accepted by implementation and one smoke
alone.
