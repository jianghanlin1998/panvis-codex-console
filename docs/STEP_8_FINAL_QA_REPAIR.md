# Step 8 Final Fresh-QA bounded repair

2026-09-06. Implementation evidence only; final Focused Re-QA is a separate
new-chat task. Step 8D remains ACCEPTED; Step 8E remains HARDENED; overall
Step 8 is HARDENED / REPAIRED / NOT ACCEPTED. Step 9 remains BLOCKED.

## A. Repository truth

Start: `main`, HEAD/origin/main
`b4049d81e6ec41fc27215aaf71525e6d1dd586f9`, tree
`1c512e457798bac82d013871e189b7dabc3e482f`, parent
`a8b994ad1c8e2b9cfde7d755625cac93330b9af1`. Clean working tree, exact approved
remote `jianghanlin1998/panvis-codex-console`. Fetch verified no remote movement.
Node v24.19.0 / pnpm 11.19.0; development preflight sourced once, offline READY.
The final repair SHA/tree and normal push/readback are reported in the delivery
Handoff, avoiding a self-referential commit ID in this tracked artifact.

## B. CTC-ORCH-STEP8-FQA-001

Before production edits, three independent deterministic tests reproduced the
same failure for LOW, STANDARD and HIGH_RISK_FOUNDATION. A reads absent ownership
history; B commits exact first ownership and dispatch; A's real provisioning
call fails and returns BLOCKED / WORKTREE_BLOCKED instead of B's authorization.
All three failed the exact-equality assertion. This is a source defect, not an
environment or timing normalization.

The reservation guard correctly rejects obsolete hierarchy/ownership reads.
The governed caller incorrectly treated those race denials as current blockers.
The repair re-reads trusted ACTIVE authority once, only after typed
OWNERSHIP_CONFLICT or TASK_HIERARCHY_UNAVAILABLE. It requires the same canonical
Subtask/Project/Big Task, plan revision/binding, exact requested workflow action
(or its deterministic MATERIALIZE → EXECUTE transition), valid physical
generation/lifecycle, clean candidate and no human boundary. Existing receipt
and authorization provenance must still identify that ownership/candidate.
Execution continues through the unchanged writer transaction and receipt reuse.
There is no second provisioning attempt or general semantic retry.

All other provisioning failures retain WORKTREE_BLOCKED, including actual
capacity exhaustion, Git failure and RECOVERY_REQUIRED. An applicable human
boundary remains HUMAN_REQUIRED. Dirty, substituted-generation, changed
repository/candidate and mismatched ownership cannot produce convergence.

The regression suite includes three observation seams for each profile:
absent resolution, absent history and immediately before reservation; competing
ownership without prior dispatch; sibling dispatch; actual capacity exhaustion;
physical/provenance/human negative cases; typed non-race failures even with an
ACTIVE competing candidate; and pending generation reconciliation with/without
independently persisted evidence. Five two-process cases force the absent read
before the competing commit (three same-Subtask profiles, sibling, capacity).
Signal files establish order; elapsed sleeps never select a winner. Normal
reopen/readback preserves exact results. In successful races, physical Git-add counts equal canonical
ownership/generation counts (one for the same Subtask); coding capacity ≤2 and
active write dispatch ≤1. Negative replacement tests preserve legitimate prior
terminal history and reject its reuse as current dispatch authority.

Status: REPAIRED / awaiting Focused Re-QA, not independently CLOSED here.

## C–G. Timing investigation and bounded test policy

Two predetermined diagnostic runs used the normal four-worker setting over the
historical HIGH_RISK case, all three serial-reopen profiles, and one existing
three-Subtask turnover case. Temporary phase wrappers measured real synchronous
Git calls, SQLite open/migration, public control/ownership operations, filesystem
setup/cleanup and mock process events; all diagnostic code was removed.
Only method/category timing was retained, not provider transcripts or payloads.

The initial diagnostic reproduced the historical 5,000 ms timeout at 5,365 ms.
The serial cases took 4,164 /4,674 /3,634 ms. The second diagnostic passed all
five semantic scenarios after the fixture separation and scoped timeout policy.
These are measurements, not deterministic timing assertions or a product SLA.

### Approximate phase baseline after repair (milliseconds)

Nested operation spans overlap: do not add Git, ownership and governed columns.
“Git” below counts production-boundary subprocesses; fixture Git is separate.

| Phase | HIGH_RISK adapter, all 3 roles | STANDARD serial reopen | HIGH_RISK serial reopen | LOW serial reopen | 3-Subtask turnover |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full case, including fixture/hooks | 5,562 | 4,344 | 4,858 | 3,564 | 20,731 |
| Disposable directories | <1 | <1 | <1 | <1 | <1 |
| Git init | 11 | 13 | 11 | 11 | 12 |
| All initial/fixture Git work | 64 | 71 | 62 | 62 | 116 |
| SQLite opens/migrations/reopens | 21 (1) | 24 (2) | 16 (2) | 16 (2) | 35 (8) |
| Initial planning/materialization/bootstrap | about 15 | about 15 | about 7 | about 7 | about 28 |
| Provisioning total | 272 (1) | 539 (2) | 493 (2) | 488 (2) | 772 (3) |
| Next provisioning after reopen | — | 262 | 231 | 242 | 266 /234 |
| ACTIVE physical-generation resolution total | 2,941 | 1,825 | 2,161 | 1,536 | 7,016 |
| Production Git calls / total ms | 570 /4,330 | 453 /3,455 | 542 /3,858 | 420 /2,973 | 1,444 /10,202 |
| Governed prepare calls / total / maximum | 4 /1,777 /818 | 3 /2,895 /1,573 | 4 /3,018 /1,507 | 3 /2,346 /1,426 | 8 /9,461 /1,965 |
| Provider input claim total | 558 | 380 | 486 | 317 | 1,052 |
| Final pre-turn validation total | 538 | 395 | 504 | 334 | 1,157 |
| Mock spawn → initialization response | 154 (3; max 60) | none | none | none | 275 (6; max 47) |
| Last setup response → turn/start | 893 total | none | none | none | 1,947 total |
| Mock turn/start → completed | 16 (3) | none | none | none | 126 (6; includes mock commits) |
| Last mock response → process close | 32 (3) | none | none | none | 23 (6) |
| Role-result persistence / reconciliation | 329 /380 | 223 /258 | 303 /362 | 204 /223 | 677 /852 |
| Governed release/revalidation total | 427 | 393 | 408 | 365 | 3,187 |
| Database close total | 1 | 3 | 1 | 4 | 11 |
| Filesystem removal/cleanup | 4 | 4 | 4 | 4 | 6 |

Initial Git commits cost roughly 13–16 ms; refs/config plus other fixture Git
account for the rest of the fixture column. Reopens alone were about 2 ms each.
For serial tests, final assertions plus uninstrumented fixture/JavaScript overhead
account for approximately 10–15 ms after subtracting the non-overlapping top-level
spans (a residual estimate, not an additional nested stopwatch measurement).
Turnover includes eleven inspect calls (2,917 ms total), six full role executions,
three releases, eight database opens and repeated final provenance assertions.

**Dominant layer: repeated local Git/filesystem subprocess work.** Git alone
accounts for about 78% of the adapter case and 79–83% of the serial cases.
Individual Git probes took roughly 6–16 ms; this is hundreds of separate
identity, HEAD, registration, repository and cleanliness checks, repeated at
independent trust boundaries. SQLite migration/reopen and mock startup/shutdown
are small. The setup-to-turn interval includes parent-side authority/context
validation; it must not be attributed to model response time. The synchronous
storage serial cases do not spawn any mock provider process.

No simple redundant serial fixture setup or obviously unnecessary production
operation was identified that could safely be removed without changing freshness,
turnover or provenance coverage. Host/process/disk contention can amplify these
costs; it was not isolated as a separate quantified causal contribution. The
provided canonical QA observations (5.239 /6.136 /5.063 seconds) remain relevant.
There is no observed deadlock or standalone unexplained multisecond stall. The
largest measured composite control operation was a turnover advance at 1.965 s;
serial next advances were 1.426–1.573 s and individual provisioning 231–276 ms.
These control-path costs are a future comparison baseline, not real task latency.
No real provider/model task latency was measured.

### Historical Step 8D timeout limitation

Simple test-quality repair: **YES**. The original single test included disposable
fixture setup and three complete provider roles in its 5-second body. EXECUTE
is now isolated beforeEach preparation with its original role, sandbox, context
and success assertions. The body still performs distinct HARDEN and FRESH_QA
provider runs, checks both policies, and proves Big Task completion. Cleanup is
an isolated afterEach; no shared state, omitted role, synthetic completion or
additional provider reuse was introduced. The existing five-role batch-repair
lifecycle test remains intact.

The timed test body passes the unchanged ordinary 5-second limit. Full reported
case time may still exceed 5 seconds because it includes preparation and cleanup;
this change does not claim faster production code or hide that total. Hook
limits were not changed. CTC-ORCH-8D-FQA-007 / CTC-ORCH-8D-FRQA-001 become
**REPAIR_CANDIDATE_PENDING_RE_QA**, not technically CLOSED and not a broader waiver.

### New serial timeouts and exact policy

Only `progresses serial %s to STANDARD across reopen` in
`packages/storage/test/governed-execution.test.ts` receives the shared local
`SERIAL_REOPEN_TIMEOUT_MS = 8_000` policy. Its three profiles are STANDARD,
HIGH_RISK_FOUNDATION and LOW. All original assertions, complete role chains,
release/turnover, close/reopen and distinct concurrency provenance remain intact.
There is no serial test restructuring or production performance change.

Old: these three cases inherited 5,000 ms. New: exactly these three have 8,000 ms.
The global Vitest configuration, root `vitest run --maxWorkers=4` script, ordinary
unit/small-test default, historical HIGH_RISK body and new first-provisioning
regressions remain unchanged at their ordinary timeout behavior. Existing longer
Step 8E lifecycle/process test bounds are unchanged. The single named constant
is applied once to the three-case parameterization, with no CLI-only override.
8 seconds accommodates the observed 6.136 seconds; 6 seconds cannot. It is not
permission for semantic failure, deadlock, unrelated slow tests or unexplained
>8-second growth. FQA-002 follows the approved policy-B repair path.

Status: CTC-ORCH-STEP8-FQA-002 REPAIRED / awaiting Focused Re-QA.
Final canonical timings and verification are recorded below.

## H–I. Verification

Initial affected/adjacent verification: **19 files /367 tests PASS**, 382.46 s,
normal four workers. This includes the full 183-test governed storage matrix,
32 adapter cases, 76 ownership base/hardening/generation cases, four migration
cases, and 72 integrated cases/worker guards. After the two final provenance
guards were added, **4 files /37 tests PASS**, 31.90 s: all 25 first-provisioning
interleavings/negative/reconciliation cases, five real two-process cases, the
inert new worker guard, and six existing dispatch/release process/interleaving
cases. These two focused counts overlap; they are not additive unique coverage.
The worker subprocesses each run a single entry test with one worker, matching
the existing process-harness pattern; the parent and canonical suite use four.

Commands:

```sh
pnpm exec vitest run packages/local-control/test/integrated-orchestration-*.test.ts packages/codex-adapter/test/governed-role-execution.test.ts packages/storage/test/governed-execution.test.ts packages/storage/test/governed-execution-migration.test.ts packages/storage/test/worktree-ownership.test.ts packages/storage/test/worktree-ownership-hardening.test.ts packages/storage/test/worktree-ownership-generation-repair.test.ts --maxWorkers=4
pnpm exec vitest run packages/local-control/test/integrated-orchestration-first-provision*.test.ts packages/local-control/test/integrated-orchestration-processes.test.ts --maxWorkers=4
```

Final canonical **`pnpm test`: 152 files /4,483 tests PASS**, exit 0,
**334.33 seconds**, normal four workers. One final canonical run, no corrective
rerun, no ad-hoc timeout flag, no skipped tests, no waiver needed for its exit.
The checked-in three-case policy applies naturally. All semantic assertions
pass; no unexplained >8-second growth or unrelated timeout was observed.

| Fresh canonical baseline | Case wall-clock |
| --- | ---: |
| HIGH_RISK adapter, complete fixture + all three roles + cleanup | 5.204 s (timed body passes unchanged 5s limit) |
| STANDARD → STANDARD serial reopen | 4.165 s /8s |
| HIGH_RISK_FOUNDATION → STANDARD serial reopen | 5.177 s /8s |
| LOW → STANDARD serial reopen | 3.895 s /8s |
| Three-Subtask automatic turnover | 21.298 s /existing 30s |
| Explicit-first-release turnover representative | 21.827 s /existing 30s |
| Full canonical suite | 334.33 s |

These are lightweight comparison points for Step 9 backend dogfood, Step 10 UI,
and Step 11 cross-layer hardening. Test fixture wall-clock, measured production
operations, mock process time and unmeasured real model latency remain distinct.
The HIGH_RISK serial result above also confirms why the ordinary 5s boundary is
insufficient for that integration class, even after the historical fixture fix.

`pnpm public:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and
`git diff --check`: **PASS**. Final changes after this canonical run are limited
to recording these results in the evidence document and CURRENT_STATE.

| Step 8E contract | Retested evidence | Result |
| --- | --- | --- |
| HARD-001 | Both three-Subtask turnover paths; ten terminal completion/provenance cases; exact RELEASED/releaseHeadSha proof | PASS / remains CLOSED |
| HARD-002 | Four release crash seams; eight altered-candidate/human boundaries; release resume/process races | PASS / remains CLOSED |
| HARD-003 | Existing four release/concurrency process scenarios and two deterministic receipt interleavings, plus new first-provisioning matrix | PASS / remains CLOSED |

No applicable Windows runner was used. Evidence is the macOS deterministic
suite, explicit UTF-8 text I/O and immutable/injected dates, not a Windows claim.

Exact changed files:

- `packages/storage/src/governed-execution.ts`
- `packages/storage/test/governed-execution.test.ts`
- `packages/codex-adapter/test/governed-role-execution.test.ts`
- `packages/local-control/test/integrated-orchestration-first-provision.test.ts`
- `packages/local-control/test/integrated-orchestration-first-provision-processes.test.ts`
- `packages/local-control/test/integrated-orchestration-first-provision-worker.test.ts`
- `CURRENT_STATE.md`
- `docs/STEP_8_FINAL_QA_REPAIR.md`

## J–M. Scope, maturity and next task

Planned and actual scope: the first-provisioning race, timeout investigation,
small historical fixture repair, three-case integration timeout policy,
deterministic regressions and compact operational/evidence documentation.
No public API, schema, ownership lifecycle, provider protocol, capacity or serial
write contract was relaxed. Production change is limited to governed execution.
No dependency/runtime installation, broad performance engineering or telemetry.

- Step 8D = ACCEPTED; Step 8E = HARDENED.
- Overall Step 8 = HARDENED / REPAIRED / NOT ACCEPTED.
- Final Fresh Independent QA on the starting b4049d81… = FAIL (historical result).
- FQA-001 and FQA-002 = REPAIRED / awaiting Focused Re-QA.
- Historical timeout pair = REPAIR_CANDIDATE_PENDING_RE_QA.
- HARD-001 through HARD-003 remain CLOSED, subject to the recorded regressions.
- Step 9 = BLOCKED / NOT STARTED; final Focused Re-QA NOT performed here.
- Real provider/model turns = 0; real target orchestration = NONE.
- No UI or dynamic graph mutation. Hanlin manual QA: NOT REQUIRED.

Next safe task, exactly:

NEW CHAT Fresh Focused Re-QA of CTC-ORCH-STEP8-FQA-001 and -002,
including closure of any repaired historical timeout limitation

No activation or deployment is needed. If rollback is later authorized, revert
this bounded repair commit normally; there is no migration or persisted-data
conversion. That restores the known race and timeout defects, so Step 9 stays
blocked. No force push or destructive reset is part of delivery or rollback.

## Environment normalization

| Class | Initial evidence | Correction / attempts | Outcome |
| --- | --- | --- | --- |
| Authorized Git metadata write | Ordinary fetch could not open .git/FETCH_HEAD: Operation not permitted | Exact authorized fetch retried with repository-write permission once | PASS; origin/main unchanged |

The canonical suite was launched with the required loopback-listener permission
from the outset; no listener denial or corrective rerun was incurred.
No timeout/assertion failure was classified as mechanical. Three original race
reproductions and the historical timing reproduction are genuine failures.
Two added negative tests then caught the initial repair accepting a clean
post-dispatch HEAD change or a newer ownership generation with the old receipt.
The repair now matches existing receipt/authorization ownership and candidate
SHA during convergence; both negative assertions are retained. These were real
intermediate repair failures, not mechanical normalization.

A development-only test-spy assertion incorrectly expected Vitest's default
spy implementation accessor to be populated; it was replaced by the intended
exact invocation count and the boundary assertions still execute. No meaningful
assertion was removed. No dependency refresh, worker reduction, model/provider
retry or retry-until-green loop was used.
