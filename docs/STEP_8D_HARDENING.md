# Step 8D comprehensive hardening evidence

This records the bounded write-enabled hardening of Operational Governed Execution V0. It is not Fresh Independent QA. All execution fixtures are synthetic and all provider processes are mocks. The Panvis product scope was excluded; the applicable references were the Codex Task Console Master Scope dated 2026-09-03 and Project Instructions dated 2026-08-14.

**A. Repository truth.** Started on clean `main` at `f2bd919fbf28ff4a478cfe9180ea25ab0088158f`, tree `89283287049b85cdc5a874df4edb779b36a601cd`, synchronized with `origin/main`. Accepted Step 8C evidence remains `288ef4f3dfe519a2cead90ff460d225aa8b6bd91`. Hardening code SHA: `58f0dace445b5e70c0a73cc74dd405a046747771`; tree: `000c724fb04017c430650657fad1cf3cef4e257a`. A subsequent documentation-only commit pins that evidence without changing executable code. Final branch and push state are reported in the task Handoff.

**B. Mandatory hypotheses.** Both were reproduced independently before repairs, against the compiled supported storage exports in `NODE_ENV=production`, using disposable synthetic workflow/worktree setup.

- `CTC-ORCH-8D-HARD-001`: REPRODUCED. A normal consumer called prepare, reserve, bind, start, persist caller-written READY/PASS JSON, and reconcile through EXECUTE → HARDEN → FRESH_QA → COMPLETE. The Subtask became DONE/ACCEPTED and Big Task completed with **zero provider spawns**. Public runtime lifecycle methods exposed the semantic-authority writer. The replacement is a frozen decision/operator facade backed by a package-private identity map. Only the governed adapter can reach the internal provider bridge. Production test seams fail closed. Generic public checkpoint calls also cannot apply or replay governed checkpoint authority. Compiled-package, concurrent-provider, and checkpoint regressions pass.
- `CTC-ORCH-8D-HARD-002`: REPRODUCED. Two blockers, a blocking/non-blocking pair, Fresh QA PASS with a deferred finding, and HARDEN PASS with a deferred finding were rejected. Result parsing and repair lookup imposed one/zero finding cardinality. Assessment results now permit at most 16 unique findings, one bounded Repair, and exact-batch Focused Re-QA. Three bounded batches, all assessment PASS variants, focused new/remaining blockers, malformed findings, and the five-role mock repair path are covered.

**C. Additional findings.** All are CLOSED by the bounded repair and regression batch; source findings are distinguished from pre-repair executable reproductions.

| ID suffix | Finding and evidence | Repair |
|---|---|---|
| 003 | Source-confirmed Focused Re-QA used a Fresh-QA base and Repair used generic Active Context; exact SHA/profile/targets were not all explicit. | Dedicated focused storage profile; exact bounded finding provenance and candidate SHA; shared accepted source reader/compiler/serializer; isolation canaries and exact byte boundaries. |
| 004 | Reproduced removal of the Project write index remained authoritatively readable; immutable-table replacement was insufficiently guarded. | Exact schema fingerprints; 89 individual trigger/index loss checks and 160 immutable-row mutation attempts. |
| 005 | Reproduced shape-valid dispatch gate-reference replacement remained readable after restoring guards. Related result, finding and delivery sources lacked exact semantic readback validation. | Durable gate/source snapshots, deterministic identities, provider provenance and exact source comparisons on authoritative use/reopen; 16 semantic-corruption cases. |
| 006 | Reproduced an early raw budget extension at zero usage; source also permitted successful governed result persistence without known total usage. | Exact historical issuance usage, one 40K grant only at the hard pause, validated aggregate rows, and required normalized result usage. |
| 007 | Source-confirmed CREATED attempt replay did not uniquely claim provider start. | Immutable unique claim before spawn; ambiguous claimed/bound/running attempts cannot resume by inference; one concurrent mock provider winner. |
| 008 | Source-confirmed write roles could accept pre-start clean HEAD drift and reconciliation did not recheck the result candidate. | Exact pre-start SHA, clean current result SHA before checkpoint/transition, prior-role SHA continuity, and internal-only checkpoint application. |
| 009 | Source-confirmed delivery always emitted NO_PROMOTION_CANDIDATE without recording whether a result supplied a candidate. | Required nullable bounded candidate field, durable PENDING_HUMAN_REVIEW candidate, and source-derived disposition; no auto-acceptance. |
| 010 | Source-confirmed MANUAL MATERIALIZE could record routine human-policy evidence before explicit manual start. | Explicit manual authority precedes gates/materialization advance; no routine source for manual work; three profile cases and operator/dispatch race. |
| 011 | Source-confirmed completion snapshot was outside the final transaction; hardening regression also reproduced inspection accepting a corrupted completion receipt. | Snapshot, checks, receipt and board transition share one transaction; read-only inspection verifies receipt and canonical states without completing work. |

**D. Public authority boundary.** Storage retains `GovernedExecutionStore`, `createGovernedExecutionStore`, the role-name constant, and the existing 11 table-description exports (DATA). The facade exposes only inspect, deterministic prepare, authorization lookup, explicit manual-start and explicit one-time extension. Preparation may persist a deterministic receipt/authorization but accepts no caller role, gates or result. The adapter root exposes `executeGovernedRoleCodex` and its failure-code DATA. Local-control's compiled supported root exports nothing; its bounded executables remain the composition surface. No reserve/bind/start/persist/reconcile/checkpoint writer or private accessor is a supported package export. Unsupported package subpaths reject; fake handles and injected public managers reject. Private filesystem imports are internal implementation, not supported package APIs.

**E. Findings and repair.** PASS accepts 0–16 non-blocking findings and no blocker. BLOCKING_FAIL requires at least one blocker and permits non-blocking findings within the same 16-item cap. EXECUTE/REPAIR keep empty findings. Fresh-QA blockers retain exact result, Subtask, ordinal, provider key, invariant, contract and reproduction. One Repair consumes the entire blocking target set. Focused PASS resolves that exact set atomically. Focused blocking failure may retain targets or report a new blocker in the repaired surface and escalates REPAIR_REQA_EXHAUSTED/HUMAN_REQUIRED; there is no second automatic Repair.

**F. Context.** Fresh QA and Repair use the narrow canonical QA source. Focused Re-QA uses the accepted FOCUSED_RE_QA compiler profile. Active Context, Digest and prior-reasoning/Handoff canaries do not leak into these role inputs. Canonical contract, acceptance criteria, rules, exact candidate SHA and target provenance remain present. The existing source reader, compiler owner and serializer owner are reused, and their structural regressions are unchanged. All role instructions and result fields are included before measuring final UTF-8 text. Exact 40,000/40,001/64,000/64,001 boundaries pass; the final text hash/size agrees with initial dispatch context evidence. No RAG or promoted-context retrieval was added.

**G. Dispatch and concurrency.** Profiles, start policies, write/read modes, dependency readiness, dirty/stale worktrees, unavailable provisioning, context/budget blocks, and atomic TODO → IN_PROGRESS dispatch are covered. Five governed cross-process cases cover competing Project writes, same-operation replay, two independent Projects, concurrent extension replay, and manual-start versus dispatch. Concurrent adapter requests add a sixth case and spawn exactly one mock provider. Serial Project write authority stays one; independent coding/worktree capacity stays two. Existing worktree and workflow process suites cover adjacent provisioning, release, lifecycle and HUMAN_REQUIRED races.

**H. Budgets.** Exact totals tested: 0, 79,999, 80,000, 80,001, 119,999, 120,000, 120,001, 159,999, 160,000 and 160,001. The 80K warning, 120K pause, single +40K extension and 160K ceiling are retained. Concurrent extension requests converge on one receipt. Started RUNNING/FAILED/INTERRUPTED usage gaps fail closed; pre-start failure is not invented usage. Historical issuance identity/usage and safe-integer accumulation are validated on reads. No caller-provided total grants authority.

**I. Role/provider binding.** Mock turns cover EXECUTE, VERIFY, HARDEN, FRESH_QA, REPAIR and FOCUSED_RE_QA with distinct exact authorization/thread/run linkage. Write roles use the exact owned candidate cwd/root, workspaceWrite, network false and approval never. Read roles use readOnly and reject write-tool lifecycle. The 25 governed adapter tests cover malformed initialization/output, wrong cwd/sandbox, approval requests, duplicate items/keys, wrong thread/turn, post-terminal traffic, wrong fields/outcomes, oversized/unpaired-Unicode results, missing usage, process exit, bounded timeout, cleanup failure, hardlinks before/after, and concurrent start. Shared accepted protocol/liveness tests remain intact. No semantic retry was added.

**J. Worktree/checkpoint.** Exact active ownership generation and current clean SHA remain prerequisites. Pre-start committed HEAD drift and post-result uncommitted changes block authority. Only internal reconciliation after provider/candidate validation can apply the governed implementation checkpoint. Synthetic no-op clean candidates remain valid; the Console does not invent commits. Shared ownership/filesystem suites cover replacement, retargeting, path escape, symlinks/hardlinks and release exclusion.

**K. Handoff and disposition.** Findings, resolutions, Handoffs and promotion disposition validate exact source identity. Handoff summary, SHA and occurrence time must match the final assessment, with zero unresolved blockers. Promotion candidates remain pending human review, and disposition cannot silently declare that no candidate exists. Non-blocking deferred findings may coexist with completion under the existing policy.

**L. Step 8C integration.** Operational/human gates have durable source rows. Role and delivery evidence is tied to the exact immutable provider/result source, stage, sequence, repair count and candidate. Old execution-shaped 8D evidence receives no fabricated provenance during migration. Pure orchestration and accepted Step 8C migrations are unchanged. The existing single compiler/serializer and three approved storage snapshot consumers are preserved.

**M. Recovery.** Tests reopen unclaimed reservation and persisted result seams, and explicitly challenge claimed CREATED, bound-thread, RUNNING, FAILED and INTERRUPTED attempts. Result reconciliation and completion replay converge without duplicate history. Existing workflow transaction/crash tests cover evidence/transition atomicity. Claimed provider-start ambiguity fails closed; a terminal or missing process is never inferred to have passed.

**N. Big Task completion.** Completion uses canonical materialization and current workflow/board states inside the write transaction, followed by the DB guard. Missing canonical joins, incomplete states, unresolved human requirements and inconsistent receipt metadata cannot establish completion. Exact completion retries return the same receipt. Corrupted stage, board, maturity and completion-count cases fail closed on use/reopen. Inspection remains a read operation.

**O. Migration and corruption.** Two forward migrations add claim/result/gate provenance and strengthen guards; `20260903184138_omniscient_lyja` is unchanged. Fresh creation, Step 8C predecessor, f2bd implementation predecessor, and legacy execution-shaped evidence are verified without fabricated dispatch/role/completion rows. Final schema contains 16 governed tables, 24 indexes and 65 triggers. All 89 governed index/trigger removals fail authoritative use. All 16 populated tables reject duplicate INSERT, INSERT OR REPLACE, UPSERT, UPDATE and DELETE with recursive triggers both ON and OFF: 160 attempts. Sixteen targeted semantic corruptions include foreign_keys OFF, original guards restored, and reopen. Foreign-key checks pass.

**P. Local-control boundaries.** Existing governed route tests and the unchanged full local-control suite verify bounded inspect/advance/manual/extension inputs, authentication and request policy, canonical IDs, exact body/route/method handling, sanitized output and absence of arbitrary role/prompt/path/evidence values. Manual and extension remain explicit commands; advancing does not call either automatically. No separate cybersecurity scan or unrelated change was performed.

**Q. Verification.** Final command results are pinned in CURRENT_STATE and the task Handoff. Direct governed coverage is 100 tests across storage (70), mock adapter (25), migration (3), compiled exports (1) and process worker (1). The adjacent compiler/serializer/source regression selection passed 106 tests. Migration predecessor/rollback regression selection passed 29 tests. Final `pnpm test`: **139 files / 4,287 tests PASS**, four workers, 138.97 seconds. `pnpm public:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff --check`: **PASS**. No failing result was promoted to PASS.

**R. Environment normalization.** Git metadata: initial authorized fetch was denied for `.git/FETCH_HEAD`; one permission correction succeeded. Loopback: the first full run contained listener EPERM/LISTEN_FAILED plus real repository-test failures. Only the listener denial received permission correction; repository failures were fixed separately. The permission-enabled run passed every listener test and exposed remaining predecessor-offset expectations, which were then updated to the two added migrations. Subsequent verification reuses that permission. No assertion failure was classified as environmental. A test-runner reporting timeout during a long synchronous matrix was addressed with event-loop yields; no host-load retry exemption, assertion removal or timeout inflation was used. No dependency refresh or installation was performed.

**S. Scope.** Actual changes are the approved Step 8D authority/context/result/forward-schema hardening, regression tests, and completion evidence. Step 8E NOT STARTED; Fresh Independent QA NOT performed; Step 9 NOT STARTED; real model/provider turns 0; real target orchestration NONE; no dynamic graph mutation, background scheduler, Git merge/rebase/push automation, UI, provider expansion, or broad retrieval. Ordinary Git commits/push of this repository are the authorized delivery operation.

**T. Operational state.** CURRENT_STATE records the exact code evidence commit after verification. Rollback requires restoring the pre-upgrade database snapshot together with matching code; do not delete migrations, infer old authority, or down-migrate live history. No real database was opened or upgraded, and no target activation or deployment occurred.

**U. Maturity.** Final gates PASS: Step 8C remains ACCEPTED; Step 8D implementation remains IMPLEMENTED and comprehensive hardening is PASS / HARDENED; Fresh Independent QA is PENDING / ELIGIBLE. Step 8D is not ACCEPTED. Next safe task: **NEW CHAT Fresh Independent no-write Step 8D QA**.

**V. Manual QA.** Hanlin manual QA: NOT REQUIRED. Independent no-write QA is still required before Step 8D ACCEPTED. Verification was on this macOS/Node environment, not a Windows runner.

Changed files (36 code/test/migration files, plus the two completion records):

```text
fixtures/mock-governed-app-server.ts
packages/codex-adapter/src/live-execution.ts
packages/codex-adapter/test/governed-role-execution.test.ts
packages/local-control/src/service.ts
packages/storage/drizzle/20260905045319_governed_hardening/migration.sql
packages/storage/drizzle/20260905045319_governed_hardening/snapshot.json
packages/storage/drizzle/20260905050930_governed_gate_sources/migration.sql
packages/storage/drizzle/20260905050930_governed_gate_sources/snapshot.json
packages/storage/src/execution-input-preflight.ts
packages/storage/src/governed-evidence-validation.ts
packages/storage/src/governed-execution-public.ts
packages/storage/src/governed-execution.ts
packages/storage/src/governed-focused-context.ts
packages/storage/src/governed-schema-integrity.ts
packages/storage/src/governed-schema-manifest.ts
packages/storage/src/index.ts
packages/storage/src/operational-context-assembly.ts
packages/storage/src/schema.ts
packages/storage/src/task-storage.ts
packages/storage/test/canonical-task-materialization-migration.test.ts
packages/storage/test/durable-execution-migration-hardening.test.ts
packages/storage/test/durable-orchestration-migration-hardening.test.ts
packages/storage/test/durable-orchestration-planning.test.ts
packages/storage/test/governed-dispatch-process-worker.test.ts
packages/storage/test/governed-execution-migration.test.ts
packages/storage/test/governed-execution.test.ts
packages/storage/test/governed-public-authority.test.ts
packages/storage/test/implementation-completion-hardening.test.ts
packages/storage/test/jit-context-storage-source-snapshot-hardening.test.ts
packages/storage/test/migrations.test.ts
packages/storage/test/s0b2b-migration-hardening.test.ts
packages/storage/test/task-contract-migration.test.ts
packages/storage/test/workflow-control-migration.test.ts
packages/storage/test/workflow-initialization-migration-hardening.test.ts
packages/storage/test/workflow-initialization-migration.test.ts
vitest.config.ts
CURRENT_STATE.md
docs/STEP_8D_HARDENING.md
```
