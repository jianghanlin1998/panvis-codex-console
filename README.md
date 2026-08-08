# Codex Task Console

Codex Task Console is an independent, local-first internal development tool under development. It is not part of the Panvis product code and is not yet authorized as Hanlin's active operating workflow.

The current S0A scope contains only repository foundations and deterministic domain contracts for task hierarchy, context metadata, dependencies, lifecycle transitions, native-subagent ownership boundaries, and centralized usage budgets. It does not provide a working Console application. No ChatGPT Project Instructions or Project Sources have been changed or activated.

## Development

Prerequisites: Node.js 20 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Workspace packages are under `packages/`. The deliberate public API for the domain package is exported from `packages/domain/src/index.ts`.
