# Codex Task Console

Local-first control plane for organizing and safely orchestrating AI coding work across projects, bounded tasks, isolated context, approvals, and Codex executions.

## Why

Long-running AI coding work becomes difficult to manage when task boundaries, dependencies, approvals, Git state, execution evidence, and conversation context bleed together. Codex Task Console explores a deterministic control layer that keeps those concerns explicit and reviewable instead of leaving them implicit in chat history.

## Current foundation

- Project -> Big Task -> Subtask task model with explicit scope and lifecycle contracts
- Deterministic maturity, dependency, readiness, implementation-checkpoint, approval, and acceptance gates
- Local SQLite persistence through Drizzle, including schema migrations and constrained storage contracts
- Default-deny context ACLs, allowed-context snapshots, active-item selection, and clean-context QA profiles
- Provider-neutral structured JIT Context Packet core with fixed execution and clean-QA profiles
- Explicit Promoted Context contracts that avoid raw sibling-chat leakage
- Provider-neutral execution references and mappings with Codex App Server as the V1 target boundary
- Deterministic unit, integration, migration, concurrency, and adversarial test coverage

## Architecture

The repository separates two concerns:

- **Control plane:** projects, task hierarchy, maturity and dependency gates, context boundaries, approvals, acceptance evidence, and provider-neutral execution contracts.
- **Execution plane:** Console-owned local Codex App Server runs approved planning, implementation and review work, with durable progress, bounded repair, isolated Git workspaces and integrated delivery evidence. Model inference uses the authenticated provider; the control service and task database run locally.

V1 is intentionally local-first and single-user. Codex Task Console is independent from the Panvis product codebase.

## Tech

- TypeScript and Node.js 24
- pnpm workspaces
- Zod contracts
- SQLite with Drizzle ORM and Drizzle migrations
- Vitest and ESLint
- Codex App Server target boundary with sanitized protocol fixtures

## Status

The complete local browser workspace is implemented: project, big-task and subtask discussions; direct small-task intake; product-direction confirmation; reviewed plans; execution controls; decisions; context; and delivery previews. Step 10 engineering verification is complete; Hanlin's personal product test remains pending. Earlier Board delivery is closed without product acceptance, and its content redesign remains deferred.

## Open the Console

From this repository, after the development preflight:

```sh
pnpm ctc:ui
```

This builds the Console, starts or reuses its local service and opens the browser with a one-use local sign-in ticket. Keep the owning terminal running; Ctrl+C stops the service safely. Opening the workspace does not start a model task. The browser does not receive the CLI bearer token.

Start with a project and a big or small task. Discuss and confirm the product direction, inspect the generated plan, then approve implementation. Ordinary engineering proceeds within that agreement; changes to direction, exceptions and final product acceptance remain explicit human decisions. Check depth is adjustable for each new task.

See [Step 10 workflow, verification and limits](docs/STEP_10_CONSOLE_UI.md) before personal testing.

## Development

Prerequisites: Node.js 24 or newer and pnpm 11.

```sh
source scripts/dev-environment-preflight.sh
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:local-control:e2e
git diff --check
```

The preflight checks the installed workspace offline and fails without installing or refreshing dependencies. Initial dependency setup is a separate operation. Tests use deterministic fixtures and mocked providers; executable and preview tests require local loopback listeners.

To verify the installed Codex protocol generators without starting App Server, provide an explicit temporary or ignored output path:

```sh
pnpm codex:schema:generate -- /absolute/temporary/path
```

## Design documentation

Workspace packages are under `packages/`, and deliberate public APIs are exported by package entry points. Detailed implemented boundaries are documented in:

- [Domain and storage foundation](docs/S0A_SCOPE.md)
- [Core task storage](docs/S0B1_SCOPE.md)
- [Context Item storage](docs/S0B2A_CONTEXT_STORAGE.md)
- [Context Digest and Audit Event storage](docs/S0B2B_DIGEST_AUDIT_STORAGE.md)
- [Mock Codex App Server boundary](docs/S0C_SCOPE.md)
- [Provider-neutral execution contracts](docs/S0D_PROVIDER_NEUTRAL_EXECUTION.md)
- [Maturity, dependencies, and readiness](docs/S1A_MATURITY_DEPENDENCY_READINESS.md)
- [Persisted readiness snapshot](docs/S1B1_PERSISTED_READINESS_SNAPSHOT.md)
- [Implementation completion](docs/S1B2A_IMPLEMENTATION_COMPLETION.md)
- [Context scope ACL](docs/S2A_CONTEXT_SCOPE_ACL.md)
- [Allowed raw-context retrieval](docs/S2B1_ALLOWED_RAW_CONTEXT_RETRIEVAL.md)
- [Active-context selection](docs/S2B2_ACTIVE_CONTEXT_SELECTION.md)
- [Clean-context QA profile](docs/S2C1_QA_CLEAN_CONTEXT_PROFILE.md)
- [Promoted Context route eligibility](docs/S2D1_PROMOTED_CONTEXT_ROUTE_ELIGIBILITY.md)
- [Promoted Context candidate](docs/S2D2_PROMOTED_CONTEXT_CANDIDATE.md)
- [Promoted Context acceptance authority](docs/S2D3_PROMOTED_CONTEXT_ACCEPTANCE_AUTHORITY.md)
- [Human confirmation evidence](docs/S2D4_PROMOTED_CONTEXT_HUMAN_CONFIRMATION_EVIDENCE.md)
- [Accepted Promoted Context snapshot](docs/S2D5A_ACCEPTED_PROMOTED_CONTEXT_SNAPSHOT.md)
- [Typed deterministic engineering facts](docs/S2D6A_TYPED_DETERMINISTIC_ENGINEERING_FACT.md)
- [JIT Context Packet core](docs/JIT_CONTEXT_PACKET_CORE.md)
