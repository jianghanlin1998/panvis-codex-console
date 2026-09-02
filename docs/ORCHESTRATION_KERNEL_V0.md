# Deterministic Orchestration Kernel V0

Status: Roadmap Step 8A IMPLEMENTED. This is a pure control-plane kernel; Roadmap Step 8 overall is not complete.

## Authority boundary

`@codex-task-console/orchestration` consumes explicit authoritative facts and immutable prior state, then returns deterministic eligibility, blocking, escalation, materialization, dispatch, and completion decisions. It performs no storage writes, process or Codex execution, worktree changes, HTTP requests, repository mutation, or product-scope judgment. It depends only on the public Domain package and reuses canonical identifier, dependency, readiness, and maturity contracts.

## V0 policy

- Profiles are closed to `LOW`, `STANDARD`, and `HIGH_RISK_FOUNDATION`. Their stage paths are deterministic and distinct.
- A Planner supplies proposal-only Plan Candidates. A Reviewer can only `APPROVE`, `REJECT` with bounded revision requirements, or `ESCALATE`; a review decision cannot contain a replacement plan.
- Two automatic Planner revisions are allowed after rejection. A third rejection returns `HUMAN_REQUIRED / PLAN_REVIEW_EXHAUSTED`; escalation returns `HUMAN_REQUIRED / REVIEW_ESCALATED` immediately.
- Approved plans are validated against canonical ownership and Domain dependency rules before materialization. Materialization freezes approved plan order and canonical dependency order.
- A materialized graph is immutable. Any add, remove, split, merge, replacement, or dependency-structure change returns `HUMAN_REQUIRED / REPLAN_REQUIRED` without changing the graph.
- Write-enabled dispatch is serial: at most one Subtask is selected, approved-plan order wins, and dependency readiness uses existing `HARDENED` / `ACCEPTED` semantics. Typed repository, context, budget, capacity, worktree, and human-authority facts gate execution.
- High-risk Fresh QA may enter exactly one Repair and one Focused Re-QA. A second blocking QA result returns `HUMAN_REQUIRED / REPAIR_REQA_EXHAUSTED`.
- Completion evaluation returns `BIG_TASK_COMPLETION_ELIGIBLE`; it does not mutate Big Task status or infer persisted acceptance.

## Deferred to Step 8B or later

Step 8A does not persist orchestration state, execute Planner/Reviewer/Executor/Hardener/QA roles, expose Local Control routes, mutate durable task lifecycle or maturity, provision worktrees, or run real-target dogfood. Step 8B may bind this public pure API to durable/service layers without moving decision authority into those side-effecting layers. Real Big Task orchestration dogfood remains reserved for Roadmap Step 9.
