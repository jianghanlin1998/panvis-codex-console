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

The exact `.9` stable `account/updated` notification is monitored after the
required `account/read` gate. Only `authMode: "chatgpt"` preserves authority;
the other exact stable modes, `null`, missing or malformed fields, and unknown
modes fail closed. A downgrade before the turn prevents `turn/start`. A
downgrade during the authorized turn fails execution and may issue at most one
correlated interrupt; it never starts another turn.

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

A terminal turn event is authoritative only after the authorized ephemeral
thread response, the one sent `turn/start`, and its correlated provider turn
response establish matching identities. Early terminals, cross-thread or
cross-turn terminals, duplicate terminals, and conflicting terminal statuses
fail as protocol errors and cannot produce success. A protocol failure observed
while bounded shutdown drains the direct child's output also prevents an
otherwise completed turn from being reported as successful. Stdout JSONL
framing is validated through EOF before success, so any unterminated trailing
frame fails closed. Any turn-scoped protocol event observed after the
authoritative terminal and before public return also fails closed. These later
protocol and bounded-shutdown failures remain authoritative over an earlier
apparently successful terminal.

Normal shutdown closes stdin, waits a bounded grace period, then uses TERM and
KILL fallbacks if necessary. The disposable workspace is removed. Failure to
clean the child or workspace is reported without exposing raw process details.

## Persistence and next dependency

The result exists only in process memory. This slice does not persist provider
thread or turn IDs, events, response text, usage, process IDs, transcripts, or
temporary storage. It adds no migrations, lifecycle mutation, orchestration,
worktrees, UI, daemon, deployment, or provider routing.

## Approved local single-user V1 boundary

The hard V1 guarantees remain deterministic Console context ACL and preflight
authority, ChatGPT-only execution, at most one `turn/start` with no automatic
real-turn retry, no V0 write/network/approval/tool authority, and bounded
protocol lifecycle, direct-child shutdown, and disposable-workspace cleanup.
The live adapter does not deliberately inject sibling, unrelated-task, or raw
project context, and the accepted host boundary does not weaken any Console
context ACL or budget decision.

This local-first, single-user V1 is not a multi-tenant or adversarial-host
security sandbox. It accepts two documented best-effort limitations: there is
no OS-level guarantee that the same-user Codex process cannot read every other
same-user filesystem path, and reuse of normal local ChatGPT authentication
does not provide a complete clean-room guarantee against all ambient Codex
configuration or context. The adapter still uses a disposable cwd, a minimal
child environment, no arbitrary secret propagation, no Console-added dynamic
tools or MCP configuration, and no unmeasured prompt appended after Execution
Input Preflight.

Comprehensive Hardening passes under this approved V1 boundary. Fresh
Independent QA remains pending, so Live Execution V0 is not accepted.
