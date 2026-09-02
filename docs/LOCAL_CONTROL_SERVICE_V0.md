# Local Control Service & Operator Harness V0

Status: ACCEPTED. Roadmap Step 6 is complete, Roadmap Step 7 backend dogfood completed successfully, and Fresh Independent QA passed on `20932e5438c14d6d0a82c00967de0fee00b8378e`.

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
