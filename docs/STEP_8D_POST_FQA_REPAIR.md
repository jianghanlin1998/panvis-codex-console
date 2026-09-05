# Step 8D Post-FQA Repair Handoff

Step 8D remains **HARDENED / REPAIRED / NOT ACCEPTED**. This was the authorized bounded repair of FQA-001 through FQA-007, not independent Re-QA.

## A. Repository truth

- Start: clean `main`, HEAD and origin/main `27568b16b14cd2a52ce6dd5e2024ab8189a02b83`, tree `373f17a2954ba54a27f318622a36c9fcfc2e89be`.
- Repair code SHA: 01d4501a03dba17d9880a18177dfaefe9784f99f; code tree: 6a771635c201b8c34c7f988ee492695db8234177.
- A subsequent evidence-only commit records these immutable identifiers. Final delivery SHA/tree and push readback are reported in the task response.
- Final fetch found no upstream movement. No merge, rebase, reset, force push, or history rewrite was needed.

## B–H. Finding dispositions

All seven are **REPAIRED / awaiting Fresh Focused Re-QA**, with FQA-006 non-blocking as authorized.

| Finding | Reproduction and root cause | Repair and evidence |
|---|---|---|
| FQA-001 | Independently reproduced both changed-hash and changed-byte successful result persistence. Shape/range checks did not prove the measured input. | An immutable Console-generated input observation owns the exact text, authorization, candidate, attempt, targets and claim time. Reads recompute its hash/UTF-8 bytes. A distinct final-turn receipt binds that observation to the actual provider thread. Hash-only, bytes-only, combined changes, wrong targets/run/candidate, exact text, altered text, repeated turn, result and reopen cases fail or succeed as required. |
| FQA-002 | Independently reproduced jointly replaced receipt/snapshot references remaining authoritative. Two matching stored strings did not identify an owning observation. | Typed observations for all seven gates bind Project, Big Task, revision, candidateBinding, Subtask, workflow stage/sequence, occurrence, worktree and candidate SHA. Context text/measurement, usage/extension, capacity, dependency readiness and manual/routine policy remain attributable. The 63-case owner matrix and 21 substitutions with actual sibling Subtask, sibling Big Task and different Project observations restore guards and test use plus reopen; references cannot borrow another owner. |
| FQA-003 | Independently reproduced a new committed candidate after final assessment still completing the Big Task. Completion checked workflow rows without checking the current candidate. | Inside the completion transaction, each final Handoff/result is validated and the exact ACTIVE owned candidate must be clean with HEAD equal to its assessed SHA. Unchanged/reopen/replay pass; new commit, dirty state, mismatched Handoff and RELEASED authority fail. A sibling's new commit does not change another Subtask's assessed identity. |
| FQA-004 | Mock processes independently reproduced context changes at spawn and after thread setup still producing a successful turn. The final checks covered candidate/worktree only. | After thread setup, binding and filesystem validation, immediately before `turn/start`, the private bridge recompiles current input, checks the claim/targets and applicable HUMAN_REQUIRED state, checks current candidate, and rederives aggregate budget. Changed context/targets and hard-paused/unknown usage prevent sending the turn. Mock 119,999 passes; 120,000 blocks without extension and passes with applicable extension; 160,000 and unknown started-run usage block. Failures terminalize without semantic completion or retry. |
| FQA-005 | Independently reproduced STANDARD→STANDARD and HIGH_RISK_FOUNDATION→STANDARD failing with TRANSACTION_FAILED; LOW→STANDARD already passed. Globally unique Step 8C source authority collided on reused capacity-value strings. | Identity now includes the observation occurrence and value. Three serial graph regressions close/reopen after the first completes, then start the second with distinct source IDs despite both observing activeCoding=0 / activeWrite=0. The second becomes IN_PROGRESS and the first receipt is COMPLETED. Project write serialization remains one. |
| FQA-006 | Independently reproduced a changed promotion conclusion returning the prior result. The partial replay comparison omitted promotionCandidate. | Compare the complete canonical structured result, including schemaVersion and promotionCandidate. Exact replay converges; any semantic conflict rejects. Promotion candidates stay PENDING_HUMAN_REVIEW. |
| FQA-007 | The first baseline run did not repeat the historical three timeouts; affected cases took 4.0–4.3s. A subsequent canonical run reproduced two 5,000ms bounded-Re-QA timeouts (5,009 / 5,449ms), plus a worker onTaskUpdate timeout during the long synchronous corpus. A confirmation run then exposed three remaining five-role source-fixture timeouts (5,532 / 5,493 / 5,782ms); those preparation phases were separated as well. These were test defects, not environment normalization. | Separate private per-test preparation phases from bounded repair assertions; split four byte-boundary cases; avoid five-role setup where only a local source is needed; yield between tests for reporter I/O. Existing assertions and invariant coverage remain. No timeout configuration, test worker configuration, skip, or weakened assertion was introduced. two consecutive final runs PASS — 139 files / 4,409 tests each, normal four workers and default timeout policy; 296.37s and 296.59s, with no unhandled errors. |

## I. Provider and gate authority

One new forward migration adds three immutable internal tables:

- `governed_gate_observations`: one typed observation per Subtask/workflow sequence/gate kind. The content-bound reference includes the complete occurrence owner and observed value. Existing `governed_gate_sources` now points to these observations; receipt references are validated against the same source.
- `governed_provider_input_observations`: one exact compiled-text observation per provider claim, bound to the full authorization, reserved thread/run, candidate, targets and claim time. Hash/bytes are recomputed from its owning text.
- `governed_provider_turn_starts`: one final validation receipt per authorization, referencing the exact input observation and bound provider thread. Both provider run start and result authority require it.

The public facade and package exports remain unchanged. Only the private provider bridge can create these authorities; no caller boolean/token, generic prompt or public result writer was added. Existing schema fingerprints now cover the added objects. All 19 immutable governed tables retain replacement/update/delete protection (190 mutation attempts).

## J. Candidate and completion

Current physical candidate validation and existing materialization/workflow/DONE/maturity/HUMAN_REQUIRED checks remain inside the Big Task completion transaction and its existing database guard. Final role result, Handoff and delivery evidence preserve their exact source relationship. No accepted RELEASED-completion contract was extended: released or unavailable active authority fails closed. A changed candidate requires new governed assessment.

## K. Migration and reopen

New migration: `20260905103249_governed_occurrence_provenance`.

The implementation and two pushed hardening migrations are unchanged. Fresh latest creation, accepted Step 8C, implementation, hardened predecessor, legacy gate authority and predecessor-format provider claims are covered. Historical rows remain intact, missing new observations remain absent, and authoritative use refuses to invent ownership. Foreign-key checks and deterministic reopen pass. Accepted Step 8C workflow history is preserved. Existing migration tests retain their assertions with the ledger/table inventories updated for the single new migration.

## L. Prior hardening

The affected HARD-001 through HARD-011 regressions remain: public/private separation, exact bounded QA batches, dedicated focused context and leakage exclusions, schema-object integrity, immutable provenance, 120K-only extension, one start claim, candidate continuity, pending promotion, explicit manual policy, and transaction-level completion/read-only inspection. The complete canonical suite covers the prior unaffected authority surfaces as well. No additional product feature or independently discovered out-of-scope repair was included.

## M. Verification

- Direct governed storage: 183 tests; mock-provider adapter: 32 tests; explicit migration file: 4 tests. Serial graph cases: 3; gate-owner cases: 63 plus 21 substitutions using actual sibling/other-Project sources. These are test counts, not real provider runs.
- Focused repair/migration selection: 71 PASS; owner matrix: 63 PASS; final candidate/historical-claim additions: 2 PASS; phased reliability regressions: 3 PASS; final timeout/sibling-Subtask/run selection: 14 PASS. All 21 legitimate-source substitutions also pass in the final full suite.
- Canonical `pnpm test`: two consecutive final runs PASS — 139 files / 4,409 tests each, normal four workers and default timeout policy; 296.37s and 296.59s, with no unhandled errors.
- `pnpm public:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `git diff --check`: PASS.
- Runtime verified on macOS, Node v24.19.0 / pnpm 11.19.0. No Windows verification claim.
- Failing development results were investigated and superseded by verification, never reported as passing.

## N. Environment normalization

- Loopback listener sandbox: initial full run denied intentionally required 127.0.0.1 listeners with EPERM/LISTEN_FAILED. One permission correction enabled canonical tests; subsequent verification reused that permission. Assertion/timeout failures in the mixed run were handled separately as actual defects.
- Authorized Git metadata write: final fetch initially denied `.git/FETCH_HEAD`. The same fetch was retried once with repository write permission and succeeded, confirming unchanged origin/main. Delivery Git operations reuse that permission.
- No dependency refresh, install, provider retry or host-load timeout normalization occurred. Each used class had one permission correction; neither consumed semantic repair/provider retry authority.

## O. Scope, activation and rollback

Actual scope matches the approved seven-finding batch: storage/provider composition, deterministic tests, one forward migration and state/evidence reconciliation. No Step 8E, Step 9, Fresh Focused Re-QA, dynamic graph mutation, Git merge/rebase/push orchestration feature, UI, deployment or provider expansion. Real provider/model turns: **0**. Real target orchestration: **NONE**. Ordinary repository commits and push are delivery only.

No target or live database was activated or deployed. Rollback requires restoring a pre-upgrade database snapshot with its matching code; do not delete migrations, down-migrate historical rows, or fabricate missing provenance. Existing historical Step 8D rows without the new source observations intentionally fail closed.

## P. Current state

CURRENT_STATE preserves Step 8C ACCEPTED, Step 8D IMPLEMENTED and historical comprehensive hardening PASS, records Fresh Independent QA FAIL on `27568b16b14cd2a52ce6dd5e2024ab8189a02b83`, and pins this repair evidence. FQA-001 through FQA-007 await Fresh Focused Re-QA. Step 8D remains HARDENED / REPAIRED / NOT ACCEPTED; Step 8E stays blocked and Step 9 stays blocked until overall Step 8 acceptance.

## Q. Manual QA

Hanlin manual QA: **NOT REQUIRED**.

## R. Next safe task

**NEW CHAT Fresh Focused Re-QA of the Step 8D FQA-001 through FQA-007 repair batch**

## Changed files

```text
packages/codex-adapter/src/live-execution.ts
packages/codex-adapter/test/governed-role-execution.test.ts
packages/storage/drizzle/20260905103249_governed_occurrence_provenance/migration.sql
packages/storage/drizzle/20260905103249_governed_occurrence_provenance/snapshot.json
packages/storage/src/governed-evidence-validation.ts
packages/storage/src/governed-execution.ts
packages/storage/src/governed-occurrence-provenance.ts
packages/storage/src/governed-schema-manifest.ts
packages/storage/src/schema.ts
packages/storage/test/canonical-task-materialization-migration.test.ts
packages/storage/test/durable-execution-migration-hardening.test.ts
packages/storage/test/durable-orchestration-migration-hardening.test.ts
packages/storage/test/durable-orchestration-planning.test.ts
packages/storage/test/governed-execution-migration.test.ts
packages/storage/test/governed-execution.test.ts
packages/storage/test/implementation-completion-hardening.test.ts
packages/storage/test/jit-context-storage-source-snapshot-hardening.test.ts
packages/storage/test/migrations.test.ts
packages/storage/test/s0b2b-migration-hardening.test.ts
packages/storage/test/task-contract-migration.test.ts
packages/storage/test/workflow-control-migration.test.ts
packages/storage/test/workflow-initialization-migration-hardening.test.ts
packages/storage/test/workflow-initialization-migration.test.ts
CURRENT_STATE.md
docs/STEP_8D_POST_FQA_REPAIR.md
```
