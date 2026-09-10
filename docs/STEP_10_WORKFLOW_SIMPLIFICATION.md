# Step 10 — Context, task controls and simpler workflow

Approved by Hanlin on 2026-09-09. This changes Console behavior; it does not approve or restart AI Update Board implementation.

## User workflow

1. Choose a project folder. Console detects the repository, display name and current branch; manual entry remains available. A folder without initial Git history gets an actionable explanation.
2. Discuss the goal in project, task or subtask chat. Suggested children have their own pages and conversations before execution is approved.
3. Confirm product direction. Planning can investigate local files, repository status, saved task state and discussion history through a read-only tool. Technical evidence gathering does not require a separate product approval.
4. Inspect the plan and choose each task's checking depth. New work defaults to planner self-check; independent plan review is optional. The owner confirms the implementation plan once.
5. Execute with the selected checks: implementation/basic verification, independent QA with feedback on the second failed QA attempt, or hardening/QA with feedback on the third. Context and accepted product direction remain available to the assigned role.
6. Pause at the current role's save boundary, continue, or end and retain records. Reopening does not repeat a completed role. Ending work never fabricates QA or product acceptance.
7. Inspect the deliverable: changed files, usage instructions and appropriate output links. Local web launch is offered only for detected web results. Git revision details and long historical closeout notes are expandable.

Projects, big tasks and subtasks have explicit ownership and navigation. Completed big tasks collapse in place. Ended projects collapse and appear below active projects. Candidate subtask review changes follow the new immutable plan version while preserving human context and per-scope settings.

## Context and model boundary

- Chats accept PNG, JPEG and WebP by file upload, paste or drop: at most six images, four MiB each. Images are stored locally with project ownership and sent as actual model image inputs. Text is escaped in the UI.
- Chats can inspect their saved plans, review findings, failure state, history and local repository. Long conversations carry a generated context summary; original messages remain retained.
- Planning includes bounded human feedback from candidate subtasks, draft children and previous plan versions. Execution and QA receive human reference material without implementation-agent conversations or verdicts. New product requests remain reference material until reconciled with the approved task contract.
- Current task images take precedence over older parent images. A maximum of six is sent. Large histories remain accessible through bounded read-only history requests.
- The model has a scoped `console_read` dynamic tool for investigation. The 2026-09-10 follow-up below adds native read-only shell, web search and image viewing; project writes and approval escalation remain unavailable in planning and discussion. Tool output is untrusted reference data; it cannot grant implementation authority.
- Provider output uses the supported strict object schema: all properties are required, including the context summary, while stored historical responses remain readable without the new field.

## Usage and approvals

New work defaults to measurement and reminders. A successful turn with unavailable usage is kept successful and marked unknown. Actual model failures still stop; they are never converted into success or replayed automatically. A selected hard budget still stops when reached or when required usage is unknown. The selected duration remains an execution window.

The policy is carried through planning, aggregate execution, provider claim, persisted success provenance and completion validation. Existing approvals without the new policy retain their historical limits and digests. Changing defaults affects future plans; it does not silently rewrite an approved task.

## QA repairs made during this change

- Reconciled successful unknown usage at all three persistence/validation boundaries, not just the visible budget check.
- Corrected candidate pause handling and cooperative in-flight pause so a paused dependency is not reported as an unexplained governed failure.
- Preserved human context across successive plan revisions, and included child feedback in replanning.
- Corrected image priority and the SELF amendment message that incorrectly promised independent review.
- Fixed strict provider schema compatibility with a real synthetic read-file/image turn.
- Preserved draft ordering, parent/child grouping, lifecycle display and selected task checking depth.
- Removed repeated approval parsing and full execution-state replay from known-usage hot paths; missing-usage exceptions still perform the same authority checks.
- Isolated two older tests' private Git/SQLite preparation using per-test hooks. Changed a repair-loop test's busy state polling to role-completion notifications. Operation ordering, all business assertions and existing timeouts remain unchanged.
- Updated the explicit current migration/table inventories and reconstructed predecessor trigger definitions for schema-upgrade tests. Historical migration counts stay pinned.

## Verification and activation

Focused checks cover these behaviors and existing browser/HTTP execution from approval to owner acceptance. Compiled executable E2E passed daemon startup/race, governed commands, signal handling and cleanup with zero real provider turns or target writes. A real synthetic model smoke read a verification file and identified a red/blue image: 28,487 reported tokens, about 22 seconds, no tool approval. Earlier failed probes reported unavailable usage; that successful count is not an all-attempt total. No Board work was started.

Browser interaction covered candidate pages, actual image upload/persistence, pause/continue, end/reopen, plan-level checking changes, and narrow layout without horizontal overflow. macOS native folder point-and-click could not finish because the host locked; command construction, cancellation, Unicode/spaced paths and repository detection have deterministic coverage. Windows has not been exercised on a Windows runner.

Final unified verification on 2026-09-10: **197 files / 4,891 tests PASS**, four workers, 653.59 seconds, no failures, errors or skips. Public hygiene, lint, typecheck, build, compiled executable E2E and diff checks PASS. Earlier full attempts exposed migration expectations and fixture timing/polling failures; those attempts are not relabeled as passes. Independent QA found no remaining blocker after the context, usage-policy and fixture corrections.

Activated through the unchanged, signature-verified desktop app after a private mode-0600 schema-30 backup. All **54 existing table record sets** have identical before/after hashes; the new context table starts empty. SQLite integrity and foreign-key checks PASS. Actual authenticated HTTP readback confirms six unmaterialized subtask pages with discussion/context, the original four-child CLOSED Board delivery and exact result revision, and no new Board execution. macOS locked during the native folder point-and-click check, so that interaction and Windows execution remain unverified. Schema 31 adds local context/image entries and updates the governed success trigger only for newly approved measurement-mode work. Preserve a private schema-30 backup before activation. Rollback requires retaining the new database separately and restoring the matching old database and binary; do not open schema 31 with an old binary or discard user history.


## 2026-09-10 — Working chat actions and larger context

Approved follow-up: repair failed re-investigation and chat progression, broaden available investigation tools, and replace restrictive text/context capacity limits with 1 MiB. This does not authorize new Board execution or reopen tasks ended by the owner.

The retained intake and six suggested children together exceeded the old 24,000-byte planning acceptance limit. `prepareAgain` now preserves them under the larger limit, reuses an existing successor and rejects incompatible active/ended states. The two reported chat failures stored `TOOL_ACTION_ATTEMPTED`: native command events were rejected even though the model could attempt them. Those stored failures remain unchanged; the UI now explains their category.

Big-task and subtask chats can request scoped advance/pause operations through the same application services as the controls. Requests become durable outcomes with navigation links; failures are displayed as unfinished actions. Implementation still requires the owner's current plan confirmation. An ended task must explicitly be reopened; a subtask cannot advance its parent or sibling. Interrupted pending requests are not silently replayed after restart.

Discussion messages/replies/summaries, durable human notes, planning intake/output, compiled role context and structured role results support 1,048,576 UTF-8 bytes. Envelopes are larger where they carry several blocks, JSON escaping, conversation history or attachments. Compact titles, IDs and task-count constraints remain semantic limits. Ordinary context targets and user-selected hard budgets are unchanged. This increases Console capacity; it does not promise that every model can consume a 1 MiB prompt.

Investigation now supports scoped Console state/history, current and retained-revision repository files, native read-only shell, web search/page open/find and image viewing. Authorized owned-worktree implementation/QA accepts search/image events as well. Configured unrelated MCP servers remain disabled. No new browser automation package, plugin or credential was installed. Availability and event handling were verified with mocked provider streams, not a real network/model run.

Schema 32 rebuilds only governed provider-claim and result-provenance tables to raise two capacity checks, preserving their guards and referencing triggers. A production database copy migrated successfully with all 55 table record sets unchanged and no foreign-key errors; retained replanning with all six children also passed on the copy.

Verification: the full applicable suite ran 198 files / 4,900 tests; 4,892 passed and eight failed on old boundary fixtures or fixture setup timing. After correcting those fixtures without weakening assertions/timeouts, affected grouped verification covered 532 tests (530 passed; two additional old operator-boundary expectations were then corrected). The final release group passed 10 files / 321 tests, including those corrections and a new execution search/image case. No second whole-suite run or real provider turn was used. The compiled executable test likewise required its old 64 KiB response fixture to move to the new 1 MiB threshold. Windows execution and live browser/search availability are not claimed.


Release checks passed: `pnpm public:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:local-control:e2e` and `git diff --check`. Desktop activation completed after an idle check and a private schema-31 backup. All 55 table record sets remain identical, schema 32 integrity/foreign-key checks pass, and the unchanged signature-verified desktop app reopened with the new chat controls. No task lifecycle or execution was changed. For rollback, retain the schema-32 database separately and restore the matching schema-31 backup and prior binary; do not run an old binary against the upgraded database.
