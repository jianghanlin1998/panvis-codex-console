# Step 10 — project workspace and task navigation

Approved scope: make projects, big tasks and subtasks visibly related; expose context and a dependency-based progress view; allow conversational draft creation and selectable review depth; provide a persistent macOS desktop entry. Board content changes and the next live task are reserved for the owner's next Console session.

## Resulting behavior

- The sidebar follows Project → Big Task → Subtask. Active projects initially expand; ended projects collapse into the lower group. Completed big tasks collapse in place and retain progression order. Manual folding survives refresh; navigating to a different descendant reveals its ancestors. Earlier attempts remain accessible separately from the delivered result.
- Project progress shows dependency arrows, branches and joins, role/stage and completion. Same-column nodes are logically parallel opportunities. The executor still dispatches serially; readiness is not represented as active execution.
- Project, task and subtask discussions have separate histories. Confirmed parent conclusions are inherited with source labels. A conversation-created draft links back to the actual saved originating message. Previous Codex conversations were not stored as Console transcripts; explicitly approved conclusions may be curated as attributed context without fabricating messages.
- Chat actions create direction drafts and suggested subtasks, set scope defaults, or adjust selected review profiles on a plan that has not been approved for execution. Direction and execution approval remain owner decisions. Applying a profile amendment creates a separate immutable plan version, runs a fresh Reviewer and retains the original records and cumulative planning usage. Approved execution cannot be silently rewritten.

## Review depth

| Choice | Work | Failure stop |
| --- | --- | --- |
| Implementation and basic tests | Execute, then verify | Basic verification must succeed; no independent QA |
| Independent QA | Execute, fresh QA, at most one repair/re-QA | Second failed QA stops for the owner |
| Hardening and QA | Execute, harden, fresh QA, at most two repairs/re-QAs | Third failed QA stops for the owner |

The first QA counts as round one. Existing approved workflows keep their historical limits. Required repository checks remain mandatory. New UI QA inputs require an actual rendered/interacted visual check; unavailable visual tooling is blocking evidence, never a fabricated pass. A LIGHT dependency becomes ready only after trusted workflow completion, not merely an IMPLEMENTED maturity label. Scope defaults and the frozen current execution policy are shown separately.

## Hardening and QA

Independent QA covers atomic chat actions and idempotent retries, settings inheritance and explicit clearing, immutable plan amendments, original-draft context inheritance, historical policy compatibility, queued Reviewer work when all live slots are occupied, bounded workspace navigation, and the actual mock execution/repair sequences for all three levels. Tests exercise the real storage, coordinator and provider boundaries with isolated databases and repositories.

Browser checks use an isolated HTTP service and mock model: draft creation from project chat, prefilled direction and source link, dropdown-driven plan amendment and fresh review, sidebar fold/reload/deep link, dependency graph and narrow-screen layout. The graph uses CSP-compatible CSSOM positioning; desktop and 390-pixel layouts were inspected.

The initial full run exposed a quadratic dependency-membership scan on very large legacy graphs. A single precomputed set replaces the repeated scan. The unchanged large-graph regression and expiry/no-further-Git-write regression passed in isolation. The domain enum assertion now explicitly includes the newly authorized VERIFIED gate while retaining all prior gates.

Final full verification: **188 files / 4,838 tests PASS**, four workers, 519.79 seconds. Public hygiene, lint, typecheck, production build, compiled executable E2E and diff checks PASS. Final render/navigation/launcher regressions: **16/16 PASS**. Migration to schema 30 and formal read-only HTTP checks preserve all 13 core record sets, original delivery revision, usage and CLOSED state; one current delivery, seven retained attempts and three attributed conclusions are visible through the API. No new model work was submitted.

| Issue found during this slice | Root repair / retained evidence |
| --- | --- |
| Failed chat action retries conflicted; optional-field omissions changed request equality | Save completion bindings; compare canonical requests; atomic rollback and exact retry regressions |
| Clearing a draft override incorrectly restored its original preference | Distinguish an absent settings record from an explicit inherited value |
| Amended plans lost their original draft/context link | Resolve the immutable predecessor chain with cycle detection |
| Preference controls could show a value that did not govern the next plan | Use server scope defaults; remove the obsolete browser-only review setting |
| An amendment could be saved while all workers were busy and never reviewed | Queue persisted pending plans; drain the bounded queue as active jobs finish |
| Full task bodies could make the navigation bootstrap exceed its response cap | Send a bounded directory and explicit deeper-navigation links |
| Discussion context omitted draft IDs and saved action effects | Include bounded draft inventory and authoritative effects for subsequent turns |
| Dependency-table reconstruction encountered existing triggers, then the expected trigger fingerprint changed | Preserve/recreate the four dependent triggers; update only the deliberately changed dispatch fingerprint; migration and tamper regressions remain active |
| CSP rejected inline graph positioning; manual folds reopened on reload | Apply measured CSSOM layout; persist navigation identity and fold state; browser checks and regressions |
| Legacy dependency graphs became slow; historical QA counts looked like new-policy limits | Precompute membership once; display actual repair round count without inferring a historical allowance |

Environment normalization: localhost-listener sandbox denial was rerun with the authorized local listener permission. The first full run also had one 5-second test-runner timeout during concurrent host load; its unchanged expiry/no-write assertions passed in isolation. These observations do not consume production repair allowances or turn an unsuccessful test attempt into a pass.

The first activation attempt did not execute because automatic permission review timed out. The tool explicitly allowed one retry; the same prepared activation script then succeeded. Formal HTTP smoke initially assumed the display text of a historical raw title; the check was corrected to use the verified stable task ID, while the independent before/after record hashes continue to verify exact preservation.

## Local entry and recovery

After building, `node scripts/install-desktop-entry.mjs` installs `~/Desktop/Codex Task Console.app`. Double-clicking starts or reuses the local daemon and opens the browser through a one-use ticket. The entry has a stable name; the internal local port remains ephemeral. No hosted deployment or login service is introduced. Closing the browser does not stop the daemon. Reopening after a computer restart starts it again; interrupted work remains recorded and requires the existing recovery decision.

Actual installation completed, but the first app launch was denied system access to the repository's `ui-cli.js` in Documents (EPERM). The Mac was locked and automatic unlock failed. This is a pending desktop activation check, not a passed cold-start test; owner unlock and the applicable folder-access decision are required before repeating actual desktop opening/visual QA. The formal service was started through the existing authorized development environment and passed its read-only HTTP checks. Desktop cold/reuse/race behavior has deterministic tests, but that does not replace the pending installed-app check.

The entry points at this repository and the installed Node runtime. If either is moved or removed, rebuild/reinstall the entry. Startup uses a private log under `~/Library/Logs/Codex Task Console/launcher.log`. A matching dead process's stale authority can be reclaimed; live or mismatched authority is preserved. A rare simultaneous stale cleanup may require reopening one launcher, without stealing another live service. If a stopped daemon's PID has been reused by an unrelated live process, automatic cleanup conservatively refuses; verified authority recovery is then needed. These are retained low-frequency launcher limitations, not a claim of universal restart recovery.

Schema 29 adds settings, idempotency and presentation metadata. Schema 30 extends dependency gates while preserving the existing materialization triggers and strengthening the dispatch trigger for VERIFIED. Migration runs with foreign-key restoration and integrity checks. Keep a private schema-28 backup before activation. For rollback, stop the exact Console daemon, preserve the current database separately, restore the backup with the matching older binary, and reinstall its entry; never open a migrated database with an old binary or delete history to force compatibility.

Verification is macOS-only. Model-boundary tests use mocks and do not establish a new live-provider smoke result. The next real product task remains the owner's personal Console test.
