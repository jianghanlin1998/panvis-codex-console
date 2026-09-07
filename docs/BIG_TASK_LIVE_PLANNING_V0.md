# Step 9B — Big Task intake and live planning

Status: ACCEPTED after fresh independent re-QA round 1 on
`046e9af12115fd6acf64c5fcb971b3b0f690c468`, tree
`7d86bc3d9485d0f51aae28f48f21e6e76efcfe62`. Based on the
accepted Step 9A main at `d4fae592b3b4213d99506489c7d5e08ca267762b`.
Hanlin approved this bounded slice on 2026-09-07.

## Result and boundary

A human approves a Big Task's goal, scope, acceptance criteria, product decisions
and planning budget for an existing canonical Project. The Console stores that
intent before calling Codex. No Subtask, task contract or dependency graph is
accepted in the intake. The Planner's validated structured response supplies the
proposed work; the coordinator assigns scoped IDs and builds the existing V0
Task Contracts. A separate fresh Reviewer accepts, rejects with requirements, or
escalates product questions. The initial proposal can receive at most two
automatic revisions: at most six provider attempts in total.

The result stops at existing durable planning authority in `APPROVED` or at a
recorded human stop. This slice does not materialize the graph, create execution
worktrees, run Subtasks, integrate code, deploy, or touch AI Update Board. Tests
demonstrate that the existing materialization API can consume a generated,
reviewed bundle without hand-seeded Subtasks. No live provider turn is needed
for these deterministic tests.

## Operator interface

The existing `ctc-operator` gains three commands, using the daemon's authenticated
localhost session and existing request/response limits:

| Command | Fixed route | Result |
| --- | --- | --- |
| `planning-intake <approved-intake.json>` | POST `/v0/planning/intake` | Persist human-approved intent for a new Big Task in an existing Project |
| `planning-status <bigTaskId>` | POST `/v0/planning/status` | Inspect progress, stop reason, questions, runs and usage; no provider call |
| `planning-run <bigTaskId>` | POST `/v0/planning/run` | Run the remaining bounded Planner/Reviewer cycle |

The UTF-8 intake file has the exact fields `bigTask` (existing BigTask schema,
status `IN_PROGRESS`), `approved: true`, `productDecisions` (bounded strings), and
`planningTokenLimit` (positive integer up to 120,000). It cannot specify prompts,
roles, model output, provider endpoints, credentials, execution grants or tasks.
The CLI accepts a regular file of at most 16,384 bytes and rejects invalid UTF-8,
duplicate JSON keys and unknown fields. The human's file is intent, not a prompt
to paste into another chat.

The current operator wait deadline is unchanged. A client timeout ends its wait,
not the bounded daemon operation; inspect status rather than blindly retrying.
There is no automatic client retry. The service rejects duplicate active requests,
and SQLite serializes provider claims across storage connections.

## Context, independence and accounting

- Project, approved Big Task and repository identity/rules are collected through
  the existing trusted repository reader. Intake freezes this evidence. A later
  change to the goal, Project, local repository state or canonical rules stops
  the attempt instead of silently widening its approved context.
  Planning requires a clean Git worktree, including staged, tracked, untracked
  and submodule changes. Dirty intake fails atomically before any provider call;
  later dirty state stops as `CONTEXT_CHANGED`. This deliberately rejects dirty
  baselines rather than treating equal change counts as equal file contents.
  Ignored files are not planning source context. The earlier Subtask reader's
  evidence contract remains unchanged.
- Planner context contains approved intent and the current proposal plus exact
  revision requirements, when applicable. Fresh review contains the intent and
  current proposal/contracts; previous Planner transcripts, previous run records
  and private reasoning are not injected. The proposal binding and revision must
  match the stored review authority exactly.
  The provider sees and echoes the 64-character lowercase SHA-256 digest of the
  existing canonical candidate binding. The coordinator verifies that digest
  against the current captured proposal, then submits the original full binding
  to durable review. The durable binding format and matching are unchanged;
  large valid graphs do not have to echo the full binding in the 16 KiB output.
- Each role starts a fresh ephemeral read-only Codex App Server session using
  the existing owned, pinned runtime and ChatGPT authentication. API-key fallback,
  network-enabled sandboxing, writes, plugins and native delegation are unavailable;
  observed tool attempts fail the operation. A reused Planner thread is rejected
  before a Reviewer turn starts.
- Exact compiled input and its SHA-256 binding stay in local storage. Inputs over
  64,000 UTF-8 bytes are blocked, with no truncation. Structured output is bounded
  to 16,384 bytes, at most 24 proposed tasks and 64 blocking dependencies, and
  validated before any candidate/review authority is recorded.
- Big Task planning has its own ledger; no synthetic Subtask or fake execution
  thread is created. Provider identities, model and normalized usage are persisted
  as they become available. Raw provider JSONL and errors are never returned or
  stored in the ledger. Operator status omits compiled context text.
- The human-selected planning cap is separate from Subtask execution budgets.
  Usage from all attempts counts toward it, with warning at the lower of 80,000
  tokens or the selected cap. A usage event reaching the cap stops the operation
  and shuts down its dedicated provider process;
  missing final usage prevents further calls. Metering is based on reported usage,
  not a promise that a provider cannot overshoot between usage notifications.
- Intake is immutable. Run inputs and completed records are immutable. On daemon
  startup, after its exclusive lock is held, unfinished attempts become explicit
  `INTERRUPTED` human stops. They are never automatically reissued.

Product questions, exhausted reviews, missing usage, provider failure, stale
context and budget stops require a human decision. This slice does not erase or
reopen those records, grant extensions, or mutate an already approved graph.
A separately approved new planning request can carry clarified product decisions;
the earlier record and usage remain intact.

The existing V1 limitation remains: read-only Codex execution is not a claim of
OS-level read confinement from other files available to the same user. This slice
reuses that accepted runtime boundary and does not widen it.

## Product direction recorded during implementation

Hanlin confirmed on 2026-09-07 that approving a task already authorizes normal
task-scoped calls through the established local Codex runtime and existing
ChatGPT login to OpenAI. Do not request a second human approval solely because
the model processes that approved task context in the cloud. This removes the
duplicate conversational approval step; it does not disable an enforcing tool
approval mechanism or change product-scope, context, budget or execution gates.
If a tool itself blocks an authorized action, present the existing authorization
and concrete evidence, respect the result, and explain any remaining blocker.

Hanlin wants both whole goals and explicit small tasks, with Project/Repo, Big
Task and Subtask discussion/context levels. The current durable hierarchy already
has those three scopes, while execution chats are Subtask-bound. Three discussion
interfaces and a direct-small-task intake are future product work, outside 9B.
A small request may later attach to an existing approved Big Task or use a small
single-Subtask container; the user should not have to invent an elaborate goal.

The first live AI Update Board pilot must obtain real public AI news, preserve
and reconcile the retained earlier UI work, and ask Hanlin only for material
product/authority decisions. Source collection, target-rule changes and actual
target writes are not activated here.

## Verification and activation

### Initial independent acceptance and repair round 1

Initial independent acceptance of `a7efbfa1d27c59d91369d1a444f5bf7ccdbf2504`
failed with two reproduced blockers: `CTC-STEP9B-FQA-001` (the general 1,000-character
text cap rejected exact Reviewer bindings for supported graphs) and
`CTC-STEP9B-FQA-002` (same-count dirty-content changes escaped snapshot comparison).
Hanlin authorized at most two repair/re-QA rounds and a three-hour session limit.

Round 1 replaces only the provider binding representation with the verified
compact digest and requires clean planning repository snapshots. Deterministic
regressions cover 24 tasks with zero and 64 dependencies, including an old full
binding response larger than 16 KiB; exact wrong-digest rejection; atomic dirty
intake rejection for staged/tracked/untracked changes; and submodule drift.
Fresh independent re-QA subsequently passed on the exact repaired candidate above.

Round 1 verification: six new regression cases and the affected planning/source
tests pass. Canonical `pnpm test` passes 155 files /4,597 tests with the normal
four workers (361.30 s, no skips or waiver). Public hygiene, lint, typecheck,
build, executable local-control E2E and diff checks pass. The full verification
uses the localhost listener permission established by the initial QA denial;
no provider calls, target writes, dependency refresh or timeout changes occur.

Initial QA public hygiene, lint, typecheck, build and diff checks passed. Its
four-worker full suite reported 4,382 passed /209 failed (356.02 s), all due to
localhost listener denial and its consequences. It was not rerun on the already
known-failing candidate; executable E2E was not reached. These observations are
not a full-suite pass and are not counted as a product repair round.

### Fresh independent re-QA and pilot preparation

Fresh re-QA round 1: PASS; both original findings are closed. Independent private
probes pass 23/23, including a 16,316-byte proposal with 24 tasks /64 dependencies,
exact wrong/stale digest and revision rejection, dirty intake and later drift,
original Subtask reader parity, immutable/reopened authority, revision ceilings,
independent context and budget/product/interruption stops. Canonical full suite:
155 files /4,597 tests PASS, four workers, 360.34 s. Public hygiene, lint,
typecheck, build, executable local-control E2E and diff checks PASS. Re-QA made
no candidate changes and no real provider calls or target writes. A second
repair round was not needed. The accepted repair is pushed to the existing
feature branch; main remains unchanged.

After acceptance, Hanlin's real AI Update Board goal was stored through the
production planning-intake interface as
`bt_ai_update_board_step9_real_news_20260907`, under the existing Board Project.
The approved intent includes real public AI news and preservation of the retained
Step 7 UI; it contains no hand-seeded Subtasks. The ordinary planning cap is
120,000 tokens. A private SQLite backup preceded the additive migration.

The outer automatic approval review rejected the planning-run tool action before
execution, requiring specific consent to send the task, project metadata,
repository rules and Git/runtime context to the default OpenAI service. Read-only
checks verified the actual payload categories and absence of provider/base-URL
overrides; one reconsideration of the identical action was also rejected. No
workaround was attempted. The intake remains READY with zero planning attempts,
zero generated Subtasks and zero provider usage. The daemon was stopped cleanly;
its lock/session files are absent. The target repository and retained UI branch
are unchanged. This approval blocker is outside the accepted feature's QA and
does not consume the second product repair round.

Hanlin subsequently accepted the explicit local/remote data-flow explanation
and reiterated that normal Codex calls were included in the task authorization.
The same planning-run action was then approved and invoked once on the existing
intake, without recreating it. The Planner attempt started at
`2026-09-06T20:53:14.171Z` and terminalized at `2026-09-06T20:54:04.960Z` as
`HUMAN_REQUIRED / PROVIDER_FAILED`. Separate provider thread/run identity and
the configured `gpt-6-astra` model were recorded. Normalized usage is unavailable;
the reported numeric total of zero is not evidence of zero consumed usage.
No candidate, review or Subtask was generated. The daemon stopped cleanly again.

Read-only diagnostics limited to this exact provider thread classified the
failure as a TLS handshake EOF while connecting to `chatgpt.com`. Credential-free
HEAD checks from the local execution environment to both `chatgpt.com` and
`api.openai.com` independently failed the TLS handshake (curl exit 35, no HTTP
response). No raw provider error, headers, credentials or unrelated logs were
printed or copied. At that point this was an unresolved connection blocker; no code change,
runtime upgrade, TLS-verification bypass or additional model attempt was made.
The original one-repair fresh-QA PASS remains valid; a second product repair
round was not consumed by this connection diagnosis.

The old consent blocker is resolved. The existing intake now has a sticky human
stop, one attempted Planner run and unknown usage; ordinary planning-run must
not retry it. Resolve the connection issue and reconcile the unknown-usage /
new-request authority before a later live attempt, preserving this evidence.
Full automatic Subtask progression and cross-worktree integration remain
unimplemented later slices, so planning approval alone is not an end-to-end
Board delivery claim.

### Connection repair follow-up

Hanlin authorized connection diagnosis and repair on 2026-09-07. The adapter
now supports an explicit validated local HTTP CONNECT proxy through
`CTC_CODEX_HTTPS_PROXY`; [startup and rollback](LOCAL_CONTROL_SERVICE_V0.md#daemon-and-session-boundary)
are process-scoped. No model, provider, TLS trust, runtime activation, system
network setting, task budget, or stop policy was changed.

Credential-free direct-route HTTPS probes reproduced the TLS failure, while
the existing local proxy completed certificate verification. Correctly
configured owned-runtime requests also reached OpenAI and fetched the model
catalog. Two such diagnostic turns received HTTP 400 reasoning-effort
rejections, first for a diagnostic `low` override and then for the inherited
`xhigh` setting. Neither generated a successful response. Three earlier
diagnostic turns used an invalid harness: the test-only environment helper
returned an empty environment outside test mode. Those observations cannot
validate this repair. All five diagnostic turns have unavailable usage, not
proven zero. Diagnostic generation stopped pending runtime compatibility work.

The then-active owned `0.148.0-alpha.9` catalog does not include `gpt-6-astra`.
A read-only comparison against the verified desktop `0.153.3` catalog includes
that model and its `xhigh` setting. This identifies a separate compatibility
workstream; the desktop executable was not adopted as Console authority.
That connection-repair commit left the owned-runtime upgrade pending; the
subsequent approved upgrade is recorded below.

Verification: 21 added regression cases; focused 91/91 PASS; full canonical
155 files /4,618 tests PASS, four workers, 360.89 s. Public hygiene, lint,
typecheck, build, executable local-control E2E and diff checks PASS. Tests use
mock providers; live diagnosis is separate. Windows and successful real model
generation were not verified. The canonical intake still has exactly its
original one Planner attempt; the daemon is stopped and the Board is unchanged.

### Owned-runtime upgrade follow-up

Hanlin approved `0.153.3`. The owned candidate passed isolated schema and
permission checks, with one necessary repair: hardened planning, write and
governed-role tasks disable each configured MCP server through task-local
config before thread creation. The existing external-feature flags alone did
not prevent configured server startup on either release. No user config files
or normal login settings were changed.

The real owned `0.153.3` / Astra / `xhigh` diagnostic completed successfully
through the existing explicit local proxy: one turn, 12,692 total tokens, no
tool calls. [Exact evidence and rollback](CODEX_RUNTIME_OWNERSHIP_V0.md#2026-09-07-runtime-upgrade).
The old canonical Planner attempt remains stopped with unknown historical
usage. No second intake, production planning retry, target write or automatic
Subtask runner was introduced.

### Original implementation verification

- New planning/storage/adapter/local-control coverage: 27 deterministic tests PASS.
- Final `pnpm test`: 155 files /4,591 tests PASS; normal four workers, 473.27 s,
  no skipped cases or waiver.
- `pnpm public:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`,
  `pnpm test:local-control:e2e`, and `git diff --check`: PASS.
- The first full suite reported 45 failures in historical migration fixtures
  (4,545 passing). Exact current-generation counts/table inventories and the
  synthetic pre-provenance downgrade fixture were corrected; focused checks and
  the final full suite passed. All historical preservation, rollback, immutability
  and authority assertions remain. The matrix now also covers generation 21.

### Environment normalization

The initial localhost integration test hit sandbox `EPERM` before listener
assertions. One authorized rerun with loopback-listener permission passed. No
provider network access, production state, dependency refresh, timeout relaxation
or host-load correction was used.

### Activation and limitations

The installed `codex-cli 0.148.0-alpha.9` generated its protocol schema locally,
without a provider call; `v2/TurnStartParams.json` contains `outputSchema`.
The [official App Server reference](https://learn.chatgpt.com/docs/app-server)
also documents per-turn structured output.
No production daemon, provider runtime or AI Update Board task is activated by
building or testing this change. After acceptance, restart the daemon using the
normal local-control procedure to apply the additive planning migration. Keep a
normal private database backup before upgrading. A code rollback can leave the
additive tables in place; do not delete planning evidence to retry a failed run.

## Changed files

The approved feature scope is unchanged. Existing migration tests also receive
current-generation counts/table inventories and an exact predecessor-reconstruction
fixture update; historical data, rollback and authority assertions remain in place.

- `CURRENT_STATE.md`
- `docs/BIG_TASK_LIVE_PLANNING_V0.md`
- `docs/LOCAL_CONTROL_SERVICE_V0.md`
- `packages/codex-adapter/src/index.ts`
- `packages/codex-adapter/src/live-execution.ts`
- `packages/codex-adapter/test/big-task-planning.test.ts`
- `packages/codex-adapter/test/planning-provider-fixture.ts`
- `packages/domain/src/big-task-planning.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/json-boundary.ts`
- `packages/local-control/src/daemon.ts`
- `packages/local-control/src/http-server.ts`
- `packages/local-control/src/operator.ts`
- `packages/local-control/src/service.ts`
- `packages/local-control/test/live-planning.test.ts`
- `packages/storage/drizzle/20260906172802_big_task_live_planning/migration.sql`
- `packages/storage/drizzle/20260906172802_big_task_live_planning/snapshot.json`
- `packages/storage/src/index.ts`
- `packages/storage/src/live-planning.ts`
- `packages/storage/src/schema.ts`
- `packages/storage/src/trusted-repository-source.ts`
- `packages/storage/test/canonical-task-materialization-migration.test.ts`
- `packages/storage/test/durable-execution-migration-hardening.test.ts`
- `packages/storage/test/durable-orchestration-migration-hardening.test.ts`
- `packages/storage/test/durable-orchestration-planning.test.ts`
- `packages/storage/test/governed-execution-migration.test.ts`
- `packages/storage/test/governed-execution.test.ts`
- `packages/storage/test/implementation-completion-hardening.test.ts`
- `packages/storage/test/jit-context-storage-source-snapshot-hardening.test.ts`
- `packages/storage/test/live-planning-fixture.ts`
- `packages/storage/test/live-planning.test.ts`
- `packages/storage/test/migrations.test.ts`
- `packages/storage/test/s0b2b-migration-hardening.test.ts`
- `packages/storage/test/task-contract-migration.test.ts`
- `packages/storage/test/workflow-control-migration.test.ts`
- `packages/storage/test/workflow-initialization-migration-hardening.test.ts`
- `packages/storage/test/workflow-initialization-migration.test.ts`
