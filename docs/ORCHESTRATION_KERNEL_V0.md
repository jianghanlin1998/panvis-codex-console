# Deterministic Orchestration Kernel V0

Status: Roadmap Step 8A HARDENED. Acceptance is pending Focused Fresh Re-QA. This is a pure control-plane kernel; Roadmap Step 8 overall is not complete.

## Authority boundary

`@codex-task-console/orchestration` consumes explicit authoritative facts and immutable prior state, then returns deterministic eligibility, blocking, escalation, materialization, dispatch, and completion decisions. It performs no storage writes, process or Codex execution, worktree changes, HTTP requests, repository mutation, or product-scope judgment. It depends only on the public Domain package and reuses canonical identifier, dependency, readiness, and maturity contracts.

## V0 policy

- Profiles are closed to `LOW`, `STANDARD`, and `HIGH_RISK_FOUNDATION`. Their stage paths are deterministic and distinct.
- A Planner supplies proposal-only Plan Candidates. Every Reviewer decision carries the deterministic canonical value binding exposed by the current review state, so the decision applies only to that exact Project, Big Task, revision, ordered Subtask set, Task Contract references, profiles, write flags, and canonical dependency set. The binding is an in-memory value identity, not persisted cryptographic provenance. A Reviewer can only `APPROVE`, `REJECT` with unique bounded revision requirements, or `ESCALATE`; a review decision cannot contain a replacement plan.
- Two automatic Planner revisions are allowed after rejection. A third rejection returns `HUMAN_REQUIRED / PLAN_REVIEW_EXHAUSTED`; escalation returns `HUMAN_REQUIRED / REVIEW_ESCALATED` immediately.
- Approved plans are validated against canonical ownership and Domain dependency rules before materialization. Materialization freezes approved plan order, canonical dependency order, and the exact candidate binding.
- A materialized graph is immutable. Any add, remove, split, merge, replacement, or dependency-structure change returns `HUMAN_REQUIRED / REPLAN_REQUIRED` without changing the graph.
- Stage evidence snapshots must carry both the exact materialized candidate binding and the exact target Subtask ID; both must match the transition request before any evidence fact can authorize it. Dispatch state/facts and completion state snapshots carry the exact materialized candidate binding. Stage profiles are derived from the bound graph rather than supplied independently. Evidence from sibling Subtasks, unrelated candidates, or unrelated or future stages fails closed.
- Write-enabled dispatch is serial: at most one Subtask is selected, approved-plan order wins, and dependency readiness uses existing `HARDENED` / `ACCEPTED` semantics. Project capacity is an exact Project-scoped snapshot with zero or one active write ID. Typed repository, context, budget, capacity, worktree, and human-authority facts gate execution.
- High-risk Fresh QA may enter exactly one Repair and one Focused Re-QA. A blocking Focused Re-QA returns `HUMAN_REQUIRED / REPAIR_REQA_EXHAUSTED`; impossible repair-counter/stage combinations fail closed.
- Completion evaluation returns `BIG_TASK_COMPLETION_ELIGIBLE` only for an exact bound snapshot in which every graph Subtask reports `COMPLETE` and no completed Subtask remains `NOT_STARTED`. It does not prove transition history, mutate Big Task status, or infer persisted acceptance.

## Trusted producer boundary

Step 8A operations validate exact immutable shapes, graph ownership, candidate and stage-evidence Subtask bindings, evidence relevance, dependency readiness, and local transition rules. They do not persist or prove historical traversal. Step 8B trusted producers must preserve both the candidate binding and target Subtask binding for stage evidence, as well as Project scope when producing execution, capacity, and completion snapshots; they must not relabel stale evidence or reconstruct arbitrary `COMPLETE` history. Proposal-only `taskContractRef` and revision-requirement text retain the existing bounded trim/length policy; no new durable Unicode-normalization or control-character policy is introduced by Step 8A.

## Deferred to Step 8B or later

Step 8A does not persist orchestration state, execute Planner/Reviewer/Executor/Hardener/QA roles, expose Local Control routes, mutate durable task lifecycle or maturity, provision worktrees, or run real-target dogfood. Step 8B may bind this public pure API to durable/service layers without moving decision authority into those side-effecting layers. Real Big Task orchestration dogfood remains reserved for Roadmap Step 9.
