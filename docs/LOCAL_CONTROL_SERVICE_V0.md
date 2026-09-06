# Local Control Service & Operator Harness V0

Status: ACCEPTED. Roadmap Step 6 is complete, Roadmap Step 7 backend dogfood completed successfully, and Fresh Independent QA passed on `20932e5438c14d6d0a82c00967de0fee00b8378e`.

Later extension: [Step 9B Big Task intake and live planning](BIG_TASK_LIVE_PLANNING_V0.md)
adds three planning commands and additive planning storage; its independent acceptance
is pending. The original Step 6 surface described below remains unchanged.

## Purpose and composition

Local Control V0 is the smallest real application boundary around the accepted Console core:

```text
operator CLI -> loopback HTTP daemon -> trusted service -> TaskStorage / WorktreeOwnership / Step 5B
```

The production composition opens the one canonical `TaskStorage`, creates the accepted public `WorktreeOwnership` manager, and invokes the accepted public `executeSingleSubtaskOwnedWorktreeCodex(storage, subtaskId)` entrypoint. HTTP callers can supply only a canonical Subtask ID. Test-only dependency seams are package-private and are not package-root exports.

No new storage schema or migration is introduced.

## Canonical local state

The one production state root is:

```text
~/Library/Application Support/Codex Task Console/
  state/console.sqlite3
  operator/daemon.lock
  operator/current-session.json
  worktrees/
```

The application, state, and operator directories must be canonical absolute, owner-owned, mode `0700`, non-symlink directories. `console.sqlite3` must be an owner-owned, mode `0600`, single-link regular file at the exact canonical path. The daemon creates that file without following links, verifies its filesystem identity before and after SQLite open/migration and listener creation, and applies the same fail-closed regular-file checks to existing `-journal`, `-wal`, and `-shm` sidecars. The current SQLite configuration uses delete-journal mode; its transient journal inherits the private database mode. Unsafe existing state fails closed; the daemon does not repair permissions or replace authority files. The SQLite path is derived internally and cannot be supplied by HTTP or a production CLI option. Tests inject only disposable roots and never use the real Application Support state.

## Daemon and session boundary

`pnpm ctc:daemon` builds and runs one foreground daemon. It binds exactly `127.0.0.1` on an OS-assigned ephemeral port. There is no remote-host, fixed-port, TLS, container, deployment, daemonization, LaunchAgent, or system-service mode.

An exclusive owner-private lock prevents two production daemons from becoming authoritative over the canonical state store. The daemon never kills another process and removes lock/session files only after matching the original filesystem identity and daemon instance ID.

Each start creates a 256-bit cryptographically random lowercase hexadecimal session token. The owner-private `operator/current-session.json` descriptor is mode `0600` and contains schema version, daemon instance ID, PID, port, canonical start timestamp, and token. The token is not accepted on a command line, URL, route, or query; it is not logged, returned in HTTP errors, or stored in TaskStorage.

All operational requests require `Authorization: Bearer <token>` and the exact `Host: 127.0.0.1:<actual-port>`. An absent `Origin` is allowed for the CLI; a present Origin must be exactly `http://127.0.0.1:<actual-port>`. Duplicate header names are rejected before authority checks so Node header joining or selection cannot create ambiguity. Mutating requests additionally require one `X-CTC-Request: 1`, exact `Content-Type: application/json`, and one exact decimal `Content-Length`; transfer encoding is rejected. No permissive CORS header or wildcard origin is emitted, and OPTIONS does not grant authority.

## Narrow HTTP API

All responses are bounded JSON. Errors have a stable `{ "error": { "code": "..." } }` shape and contain no stacks, raw storage/Git/provider errors, paths, prompt/context, response text, JSONL, stderr, environment, or credentials.

| Method and route | Exact caller input | Trusted producer | Result |
| --- | --- | --- | --- |
| `GET /v0/ping` | none | daemon | schema-version readiness |
| `GET /v0/subtasks/<canonical-id>` | canonical path Subtask ID only; encoded separators and noncanonical encodings fail closed | `TaskStorage` and `WorktreeOwnership` read APIs | board status, maturity, dependency readiness, verified/bounded worktree status, and at most eight recent threads with at most eight recent runs each |
| `POST /v0/worktrees/provision` | `{ "subtaskId": "st_..." }` only | accepted `WorktreeOwnership.provisionOwnedWorktreeForSubtask` | sanitized ownership ID/status and commit evidence; no path or branch |
| `POST /v0/executions/run` | `{ "subtaskId": "st_..." }` only | accepted `executeSingleSubtaskOwnedWorktreeCodex` | minimized sanitized Step 5B result; failures remain explicit and are not retried |
| `POST /v0/worktrees/release` | `{ "subtaskId": "st_..." }` only | accepted non-force `WorktreeOwnership.releaseOwnedWorktreeForSubtask` | sanitized terminal ownership evidence |

Provision does not run a provider. Run does not auto-provision. Release offers no force, cleanup, reset, prune, or branch-deletion option. Callers cannot supply repository/worktree paths, roots, branches, SHAs, ownership IDs, cwd, sandbox, writable roots, network, runtime, model, approval policy, profile, retry, or provider request data.

The built-in Node HTTP boundary caps request bodies at 16 KiB, responses at 64 KiB, routes at 256 characters, headers at 8 KiB/32 fields, and active requests at 16. Header byte/count limits are enforced explicitly instead of relying on Node's truncating `maxHeadersCount` behavior, and parser-level malformed requests receive the same bounded JSON error surface. It also sets finite request, header, and keep-alive timeouts. Raw JSON mutation bodies must have exact length and valid UTF-8 before JSON interpretation, then be one strict object with the one allowed field; malformed JSON, duplicate or escaped-duplicate keys, unknown fields, arrays, primitives, and noncanonical IDs are rejected. Inspection counts durable threads separately but fetches only the eight returned threads and eight returned runs per thread from SQLite.

## Operator CLI

The thin operator reads only the canonical local session descriptor and has no arbitrary URL or path mode:

```text
pnpm ctc:operator ping
pnpm ctc:operator status <subtask-id>
pnpm ctc:operator provision <subtask-id>
pnpm ctc:operator run <subtask-id>
pnpm ctc:operator release <subtask-id>
```

It sends the token only in the Authorization header, applies the exact Host and mutation headers, enforces an absolute bounded timeout and 64 KiB response limit, and handles resets/aborted responses without hanging. Before parsing, it requires the bounded response bytes to be valid UTF-8, structurally validates the resulting JSON text, and rejects duplicate decoded object keys at every nesting level. It then validates the exact route-specific result shape using canonical Domain schemas and the canonical Step 5B failure-code vocabulary. Token-reflection checks run both on raw response bytes and on the parsed value that will be serialized, so Unicode escapes cannot reconstitute the token in CLI output. The operator prints one scriptable JSON object and exits nonzero for transport, HTTP, or Step 5B result failure.

`OPERATOR_TIMEOUT` is an indeterminate operator observation, not proof that trusted daemon-side execution failed or stopped. After it occurs, the operator must reconcile through authoritative `status` before any later run decision: if the execution is `CREATED` or `RUNNING`, no new run is allowed; if it terminalized, that durable terminal result is authoritative. The timeout grants no retry. Any later execution is a distinct attempt requiring normal higher-level authority and retry budget, with no automatic retry.

## Lifecycle, privacy, and limitations

Graceful SIGINT/SIGTERM handling stops new work, lets already-started trusted operations finish within a bounded shutdown wait, closes TaskStorage only after in-flight operations finish, then removes only the daemon's own descriptor and lock. A timeout retains fail-closed evidence, and phased cleanup state makes a later stop retry coherent without re-removing already-cleaned evidence. It never kills, resets, releases, or repairs an owned worktree during shutdown.

Unexpected process crashes can leave lock/session evidence or accepted Step 5B durable residue. V0 intentionally fails closed on stale authority files and provides no automatic stale-process recovery, provider-thread recovery, crash repair, or supervisor. This is a deterministic local-single-user V1 guard, not protection against a malicious same-user host actor.

There is no generic shell, command, SQL, filesystem-write, provider-request, or raw App Server endpoint. There is no task authoring, generic CRUD, streaming/WebSocket/SSE, orchestration, planner/reviewer/dispatcher, queue, scheduling, retry, maturity automation, or browser UI in this slice. Tests use synthetic disposable repositories only and make zero provider/model turns.

Roadmap Step 7 backend dogfood completed successfully and Fresh Independent QA passed. Browser UI and orchestration remain later roadmap work; Step 8 is not authorized.


## Step 9A governed operator commands

Status: ACCEPTED after fresh independent no-write QA on
`0447ff48964a1da133d62b6fff9b0fd793d49472` (2026-09-07). Hanlin approved
integration into main; this state synchronization changes no implementation code.

The existing Step 8 governed HTTP/service boundary is also available through
four fixed CLI commands. These add client access to accepted operations; they
add no planning, lifecycle, execution or budget authority.

| Command | Existing route | Effect |
| --- | --- | --- |
| `pnpm ctc:operator governed-status <big-task-id>` | `GET /v0/governed/big-tasks/<id>` | Inspect authoritative workflow state, budgets and dispatch receipts |
| `pnpm ctc:operator governed-advance <big-task-id>` | `POST /v0/governed/advance` | Ask the controller for one bounded advance; execute at most its one authorized role |
| `pnpm ctc:operator governed-manual-start <subtask-id>` | `POST /v0/governed/manual-start` | Explicitly authorize manual start; does not dispatch or run |
| `pnpm ctc:operator governed-budget-extension <subtask-id>` | `POST /v0/governed/budget-extension` | Request the existing one-time 40K extension at its eligible pause; does not run |

Each invocation makes exactly one request. It accepts only a canonical task ID;
there are no URL, session-token, role, prompt, path, evidence, or loop options.
Use the command forms above without inserting an extra `--`. The earlier five
commands and their result/exit behavior remain unchanged. Earlier slice
non-goals above describe Step 6, not the later accepted Step 8 backend.

Successful responses preserve the existing route-specific JSON shape. Client
validation checks exact fields, canonical IDs/enums, timestamps and nested
objects, plus returned task/role/receipt identity associations. It does not
replace the controller's eligibility decisions. The existing 64 KiB response
cap, timeout, valid UTF-8, duplicate-key and session-token-reflection protections
apply unchanged; oversized results fail explicitly without truncation.

Exit behavior for the new commands:

- `0`: a valid successful inspection, manual-start grant or budget grant; for
  advance, either `BIG_TASK_COMPLETE` or one successful role result reconciled
  as `TRANSITION_RECORDED` with `READY`/`PASS` outcome.
- `1`: an HTTP/transport/validation failure, failed role execution, or an advance
  returning `BLOCKED`, `HUMAN_REQUIRED`, `ROLE_IN_PROGRESS`, or a blocked/human
  reconciliation. These structured observations remain in stdout when valid.
- `2`: invalid command syntax or a noncanonical ID, before session discovery.

Exit `0` for an inspection or a role advance does not itself mean the Big Task
is DONE. Inspect its explicit status; an advance completion result includes its
Big Task ID and completion receipt. Status/advance never grant manual-start or
budget-extension authority implicitly. Human authority operations should be
issued only for that explicit human decision, not as an error-recovery default.

`OPERATOR_TIMEOUT` remains an indeterminate observation, not cancellation or
permission to retry. Use `governed-status <big-task-id>` and the existing
`status <subtask-id>` to reconcile authoritative workflow and recent run state.
An active run must not trigger another advance. A terminal failure grants no
replacement attempt. A later action still needs the approved task policy and
normal deterministic gates; no operator command retries or automatically polls.

This slice does not add Big Task intake, live Planner/Reviewer execution,
automatic progression loops, cross-worktree integration or real provider
execution. Real dogfood and its external-target write envelope remain separate.

### Step 9A comprehensive hardening

The operator rejects internally contradictory responses as `RESPONSE_MALFORMED`
before exposing them as valid command output. These checks compare the existing
wire contract and its linked fields; they do not authorize work or recreate the
backend's workflow engine. A self-consistent response still relies on the trusted
local service for provenance and eligibility.

| Finding | Reproduced behavior | Repair and regression |
| --- | --- | --- |
| `CTC-OPERATOR-9A-HARD-001` | A role could report another role family's outcome, incompatible write/context metadata, or a partially populated execution identity and still pass validation | Check role/outcome family, role write/context policy against its receipt, and identity/result/reconciliation presence. Preserve legitimate failures before claim, during a provider attempt, after a result, and after reconciliation |
| `CTC-OPERATOR-9A-HARD-002` | Budget totals, status, permission, warning and extension flags could contradict each other | Check summary coherence against the existing V1 thresholds, including unknown usage, 80K warning, 120K pause and 160K ceiling; never grant an extension locally |
| `CTC-OPERATOR-9A-HARD-003` | DONE could accompany an empty/unfinished graph or missing completion receipts; duplicate receipts and mixed project/revision views could pass | Require completion evidence already present in the response and consistent graph ownership. Preserve IN_PROGRESS after every Subtask completes until the controller records Big Task completion |
| `CTC-OPERATOR-9A-HARD-004` | Opaque evidence fields accepted whitespace-only text or unpaired Unicode surrogates | Apply the source's canonical text boundary, preserving legitimate Unicode including astral characters and encoded replacement characters |
| `CTC-OPERATOR-9A-HARD-005` | Rejection of bad content-type or oversized declared content-length cleared the deadline while leaving a never-ending response connected | Every failure closes the owned request and clears its timer once. Compiled executable tests prove the client exits even when the responder never ends; no retry, timeout increase or daemon-side cancellation is implied |

All five findings are closed by the bounded operator changes. The original
26 failing reproduction cases pass after repair. Existing role-stage sequence
and dispatch sequence may legitimately differ; a read-only assessment can also
follow a write-enabled dispatch. Neither case is rejected merely for that
difference. A fresh-QA blocking finding can validly record a transition into
Repair while the CLI still returns exit 1.

Verification uses independent wire fixtures plus actual storage, governed
execution and service serialization with a mock App Server. It covers all six
roles, LOW/STANDARD/HIGH_RISK completion, failed fresh QA, Repair, focused QA
pass and human escalation, provider failure, active unknown usage, reopen,
manual authority, one replayable budget grant, exact routes, fixed request
counts, Unicode IDs, error output, and executable exit 0/1/2. Historical role
setup uses separate ordinary-timeout hooks and fresh disposable fixtures; no
existing assertion or timeout is relaxed.

The initial oracle setup accidentally allowed the service constructor to create
its default worktree manager. The final fixture binds that constructor to the
real governed store with the fixture's private manager and clock. Two empty
synthetic worktree directories from that failed setup were identified by their
exact temporary Git origins and synthetic-only contents and removed. No real
target or application database was changed.

Focused verification: 155 operator tests plus 48 adjacent HTTP/service tests
PASS (203 total). Canonical full-suite and executable results are recorded in
CURRENT_STATE.md. Subsequent fresh independent no-write QA passed on the exact
hardening candidate: 12 additional source/transport probes and the full 4,563-test
suite passed, with no blocking findings. The interface is ACCEPTED; live AI Update
Board work still needs its separately approved connection and target-write scope.

Approved versus actual scope: the same six files only —
`packages/local-control/src/operator.ts`, `packages/local-control/test/operator.test.ts`,
`packages/local-control/test/operator-hardening.test.ts`,
`packages/local-control/test/executable-e2e.mjs`, this document, and `CURRENT_STATE.md`.
Backend APIs, storage, orchestration, provider behavior, public response shapes,
limits and runtime activation are unchanged. No deployment or data migration is
needed. Reverting the hardening commit restores the original Step 9A client;
no database rollback is involved.

Environment normalization: the offline preflight was READY. Approved localhost
fixtures and ordinary Git operations used the required sandbox permissions;
no dependency refresh, runtime replacement, test-timeout relaxation or full-suite
recovery rerun was used. Development fixture/type/lint failures were corrected
at their source before final verification.
