# Step 9B — Big Task intake and live planning

Status: implementation candidate; independent acceptance is pending. Based on the
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
- Planner context contains approved intent and the current proposal plus exact
  revision requirements, when applicable. Fresh review contains the intent and
  current proposal/contracts; previous Planner transcripts, previous run records
  and private reasoning are not injected. The proposal binding and revision must
  match the stored review authority exactly.
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
