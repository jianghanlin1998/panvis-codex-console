# Step 10 — Complete local Console workspace

Approved implementation, 2026-09-08. Hanlin's personal product acceptance is pending.

## Resulting workflow

The browser now uses the real local task store and orchestration service. A project contains its long-term discussion and explicitly confirmed context. A big task contains product direction, planning, execution and delivery. Each subtask has its own discussion, context and execution evidence. Direct small-task intake produces one planned subtask; it does not require the user to invent a larger task first.

1. Add a local Git project or open an existing one.
2. Create a big or small task and discuss the desired result. The editable direction brief records scope, exclusions and success criteria.
3. Confirm the direction and inspection depth. Only then is a canonical task created and sent to the planner/reviewer.
4. Inspect the concrete plan and approve execution with its displayed time, usage and repair allowance. Routine tools and engineering checks do not receive duplicate conversational approval gates.
5. Follow actual subtask dependencies, progress, usage and saved errors. Pause, resume, renew an expired window or inspect a bounded recovery exception when applicable.
6. Inspect the delivered revision, change statistics, available patch, review evidence and supported preview. Engineering completion and the human product decision are separate. Closing without product acceptance remains truthful.

Dark, light and system themes, mobile navigation, readable empty/error states, keyboard focus and retained form values are included. The decision center collects pending product, plan and exception decisions. Settings establish defaults for future tasks; existing approved contracts are preserved.

## Implementation boundaries

- Additive migration 28 stores scoped draft and discussion records. Direction confirmation atomically creates the planning intake. Explicitly confirmed active context is frozen into the intake; raw parent and sibling chats are not silently imported.
- Browser access uses short-lived, one-use launch tickets and HttpOnly SameSite cookies. Current browser sessions rotate on relaunch; CLI credentials stay outside the page. Mutations require the local origin and strict request envelope. Existing operator APIs retain their contracts.
- Discussion and planning jobs are persisted before provider calls, limited concurrently and not replayed on restart. Errors are sanitized. Graceful shutdown drains in-flight read-only planning/discussion; it is not a promise of instant model cancellation. Governed execution retains its explicit pause/recovery semantics.
- Delivery is bound to the approved task, repository, result ref and exact revision. Oversized/unavailable patch text leaves version, statistics and delivery controls visible.
- Preview uses a private snapshot of committed files, not the original working tree. Static root `index.html` and Node `server/index.mjs` are supported. No automatic dependency installation or arbitrary project launch recipe is added.
- Node previews require macOS OS sandboxing plus Node filesystem permissions; unsupported platforms return an explicit result. The snapshot permits its own runtime data writes, while outside reads/writes and child execution are denied. Static previews use a constrained worker. Preview capacity, snapshot size and startup time are bounded; stop and daemon exit clean up children.

## Independent QA and repairs

A fresh read-only agent, explicitly authorized by Hanlin, inspected the implementation. All seven findings were repaired; focused independent re-QA found no remaining blocker in those fixes.

| Finding | Root repair and evidence |
| --- | --- |
| A modal could act on a different task after navigation | Capture the task/scope/revision when opening; route changes invalidate the modal; stale confirmation sends no request. Render regression. |
| A Node preview could access files outside the snapshot | OS sandbox and Node permission boundary; external file, SQLite, write and child-process probes denied. Preview regressions. |
| Confirmed project conclusions did not reach planning | Freeze applicable confirmed context in the intake transaction. Storage/context regressions. |
| A renewed or expired paused task could lack continuation controls | Backend-derived resume/window eligibility covers user pause, daemon stop and time expiry. Render regressions. |
| Redraw could reset budget and exception inputs | Preserve entered form values and checkbox state. Render regression. |
| Repeated browser launch could exhaust eight sessions | Rotate the current browser's session; twenty relaunches retain access without unbounded session growth. Session regressions. |
| Large patch failure could hide all delivery content | Bound patch retrieval and report unavailability separately from delivery metadata. Large-diff regression. |

The first recheck also caught an accidental undefined handler reference and the remaining pause-plus-expiry branch. Both were repaired. Independent final render regression: **7/7 PASS**. No agent performed Hanlin's product acceptance.

## Verification

- Final stable full suite: **182 files, 4,789 tests PASS**, four workers, 503.66 seconds; zero failures, errors or skips.
- Focused final storage/session/render checks: **20/20 PASS**. Preview/session/large-diff checks: **9/9 PASS**. Mocked browser HTTP flow: **4/4 PASS**, including two STANDARD subtasks, four roles, exact-revision acceptance rejection and valid acceptance.
- Public hygiene, lint, typecheck, build and diff checks are recorded with the final commit verification.
- Compiled executable E2E: **PASS**; daemon race, governed commands, signal cleanup and exit verified; zero provider model turns and zero real target writes.
- Browser: synthetic isolated project; authentication and fragment removal; small-task intake, discussion and confirmed direction; reviewed plan; mocked execution through delivery; results evidence; mobile width 390 with no document overflow. Final-code page, plan, preferences, light mobile layout and in-page service-disconnection state checked. Earlier intermediate browser checks found and repaired a plan-shape mismatch and long-ref overflow.
- An earlier full run overlapped edits and had two failures. It is superseded by the stable final full suite above, not relabeled as passing.
- No new real model call or Board execution was made for Step 10 verification. Existing real-runtime evidence remains historical. Windows was not exercised.

### External automatic approval limits observed

The managed tool reviewer rejected two synthetic browser actions because their labels appeared to approve implementation or submit Hanlin's personal acceptance. Those browser clicks were not retried or bypassed. Isolated HTTP and render tests cover their program behavior; final browser approval/acceptance interaction remains part of Hanlin's personal test.

A diagnostic proposal to allow all macOS Mach lookups was also rejected as an overly broad permission relaxation. It did not run. The preview startup problem was resolved using exact runtime file mapping access and named system services, with confinement probes passing. These are external managed-tool decisions, not configurable Console product gates.

## Personal test and local operation

Run `source scripts/dev-environment-preflight.sh` and `pnpm ctc:ui` from the repository. The launcher opens the default browser without printing its ticket. It starts no planning or execution merely by opening the page. Keep the owning terminal running, or reuse an already running local daemon.

For the first personal test, inspect the existing Board task and delivery, visit project/task/subtask discussions, and try a separate bounded small task. Confirm that the direction brief and concrete plan match what you intend before starting it. Use final acceptance only after your own test. Improving Board news coverage remains the later task after Console acceptance.

Before first schema-28 activation, retain a private SQLite backup of schema 27 and check integrity. The new schema is additive, but rollback must preserve subsequent drafts/discussions and all execution history: stop the service, keep the current database separately, and restore a matching pre-activation database only if losing post-backup changes is explicitly intended. Do not point an old binary at newer state as a shortcut. A forced process kill may leave the inherited authority lock requiring verified recovery; normal Ctrl+C shutdown removes owned authority files.

The UI is local and single-user, not a public hosted service. Board's Step 9 record remains CLOSED with `productAccepted: false`. No Board redesign, rerun, main merge, push or deployment is included in this milestone.

Activation completed on 2026-09-08: private schema-27 backup created, schema 28 applied, quick/foreign-key checks passed, existing Board CLOSED state/revision/known usage read back unchanged, and no new production discussion/draft or planning run created. The default browser was opened by the normal launcher. The Console daemon remains running for Hanlin's personal test.
