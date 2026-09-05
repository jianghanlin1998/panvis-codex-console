# Step 8E integrated synthetic orchestration hardening

2026-09-06. This is the same approved sweep, including both later Hanlin
amendments. **Step 8E HARDENED; overall Step 8 HARDENED / NOT ACCEPTED.**
Canonical verification satisfies Hanlin's explicit narrow timeout-waiver gate.
This document records implementation evidence, not Fresh Independent QA.

## A–B. Repository truth and approved decisions

Starting branch: `main`. Starting HEAD/origin/main:
`a8b994ad1c8e2b9cfde7d755625cac93330b9af1`; tree:
`7eab2a59fe0d58b1feed3a2619e2e575f0b2f7ce`.
Seven legitimate uncommitted files were inspected and preserved: CURRENT_STATE,
worktree contract, mock provider, this evidence document, integrated fixture,
turnover tests, and release-recovery tests. No unrelated work was present.
Final commit/tree, normal push and remote readback are reported in the delivery
Handoff; this document is included in that delivery tree.

Hanlin approved `STEP8E_WORKTREE_TURNOVER_CONTRACT` and
`STEP8E_WORKTREE_RELEASE_RECOVERY_CONTRACT`. Both are implemented. Decisions
were not re-requested. Scope: internal governed lifecycle composition, exact
completion provenance, bounded pending-release recovery and integrated tests.
No migration, new public method, HTTP input or caller-supplied authority flag.

## C–D, M. Findings and repairs

| Finding | Reproduction and root cause | Repair and regression | Status |
| --- | --- | --- | --- |
| CTC-ORCH-8E-HARD-001, P1 | Two authoritatively completed ACTIVE candidates occupy both Project slots; Subtask 3 cannot provision. Explicit normal release frees capacity, but old completion insists every candidate remain ACTIVE. | Bounded governed advance derives authoritative completion, invokes normal release before later capacity evaluation, and accepts exact terminal RELEASED assessed/Handoff SHA. Two full three-Subtask cases; mixed and all-released proof; no accounting exception. | CLOSED |
| CTC-ORCH-8E-HARD-002, P1 | COMPLETE → ACTIVE/RELEASING persisted → crash before Git removal → reopen. Ordinary reconcile returns RECOVERY_REQUIRED; ordinary release retry returns OWNERSHIP_NOT_ACTIVE. Exact clean candidate and capacity remain stranded. | Internal governed completion revalidation can finish the same normal release. Four crash seams, altered-generation/candidate/human cases, process races and exact repeat. Public ordinary reconciliation still cannot authorize intact removal. | CLOSED |
| CTC-ORCH-8E-HARD-003, P2 | Two bounded advances resume one release, then race downstream MATERIALIZE → EXECUTE. Loser reports stale workflow CONFLICT. Deterministic LOW/STANDARD interleavings also reproduced an own-receipt CONCURRENCY_BLOCKED after another caller committed between ownership resolution and gates. | Gate evidence/transition commit atomically; reuse only the exact deterministic transition. Dispatch receipt read, gates and reservation share one writer transaction. Typed gate denials survive rollback as the original bounded control outcome. No semantic retry. Four process cases plus two deterministic interleavings. | CLOSED |

HARD-001/002 originated at the two earlier explicit contract stops. Those stops
changed no production semantics. The initial two turnover characterizations and
four crash proofs remain historical defect evidence, not successful acceptance.

Development corrections: the new internal release method initially appeared on
the manager prototype; the unchanged existing API test caught it and it became
a private method behind a package-private identity map. New fixture corrections
included canonical `wop_` operation IDs, accepted MANUAL/provider-failure result
kinds, and observing running-provider state after its actual protocol start.
No meaningful test was removed or weakened. The old RELEASED-rejection assertion
alone changed to the explicitly approved RELEASED-completion expectation;
dirty, drifted and mismatched candidates still reject.

## E–H. Ownership, provenance, capacity and recovery

Release eligibility is derived from current canonical Project/Big Task/Subtask,
materialization binding, source-validated COMPLETE/DONE and legal maturity,
COMPLETED dispatch, final PASS assessment/Handoff, resolved blockers and delivery
context disposition. Applicable Subtask or Big Task human requirements stop
release. Primary/provider CREATED or RUNNING execution excludes removal.

ACTIVE proof uses the trusted exact physical-generation resolver and clean HEAD.
RELEASED proof uses canonical terminal history, stored generation evidence,
non-null canonical releaseHeadSha matching the assessment and Handoff, and no
contradictory later ownership. RELEASED grants no coding or provider authority.
RELEASING remains capacity-consuming, non-executable, and insufficient completion
proof. PROVISIONING and FAILED cannot resume. A terminal RELEASED observation is
idempotent; it is never treated as another removal operation.

Normal release commits ACTIVE → RELEASING before external removal. A separate
SQLite writer transaction covers fresh governed/physical checks, fixed-argument
non-force `git worktree remove`, absence/unregistration and retained-branch SHA
checks, and terminal persistence. A crash rolls back only this second phase;
the pending reservation survives. Reconciliation and provisioning share writer
exclusion. No force, reset, clean, project-file edits, branch deletion/rewrite,
merge, rebase, push, prune or provider execution is introduced by release.

| Crash seam | Required final behavior and evidence |
| --- | --- |
| Before release | Reopen retains ACTIVE; governed advance performs normal release |
| RELEASING before remove | Reopen retains exact intact generation; ordinary reconcile still refuses removal; governed advance revalidates and resumes |
| Removed before RELEASED | Reopen verifies absence/unregistration and retained branch; accepted reconciliation terminalizes |
| After RELEASED | Reopen/repeat preserves one terminal record and release SHA; no resurrection |
| Two resume processes | One physical removal, same next-role authorization/receipt, one terminal history |
| Resume/reconcile | Reconcile either observes pending recovery or the exact terminal state; one removal |
| Resume/provision | Provision either sees genuinely available capacity or rejects at the ceiling; no oversubscription |
| Two Projects | Independent dispatch in one database, including separate competing processes |

Negative physical recovery cases: dirty checkout, changed HEAD, wrong branch,
replaced equal-content marker, retargeted administrative identity, equal-shaped
new Git checkout generation, and applicable human requirements. ACTIVE human
preservation is also explicit. Durable corruption tests restore the original
schema after synthetic corruption, then reject changed/malformed release SHA,
RELEASING/FAILED/PROVISIONING completion, mismatched Handoff/assessment, missing
disposition/generation, and active execution. No corruption is “repaired” by
inventing authority.

### Three-Subtask timeline

Each scenario has Project maxActiveCodingSubtasks=2 and one autonomous write
receipt at a time. Subtasks are independent canonical STANDARD components;
production deterministic ordering selects 1, then 2, then 3. Each EXECUTE makes
a real deterministic commit in its own disposable branch. VERIFY assesses that
exact commit, without modifying it.

| Observation | Ownership states 1 / 2 / 3 | Capacity | Active write receipts | Workflow/dispatch |
| --- | --- | ---: | ---: | --- |
| 1 executing | ACTIVE / absent / absent | 1 | 1 | EXECUTE / ACTIVE |
| 1 verified | ACTIVE / absent / absent | 1 | 0 | COMPLETE / COMPLETED |
| Advance to 2 | RELEASED / ACTIVE / absent | 1 | 1 | 2 EXECUTE / ACTIVE |
| 2 verified | RELEASED / ACTIVE / absent | 1 | 0 | 2 COMPLETE / COMPLETED |
| Advance to 3 | RELEASED / RELEASED / ACTIVE | 1 | 1 | 3 EXECUTE / ACTIVE |
| 3 verified, read-only inspect | RELEASED / RELEASED / ACTIVE | 1 | 0 | All COMPLETE; Big Task still IN_PROGRESS |
| Bounded completion advance | RELEASED / RELEASED / RELEASED | 0 | 0 | Big Task DONE; exactly one completion receipt |

The second scenario explicitly releases 1 before the next advance; terminal
proof remains valid. Every observed state satisfies coding ≤2 and active write
dispatch ≤1. The pending-release race fixture deliberately fills both coding
slots before resume, then proves downstream capacity is genuinely freed.
The exact final assessed SHA in all three isolated STANDARD branches is
`aa2cfcaca7e2bf2e70e13dbf7a095767dbd7eeff`: each branch starts from the same
foundation and performs the same deterministic edit/commit independently.
Ownership/authorization/Handoff identities remain distinct and bound to each
Subtask. The tests emit the observed SHA/ownership timeline and check every
retained branch against that exact final assessment.

## I–L. Integrated scenario coverage

The dedicated fixture sequences production storage/governed facade and adapter
APIs over disposable SQLite and Git. Separate structured Planner and Reviewer
fixture functions have proposal/decision authority only. There is no second
workflow state machine and no real Planner/Reviewer provider execution hierarchy.
The mock App Server speaks the actual adapter protocol, receives the exact role
input/sandbox and makes opt-in deterministic commits only for write roles.

| Area | Integrated evidence |
| --- | --- |
| Planning/review | v1 insufficient acceptance criteria → independent REJECT; v2 exact immutable contracts → APPROVE; stale/wrong Reviewer binding and mismatched bundles fail atomically; rejected/superseded history survives reopen |
| Materialization/bootstrap | Exact approved binding, canonical Subtasks/dependencies and initialization receipts; idempotent retry and reopen at approval, canonical materialization, initialization, and before dispatch |
| Primary HIGH_RISK | EXECUTE → HARDEN → FRESH_QA (2 blocking +1 non-blocking) → exactly one REPAIR → FOCUSED_RE_QA PASS → COMPLETE/DONE/ACCEPTED |
| Candidate chain | EXECUTE/HARDEN/REPAIR each create a direct child commit; the next role’s authorization uses it. Read-only roles preserve SHA. The mock reads the actual prior candidate file before assessment/hardening/repair |
| Dependent STANDARD | BLOCKING/ACCEPTED dependency prevents early dispatch; exact upstream acceptance unlocks EXECUTE/VERIFY/COMPLETE; 7 role results and 2 Handoffs across primary A/B |
| LOW | Starts EXECUTE/TODO with no worktree, dispatch, provider run or fabricated readiness; full EXECUTE/VERIFY completion |
| Planning exhaustion | Three rejections consume two automatic revisions; PLAN_REVIEW_EXHAUSTED/HUMAN_REQUIRED persists; fourth revision/materialization forbidden |
| Reviewer escalation | REVIEW_ESCALATED/HUMAN_REQUIRED persists; no revision/materialization or forced continuation |
| Graph change | Existing authoritative change request yields REPLAN_REQUIRED, immutable graph and preserved history; no rematerialization |
| QA ceiling | Fresh fail → one repair → focused fail yields REPAIR_REQA_EXHAUSTED; no second repair or Handoff, candidate preserved |
| Provider failure | Mock process failure creates no semantic result, repair consumption, fake success or autonomous retry |
| MANUAL | Normal advance requires operator authority; exact replay is idempotent and first Subtask’s authority does not start the second |
| Context | Current v2 contract canary; exact HARDEN candidate/write policy; Fresh/Repair exclude execution/hardening summaries; Repair receives exactly two blocking targets; Focused receives that exact repaired batch/SHA and excludes repair reasoning; sibling/Project context does not leak |
| Budget | AVAILABLE → exact 120K pause; explicit operator grants one 40K extension; exact replay grants nothing more; actual second role reaches 160K absolute ceiling; no next role, model override or semantic retry |
| Graph/dispatch topology | ACCEPTED-gated blocked downstream plus an independent eligible sibling. Unknown active-provider usage fails closed; a separately ready Big Task in the same Project reaches and fails the serial-write gate |
| Cross-layer interruption | Reopen after approval, graph/canonical creation, initialization, upstream COMPLETE, Fresh fail, repair commit, and final Subtask COMPLETE before Big Task DONE |
| Human after dispatch | Authoritative replan arriving before provider execution prevents any turn/input/result |
| Final completion | Exact graph, legal COMPLETE/DONE, delivery evidence, no human/blockers, ACTIVE or RELEASED proof; read-only never finishes Big Task; write repeat returns one receipt |

Accepted adjacent Step 8D regression matrices additionally cover wrong role or
Subtask result, repair-batch candidate substitution, gate/provider occurrence
ownership, SHA drift, schema integrity, result replay, context ACL and budget
mutation. These remain source-backed tests; no provider turns or authority were
fabricated to make an integrated scenario pass.

## N–P. Verification and environment accounting

Final stable gate: **149 files /4,452 tests; 148 files passed /1 failed;
4,451 tests passed /1 failed; 481.26 seconds; normal four workers**.
The sole failure is the exact previously waived HIGH_RISK adapter timeout:
**5,478 ms against 5,000 ms**, with no semantic assertion failure, new affected
test or systemic timeout. The raw command exited 1; it is not relabeled all-green.
Hanlin's explicit contract permits HARDENED with this exact accepted limitation.
No additional full rerun or timeout tuning.

- Integrated: **10 files /43 tests PASS** (42 scenario cases plus one inert
  worker-entry guard); all real subprocess-worker outcomes are also asserted.
- Governed storage: **183/183 PASS**, including the three existing races that
  failed during the intermediate repair; migration regressions **4/4 PASS**.
- Ownership base/hardening/generation: **28 +35 +13 =76 tests PASS**, plus the
  separate inert ownership-worker guard. New integration includes four release
  seams, eight physical/human preservation cases, ten completion-provenance
  cases, two turnover cases, four process races and two exact interleavings.
- `pnpm public:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and
  `git diff --check`: **PASS** on final implementation.
- Affected dispatch/context/human tests passed **3/3** after preserving typed gate
  blocks through transaction rollback; all six process/interleaving tests pass.

Required commands are the repository's unchanged scripts. Focused commands used
`pnpm exec vitest run packages/local-control/test/integrated-orchestration-*.test.ts --maxWorkers=4`
and named storage regressions. Name-filtered tests were outside the selected
command, never skipped or removed in source. Canonical verification executes all.

Historical focused and intermediate observations follow for traceability.
Focused integrated run before the final two deterministic race cases:
**10 files / 41 tests PASS, 66.36 seconds, four workers**. These were followed by
the deterministic race reproduction/repair, rather than a retry-until-green loop.

Existing lifecycle/governed adjacent run: 246 tests executed; 244 passed, the
public-prototype implementation mistake and now-amended RELEASED assertion
failed. Both were corrected at their respective source/approved-contract roots.
Focused manager-boundary plus final-candidate matrix then passed all 6 selected
tests. Ordinary worktree hardening's 35 tests passed, including the intentionally
unchanged refusal to remove an intact ungoverned pending release.

Historical initial canonical run: 140 files / 4,411 tests; 4,282 PASS /129 FAIL.
128 failures were denied loopback setup in six existing local-control files.
One permission correction passed all 151 tests in those files. The remaining
failure was the exact known HIGH_RISK adapter timeout at 5,067 ms/5,000 ms.
The next amendment added four crash proofs, all passing, without production edits.

The accepted Step 8D P2 reliability issue (`CTC-ORCH-8D-FQA-007` /
`CTC-ORCH-8D-FRQA-001`) remains technically unresolved and
**DEFERRED / ACCEPTED_P2_LIMITATION**. Its exact test is
`binds HIGH_RISK hardening and fresh QA to write/read policies` in
`packages/codex-adapter/test/governed-role-execution.test.ts`.
The first final-gate attempt observed the same timeout at **5,194 ms** against
5,000 ms. No timeout, worker or assertion was tuned. This is not a blanket waiver
for any different/new/systemic failure. That run completed with 149 files /4,450 tests: 4,446 passed and four failed.
Three existing cross-process cases encountered the nested-transaction mistake
while the final race repair was underway. The private reservation was corrected
to operate inside its caller's writer transaction; no public nested-transaction
rule was changed. Both the initial stale/own-receipt races and this implementation
mistake are real source failures, not environment normalization. The run is
superseded by stable focused and canonical verification after the repair.
A fixture typecheck correction replaced unsupported Array.findLast with the
existing target-compatible filter/at operation; no TypeScript target changed.
Final stable observations are recorded at the start of this section.

| Mechanical class | Initial evidence | Correction / count | Outcome |
| --- | --- | --- | --- |
| Loopback listener | Earlier 128 setup denials, EPERM/LISTEN_FAILED at 127.0.0.1 | Exact scoped permission retry, 1 correction | 151/151 PASS; established listener permission used for canonical verification |
| Git metadata write | Current continuation fetch could not open .git/FETCH_HEAD: Operation not permitted | Same ordinary fetch with repository-write permission, 1 correction | PASS; origin/main unchanged |

No dependency installation/refresh, host-load worker reduction, model/provider
retry or semantic normalization. UTF-8 text I/O and fixed/injected dates used.
No Windows runner was used; cross-platform evidence is explicit encoding and
network-free deterministic fixtures, not a Windows verification claim.

## Q–R. Scope and contract documentation

Final Fresh Independent QA NOT performed. Step 9 NOT STARTED. Real provider/model
turns=0. Real target orchestration=NONE. No dynamic graph mutation, automatic Git
merge/rebase/push feature, browser UI, scheduler, provider expansion, broad RAG,
new Planner/Reviewer provider hierarchy, capacity relaxation or serial-dispatch
relaxation. Ordinary Git push of this authorized repair is delivery only.

Production files: `packages/storage/src/governed-execution.ts` and
`packages/storage/src/worktree-ownership.ts`. Existing governed completion test
updated only for the approved released-proof contract. Test-only additions are
the integrated fixture and ten scenario/worker files under local-control/test,
plus opt-in mock provider behavior. Documentation: CURRENT_STATE, this Handoff,
GIT_WORKTREE_OWNERSHIP_V0 and ORCHESTRATION_KERNEL_V0.
Historical Step 8A/8D acceptance and SHA evidence remain historical and unchanged.

### Exact changed files

- `CURRENT_STATE.md`
- `docs/GIT_WORKTREE_OWNERSHIP_V0.md`
- `docs/ORCHESTRATION_KERNEL_V0.md`
- `docs/STEP_8E_INTEGRATED_HARDENING.md`
- `fixtures/mock-governed-app-server.ts`
- `packages/storage/src/governed-execution.ts`
- `packages/storage/src/worktree-ownership.ts`
- `packages/storage/test/governed-execution.test.ts`
- `packages/local-control/test/integrated-orchestration-budgets.test.ts`
- `packages/local-control/test/integrated-orchestration-completion-boundaries.test.ts`
- `packages/local-control/test/integrated-orchestration-dispatch.test.ts`
- `packages/local-control/test/integrated-orchestration-fixture.ts`
- `packages/local-control/test/integrated-orchestration-planning.test.ts`
- `packages/local-control/test/integrated-orchestration-process-worker.test.ts`
- `packages/local-control/test/integrated-orchestration-processes.test.ts`
- `packages/local-control/test/integrated-orchestration-recovery-boundaries.test.ts`
- `packages/local-control/test/integrated-orchestration-release-recovery.test.ts`
- `packages/local-control/test/integrated-orchestration-turnover.test.ts`
- `packages/local-control/test/integrated-orchestration-workflows.test.ts`

## S. MASTER_SCOPE_UPDATE_CANDIDATE

Insert in Master §19 Git / Worktree Direction immediately after the ownership
rules; cross-reference from §21 Lifecycle / Human Intervention. Exact approved
wording, consolidated for both amendments:

> After authoritative Subtask completion, the governed controller may automatically invoke the accepted normal worktree-release lifecycle. A successfully RELEASED owned worktree no longer grants execution authority or consumes active-coding capacity, but its exact immutable releaseHeadSha may serve as Big Task completion provenance when it matches the final governed assessment and Handoff candidate SHA. Exact clean ACTIVE candidate authority remains valid as an alternative completion proof. RELEASING, FAILED, ambiguous, mismatched, or unverifiable ownership fails closed. Candidates under applicable HUMAN_REQUIRED are preserved rather than automatically released. This does not relax the Project active-coding ceiling or the Step 8 V0 serial write-dispatch limit.

> When an authoritative post-completion normal release has durably entered RELEASING but the exact clean owned worktree remains because removal was interrupted, the governed controller may deterministically resume that same pending release after revalidating canonical ownership generation, final assessed/releaseHeadSha identity, cleanliness, execution exclusion, and absence of applicable HUMAN_REQUIRED. Resumption may perform only the remaining accepted normal non-force release steps and may not restore coding authority, change the candidate, force-remove, or bypass ambiguous recovery state.

ChatGPT Project Sources, external Master and Project Instructions were not edited.
No duplicate Master document was created.

## T–V. Maturity, delivery and manual QA

Step 8D=ACCEPTED; FQA-001 through FQA-006=CLOSED; narrow timeout waiver remains
technically unresolved. Step 8E=HARDENED; overall Step 8=HARDENED / NOT ACCEPTED.
Final Fresh Independent no-write QA=PENDING / ELIGIBLE. All Step 8E HARD-001
through HARD-003 findings are CLOSED. The narrow Step 8D P2 limitation remains
DEFERRED / ACCEPTED_P2_LIMITATION, never technically CLOSED.
Step 9 stays blocked until overall Step 8 acceptance in a separate fresh QA task.

No deployment, migration or production-state activation. Normal bounded governed
advance is the only auto-release entry; read-only inspection remains read-only.
If rollback is needed, revert the delivered code commit normally after reviewing
pending releases; preserve durable history and retained branches. Do not reset
or resurrect released worktrees. No automatic rollback or cleanup is performed.

Next safe task: **NEW CHAT Fresh Independent no-write Step 8E / overall Step 8 QA**.
Hanlin manual QA: **NOT REQUIRED**.
